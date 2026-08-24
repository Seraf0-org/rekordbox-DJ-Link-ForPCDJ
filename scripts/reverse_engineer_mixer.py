#!/usr/bin/env python3
"""Locate mixer-related strings and their x64 code references in rekordbox.exe."""

from __future__ import annotations

import argparse
import re
import struct
from bisect import bisect_right
from pathlib import Path

import pefile
from capstone import CS_ARCH_X86, CS_MODE_64, Cs


DEFAULT_TERMS = (
    "getCrossfaderValue",
    "getMixerState",
    "IDjMixerState",
    "ChannelFader",
    "CrossFader",
    "setChannelFader",
    "setCrossFader",
)


def section_bytes(pe: pefile.PE, name: bytes) -> tuple[int, bytes]:
    for section in pe.sections:
        if section.Name.rstrip(b"\0") == name:
            return section.VirtualAddress, section.get_data()
    raise RuntimeError(f"PE section not found: {name.decode()}")


def find_strings(image: bytes, image_base: int, term: str):
    needles = (("ascii", term.encode("ascii")), ("utf16", term.encode("utf-16le")))
    for encoding, needle in needles:
        offset = 0
        while True:
            offset = image.find(needle, offset)
            if offset < 0:
                break
            yield encoding, offset, image_base + offset
            offset += len(needle)


def runtime_functions(pe: pefile.PE) -> list[tuple[int, int]]:
    functions = []
    for entry in getattr(pe, "DIRECTORY_ENTRY_EXCEPTION", []):
        begin = int(entry.struct.BeginAddress)
        end = int(entry.struct.EndAddress)
        if begin < end:
            functions.append((begin, end))
    return sorted(set(functions))


def containing_function(functions: list[tuple[int, int]], rva: int):
    starts = [item[0] for item in functions]
    index = bisect_right(starts, rva) - 1
    if index >= 0 and functions[index][0] <= rva < functions[index][1]:
        return functions[index]
    return None


def rip_relative_xrefs(text: bytes, text_rva: int, targets: set[int], image_base: int):
    """Find common RIP-relative LEA/MOV references without decoding all .text."""
    results = []
    for opcode in (0x8D, 0x8B):
        needle = bytes((opcode,))
        offset = 0
        while True:
            offset = text.find(needle, offset)
            if offset < 0:
                break
            if offset + 6 <= len(text):
                modrm = text[offset + 1]
                if modrm & 0xC7 == 0x05:
                    displacement = int.from_bytes(
                        text[offset + 2 : offset + 6], "little", signed=True
                    )
                    target = image_base + text_rva + offset + 6 + displacement
                    if target in targets:
                        start = offset - 1 if offset > 0 and 0x40 <= text[offset - 1] <= 0x4F else offset
                        results.append((image_base + text_rva + start, target))
            offset += 1
    return results


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("exe", type=Path)
    parser.add_argument("terms", nargs="*", default=DEFAULT_TERMS)
    parser.add_argument("--context", type=int, default=18)
    parser.add_argument("--dump-start", type=lambda value: int(value, 0))
    parser.add_argument("--dump-length", type=lambda value: int(value, 0), default=0x800)
    parser.add_argument("--grep-strings")
    parser.add_argument("--disasm-start", type=lambda value: int(value, 0))
    parser.add_argument("--disasm-length", type=lambda value: int(value, 0), default=0x200)
    parser.add_argument("--rtti")
    args = parser.parse_args()

    pe = pefile.PE(str(args.exe), fast_load=False)
    image_base = int(pe.OPTIONAL_HEADER.ImageBase)
    image = pe.get_memory_mapped_image()
    text_rva, text = section_bytes(pe, b".text")
    if args.rtti:
        name = args.rtti.encode("ascii")
        name_offsets = []
        offset = 0
        while True:
            offset = image.find(name, offset)
            if offset < 0:
                break
            name_offsets.append(offset)
            offset += len(name)
        for name_rva in name_offsets:
            type_descriptor_rva = name_rva - 16
            print(
                f"TYPE {args.rtti} name_rva=0x{name_rva:X} "
                f"type_descriptor_rva=0x{type_descriptor_rva:X}"
            )
            type_bytes = struct.pack("<I", type_descriptor_rva)
            search = 0
            while True:
                type_field = image.find(type_bytes, search)
                if type_field < 0:
                    break
                col_rva = type_field - 12
                search = type_field + 1
                if col_rva < 0 or col_rva + 24 > len(image):
                    continue
                signature, object_offset, cd_offset, td_rva, hierarchy_rva, self_rva = struct.unpack_from(
                    "<IIIIII", image, col_rva
                )
                if signature not in (0, 1) or td_rva != type_descriptor_rva:
                    continue
                if signature == 1 and self_rva != col_rva:
                    continue
                print(
                    f"  COL rva=0x{col_rva:X} sig={signature} offset=0x{object_offset:X} "
                    f"cd=0x{cd_offset:X} hierarchy=0x{hierarchy_rva:X}"
                )
                if 0 <= hierarchy_rva <= len(image) - 16:
                    _, hierarchy_attrs, base_count, base_array_rva = struct.unpack_from(
                        "<IIII", image, hierarchy_rva
                    )
                    if (
                        base_count == 0
                        or base_count > 128
                        or base_array_rva > len(image) - base_count * 4
                    ):
                        print(
                            f"    invalid hierarchy bases={base_count} "
                            f"array=0x{base_array_rva:X}"
                        )
                        continue
                    print(
                        f"    hierarchy attrs=0x{hierarchy_attrs:X} bases={base_count} "
                        f"array=0x{base_array_rva:X}"
                    )
                    for base_index in range(min(base_count, 48)):
                        base_rva = struct.unpack_from(
                            "<I", image, base_array_rva + base_index * 4
                        )[0]
                        if base_rva + 28 > len(image):
                            continue
                        base_td, contained, mdisp, pdisp, vdisp, attrs, _ = struct.unpack_from(
                            "<IIiiiII", image, base_rva
                        )
                        name_start = base_td + 16
                        name_end = image.find(b"\0", name_start, min(len(image), name_start + 256))
                        base_name = (
                            image[name_start:name_end].decode("ascii", "replace")
                            if name_end >= 0
                            else "?"
                        )
                        print(
                            f"      base[{base_index:02d}] {base_name} mdisp=0x{mdisp:X} "
                            f"pdisp={pdisp} vdisp={vdisp} attrs=0x{attrs:X} contained={contained}"
                        )
                col_pointer = struct.pack("<Q", image_base + col_rva)
                pointer_search = 0
                while True:
                    col_pointer_rva = image.find(col_pointer, pointer_search)
                    if col_pointer_rva < 0:
                        break
                    pointer_search = col_pointer_rva + 1
                    vtable_rva = col_pointer_rva + 8
                    print(f"    vtable_rva=0x{vtable_rva:X}")
                    for index in range(96):
                        entry_rva = vtable_rva + index * 8
                        if entry_rva + 8 > len(image):
                            break
                        function_va = struct.unpack_from("<Q", image, entry_rva)[0]
                        function_rva = function_va - image_base
                        if text_rva <= function_rva < text_rva + len(text):
                            print(f"      [{index:02d}] function_rva=0x{function_rva:X}")
                        else:
                            break
                    refs = rip_relative_xrefs(
                        text, text_rva, {image_base + vtable_rva}, image_base
                    )
                    for instruction_va, _ in refs:
                        print(f"      code_xref_rva=0x{instruction_va - image_base:X}")
        return 0
    if args.disasm_start is not None:
        start = args.disasm_start
        end = min(len(image), start + args.disasm_length)
        md = Cs(CS_ARCH_X86, CS_MODE_64)
        for insn in md.disasm(image[start:end], image_base + start):
            print(f"{insn.address - image_base:08X}  {insn.mnemonic:<8} {insn.op_str}")
        return 0
    if args.grep_strings:
        pattern = re.compile(args.grep_strings, re.IGNORECASE)
        for match in re.finditer(rb"[ -~]{4,}", image):
            value = match.group().decode("ascii", "replace")
            if pattern.search(value):
                print(f"{match.start():08X}: {value}")
        return 0
    if args.dump_start is not None:
        start = args.dump_start
        end = min(len(image), start + args.dump_length)
        for match in re.finditer(rb"[ -~]{4,}", image[start:end]):
            print(f"{start + match.start():08X}: {match.group().decode('ascii', 'replace')}")
        return 0
    functions = runtime_functions(pe)

    md = Cs(CS_ARCH_X86, CS_MODE_64)
    md.detail = True
    locations: dict[int, list[str]] = {}
    for term in args.terms:
        for encoding, rva, va in find_strings(image, image_base, term):
            locations.setdefault(va, []).append(f"{term} ({encoding}, RVA 0x{rva:X})")

    xrefs_by_target: dict[int, list[int]] = {}
    for instruction_va, target_va in rip_relative_xrefs(
        text, text_rva, set(locations), image_base
    ):
        xrefs_by_target.setdefault(target_va, []).append(instruction_va)

    print(f"image_base=0x{image_base:X} text_rva=0x{text_rva:X} runtime_functions={len(functions)}")
    for string_va, labels in sorted(locations.items()):
        print(f"\nSTRING 0x{string_va:X}: {', '.join(labels)}")
        xrefs = sorted(set(xrefs_by_target.get(string_va, [])))
        if not xrefs:
            print("  no RIP-relative .text references")
            continue

        for instruction_va in xrefs:
            xref_rva = instruction_va - image_base
            function = containing_function(functions, xref_rva)
            function_text = (
                f"RVA 0x{function[0]:X}-0x{function[1]:X}"
                if function
                else "runtime-function unknown"
            )
            print(f"  XREF RVA 0x{xref_rva:X} in {function_text}")
            if function:
                function_bytes = image[function[0] : function[1]]
                function_va = image_base + function[0]
            else:
                window_start = max(text_rva, xref_rva - 96)
                window_end = min(text_rva + len(text), xref_rva + 128)
                function_bytes = image[window_start:window_end]
                function_va = image_base + window_start
            decoded = list(md.disasm(function_bytes, function_va))
            xref_index = next(
                (index for index, nearby in enumerate(decoded) if nearby.address == instruction_va),
                0,
            )
            start = max(0, xref_index - args.context)
            end = min(len(decoded), xref_index + args.context + 1)
            for nearby in decoded[start:end]:
                marker = ">" if nearby.address == instruction_va else " "
                print(
                    f"   {marker} {nearby.address - image_base:08X}  "
                    f"{nearby.mnemonic:<8} {nearby.op_str}"
                )

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
