#!/usr/bin/env python3
"""Verifikasi integritas installer NSIS (CRC yang diperiksa Windows saat Setup dibuka).
Pemakaian: python3 scripts/verifikasi-installer.py dist/KOPKU-Desktop-<versi>-Setup.exe"""
import sys, zlib, struct
d = open(sys.argv[1], 'rb').read()
fh = d.find(b'\xef\xbe\xad\xdeNullsoftInst') - 4
total = struct.unpack('<I', d[fh + 24:fh + 28])[0]
end = fh + total
ok = total > 0 and end == len(d) and (zlib.crc32(d[512:end - 4]) & 0xffffffff) == struct.unpack('<I', d[end - 4:end])[0]
print('INSTALLER UTUH' if ok else 'INSTALLER RUSAK', f'(ukuran {len(d)} B, data {total} B)')
sys.exit(0 if ok else 1)
