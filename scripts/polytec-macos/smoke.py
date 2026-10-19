#!/usr/bin/env python3
"""Resolve C exports and roundtrip memory-only payloads; never open device communications."""
import argparse
import ctypes as C
import json
from pathlib import Path
import re


def require(condition, message):
    if not condition:
        raise RuntimeError(message)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--library", required=True, type=Path)
    parser.add_argument("--headers", required=True, type=Path)
    args = parser.parse_args()
    api = C.CDLL(str(args.library.resolve()))
    symbols = []
    for relative in ("IO/DeviceCommunication/PolyDeviceCommunication.h", "IO/DataAcquisition/PolyDataAcquisition.h"):
        symbols.extend(re.findall(r"(?:COMMAPI|DAQAPI)\s+\w+\s+(Poly\w+)\s*\(", (args.headers / relative).read_text()))
    if not symbols:
        raise RuntimeError("No C API declarations found")
    for name in symbols:
        getattr(api, name)
    api.PolyFreePayload.argtypes, api.PolyFreePayload.restype = [C.c_int], None
    api.PolyCreatePayloadFromInt32.argtypes = [C.POINTER(C.c_int32), C.c_size_t]
    api.PolyCreatePayloadFromInt32.restype = C.c_int
    api.PolyGetInt32FromPayload.argtypes = [C.c_int, C.POINTER(C.c_int32), C.POINTER(C.c_size_t), C.c_size_t]
    api.PolyGetInt32FromPayload.restype = C.c_int
    expected = [-2147483648, -1234567, 0, 1234567, 2147483647]
    values = (C.c_int32 * len(expected))(*expected)
    handle = api.PolyCreatePayloadFromInt32(values, len(expected))
    require(handle > 0, "SDK failed to create payload")
    try:
        result, count = (C.c_int32 * len(expected))(), C.c_size_t()
        require(api.PolyGetInt32FromPayload(handle, result, C.byref(count), len(expected)) == 0, "SDK int32 extraction failed")
        require(count.value == len(expected) and list(result) == expected, "SDK int32 payload mismatch")
    finally:
        api.PolyFreePayload(handle)
    api.PolyCreatePayloadFromCStr.argtypes, api.PolyCreatePayloadFromCStr.restype = [C.c_char_p], C.c_int
    api.PolyGetCStrFromPayload.argtypes = [C.c_int, C.POINTER(C.c_char), C.c_size_t]
    api.PolyGetCStrFromPayload.restype = C.c_int
    expected_text = "BladeVMS native arm64 / macOS / 采集".encode()
    handle = api.PolyCreatePayloadFromCStr(expected_text)
    require(handle > 0, "SDK failed to create payload")
    try:
        result = C.create_string_buffer(256)
        require(api.PolyGetCStrFromPayload(handle, result, len(result)) == 0, "SDK UTF-8 extraction failed")
        require(result.value == expected_text, "SDK UTF-8 payload mismatch")
    finally:
        api.PolyFreePayload(handle)
    print(json.dumps({"passed": True, "exportedCApiCount": len(symbols), "hardwareAccessed": False,
                      "tests": ["native load", "all C exports", "int32 boundary roundtrip", "UTF-8 roundtrip"]}, indent=2))


if __name__ == "__main__":
    main()
