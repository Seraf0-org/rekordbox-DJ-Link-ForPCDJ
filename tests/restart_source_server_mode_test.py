import importlib.util
import shutil
import unittest
from pathlib import Path

import psutil


REPO_ROOT = Path(__file__).resolve().parents[1]
MODULE_PATH = REPO_ROOT / "scripts" / "restart_source_server.py"
SPEC = importlib.util.spec_from_file_location("restart_source_server_under_test", MODULE_PATH)
MODULE = importlib.util.module_from_spec(SPEC)
assert SPEC.loader is not None
SPEC.loader.exec_module(MODULE)


class FakeProcess:
    def __init__(self, pid, script, args=(), *, cwd=None, name="node.exe"):
        self.pid = pid
        self.script = Path(script)
        self.args = list(args)
        self._cwd = str(cwd or MODULE.PROJECT_ROOT)
        self._name = name
        self.terminated = False
        self.waited = False

    def name(self):
        return self._name

    def cwd(self):
        return self._cwd

    def cmdline(self):
        return ["node.exe", str(self.script), *self.args]

    def terminate(self):
        self.terminated = True

    def poll(self):
        return 0 if self.terminated else None

    def wait(self, timeout=None):
        self.waited = True
        return 0


class FakeWorld:
    def __init__(self, *processes, listeners=None):
        self.processes = {process.pid: process for process in processes}
        self.listeners = {port: set(pids) for port, pids in (listeners or {}).items()}

    def process_iter(self):
        return [process for process in self.processes.values() if not process.terminated]

    def listener_pids(self, port):
        return {
            pid
            for pid in self.listeners.get(port, set())
            if pid in self.processes and not self.processes[pid].terminated
        }

    def process(self, pid):
        process = self.processes.get(pid)
        if process is None or process.terminated:
            raise psutil.NoSuchProcess(pid)
        return process

    @staticmethod
    def wait_processes(processes, timeout):
        assert timeout == 10
        return (list(processes), [])


class ModeSpecificRestartTest(unittest.TestCase):
    def stop_with(self, world, port, rekordbox_local_test):
        return MODULE.stop_owned_listeners(
            port,
            rekordbox_local_test,
            listener_pid_provider=world.listener_pids,
            process_provider=world.process,
            wait_processes=world.wait_processes,
            process_iter_provider=world.process_iter,
        )

    def test_source_server_mode_accepts_only_the_three_absolute_forms(self):
        production = FakeProcess(1, MODULE.SERVER_SCRIPT)
        direct_local = FakeProcess(2, MODULE.TEST_SERVER_SCRIPT)
        flag_local = FakeProcess(3, MODULE.SERVER_SCRIPT, [MODULE.REKORDBOX_LOCAL_TEST_ARGUMENT])

        self.assertEqual(
            MODULE.source_server_mode(production), MODULE.PRODUCTION_SOURCE_SERVER_MODE
        )
        self.assertEqual(MODULE.source_server_mode(direct_local), MODULE.LOCAL_SOURCE_SERVER_MODE)
        self.assertEqual(MODULE.source_server_mode(flag_local), MODULE.LOCAL_SOURCE_SERVER_MODE)

        relative = FakeProcess(4, Path("server") / "index.js")
        wrong_args = FakeProcess(5, MODULE.SERVER_SCRIPT, [MODULE.REKORDBOX_LOCAL_TEST_ARGUMENT, "extra"])
        wrong_cwd = FakeProcess(6, MODULE.SERVER_SCRIPT, cwd=MODULE.PROJECT_ROOT.parent)
        self.assertIsNone(MODULE.source_server_mode(relative))
        self.assertIsNone(MODULE.source_server_mode(wrong_args))
        self.assertIsNone(MODULE.source_server_mode(wrong_cwd))

    def test_opposite_mode_on_a_different_port_fails_before_any_termination(self):
        production = FakeProcess(101, MODULE.SERVER_SCRIPT)
        world = FakeWorld(production, listeners={9001: {101}})

        with self.assertRaisesRegex(RuntimeError, r"opposite-mode.*PID 101 mode=production"):
            self.stop_with(world, 8787, True)
        self.assertFalse(production.terminated)

    def test_listenerless_opposite_mode_fails_before_any_termination(self):
        production = FakeProcess(202, MODULE.SERVER_SCRIPT)
        world = FakeWorld(production)

        with self.assertRaisesRegex(RuntimeError, r"opposite-mode.*PID 202 mode=production"):
            self.stop_with(world, 8787, True)
        self.assertFalse(production.terminated)

    def test_same_mode_on_a_different_port_requires_explicit_stop(self):
        production = FakeProcess(303, MODULE.SERVER_SCRIPT)
        world = FakeWorld(production, listeners={9001: {303}})

        with self.assertRaisesRegex(RuntimeError, r"same-mode.*PID 303 mode=production.*Stop it explicitly"):
            self.stop_with(world, 8787, False)
        self.assertFalse(production.terminated)

    def test_same_mode_prelisten_requires_explicit_stop(self):
        production = FakeProcess(304, MODULE.SERVER_SCRIPT)
        world = FakeWorld(production)

        with self.assertRaisesRegex(RuntimeError, r"same-mode.*PID 304 mode=production.*Stop it explicitly"):
            self.stop_with(world, 8787, False)
        self.assertFalse(production.terminated)

    def test_direct_local_entry_form_is_same_mode_and_restartable(self):
        local = FakeProcess(404, MODULE.TEST_SERVER_SCRIPT)
        world = FakeWorld(local, listeners={8787: {404}})

        self.stop_with(world, 8787, True)
        self.assertTrue(local.terminated)

    def test_existing_same_mode_requested_port_restarts(self):
        production = FakeProcess(505, MODULE.SERVER_SCRIPT)
        world = FakeWorld(production, listeners={8787: {505}})

        self.stop_with(world, 8787, False)
        self.assertTrue(production.terminated)

    def test_process_iteration_access_denied_fails_closed(self):
        production = FakeProcess(606, MODULE.SERVER_SCRIPT)

        def denied_process_iter():
            raise psutil.AccessDenied(606)

        with self.assertRaisesRegex(RuntimeError, "cannot enumerate source-server processes"):
            MODULE.stop_owned_listeners(
                8787,
                False,
                listener_pid_provider=lambda _port: {606},
                process_provider=lambda _pid: production,
                process_iter_provider=denied_process_iter,
            )
        self.assertFalse(production.terminated)

    def test_process_iteration_disappearance_is_allowed(self):
        def disappeared_process_iter():
            raise psutil.NoSuchProcess(707)

        MODULE.stop_owned_listeners(
            8787,
            False,
            listener_pid_provider=lambda _port: set(),
            process_iter_provider=disappeared_process_iter,
        )

    def test_spawn_gate_rechecks_opposite_mode_before_popen(self):
        production = FakeProcess(808, MODULE.SERVER_SCRIPT)
        world = FakeWorld(production, listeners={9001: {808}})
        started = []

        with self.assertRaisesRegex(RuntimeError, r"immediately before source-server spawn.*PID 808 mode=production"):
            MODULE.start_source_server(
                8787,
                True,
                listener_pid_provider=world.listener_pids,
                process_iter_provider=world.process_iter,
                process_starter=lambda *args, **kwargs: started.append((args, kwargs)),
            )
        self.assertEqual(started, [])
        self.assertFalse(production.terminated)

    def test_spawn_gate_rejects_listenerless_same_mode_before_popen(self):
        production = FakeProcess(809, MODULE.SERVER_SCRIPT)
        world = FakeWorld(production)
        started = []

        with self.assertRaisesRegex(RuntimeError, r"immediately before source-server spawn.*PID 809 mode=production"):
            MODULE.start_source_server(
                8787,
                False,
                listener_pid_provider=world.listener_pids,
                process_iter_provider=world.process_iter,
                process_starter=lambda *args, **kwargs: started.append((args, kwargs)),
            )
        self.assertEqual(started, [])
        self.assertFalse(production.terminated)

    def test_local_spawn_uses_the_explicit_local_entry_script(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node.js is required for the spawn contract fixture")
        spawned = FakeProcess(910, MODULE.TEST_SERVER_SCRIPT)
        captured = {}
        has_spawned = False

        def listener_provider(port):
            return {910} if has_spawned and port == 8787 else set()

        def starter(*args, **kwargs):
            nonlocal has_spawned
            has_spawned = True
            captured["args"] = args
            captured["kwargs"] = kwargs
            return spawned

        result = MODULE.start_source_server(
            8787,
            True,
            listener_pid_provider=listener_provider,
            process_iter_provider=lambda: [],
            process_starter=starter,
        )

        self.assertEqual(result, 910)
        self.assertEqual(captured["args"][0][1], str(MODULE.TEST_SERVER_SCRIPT))

    def test_post_listen_opposite_mode_is_seen_and_only_new_child_is_terminated(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node.js is required for the spawn contract fixture")
        child = FakeProcess(920, MODULE.TEST_SERVER_SCRIPT)
        opposite = FakeProcess(921, MODULE.SERVER_SCRIPT)
        world = FakeWorld()
        has_spawned = False

        def starter(*args, **kwargs):
            nonlocal has_spawned
            has_spawned = True
            world.processes[child.pid] = child
            return child

        def listener_provider(port):
            if has_spawned and port == 8787:
                world.listeners[8787] = {child.pid}
                # This opposite process appears only after the child listener
                # is observable, exercising the success-return race.
                world.processes[opposite.pid] = opposite
            return world.listener_pids(port)

        with self.assertRaisesRegex(
            RuntimeError,
            r"after source-server listener became ready.*PID 921 mode=production",
        ):
            MODULE.start_source_server(
                8787,
                True,
                listener_pid_provider=listener_provider,
                process_iter_provider=world.process_iter,
                process_starter=starter,
            )
        self.assertTrue(child.terminated)
        self.assertFalse(opposite.terminated)

    def test_post_listen_unexpected_same_mode_is_seen_and_only_new_child_is_terminated(self):
        node = shutil.which("node")
        if not node:
            self.skipTest("Node.js is required for the spawn contract fixture")
        child = FakeProcess(930, MODULE.TEST_SERVER_SCRIPT)
        unexpected = FakeProcess(931, MODULE.TEST_SERVER_SCRIPT)
        world = FakeWorld()
        has_spawned = False

        def starter(*args, **kwargs):
            nonlocal has_spawned
            has_spawned = True
            world.processes[child.pid] = child
            return child

        def listener_provider(port):
            if has_spawned and port == 8787:
                world.listeners[8787] = {child.pid}
                world.processes[unexpected.pid] = unexpected
            return world.listener_pids(port)

        with self.assertRaisesRegex(
            RuntimeError,
            r"after source-server listener became ready.*PID 931 mode=local",
        ):
            MODULE.start_source_server(
                8787,
                True,
                listener_pid_provider=listener_provider,
                process_iter_provider=world.process_iter,
                process_starter=starter,
            )
        self.assertTrue(child.terminated)
        self.assertFalse(unexpected.terminated)


if __name__ == "__main__":
    unittest.main()
