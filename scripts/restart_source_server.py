import os
import shutil
import subprocess
import sys
import time
from pathlib import Path

import psutil


PROJECT_ROOT = Path(__file__).resolve().parent.parent
SERVER_SCRIPT = (PROJECT_ROOT / "server" / "index.js").resolve()


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


def listener_pids(port: int) -> set[int]:
    owners: set[int] = set()
    for connection in psutil.net_connections(kind="tcp"):
        if connection.status != psutil.CONN_LISTEN or not connection.laddr:
            continue
        if int(connection.laddr.port) == port and connection.pid is not None:
            owners.add(int(connection.pid))
    return owners


def is_owned_source_server(process: psutil.Process) -> bool:
    try:
        if process.name().lower() != "node.exe":
            return False
        cwd = Path(process.cwd())
        command = process.cmdline()
    except (psutil.AccessDenied, psutil.NoSuchProcess, OSError):
        return False
    if normalized_path(cwd) != normalized_path(PROJECT_ROOT):
        return False
    if len(command) != 2:
        return False
    script_argument = Path(command[1])
    if not script_argument.is_absolute():
        script_argument = cwd / script_argument
    return normalized_path(script_argument) == normalized_path(SERVER_SCRIPT)


def stop_owned_listeners(port: int) -> None:
    owners = listener_pids(port)
    if not owners:
        return
    processes = []
    for pid in sorted(owners):
        try:
            process = psutil.Process(pid)
        except psutil.NoSuchProcess:
            continue
        if not is_owned_source_server(process):
            raise RuntimeError(
                f"port {port} is owned by PID {pid}, not this checkout's source server"
            )
        processes.append(process)

    for process in processes:
        process.terminate()
    _, alive = psutil.wait_procs(processes, timeout=10)
    if alive:
        pids = ", ".join(str(process.pid) for process in alive)
        raise RuntimeError(f"source server did not stop within 10 seconds (PID {pids})")

    deadline = time.monotonic() + 5
    while listener_pids(port) and time.monotonic() < deadline:
        time.sleep(0.1)
    if listener_pids(port):
        raise RuntimeError(f"port {port} remained busy after the source server stopped")


def start_source_server(port: int) -> int:
    node = shutil.which("node")
    if not node:
        raise RuntimeError("Node.js was not found on PATH")
    node_path = Path(node).resolve()
    if not node_path.is_file():
        raise RuntimeError(f"resolved Node.js path is not a file: {node_path}")

    creation_flags = 0
    if os.name == "nt":
        creation_flags = subprocess.CREATE_NEW_PROCESS_GROUP | subprocess.CREATE_NO_WINDOW
    process = subprocess.Popen(
        [str(node_path), str(SERVER_SCRIPT)],
        cwd=str(PROJECT_ROOT),
        env=os.environ.copy(),
        stdin=subprocess.DEVNULL,
        stdout=subprocess.DEVNULL,
        stderr=subprocess.DEVNULL,
        close_fds=True,
        creationflags=creation_flags,
    )

    deadline = time.monotonic() + 20
    while time.monotonic() < deadline:
        exit_code = process.poll()
        if exit_code is not None:
            raise RuntimeError(f"source server exited before listening (exit {exit_code})")
        owners = listener_pids(port)
        if process.pid in owners:
            return process.pid
        unexpected = owners - {process.pid}
        if unexpected:
            process.terminate()
            process.wait(timeout=5)
            pids = ", ".join(str(pid) for pid in sorted(unexpected))
            raise RuntimeError(f"port {port} was claimed by another process (PID {pids})")
        time.sleep(0.1)

    process.terminate()
    process.wait(timeout=5)
    raise RuntimeError(f"source server did not listen on port {port} within 20 seconds")


def main() -> int:
    try:
        port = configured_port()
        stop_owned_listeners(port)
        pid = start_source_server(port)
    except Exception as error:
        print(f"[error] {error}", file=sys.stderr, flush=True)
        return 1
    print(f"[ok] source server PID {pid} is listening on port {port}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
