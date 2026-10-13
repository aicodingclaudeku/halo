#!/bin/sh
# Membangun installer Windows (Setup.exe) TANPA Wine:
#  1) electron-builder --win dir   -> dist/win-unpacked
#  2) ikon & info versi exe (resedit, JS murni) -> scripts/pasang-ikon-exe.mjs
#  3) makensis installer/kopku-setup.nsi        -> dist/KOPKU-Desktop-<versi>-Setup.exe
#  4) verifikasi CRC installer (yang diperiksa Windows saat Setup dibuka)
# Di Windows cukup: npm run dist:win (electron-builder NSIS bawaan).
set -e
cd "$(dirname "$0")/.."
VERSI=$(node -p "require('./package.json').version")
npx electron-builder --win dir --x64
node scripts/pasang-ikon-exe.mjs "dist/win-unpacked/KOPKU Desktop.exe" build/icon.ico
rm -f "dist/KOPKU-Desktop-$VERSI-Setup.exe"
(cd installer && makensis -V2 kopku-setup.nsi)
python3 scripts/verifikasi-installer.py "dist/KOPKU-Desktop-$VERSI-Setup.exe"
