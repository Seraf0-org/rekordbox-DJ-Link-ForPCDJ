#!/usr/bin/env python3
"""Read-only live scan for the Rekordbox 7.2.18 DjMixerUnit instance."""

from __future__ import annotations

import argparse
import ctypes
import struct
from ctypes import wintypes


PROCESS_QUERY_INFORMATION = 0x0400
PROCESS_VM_READ = 0x0010
MEM_COMMIT = 0x1000
PAGE_GUARD = 0x100
PAGE_NOACCESS = 0x01

DJ_MIXER_PRIMARY_VTABLE_RVA = 0x5563D10
DJ_MIXER_CONTROL_VTABLE_RVA = 0x5563598
DJ_MIXER_STATE_VTABLE_RVA = 0x5563750
DJ_MIXER_TIMER_VTABLE_RVA = 0x5563948
AUTO_MIX_CROSSFADER_WRAPPER_VTABLE_RVA = 0x38DB1B8
CHANNEL_FADER_VTABLE_RVA = 0x557EF48
CROSS_FADER_VOLUME_CONTROL_VTABLE_RVA = 0x557F008


class MEMORY_BASIC_INFORMATION(ctypes.Structure):
    _fields_ = [
        ("BaseAddress", ctypes.c_void_p),
        ("AllocationBase", ctypes.c_void_p),
        ("AllocationProtect", wintypes.DWORD),
        ("PartitionId", wintypes.WORD),
        ("RegionSize", ctypes.c_size_t),
        ("State", wintypes.DWORD),
        ("Protect", wintypes.DWORD),
        ("Type", wintypes.DWORD),
    ]


kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)
kernel32.OpenProcess.argtypes = [wintypes.DWORD, wintypes.BOOL, wintypes.DWORD]
kernel32.OpenProcess.restype = wintypes.HANDLE
kernel32.ReadProcessMemory.argtypes = [
    wintypes.HANDLE,
    ctypes.c_void_p,
    ctypes.c_void_p,
    ctypes.c_size_t,
    ctypes.POINTER(ctypes.c_size_t),
]
kernel32.ReadProcessMemory.restype = wintypes.BOOL
kernel32.VirtualQueryEx.argtypes = [
    wintypes.HANDLE,
    ctypes.c_void_p,
    ctypes.POINTER(MEMORY_BASIC_INFORMATION),
    ctypes.c_size_t,
]
kernel32.VirtualQueryEx.restype = ctypes.c_size_t
kernel32.CloseHandle.argtypes = [wintypes.HANDLE]


def read_process(handle, address: int, size: int) -> bytes | None:
    buffer = ctypes.create_string_buffer(size)
    read = ctypes.c_size_t()
    if not kernel32.ReadProcessMemory(
        handle, ctypes.c_void_p(address), buffer, size, ctypes.byref(read)
    ):
        return None
    return buffer.raw[: read.value]


def is_readable(mbi: MEMORY_BASIC_INFORMATION) -> bool:
    if mbi.State != MEM_COMMIT:
        return False
    if mbi.Protect & (PAGE_GUARD | PAGE_NOACCESS):
        return False
    return bool(mbi.Protect & 0xEE)


def unpack_pointer(data: bytes | None, offset: int = 0) -> int:
    if not data or len(data) < offset + 8:
        return 0
    return struct.unpack_from("<Q", data, offset)[0]


def scan_vtable_instances(pid: int, module_base: int, vtable_rva: int):
    """Find live objects by an exact vtable and return key wrapper pointers."""
    handle = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        needle = struct.pack("<Q", module_base + vtable_rva)
        address = 0
        max_address = 0x00007FFFFFFFFFFF
        while address < max_address:
            mbi = MEMORY_BASIC_INFORMATION()
            queried = kernel32.VirtualQueryEx(
                handle, ctypes.c_void_p(address), ctypes.byref(mbi), ctypes.sizeof(mbi)
            )
            if not queried:
                break
            base = int(mbi.BaseAddress or 0)
            size = int(mbi.RegionSize)
            if size <= 0:
                break
            if is_readable(mbi):
                chunk_size = 8 * 1024 * 1024
                chunk_offset = 0
                carry = b""
                while chunk_offset < size:
                    to_read = min(chunk_size, size - chunk_offset)
                    data = read_process(handle, base + chunk_offset, to_read)
                    if data:
                        haystack = carry + data
                        search = 0
                        while True:
                            found = haystack.find(needle, search)
                            if found < 0:
                                break
                            candidate = base + chunk_offset - len(carry) + found
                            wrapper = read_process(handle, candidate, 0x10)
                            inner = unpack_pointer(wrapper, 8)
                            mixer = unpack_pointer(read_process(handle, inner + 0x220, 8)) if inner else 0
                            yield candidate, inner, mixer
                            search = found + 1
                        carry = haystack[-7:]
                    else:
                        carry = b""
                    chunk_offset += to_read
            next_address = base + size
            if next_address <= address:
                break
            address = next_address
    finally:
        kernel32.CloseHandle(handle)


def scan(pid: int, module_base: int):
    handle = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        expected = {
            0x00: module_base + DJ_MIXER_PRIMARY_VTABLE_RVA,
            0x158: module_base + DJ_MIXER_CONTROL_VTABLE_RVA,
            0x160: module_base + DJ_MIXER_STATE_VTABLE_RVA,
            0x180: module_base + DJ_MIXER_TIMER_VTABLE_RVA,
        }
        needle = struct.pack("<Q", expected[0])
        address = 0
        max_address = 0x00007FFFFFFFFFFF
        while address < max_address:
            mbi = MEMORY_BASIC_INFORMATION()
            queried = kernel32.VirtualQueryEx(
                handle, ctypes.c_void_p(address), ctypes.byref(mbi), ctypes.sizeof(mbi)
            )
            if not queried:
                break
            base = int(mbi.BaseAddress or 0)
            size = int(mbi.RegionSize)
            if size <= 0:
                break
            if is_readable(mbi):
                chunk_size = 8 * 1024 * 1024
                chunk_offset = 0
                carry = b""
                while chunk_offset < size:
                    to_read = min(chunk_size, size - chunk_offset)
                    data = read_process(handle, base + chunk_offset, to_read)
                    if data:
                        haystack = carry + data
                        search = 0
                        while True:
                            found = haystack.find(needle, search)
                            if found < 0:
                                break
                            candidate = base + chunk_offset - len(carry) + found
                            block = read_process(handle, candidate, 0x188)
                            if block and len(block) >= 0x188 and all(
                                struct.unpack_from("<Q", block, offset)[0] == value
                                for offset, value in expected.items()
                            ):
                                yield candidate
                            search = found + 1
                        carry = haystack[-7:]
                    else:
                        carry = b""
                    chunk_offset += to_read
            next_address = base + size
            if next_address <= address:
                break
            address = next_address
    finally:
        kernel32.CloseHandle(handle)


def module_references(pid: int, module_base: int, module_size: int, targets: list[int]):
    handle = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        needles = {struct.pack("<Q", target): target for target in targets}
        chunk_size = 8 * 1024 * 1024
        offset = 0
        carry = b""
        while offset < module_size:
            data = read_process(handle, module_base + offset, min(chunk_size, module_size - offset))
            if not data:
                carry = b""
                offset += chunk_size
                continue
            haystack = carry + data
            for needle, target in needles.items():
                search = 0
                while True:
                    found = haystack.find(needle, search)
                    if found < 0:
                        break
                    reference = module_base + offset - len(carry) + found
                    yield target, reference
                    search = found + 1
            carry = haystack[-7:]
            offset += len(data)
    finally:
        kernel32.CloseHandle(handle)


def inspect_mixer_components(pid: int, addresses: list[int]):
    handle = kernel32.OpenProcess(PROCESS_QUERY_INFORMATION | PROCESS_VM_READ, False, pid)
    if not handle:
        raise ctypes.WinError(ctypes.get_last_error())
    try:
        for address in addresses:
            block = read_process(handle, address, 0x48)
            if not block or len(block) < 0x40:
                yield address, None
                continue
            yield address, {
                "mode20": struct.unpack_from("<I", block, 0x20)[0],
                "table28": struct.unpack_from("<Q", block, 0x28)[0],
                "value30": struct.unpack_from("<f", block, 0x30)[0],
                "state38": struct.unpack_from("<Q", block, 0x38)[0],
            }
    finally:
        kernel32.CloseHandle(handle)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("pid", type=int)
    parser.add_argument("module_base", type=lambda value: int(value, 0))
    parser.add_argument("module_size", nargs="?", type=lambda value: int(value, 0))
    args = parser.parse_args()
    matches = list(scan(args.pid, args.module_base))
    print(f"pid={args.pid} module_base=0x{args.module_base:X} matches={len(matches)}")
    for address in matches:
        print(
            f"DjMixerUnit=0x{address:X} IDjMixerControl=0x{address + 0x158:X} "
            f"IDjMixerState=0x{address + 0x160:X}"
        )
    wrappers = list(
        scan_vtable_instances(
            args.pid, args.module_base, AUTO_MIX_CROSSFADER_WRAPPER_VTABLE_RVA
        )
    )
    print(f"AutoMixCrossfaderWrapper matches={len(wrappers)}")
    for address, inner, mixer in wrappers:
        print(
            f"AutoMixCrossfaderWrapper=0x{address:X} inner=0x{inner:X} "
            f"inner+0x220=0x{mixer:X}"
        )
    channel_faders = list(
        scan_vtable_instances(args.pid, args.module_base, CHANNEL_FADER_VTABLE_RVA)
    )
    print(f"ChannelFader matches={len(channel_faders)}")
    for address, detail in inspect_mixer_components(
        args.pid, [item[0] for item in channel_faders]
    ):
        if detail is None:
            print(f"ChannelFader=0x{address:X} unreadable")
        else:
            print(
                f"ChannelFader=0x{address:X} mode20={detail['mode20']} "
                f"table28=0x{detail['table28']:X} value30={detail['value30']:.6f} "
                f"state38=0x{detail['state38']:X}"
            )
    crossfader_volumes = list(
        scan_vtable_instances(
            args.pid, args.module_base, CROSS_FADER_VOLUME_CONTROL_VTABLE_RVA
        )
    )
    print(f"CrossFaderVolumeControl matches={len(crossfader_volumes)}")
    for address, field_08, _ in crossfader_volumes:
        print(f"CrossFaderVolumeControl=0x{address:X} field+0x08=0x{field_08:X}")
    if args.module_size:
        for target, reference in module_references(
            args.pid, args.module_base, args.module_size, matches
        ):
            print(
                f"module_ref_rva=0x{reference - args.module_base:X} "
                f"target=0x{target:X}"
            )
    return 0 if matches or wrappers or channel_faders or crossfader_volumes else 1


if __name__ == "__main__":
    raise SystemExit(main())
