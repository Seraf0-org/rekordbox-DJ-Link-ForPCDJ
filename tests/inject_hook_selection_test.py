import contextlib
import importlib.util
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock

import psutil


REPO_ROOT = Path(__file__).resolve().parent.parent
MODULE_PATH = REPO_ROOT / "scripts" / "inject_hook.py"
SPEC = importlib.util.spec_from_file_location("inject_hook_under_test", MODULE_PATH)
inject_hook = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(inject_hook)


class FakeProcess:
    def __init__(self, pid: int, executable: str):
        self.info = {
            "pid": pid,
            "name": "rekordbox.exe",
            "exe": executable,
            "create_time": float(pid),
            "memory_info": None,
        }


class FakeNativeFunction:
    def __init__(self, callback):
        self.callback = callback
        self.calls = []
        self.argtypes = None
        self.restype = None

    def __call__(self, *arguments):
        self.calls.append(arguments)
        return self.callback(*arguments)


class FakeKernel32:
    def __init__(self, image_path: str, create_time: float):
        create_ticks = int(
            round((create_time + inject_hook.WINDOWS_EPOCH_SECONDS) * 10_000_000)
        )

        def query_image(_handle, _flags, buffer, length):
            buffer.value = image_path
            length._obj.value = len(image_path)
            return 1

        def get_times(_handle, creation, _exit, _kernel, _user):
            creation._obj.dwLowDateTime = create_ticks & 0xFFFFFFFF
            creation._obj.dwHighDateTime = create_ticks >> 32
            return 1

        def write_memory(_handle, _address, _buffer, size, written):
            written._obj.value = size
            return 1

        self.OpenProcess = FakeNativeFunction(lambda _perms, _inherit, _pid: 1)
        self.QueryFullProcessImageNameW = FakeNativeFunction(query_image)
        self.GetProcessTimes = FakeNativeFunction(get_times)
        self.VirtualAllocEx = FakeNativeFunction(lambda *_arguments: 1)
        self.WriteProcessMemory = FakeNativeFunction(write_memory)
        self.GetModuleHandleW = FakeNativeFunction(lambda _name: 1)
        self.GetProcAddress = FakeNativeFunction(lambda _module, _name: 1)
        self.CreateRemoteThread = FakeNativeFunction(lambda *_arguments: 1)
        self.WaitForSingleObject = FakeNativeFunction(lambda *_arguments: 0)

        def get_exit_code(_handle, exit_code):
            exit_code._obj.value = 1
            return 1

        self.GetExitCodeThread = FakeNativeFunction(get_exit_code)
        self.CloseHandle = FakeNativeFunction(lambda *_arguments: 1)


class InjectionSelectionTests(unittest.TestCase):
    def setUp(self):
        self.temp = tempfile.TemporaryDirectory()
        self.addCleanup(self.temp.cleanup)
        root = Path(self.temp.name)
        self.dll = root / "rb_hook.dll"
        self.dll.write_bytes(b"test")
        self.supported = root / "rekordbox" / "rekordbox 7.2.18" / "rekordbox.exe"
        self.supported.parent.mkdir(parents=True)
        self.supported.write_bytes(b"test")
        self.unsupported = root / "rekordbox" / "rekordbox 7.2.19" / "rekordbox.exe"
        self.unsupported.parent.mkdir(parents=True)
        self.unsupported.write_bytes(b"test")

    def run_main(self, arguments, patches):
        stack = contextlib.ExitStack()
        self.addCleanup(stack.close)
        stack.enter_context(mock.patch.object(sys, "argv", ["inject_hook.py", *arguments]))
        stack.enter_context(mock.patch.dict(os.environ, {}, clear=False))
        os.environ.pop("REKORDBOX_EXE_PATH", None)
        for target, value in patches.items():
            stack.enter_context(mock.patch.object(inject_hook, target, value))
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            result = inject_hook.main()
        stack.close()
        return result, output.getvalue()

    def process_identity(self, executable=None, create_time=123.0, name="rekordbox.exe", running=True):
        process = mock.Mock()
        process.is_running.return_value = running
        process.name.return_value = name
        process.exe.return_value = executable or str(self.supported)
        process.create_time.return_value = create_time
        return process

    def test_preferred_process_requires_readable_exact_executable_path(self):
        processes = [
            FakeProcess(1, ""),
            FakeProcess(2, str(self.supported)),
            FakeProcess(3, str(self.unsupported)),
        ]
        with mock.patch.object(inject_hook.psutil, "process_iter", return_value=processes):
            self.assertEqual(
                inject_hook.list_pids("rekordbox.exe", preferred_exe=str(self.supported)),
                [2],
            )

    def test_explicit_path_must_equal_a_discovered_supported_install(self):
        catalog = [((7, 2, 18), self.supported.resolve())]
        with mock.patch.object(inject_hook, "installed_supported_rekordbox", return_value=catalog):
            self.assertEqual(
                inject_hook.supported_explicit_launch_path(str(self.supported)),
                str(self.supported.resolve()),
            )
            self.assertEqual(inject_hook.supported_explicit_launch_path(str(self.unsupported)), "")

    def test_launch_installed_selects_supported_running_process(self):
        injector = mock.Mock(return_value=1)
        result, _ = self.run_main(
            ["--dll-path", str(self.dll), "--launch-installed"],
            {
                "find_running_supported_rekordbox": mock.Mock(
                    return_value=(42, str(self.supported))
                ),
                "inject_dll": injector,
            },
        )
        self.assertEqual(result, 0)
        injector.assert_called_once_with(42, self.dll.resolve())

    def test_already_running_supported_process_is_not_delayed_by_settle_contract(self):
        injector = mock.Mock(return_value=1)
        sleep = mock.Mock()
        monotonic = mock.Mock()
        with mock.patch.object(inject_hook.time, "sleep", sleep), mock.patch.object(
            inject_hook.time, "monotonic", monotonic
        ):
            result, _ = self.run_main(
                [
                    "--dll-path",
                    str(self.dll),
                    "--launch-installed",
                    "--launch-settle-seconds",
                    "15",
                ],
                {
                    "find_running_supported_rekordbox": mock.Mock(
                        return_value=(42, str(self.supported))
                    ),
                    "inject_dll": injector,
                },
            )
        self.assertEqual(result, 0)
        injector.assert_called_once_with(42, self.dll.resolve())
        sleep.assert_not_called()
        monotonic.assert_not_called()

    def test_self_launched_process_uses_exact_popen_pid_and_settles_before_injecting(self):
        injector = mock.Mock(return_value=1)
        launched = mock.Mock(pid=42)
        launched.poll.return_value = None
        process = self.process_identity()
        find_pid = mock.Mock(return_value=None)
        launch = mock.Mock(return_value=launched)
        monotonic = mock.Mock(side_effect=[0.0, 0.0, 0.0, 0.0, 0.5, 15.0, 15.0])
        sleep = mock.Mock()
        with mock.patch.object(inject_hook.psutil, "Process", return_value=process), mock.patch.object(
            inject_hook.time, "monotonic", monotonic
        ), mock.patch.object(inject_hook.time, "sleep", sleep):
            result, output = self.run_main(
                [
                    "--dll-path",
                    str(self.dll),
                    "--launch-installed",
                    "--wait-seconds",
                    "60",
                    "--launch-settle-seconds",
                    "15",
                ],
                {
                    "find_running_supported_rekordbox": mock.Mock(return_value=(None, "")),
                    "find_pid": find_pid,
                    "find_latest_supported_rekordbox": mock.Mock(return_value=str(self.supported)),
                    "launch_rekordbox": launch,
                    "inject_dll": injector,
                },
            )
        self.assertEqual(result, 0, output)
        launch.assert_called_once_with(str(self.supported))
        find_pid.assert_called_once_with("rekordbox.exe")
        self.assertGreaterEqual(sleep.call_count, 1)
        self.assertEqual(sleep.call_args.args, (0.5,))
        injector.assert_called_once_with(
            42,
            self.dll.resolve(),
            ("rekordbox.exe", str(self.supported.resolve()).lower(), 123.0),
        )

    def test_self_launched_process_exit_during_settle_fails_closed_without_fallback(self):
        injector = mock.Mock(return_value=1)
        launched = mock.Mock(pid=42)
        launched.poll.return_value = None
        process = self.process_identity()
        monotonic = mock.Mock(side_effect=[0.0, 0.0, 0.0, 0.0])
        sleep = mock.Mock()
        with mock.patch.object(
            inject_hook.psutil,
            "Process",
            side_effect=[process, process, psutil.NoSuchProcess(42)],
        ), mock.patch.object(inject_hook.time, "monotonic", monotonic), mock.patch.object(
            inject_hook.time, "sleep", sleep
        ):
            result, output = self.run_main(
                [
                    "--dll-path",
                    str(self.dll),
                    "--launch-installed",
                    "--wait-seconds",
                    "60",
                    "--launch-settle-seconds",
                    "15",
                ],
                {
                    "find_running_supported_rekordbox": mock.Mock(return_value=(None, "")),
                    "find_pid": mock.Mock(return_value=None),
                    "find_latest_supported_rekordbox": mock.Mock(return_value=str(self.supported)),
                    "launch_rekordbox": mock.Mock(return_value=launched),
                    "inject_dll": injector,
                },
            )
        self.assertEqual(result, 1)
        self.assertIn("exited or its process identity could not be queried", output)
        injector.assert_not_called()
        sleep.assert_not_called()

    def test_self_launched_process_path_change_during_settle_fails_closed(self):
        injector = mock.Mock(return_value=1)
        launched = mock.Mock(pid=42)
        launched.poll.return_value = None
        process = self.process_identity()
        changed = self.process_identity(executable=str(self.unsupported))
        monotonic = mock.Mock(side_effect=[0.0, 0.0, 0.0, 0.0])
        with mock.patch.object(
            inject_hook.psutil,
            "Process",
            side_effect=[process, process, changed],
        ), mock.patch.object(inject_hook.time, "monotonic", monotonic):
            result, output = self.run_main(
                [
                    "--dll-path",
                    str(self.dll),
                    "--launch-installed",
                    "--wait-seconds",
                    "60",
                    "--launch-settle-seconds",
                    "15",
                ],
                {
                    "find_running_supported_rekordbox": mock.Mock(return_value=(None, "")),
                    "find_pid": mock.Mock(return_value=None),
                    "find_latest_supported_rekordbox": mock.Mock(return_value=str(self.supported)),
                    "launch_rekordbox": mock.Mock(return_value=launched),
                    "inject_dll": injector,
                },
            )
        self.assertEqual(result, 1)
        self.assertIn("executable path changed", output)
        injector.assert_not_called()

    def test_self_launched_process_create_time_change_during_settle_fails_closed(self):
        injector = mock.Mock(return_value=1)
        launched = mock.Mock(pid=42)
        launched.poll.return_value = None
        process = self.process_identity()
        changed = self.process_identity(create_time=124.0)
        monotonic = mock.Mock(side_effect=[0.0, 0.0, 0.0, 0.0])
        with mock.patch.object(
            inject_hook.psutil,
            "Process",
            side_effect=[process, process, changed],
        ), mock.patch.object(inject_hook.time, "monotonic", monotonic):
            result, output = self.run_main(
                [
                    "--dll-path",
                    str(self.dll),
                    "--launch-installed",
                    "--wait-seconds",
                    "60",
                    "--launch-settle-seconds",
                    "15",
                ],
                {
                    "find_running_supported_rekordbox": mock.Mock(return_value=(None, "")),
                    "find_pid": mock.Mock(return_value=None),
                    "find_latest_supported_rekordbox": mock.Mock(return_value=str(self.supported)),
                    "launch_rekordbox": mock.Mock(return_value=launched),
                    "inject_dll": injector,
                },
            )
        self.assertEqual(result, 1)
        self.assertIn("replaced or its create time changed", output)
        injector.assert_not_called()

    def test_self_launched_process_identity_query_ambiguity_times_out_without_fallback(self):
        injector = mock.Mock(return_value=1)
        launched = mock.Mock(pid=42)
        launched.poll.return_value = None
        monotonic = mock.Mock(side_effect=[0.0, 0.0, 0.0, 60.0])
        with mock.patch.object(
            inject_hook.psutil,
            "Process",
            side_effect=psutil.AccessDenied(42),
        ), mock.patch.object(inject_hook.time, "monotonic", monotonic), mock.patch.object(
            inject_hook.time, "sleep"
        ) as sleep:
            result, output = self.run_main(
                [
                    "--dll-path",
                    str(self.dll),
                    "--launch-installed",
                    "--wait-seconds",
                    "60",
                    "--launch-settle-seconds",
                    "15",
                ],
                {
                    "find_running_supported_rekordbox": mock.Mock(return_value=(None, "")),
                    "find_pid": mock.Mock(return_value=None),
                    "find_latest_supported_rekordbox": mock.Mock(return_value=str(self.supported)),
                    "launch_rekordbox": mock.Mock(return_value=launched),
                    "inject_dll": injector,
                },
            )
        self.assertEqual(result, 1)
        self.assertIn("identity became readable", output)
        launched.poll.assert_called_once_with()
        sleep.assert_called_once_with(0.5)
        injector.assert_not_called()

    def test_self_launch_explicit_path_uses_the_same_exact_pid_settle_fence(self):
        injector = mock.Mock(return_value=1)
        launched = mock.Mock(pid=42)
        launched.poll.return_value = None
        process = self.process_identity()
        find_pid = mock.Mock(return_value=None)
        launch = mock.Mock(return_value=launched)
        monotonic = mock.Mock(side_effect=[0.0, 0.0, 0.0, 0.0, 0.5, 15.0, 15.0])
        sleep = mock.Mock()
        with mock.patch.object(inject_hook.psutil, "Process", return_value=process), mock.patch.object(
            inject_hook.time, "monotonic", monotonic
        ), mock.patch.object(inject_hook.time, "sleep", sleep):
            result, output = self.run_main(
                [
                    "--dll-path",
                    str(self.dll),
                    "--launch-path",
                    str(self.supported),
                    "--wait-seconds",
                    "60",
                    "--launch-settle-seconds",
                    "15",
                ],
                {
                    "supported_explicit_launch_path": mock.Mock(return_value=str(self.supported)),
                    "find_pid": find_pid,
                    "launch_rekordbox": launch,
                    "inject_dll": injector,
                },
            )
        self.assertEqual(result, 0, output)
        find_pid.assert_called_once_with("rekordbox.exe", preferred_exe=str(self.supported))
        launch.assert_called_once_with(str(self.supported))
        injector.assert_called_once_with(
            42,
            self.dll.resolve(),
            ("rekordbox.exe", str(self.supported.resolve()).lower(), 123.0),
        )

    def test_settle_interval_cannot_be_lowered_by_an_operator(self):
        with mock.patch.object(
            sys,
            "argv",
            [
                "inject_hook.py",
                "--dll-path",
                str(self.dll),
                "--launch-installed",
                "--launch-settle-seconds",
                "14",
            ],
        ), contextlib.redirect_stderr(io.StringIO()):
            with self.assertRaises(SystemExit) as raised:
                inject_hook.main()
        self.assertEqual(raised.exception.code, 2)

    def test_open_process_identity_matches_image_and_filetime_before_remote_thread(self):
        expected_identity = (
            "rekordbox.exe",
            str(self.supported.resolve()).lower(),
            123.0,
        )
        kernel32 = FakeKernel32(str(self.supported), 123.0)
        with mock.patch.object(inject_hook.ctypes, "windll", mock.Mock(kernel32=kernel32)):
            result = inject_hook.inject_dll(42, self.dll.resolve(), expected_identity)
        self.assertEqual(result, 1)
        self.assertEqual(len(kernel32.VirtualAllocEx.calls), 1)
        self.assertEqual(len(kernel32.CreateRemoteThread.calls), 1)

    def test_open_process_image_mismatch_fails_before_virtual_alloc_or_remote_thread(self):
        expected_identity = (
            "rekordbox.exe",
            str(self.supported.resolve()).lower(),
            123.0,
        )
        kernel32 = FakeKernel32(str(self.unsupported), 123.0)
        with mock.patch.object(inject_hook.ctypes, "windll", mock.Mock(kernel32=kernel32)):
            with self.assertRaisesRegex(RuntimeError, "executable path changed"):
                inject_hook.inject_dll(42, self.dll.resolve(), expected_identity)
        self.assertEqual(len(kernel32.VirtualAllocEx.calls), 0)
        self.assertEqual(len(kernel32.CreateRemoteThread.calls), 0)
        self.assertGreaterEqual(len(kernel32.CloseHandle.calls), 1)

    def test_open_process_create_time_mismatch_fails_before_virtual_alloc_or_remote_thread(self):
        expected_identity = (
            "rekordbox.exe",
            str(self.supported.resolve()).lower(),
            123.0,
        )
        kernel32 = FakeKernel32(str(self.supported), 124.0)
        with mock.patch.object(inject_hook.ctypes, "windll", mock.Mock(kernel32=kernel32)):
            with self.assertRaisesRegex(RuntimeError, "PID was replaced"):
                inject_hook.inject_dll(42, self.dll.resolve(), expected_identity)
        self.assertEqual(len(kernel32.VirtualAllocEx.calls), 0)
        self.assertEqual(len(kernel32.CreateRemoteThread.calls), 0)
        self.assertGreaterEqual(len(kernel32.CloseHandle.calls), 1)

    def test_launch_installed_rejects_unsupported_running_process(self):
        injector = mock.Mock(return_value=1)
        result, output = self.run_main(
            ["--dll-path", str(self.dll), "--launch-installed"],
            {
                "find_running_supported_rekordbox": mock.Mock(return_value=(None, "")),
                "find_pid": mock.Mock(return_value=77),
                "inject_dll": injector,
            },
        )
        self.assertEqual(result, 1)
        self.assertIn("unsupported or differently installed", output)
        injector.assert_not_called()

    def test_launch_installed_rejects_when_no_supported_install_exists(self):
        injector = mock.Mock(return_value=1)
        result, output = self.run_main(
            ["--dll-path", str(self.dll), "--launch-installed"],
            {
                "find_running_supported_rekordbox": mock.Mock(return_value=(None, "")),
                "find_pid": mock.Mock(return_value=None),
                "find_latest_supported_rekordbox": mock.Mock(return_value=""),
                "inject_dll": injector,
            },
        )
        self.assertEqual(result, 1)
        self.assertIn("no supported Rekordbox installation", output)
        injector.assert_not_called()

    def test_supported_launch_path_is_exact_and_unsupported_is_rejected(self):
        injector = mock.Mock(return_value=1)
        result, _ = self.run_main(
            ["--dll-path", str(self.dll), "--launch-path", str(self.supported)],
            {
                "supported_explicit_launch_path": mock.Mock(return_value=str(self.supported)),
                "find_pid": mock.Mock(return_value=42),
                "inject_dll": injector,
            },
        )
        self.assertEqual(result, 0)
        injector.assert_called_once()

        rejected_injector = mock.Mock(return_value=1)
        result, output = self.run_main(
            ["--dll-path", str(self.dll), "--launch-path", str(self.unsupported)],
            {
                "supported_explicit_launch_path": mock.Mock(return_value=""),
                "inject_dll": rejected_injector,
            },
        )
        self.assertEqual(result, 1)
        self.assertIn("must exactly match", output)
        rejected_injector.assert_not_called()

    def test_no_flag_selects_only_a_supported_running_process(self):
        injector = mock.Mock(return_value=1)
        result, _ = self.run_main(
            ["--dll-path", str(self.dll)],
            {
                "find_running_supported_rekordbox": mock.Mock(
                    return_value=(42, str(self.supported))
                ),
                "inject_dll": injector,
            },
        )
        self.assertEqual(result, 0)
        injector.assert_called_once_with(42, self.dll.resolve())

    def test_retired_environment_override_fails_explicitly(self):
        injector = mock.Mock(return_value=1)
        with mock.patch.dict(os.environ, {"REKORDBOX_EXE_PATH": str(self.supported)}):
            with mock.patch.object(
                sys,
                "argv",
                ["inject_hook.py", "--dll-path", str(self.dll), "--launch-installed"],
            ):
                output = io.StringIO()
                with contextlib.redirect_stdout(output):
                    result = inject_hook.main()
        self.assertEqual(result, 1)
        self.assertIn("REKORDBOX_EXE_PATH is retired", output.getvalue())
        injector.assert_not_called()


if __name__ == "__main__":
    unittest.main()
