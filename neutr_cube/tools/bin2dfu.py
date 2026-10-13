#!/usr/bin/env python3
"""Wrap a raw firmware .bin into an ST DfuSe .dfu file.

The .dfu file can be flashed with ST DfuSe / STM32CubeProgrammer, or with
dfu-util (dfu-util -a 0 -D file.dfu).

usage: bin2dfu.py input.bin output.dfu [load_address]
"""
import struct
import sys
import zlib

VID = 0x0483  # STMicroelectronics
PID = 0xDF11  # STM32 ROM bootloader in DFU mode


def build_dfu(data: bytes, address: int) -> bytes:
    element = struct.pack('<II', address, len(data)) + data
    target_name = b'ST...'.ljust(255, b'\0')
    target = b'Target' + struct.pack('<BI', 0, 1) + target_name \
        + struct.pack('<II', len(element), 1) + element
    body_len = 11 + len(target)
    prefix = b'DfuSe' + struct.pack('<BIB', 0x01, body_len, 1)
    body = prefix + target
    suffix = struct.pack('<HHHH', 0xFFFF, PID, VID, 0x011A) + b'UFD' + bytes([16])
    crc = ~zlib.crc32(body + suffix) & 0xFFFFFFFF
    return body + suffix + struct.pack('<I', crc)


def main() -> None:
    if len(sys.argv) not in (3, 4):
        sys.exit(__doc__)
    address = int(sys.argv[3], 0) if len(sys.argv) == 4 else 0x08000000
    with open(sys.argv[1], 'rb') as f:
        data = f.read()
    with open(sys.argv[2], 'wb') as f:
        f.write(build_dfu(data, address))


if __name__ == '__main__':
    main()
