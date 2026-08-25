import contextlib
import importlib.util
import io
import os
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


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
