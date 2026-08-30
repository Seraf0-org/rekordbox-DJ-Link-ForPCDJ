import argparse
import ctypes
import math
import os
import re
import subprocess
import sys
import time
from pathlib import Path

import psutil


PROCESS_PERMS = (
    0x0002  # PROCESS_CREATE_THREAD
    | 0x0008  # PROCESS_VM_OPERATION
    | 0x0010  # PROCESS_VM_READ
    | 0x0020  # PROCESS_VM_WRITE
    | 0x0400  # PROCESS_QUERY_INFORMATION
)

MEM_COMMIT = 0x1000
MEM_RESERVE = 0x2000
PAGE_READWRITE = 0x04
INFINITE = 0xFFFFFFFF
SUPPORTED_REKORDBOX_VERSIONS = {(7, 2, 13), (7, 2, 14), (7, 2, 18)}
LAUNCH_SETTLE_SECONDS = 15
PROCESS_IDENTITY_POLL_SECONDS = 0.5
WINDOWS_EPOCH_SECONDS = 11_644_473_600
PROCESS_CREATION_TIME_TOLERANCE_TICKS = 100


def _norm_path(value: str) -> str:
    return str(Path(value).resolve()).lower()


def list_pids(
    process_name: str,
    preferred_exe: str | None = None,
    launched_after: float | None = None,
) -> list[int]:
    needle = process_name.lower()
    preferred_exe_norm = _norm_path(preferred_exe) if preferred_exe else None
    candidates: list[tuple[int, float, float]] = []

    for proc in psutil.process_iter(["pid", "name", "exe", "create_time", "memory_info"]):
        try:
            name = (proc.info.get("name") or "").lower()
            if name != needle:
                continue

            exe_path = proc.info.get("exe") or ""
            if preferred_exe_norm:
                if not exe_path or _norm_path(exe_path) != preferred_exe_norm:
                    continue

            created = float(proc.info.get("create_time") or 0.0)
            if launched_after is not None and created + 1.0 < launched_after:
                continue

            mem = proc.info.get("memory_info")
            rss = float(getattr(mem, "rss", 0.0))
            candidates.append((int(proc.info["pid"]), rss, created))
        except (psutil.NoSuchProcess, psutil.AccessDenied):
            continue

    if not candidates:
        return []

    # Prefer the main process (usually largest RSS), tie-break by newest.
    candidates.sort(key=lambda item: (item[1], item[2]), reverse=True)
    return [item[0] for item in candidates]


def find_pid(
    process_name: str,
    preferred_exe: str | None = None,
    launched_after: float | None = None,
) -> int | None:
    pids = list_pids(process_name, preferred_exe=preferred_exe, launched_after=launched_after)
    return pids[0] if pids else None


def launch_rekordbox(exe_path: str) -> subprocess.Popen:
    return subprocess.Popen([exe_path], stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)


def read_process_identity(pid: int) -> tuple[str, str, float] | None:
    """Read the immutable identity fields needed for a launched process fence."""
    try:
        process = psutil.Process(pid)
        if not process.is_running():
            return None
        name = process.name() or ""
        executable = process.exe() or ""
        create_time = float(process.create_time())
        if not name or not executable or not math.isfinite(create_time):
            return None
        executable_norm = _norm_path(executable)
    except (psutil.NoSuchProcess, psutil.AccessDenied, psutil.ZombieProcess, OSError, ValueError, RuntimeError):
        return None
    return name.lower(), executable_norm, create_time


def process_identity_mismatch(
    pid: int,
    expected_name: str,
    expected_executable: str,
    expected_create_time: float,
) -> str | None:
    observed = read_process_identity(pid)
    if observed is None:
        return f"PID {pid} exited or its process identity could not be queried"

    expected_name_norm = expected_name.lower()
    if observed[0] != expected_name_norm:
        return f"PID {pid} process name changed while waiting for injection"

    expected_executable_norm = _norm_path(expected_executable)
    if observed[1] != expected_executable_norm:
        return f"PID {pid} executable path changed while waiting for injection"

    if observed[2] != expected_create_time:
        return f"PID {pid} was replaced or its create time changed while waiting for injection"
    return None


def wait_for_launched_identity(
    launched_process: subprocess.Popen,
    process_name: str,
    launch_path: str,
    wait_deadline: float,
) -> tuple[tuple[str, str, float] | None, str | None]:
    """Wait on the exact Popen PID until its immutable identity is readable."""
    pid = int(launched_process.pid)
    while True:
        now = time.monotonic()
        if now >= wait_deadline:
            return None, "launch wait deadline expired before Rekordbox identity became readable"

        identity = read_process_identity(pid)
        try:
            if launched_process.poll() is not None:
                return None, f"launched Rekordbox PID {pid} exited before injection"
        except OSError:
            return None, f"launched Rekordbox PID {pid} state could not be queried"

        if identity is not None:
            mismatch = process_identity_mismatch(
                pid,
                process_name,
                launch_path,
                identity[2],
            )
            if mismatch:
                return None, mismatch
            return identity, None

        now = time.monotonic()
        if now >= wait_deadline:
            return None, "launch wait deadline expired before Rekordbox identity became readable"
        time.sleep(min(PROCESS_IDENTITY_POLL_SECONDS, wait_deadline - now))


def settle_launched_process(
    pid: int,
    identity: tuple[str, str, float],
    wait_deadline: float,
    settle_seconds: int,
) -> str | None:
    """Require one exact launched process to remain stable before injection."""
    settle_started = time.monotonic()
    settle_deadline = settle_started + settle_seconds
    if settle_deadline >= wait_deadline:
        return "fixed Rekordbox settle interval does not fit within the launch wait deadline"

    expected_name, expected_executable, expected_create_time = identity
    while True:
        now = time.monotonic()
        if now >= wait_deadline:
            return "launch wait deadline expired before Rekordbox became injection-ready"

        mismatch = process_identity_mismatch(
            pid,
            expected_name,
            expected_executable,
            expected_create_time,
        )
        if mismatch:
            return mismatch

        now = time.monotonic()
        if now >= wait_deadline:
            return "launch wait deadline expired before Rekordbox became injection-ready"
        if now >= settle_deadline:
            return None

        sleep_seconds = min(
            PROCESS_IDENTITY_POLL_SECONDS,
            settle_deadline - now,
            wait_deadline - now,
        )
        if sleep_seconds <= 0:
            return "launch wait deadline expired before Rekordbox became injection-ready"
        time.sleep(sleep_seconds)


def verify_open_process_identity(
    kernel32,
    process_handle,
    expected_identity: tuple[str, str, float],
) -> None:
    """Close the final PID-reuse window using identity data from the opened handle."""
    expected_name, expected_executable, expected_create_time = expected_identity
    query_image_path = kernel32.QueryFullProcessImageNameW
    query_image_path.argtypes = [
        ctypes.c_void_p,
        ctypes.c_ulong,
        ctypes.c_wchar_p,
        ctypes.POINTER(ctypes.c_ulong),
    ]
    query_image_path.restype = ctypes.c_int
    image_buffer = ctypes.create_unicode_buffer(32768)
    image_length = ctypes.c_ulong(len(image_buffer))
    if not query_image_path(
        process_handle,
        0,
        image_buffer,
        ctypes.byref(image_length),
    ):
        raise RuntimeError(f"PID image path could not be queried immediately before injection")
    if _norm_path(image_buffer.value[: image_length.value]) != expected_executable:
        raise RuntimeError(f"PID {expected_name} executable path changed immediately before injection")

    class FileTime(ctypes.Structure):
        _fields_ = [
            ("dwLowDateTime", ctypes.c_ulong),
            ("dwHighDateTime", ctypes.c_ulong),
        ]

    get_process_times = kernel32.GetProcessTimes
    get_process_times.argtypes = [
        ctypes.c_void_p,
        ctypes.POINTER(FileTime),
        ctypes.POINTER(FileTime),
        ctypes.POINTER(FileTime),
        ctypes.POINTER(FileTime),
    ]
    get_process_times.restype = ctypes.c_int
    creation_time = FileTime()
    exit_time = FileTime()
    kernel_time = FileTime()
    user_time = FileTime()
    if not get_process_times(
        process_handle,
        ctypes.byref(creation_time),
        ctypes.byref(exit_time),
        ctypes.byref(kernel_time),
        ctypes.byref(user_time),
    ):
        raise RuntimeError("PID creation time could not be queried immediately before injection")

    actual_ticks = (int(creation_time.dwHighDateTime) << 32) | int(creation_time.dwLowDateTime)
    expected_ticks = int(round((expected_create_time + WINDOWS_EPOCH_SECONDS) * 10_000_000))
    if abs(actual_ticks - expected_ticks) > PROCESS_CREATION_TIME_TOLERANCE_TICKS:
        raise RuntimeError(f"PID was replaced immediately before injection")


def installed_supported_rekordbox() -> list[tuple[tuple[int, int, int], Path]]:
    install_root = Path(os.environ.get("ProgramFiles", r"C:\Program Files")) / "rekordbox"
    candidates: list[tuple[tuple[int, int, int], Path]] = []
    try:
        entries = list(install_root.iterdir())
    except OSError:
        return []

    for entry in entries:
        match = re.fullmatch(r"rekordbox\s+(\d+)\.(\d+)\.(\d+)", entry.name, re.IGNORECASE)
        if not match or not entry.is_dir():
            continue
        version = tuple(int(value) for value in match.groups())
        if version not in SUPPORTED_REKORDBOX_VERSIONS:
            continue
        executable = entry / "rekordbox.exe"
        if executable.is_file():
            candidates.append((version, executable.resolve()))

    if not candidates:
        return []
    candidates.sort(key=lambda item: item[0], reverse=True)
    return candidates


def find_latest_supported_rekordbox() -> str:
    candidates = installed_supported_rekordbox()
    return str(candidates[0][1]) if candidates else ""


def supported_explicit_launch_path(value: str) -> str:
    candidate = Path(value).resolve()
    if not candidate.is_file():
        return ""
    candidate_norm = _norm_path(str(candidate))
    for _, installed in installed_supported_rekordbox():
        if _norm_path(str(installed)) == candidate_norm:
            return str(installed)
    return ""


def find_running_supported_rekordbox(process_name: str) -> tuple[int | None, str]:
    for _, executable in installed_supported_rekordbox():
        executable_text = str(executable)
        pid = find_pid(process_name, preferred_exe=executable_text)
        if pid is not None:
            return pid, executable_text
    return None, ""


def inject_dll(
    pid: int,
    dll_path: Path,
    expected_identity: tuple[str, str, float] | None = None,
) -> int:
    kernel32 = ctypes.windll.kernel32
    kernel32.OpenProcess.argtypes = [ctypes.c_ulong, ctypes.c_int, ctypes.c_ulong]
    kernel32.OpenProcess.restype = ctypes.c_void_p
    kernel32.VirtualAllocEx.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_size_t,
        ctypes.c_ulong,
        ctypes.c_ulong,
    ]
    kernel32.VirtualAllocEx.restype = ctypes.c_void_p
    kernel32.WriteProcessMemory.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_size_t,
        ctypes.POINTER(ctypes.c_size_t),
    ]
    kernel32.WriteProcessMemory.restype = ctypes.c_int
    kernel32.GetModuleHandleW.argtypes = [ctypes.c_wchar_p]
    kernel32.GetModuleHandleW.restype = ctypes.c_void_p
    kernel32.GetProcAddress.argtypes = [ctypes.c_void_p, ctypes.c_char_p]
    kernel32.GetProcAddress.restype = ctypes.c_void_p
    kernel32.CreateRemoteThread.argtypes = [
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_size_t,
        ctypes.c_void_p,
        ctypes.c_void_p,
        ctypes.c_ulong,
        ctypes.POINTER(ctypes.c_ulong),
    ]
    kernel32.CreateRemoteThread.restype = ctypes.c_void_p
    kernel32.WaitForSingleObject.argtypes = [ctypes.c_void_p, ctypes.c_ulong]
    kernel32.WaitForSingleObject.restype = ctypes.c_ulong
    kernel32.GetExitCodeThread.argtypes = [ctypes.c_void_p, ctypes.POINTER(ctypes.c_ulong)]
    kernel32.GetExitCodeThread.restype = ctypes.c_int
    kernel32.CloseHandle.argtypes = [ctypes.c_void_p]
    kernel32.CloseHandle.restype = ctypes.c_int

    process = kernel32.OpenProcess(PROCESS_PERMS, False, pid)
    if not process:
        raise RuntimeError(f"OpenProcess failed for PID {pid}")

    dll_w = str(dll_path)
    dll_buf = ctypes.create_unicode_buffer(dll_w)
    dll_size = ctypes.sizeof(dll_buf)

    if expected_identity is not None:
        try:
            verify_open_process_identity(kernel32, process, expected_identity)
        except RuntimeError:
            kernel32.CloseHandle(process)
            raise

    remote_mem = kernel32.VirtualAllocEx(
        process, None, dll_size, MEM_COMMIT | MEM_RESERVE, PAGE_READWRITE
    )
    if not remote_mem:
        kernel32.CloseHandle(process)
        raise RuntimeError("VirtualAllocEx failed")

    written = ctypes.c_size_t(0)
    ok = kernel32.WriteProcessMemory(
        process, remote_mem, ctypes.byref(dll_buf), dll_size, ctypes.byref(written)
    )
    if not ok or written.value != dll_size:
        kernel32.CloseHandle(process)
        raise RuntimeError("WriteProcessMemory failed")

    load_library = kernel32.GetProcAddress(kernel32.GetModuleHandleW("kernel32.dll"), b"LoadLibraryW")
    if not load_library:
        kernel32.CloseHandle(process)
        raise RuntimeError("GetProcAddress(LoadLibraryW) failed")

    thread_id = ctypes.c_ulong(0)
    remote_thread = kernel32.CreateRemoteThread(
        process,
        None,
        0,
        load_library,
        remote_mem,
        0,
        ctypes.byref(thread_id),
    )
    if not remote_thread:
        kernel32.CloseHandle(process)
        raise RuntimeError("CreateRemoteThread failed")

    kernel32.WaitForSingleObject(remote_thread, INFINITE)

    exit_code = ctypes.c_ulong(0)
    kernel32.GetExitCodeThread(remote_thread, ctypes.byref(exit_code))
    kernel32.CloseHandle(remote_thread)
    kernel32.CloseHandle(process)
    return int(exit_code.value)


def main() -> int:
    if getattr(sys, "frozen", False):
        default_dll = (Path(sys.executable).parent / "native" / "bin" / "rb_hook.dll").resolve()
    else:
        default_dll = (Path(__file__).resolve().parent.parent / "native" / "bin" / "rb_hook.dll").resolve()
    parser = argparse.ArgumentParser(description="Inject rb_hook.dll into rekordbox.exe")
    parser.add_argument(
        "--dll-path",
        default=str(default_dll),
        help="Path to rb_hook.dll",
    )
    parser.add_argument("--process-name", default="rekordbox.exe", help="Target process name")
    parser.add_argument("--launch-path", default="", help="Optional rekordbox.exe path to launch")
    parser.add_argument(
        "--launch-installed",
        action="store_true",
        help="Launch the newest installed supported Rekordbox when no process is running",
    )
    parser.add_argument("--wait-seconds", type=int, default=20, help="Wait for process after launch")
    parser.add_argument(
        "--launch-settle-seconds",
        type=int,
        default=LAUNCH_SETTLE_SECONDS,
        help=f"Fixed settle interval for a process launched by this invocation (must be {LAUNCH_SETTLE_SECONDS})",
    )
    parser.add_argument(
        "--handoff-seconds",
        type=int,
        default=0,
        help="Optional seconds to watch for a launcher handoff (disabled by default)",
    )
    args = parser.parse_args()
    if args.launch_path and args.launch_installed:
        parser.error("--launch-path and --launch-installed are mutually exclusive")
    if args.launch_settle_seconds != LAUNCH_SETTLE_SECONDS:
        parser.error(
            f"--launch-settle-seconds is fixed at {LAUNCH_SETTLE_SECONDS}; "
            "the launched-process readiness fence is not operator-adjustable"
        )
    if os.environ.get("REKORDBOX_EXE_PATH", "").strip():
        print(
            "[error] REKORDBOX_EXE_PATH is retired; remove it and use a validated --launch-path",
            flush=True,
        )
        return 1

    dll_path = Path(args.dll_path).resolve()
    if not dll_path.exists():
        print(f"[error] DLL not found: {dll_path}")
        return 1

    launched_after = None
    launched_identity = None
    launched_wait_deadline = None
    pid = None
    launch_path = ""
    if args.launch_installed:
        pid, launch_path = find_running_supported_rekordbox(args.process_name)
        if pid is None:
            if find_pid(args.process_name) is not None:
                print(
                    "[error] an unsupported or differently installed Rekordbox process is running; "
                    "refusing automatic injection",
                    flush=True,
                )
                return 1
            launch_path = find_latest_supported_rekordbox()
            if not launch_path:
                print("[error] no supported Rekordbox installation was found", flush=True)
                return 1
    elif args.launch_path:
        launch_path = supported_explicit_launch_path(args.launch_path)
        if not launch_path:
            print(
                "[error] --launch-path must exactly match a discovered supported Rekordbox installation",
                flush=True,
            )
            return 1
        pid = find_pid(args.process_name, preferred_exe=launch_path)
    else:
        pid, launch_path = find_running_supported_rekordbox(args.process_name)
        if pid is None:
            print(
                "[error] no running supported Rekordbox process was found; use a validated --launch-path",
                flush=True,
            )
            return 1

    if pid is None and launch_path:
        launched_after = time.time()
        launch_started = time.monotonic()
        print(f"[info] launching {launch_path}", flush=True)
        try:
            launched_process = launch_rekordbox(launch_path)
        except OSError as error:
            print(f"[error] failed to launch Rekordbox: {error}", flush=True)
            return 1

        pid = int(launched_process.pid)
        launched_wait_deadline = launch_started + max(1, args.wait_seconds)
        launched_identity, identity_error = wait_for_launched_identity(
            launched_process,
            args.process_name,
            launch_path,
            launched_wait_deadline,
        )
        if identity_error or launched_identity is None:
            print(f"[error] {identity_error}; refusing injection", flush=True)
            return 1

        settle_error = settle_launched_process(
            pid,
            launched_identity,
            launched_wait_deadline,
            args.launch_settle_seconds,
        )
        if settle_error:
            print(f"[error] {settle_error}; refusing injection", flush=True)
            return 1

        # Revalidate immediately before the remote-thread operation. No scan
        # or replacement PID fallback is allowed after the exact Popen PID is
        # admitted.
        mismatch = process_identity_mismatch(
            pid,
            launched_identity[0],
            launched_identity[1],
            launched_identity[2],
        )
        if mismatch:
            print(f"[error] {mismatch}; refusing injection", flush=True)
            return 1

    if pid is None:
        print(f"[error] process not found: {args.process_name}")
        return 1

    print(f"[info] injecting {dll_path} into PID {pid}", flush=True)
    try:
        if launched_identity is None:
            module_handle = inject_dll(pid, dll_path)
        else:
            module_handle = inject_dll(pid, dll_path, launched_identity)
    except (OSError, RuntimeError) as error:
        print(f"[error] injection failed for PID {pid}: {error}", flush=True)
        return 1
    if not module_handle:
        print(f"[error] LoadLibraryW returned NULL - DLL load failed (antivirus or missing dependency?)", flush=True)
        return 1
    print(f"[ok] remote module handle: 0x{module_handle:016X}", flush=True)

    # rekordbox can hand off from a launcher PID to the main UI PID.
    handoff_seconds = max(0, int(args.handoff_seconds))
    if handoff_seconds > 0:
        watched_pid = pid
        injected_pids = {pid}
        deadline = time.time() + handoff_seconds
        while time.time() < deadline:
            if psutil.pid_exists(watched_pid):
                time.sleep(1.0)
                continue

            replacement_pids = list_pids(
                args.process_name,
                preferred_exe=launch_path or None,
                launched_after=launched_after,
            )
            replacement = next((p for p in replacement_pids if p not in injected_pids), None)
            if replacement is None:
                time.sleep(1.0)
                continue

            print(f"[info] handoff detected, reinjecting into PID {replacement}", flush=True)
            module_handle = inject_dll(replacement, dll_path)
            print(f"[ok] remote module handle: 0x{module_handle:016X}", flush=True)
            injected_pids.add(replacement)
            watched_pid = replacement
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
