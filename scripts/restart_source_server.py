import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import psutil


PROJECT_ROOT = Path(__file__).resolve().parent.parent
SERVER_SCRIPT = (PROJECT_ROOT / "server" / "index.js").resolve()
TEST_SERVER_SCRIPT = (PROJECT_ROOT / "server" / "rekordbox-local-test-entry.js").resolve()
REKORDBOX_LOCAL_TEST_ARGUMENT = "--rekordbox-local-test"
PRODUCTION_SOURCE_SERVER_MODE = "production"
LOCAL_SOURCE_SERVER_MODE = "local"
# Keep the longer name as the public constant used by the launcher/tests while
# reporting the compact, unambiguous mode value in process-fence diagnostics.
REKORDBOX_LOCAL_TEST_SOURCE_SERVER_MODE = LOCAL_SOURCE_SERVER_MODE
REKORDBOX_LOCAL_TEST_FORBIDDEN_ENV_KEYS = frozenset({
    "DJ_AGENT_CONFIG",
    "DJ_AGENT_ENABLED",
    "DJ_AGENT_ALLOW_REMOTE_ACTIONS",
    "SYNDOCAL_ENABLED",
    "SYNDOCAL_HOST",
    "SYNDOCAL_PORT",
    "SYNDOCAL_PATH",
    "SYNDOCAL_NIC",
    "SYNDOCAL_TOKEN",
    "SYNDOCAL_WS_ADAPTER",
    "SYNDOCAL_HEARTBEAT_MS",
    "PEDAL_ENABLED",
    "PEDAL_MODULE",
    "MIDI_ENABLED",
    "MIDI_MODULE",
    "MIDI_DEVICE",
    "MIDI_PORT",
    "MIDI_RELEASE_FADE",
    "MIDI_RELEASE_MACRO",
    "MIDI_DECK_CHANNELS",
    "DJ_AGENT_CONFIG_PATH",
    "PORT",
    "RB_OUTPUT_HOST",
    "RB_OUTPUT_SETUP_MAPPING_PATH",
    "REKORDBOX_EXE_PATH",
    "HOOK_UDP_ENABLED",
    "HOOK_UDP_PORT",
    "REKORDBOX_POLL_MS",
    "PYTHON_BIN",
    "REKORDBOX_BRIDGE_SCRIPT",
    "REKORDBOX_CONTENT_LOOKUP_SCRIPT",
    "REKORDBOX_DB_PATH",
    "REKORDBOX_DB_DIR",
    "REKORDBOX_DB_KEY",
    "PYTHONPATH",
    "PYTHONHOME",
    "PYTHONIOENCODING",
    "PYTHONUTF8",
    "ABLETON_LINK_ENABLED",
    "ABLETON_LINK_MODULE",
    "ABLETON_LINK_INITIAL_TEMPO",
    "HISTORY_OFFSET_SECONDS",
    "NODE_OPTIONS",
    "RB_OUTPUT_REKORDBOX_LOCAL_TEST_LIVE",
})


def normalized_path(value: str | Path) -> str:
    return os.path.normcase(os.path.realpath(os.fspath(value)))


def configured_port() -> int:
    try:
        port = int(os.environ.get("PORT", "8787"))
    except ValueError as error:
        raise RuntimeError("PORT must be an integer") from error
    if port < 1 or port > 65535:
        raise RuntimeError("PORT must be in the range 1..65535")
    return port


def assert_rekordbox_local_test_environment() -> None:
    inherited = {key.upper() for key in os.environ}
    forbidden = sorted(inherited.intersection(REKORDBOX_LOCAL_TEST_FORBIDDEN_ENV_KEYS))
    if forbidden:
        raise RuntimeError(
            "Rekordbox local test refuses forbidden environment overrides: " + ", ".join(forbidden)
        )


def listener_pids(port: int) -> set[int]:
    owners: set[int] = set()
    for connection in psutil.net_connections(kind="tcp"):
        if connection.status != psutil.CONN_LISTEN or not connection.laddr:
            continue
        if int(connection.laddr.port) == port and connection.pid is not None:
            owners.add(int(connection.pid))
    return owners


def source_server_mode(process: psutil.Process) -> str | None:
    """Return the mode only for one of the three exact source command forms.

    The cwd and script checks deliberately require absolute paths.  Resolving a
    relative argument against cwd would make a different launch spelling look
    owned and would weaken the process fence.
    """
    try:
        if process.name().lower() != "node.exe":
            return None
        cwd_value = process.cwd()
        command = process.cmdline()
    except psutil.NoSuchProcess:
        return None
    except (psutil.AccessDenied, OSError, AttributeError, TypeError) as error:
        pid = getattr(process, "pid", "unknown")
        raise RuntimeError(
            f"cannot inspect source-server candidate PID {pid}; refusing to launch or stop"
        ) from error

    if not isinstance(cwd_value, (str, os.PathLike)) or not os.path.isabs(os.fspath(cwd_value)):
        return None
    cwd = Path(cwd_value)
    if normalized_path(cwd) != normalized_path(PROJECT_ROOT):
        return None

    if not isinstance(command, (list, tuple)) or not command:
        return None
    executable = command[0]
    if not isinstance(executable, (str, os.PathLike)):
        return None
    executable_name = Path(executable).name.lower()
    if executable_name not in {"node", "node.exe"}:
        return None

    # Keep the two-argument guard explicit: the only accepted three-argument
    # form is `node <absolute checkout>\server\index.js --rekordbox-local-test`.
    if len(command) != 2:
        if len(command) != 3 or command[2] != REKORDBOX_LOCAL_TEST_ARGUMENT:
            return None
        script_argument = command[1]
        if not isinstance(script_argument, (str, os.PathLike)):
            return None
        script_argument = Path(script_argument)
        if not script_argument.is_absolute():
            return None
        if normalized_path(script_argument) == normalized_path(SERVER_SCRIPT):
            return LOCAL_SOURCE_SERVER_MODE
        return None

    script_argument = command[1]
    if not isinstance(script_argument, (str, os.PathLike)):
        return None
    script_argument = Path(script_argument)
    if not script_argument.is_absolute():
        return None
    if normalized_path(script_argument) == normalized_path(SERVER_SCRIPT):
        return PRODUCTION_SOURCE_SERVER_MODE
    if normalized_path(script_argument) == normalized_path(TEST_SERVER_SCRIPT):
        return LOCAL_SOURCE_SERVER_MODE
    return None


def is_owned_source_server(process: psutil.Process) -> bool:
    return source_server_mode(process) is not None


def _process_pid(process: psutil.Process) -> int:
    try:
        return int(process.pid)
    except (psutil.AccessDenied, psutil.NoSuchProcess, OSError, TypeError, ValueError) as error:
        raise RuntimeError("cannot read a source-server PID; refusing to launch or stop") from error


def source_server_processes(
    *, process_iter_provider=psutil.process_iter
) -> dict[int, tuple[psutil.Process, str]]:
    """Enumerate exact-checkout source processes across every port/state.

    ``NoSuchProcess`` is the one allowed race: a process that was visible to
    the iterator has clearly disappeared.  AccessDenied is not treated as an
    absent process because doing so could allow an opposite-mode process to be
    left running beside a newly launched server.
    """
    matches: dict[int, tuple[psutil.Process, str]] = {}
    try:
        iterator = process_iter_provider()
        for process in iterator:
            try:
                mode = source_server_mode(process)
                if mode is None:
                    continue
                pid = _process_pid(process)
            except psutil.NoSuchProcess:
                continue
            previous = matches.get(pid)
            if previous is not None and previous[1] != mode:
                raise RuntimeError(
                    f"source process PID {pid} changed mode during enumeration; refusing to launch or stop"
                )
            matches[pid] = (process, mode)
    except psutil.NoSuchProcess:
        # The iterator itself can surface a process disappearing between its
        # snapshot and yield.  It is safe to continue with the remaining view.
        pass
    except (psutil.AccessDenied, OSError, AttributeError, TypeError, ValueError) as error:
        raise RuntimeError(
            "cannot enumerate source-server processes; refusing to launch or stop"
        ) from error
    return dict(sorted(matches.items()))


def _requested_mode(rekordbox_local_test: bool) -> str:
    return LOCAL_SOURCE_SERVER_MODE if rekordbox_local_test else PRODUCTION_SOURCE_SERVER_MODE


def _describe_processes(processes: dict[int, tuple[psutil.Process, str]]) -> str:
    return ", ".join(f"PID {pid} mode={mode}" for pid, (_, mode) in sorted(processes.items()))


def _raise_opposite_mode(
    processes: dict[int, tuple[psutil.Process, str]],
    requested_mode: str,
    *,
    phase: str,
) -> None:
    opposite = {
        pid: value
        for pid, value in processes.items()
        if value[1] != requested_mode
    }
    if not opposite:
        return
    raise RuntimeError(
        f"{phase}: opposite-mode source server present across all ports/launch states "
        f"({_describe_processes(opposite)}); requested mode={requested_mode}. "
        "Stop it explicitly; no source server was terminated."
    )


def _raise_same_mode_not_stoppable(
    processes: dict[int, tuple[psutil.Process, str]],
    requested_mode: str,
    *,
    phase: str,
) -> None:
    same_mode = {
        pid: value
        for pid, value in processes.items()
        if value[1] == requested_mode
    }
    if not same_mode:
        return
    raise RuntimeError(
        f"{phase}: same-mode source server is not eligible for automatic restart "
        f"({_describe_processes(same_mode)}); automatic stop is limited to a same-mode "
        "listener on the requested port. Stop it explicitly, then retry."
    )


def _read_listener_pids(listener_pid_provider, port: int) -> set[int]:
    try:
        raw_owners = listener_pid_provider(port)
        return {int(pid) for pid in raw_owners}
    except psutil.NoSuchProcess:
        return set()
    except (psutil.AccessDenied, OSError, TypeError, ValueError) as error:
        raise RuntimeError(
            f"cannot inspect listeners on port {port}; refusing to launch or stop"
        ) from error


def _read_process(process_provider, pid: int):
    try:
        return process_provider(pid)
    except psutil.NoSuchProcess:
        return None
    except (psutil.AccessDenied, OSError) as error:
        raise RuntimeError(
            f"cannot inspect listener owner PID {pid}; refusing to launch or stop"
        ) from error


def _raise_unexpected_same_mode(
    processes: dict[int, tuple[psutil.Process, str]],
    requested_mode: str,
    spawned_pid: int,
    *,
    phase: str,
) -> None:
    unexpected = {
        pid: value
        for pid, value in processes.items()
        if value[1] == requested_mode and pid != spawned_pid
    }
    if not unexpected:
        return
    raise RuntimeError(
        f"{phase}: unexpected same-mode source server present "
        f"({_describe_processes(unexpected)}); only the just-spawned PID {spawned_pid} "
        "may be managed automatically. Stop it explicitly, then retry."
    )


def _terminate_spawned_process(process) -> None:
    """Stop only the child created by this invocation after a launch failure."""
    try:
        process.terminate()
    except psutil.NoSuchProcess:
        return
    except (psutil.AccessDenied, OSError) as error:
        pid = getattr(process, "pid", "unknown")
        raise RuntimeError(f"cannot stop just-spawned source server PID {pid}") from error
    try:
        process.wait(timeout=5)
    except psutil.NoSuchProcess:
        return
    except subprocess.TimeoutExpired as error:
        pid = getattr(process, "pid", "unknown")
        raise RuntimeError(f"just-spawned source server PID {pid} did not stop") from error
    except (psutil.AccessDenied, OSError) as error:
        pid = getattr(process, "pid", "unknown")
        raise RuntimeError(f"cannot verify stop for just-spawned source server PID {pid}") from error


def stop_owned_listeners(
    port: int,
    rekordbox_local_test: bool = False,
    *,
    listener_pid_provider=listener_pids,
    process_provider=psutil.Process,
    wait_processes=psutil.wait_procs,
    process_iter_provider=psutil.process_iter,
    monotonic_fn=time.monotonic,
    sleep_fn=time.sleep,
) -> None:
    requested_mode = _requested_mode(rekordbox_local_test)
    enumerated = source_server_processes(process_iter_provider=process_iter_provider)
    _raise_opposite_mode(enumerated, requested_mode, phase="before source-server restart")

    owners = _read_listener_pids(listener_pid_provider, port)
    processes = []
    disappeared: set[int] = set()
    for pid in sorted(owners):
        process = _read_process(process_provider, pid)
        if process is None:
            disappeared.add(pid)
            continue
        if not is_owned_source_server(process):
            raise RuntimeError(
                f"port {port} is owned by PID {pid}, not this checkout's source server"
            )
        actual_mode = source_server_mode(process)
        if actual_mode != requested_mode:
            observed = {pid: (process, actual_mode or "unknown")}
            _raise_opposite_mode(observed, requested_mode, phase=f"port {port} listener check")
            raise RuntimeError(f"port {port} has an unclassifiable source-server owner PID {pid}")
        if pid not in enumerated:
            raise RuntimeError(
                f"listener owner PID {pid} was not present in the exact-checkout process "
                "enumeration; refusing automatic termination"
            )
        if enumerated[pid][1] != actual_mode:
            raise RuntimeError(
                f"listener owner PID {pid} changed source-server mode during inspection; "
                "refusing automatic termination"
            )
        processes.append(process)

    same_mode = {
        pid: value
        for pid, value in enumerated.items()
        if value[1] == requested_mode and pid not in disappeared
    }
    stoppable = {_process_pid(process) for process in processes}
    not_stoppable = {pid: value for pid, value in same_mode.items() if pid not in stoppable}
    _raise_same_mode_not_stoppable(
        not_stoppable,
        requested_mode,
        phase=f"port {port} listener check",
    )

    for process in processes:
        try:
            process.terminate()
        except psutil.NoSuchProcess:
            continue
        except (psutil.AccessDenied, OSError) as error:
            pid = getattr(process, "pid", "unknown")
            raise RuntimeError(f"cannot stop same-mode source server PID {pid}") from error
    try:
        _, alive = wait_processes(processes, timeout=10)
    except psutil.NoSuchProcess:
        alive = []
    except (psutil.AccessDenied, OSError) as error:
        raise RuntimeError("cannot verify same-mode source-server shutdown") from error
    if alive:
        pids = ", ".join(str(process.pid) for process in alive)
        raise RuntimeError(f"source server did not stop within 10 seconds (PID {pids})")

    deadline = monotonic_fn() + 5
    while _read_listener_pids(listener_pid_provider, port) and monotonic_fn() < deadline:
        sleep_fn(0.1)
    if _read_listener_pids(listener_pid_provider, port):
        raise RuntimeError(f"port {port} remained busy after the source server stopped")

    remaining = source_server_processes(process_iter_provider=process_iter_provider)
    _raise_opposite_mode(remaining, requested_mode, phase="after same-mode listener stop")
    _raise_same_mode_not_stoppable(remaining, requested_mode, phase="after same-mode listener stop")


def start_source_server(
    port: int,
    rekordbox_local_test: bool = False,
    *,
    listener_pid_provider=listener_pids,
    process_iter_provider=psutil.process_iter,
    process_starter=subprocess.Popen,
    monotonic_fn=time.monotonic,
    sleep_fn=time.sleep,
) -> int:
    requested_mode = _requested_mode(rekordbox_local_test)
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js was not found on PATH")
    node_path = Path(node).resolve()
    if not node_path.is_file():
        raise RuntimeError(f"resolved Node.js path is not a file: {node_path}")

    creation_flags = 0
    if os.name == "nt":
        creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW

    existing_listeners = _read_listener_pids(listener_pid_provider, port)
    if existing_listeners:
        pids = ", ".join(str(pid) for pid in sorted(existing_listeners))
        raise RuntimeError(
            f"port {port} is still occupied by PID(s) {pids}; stop the owner explicitly before launch"
        )

    # This is intentionally the final inspection before spawn.  It closes the
    # window after the eligible same-mode listener was stopped and catches both
    # modes independent of their ports or current listen state.
    before_spawn = source_server_processes(process_iter_provider=process_iter_provider)
    _raise_opposite_mode(before_spawn, requested_mode, phase="immediately before source-server spawn")
    _raise_same_mode_not_stoppable(before_spawn, requested_mode, phase="immediately before source-server spawn")

    process = process_starter(
        [str(node_path), str(TEST_SERVER_SCRIPT if rekordbox_local_test else SERVER_SCRIPT)],
        cwd=str(PROJECT_ROOT),
        env=os.environ.copy(),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        creationflags=creation_flags,
    )

    deadline = monotonic_fn() + 20
    while monotonic_fn() < deadline:
        exit_code = process.poll()
        if exit_code is not None:
            raise RuntimeError(f"source server exited before listening (exit {exit_code})")
        owners = _read_listener_pids(listener_pid_provider, port)
        if process.pid in owners:
            try:
                post_listen = source_server_processes(process_iter_provider=process_iter_provider)
                _raise_opposite_mode(
                    post_listen,
                    requested_mode,
                    phase="after source-server listener became ready",
                )
                _raise_unexpected_same_mode(
                    post_listen,
                    requested_mode,
                    process.pid,
                    phase="after source-server listener became ready",
                )
            except Exception as error:
                try:
                    _terminate_spawned_process(process)
                except Exception as cleanup_error:
                    raise RuntimeError(
                        f"source server launch failed ({error}); "
                        f"PID {getattr(process, 'pid', 'unknown')} cleanup also failed ({cleanup_error})"
                    ) from cleanup_error
                raise
            return process.pid
        unexpected = owners - {process.pid}
        if unexpected:
            try:
                _terminate_spawned_process(process)
            except Exception as error:
                raise RuntimeError("source server could not be stopped after a listener race") from error
            pids = ", ".join(str(pid) for pid in sorted(unexpected))
            raise RuntimeError(f"port {port} was claimed by another process (PID {pids})")
        sleep_fn(0.1)

    try:
        _terminate_spawned_process(process)
    except Exception as error:
        raise RuntimeError("source server failed to listen and could not be stopped") from error
    raise RuntimeError(f"source server did not listen on port {port} within 20 seconds")


def main() -> int:
    try:
        if len(sys.argv) > 1 and sys.argv[1:] != [REKORDBOX_LOCAL_TEST_ARGUMENT]:
            raise RuntimeError(
                f"unsupported restart argument; use no arguments or exactly {REKORDBOX_LOCAL_TEST_ARGUMENT}"
            )
        rekordbox_local_test = sys.argv[1:] == [REKORDBOX_LOCAL_TEST_ARGUMENT]
        if rekordbox_local_test:
            assert_rekordbox_local_test_environment()
            port = 8787
        else:
            port = configured_port()
        stop_owned_listeners(port, rekordbox_local_test)
        pid = start_source_server(port, rekordbox_local_test)
    except Exception as error:
        print(f"[error] {error}", file=sys.stderr, flush=True)
        return 1
    print(f"[ok] source server PID {pid} is listening on port {port}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
