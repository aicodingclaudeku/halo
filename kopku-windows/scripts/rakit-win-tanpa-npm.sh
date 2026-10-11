#!/bin/sh
# Merakit KOPKU Desktop untuk Windows x64 TANPA npm/electron-builder/Wine
# (dipakai bila registry npm tidak dapat diakses). Hasil setara `electron-builder --win dir`
# + installer NSIS dari installer/kopku-setup.nsi.
#
# Kebutuhan (path diberikan lewat variabel lingkungan):
#   ELECTRON_ZIP  electron-v44.5.1-win32-x64.zip (rilis resmi GitHub electron/electron; cocokkan SHA256)
#   NODE_MODULES  folder berisi qrcode@1.5.4, dijkstrajs@1.0.3, pngjs@5.0.0 (dependensi produksi)
#   NSISDIR       folder NSIS 3 (berisi Include/, Contrib/, Stubs/, Plugins/) + MAKENSIS (biner makensis)
#   PYTHON        python3 (+ Pillow untuk ikon multi-ukuran)
# Pemakaian: sh scripts/rakit-win-tanpa-npm.sh
#
# 1.0.13: pengaman biner setara `npm run dist:win` dipasang oleh scripts/rakit-asar-fuse.js:
# resources/app.asar (+ integritas per berkas), Electron Fuses dari package.json
# (build.electronFuses), dan resource exe INTEGRITY/ELECTRONASAR (pe_ikon_versi.py).
# TANPA_INTEGRITAS=1 → fuse EnableEmbeddedAsarIntegrityValidation dibiarkan OFF
# (cadangan bila exe menolak jalan karena validasi integritas); fuse lain tetap.
set -e
cd "$(dirname "$0")/.."
VERSI=$(node -p "require('./package.json').version")
# Akhiran nama berkas hasil (mis. LAN-WhatsApp2). Versi aplikasi tetap dari package.json.
AKHIRAN=${AKHIRAN:-LAN}
# Pastikan menu Pengaturan › LAN & WhatsApp terpasang di bundle renderer (idempoten).
node scripts/pasang-menu-lan-wa.js
OUT=dist/win-unpacked
rm -rf "$OUT" && mkdir -p "$OUT"
unzip -q "$ELECTRON_ZIP" -d "$OUT"
rm -f "$OUT/resources/default_app.asar"
APP="dist/app-staging"
rm -rf "$APP" && mkdir -p "$APP"
mkdir -p "$APP/build" "$APP/node_modules"
# Isi aplikasi = build.files di package.json (electron/**, renderer/**, build/icon.png, package.json)
cp -r electron renderer "$APP/"
cp build/icon.png "$APP/build/"
node -e "const p=require('./package.json');const o={};for(const k of ['name','productName','version','description','author','private','main','dependencies'])o[k]=p[k];require('fs').writeFileSync('$APP/package.json',JSON.stringify(o,null,2))"
cp -r "$NODE_MODULES"/qrcode "$NODE_MODULES"/dijkstrajs "$NODE_MODULES"/pngjs "$APP/node_modules/"
mv "$OUT/electron.exe" "$OUT/KOPKU Desktop.exe"
# app.asar + integritas, lalu fuse
node scripts/rakit-asar-fuse.js pak "$APP" "$OUT/resources/app.asar" > dist/integritas-asar.json
rm -rf "$APP"
node -e "const p=require('./package.json');if(process.env.TANPA_INTEGRITAS==='1')p.build.electronFuses.enableEmbeddedAsarIntegrityValidation=false;require('fs').writeFileSync('dist/fuse.json',JSON.stringify(p))"
node scripts/rakit-asar-fuse.js fuse "$OUT/KOPKU Desktop.exe" dist/fuse.json
# Ikon multi-ukuran (16–256 px) dari build/icon.png + info versi exe
$PYTHON -c "from PIL import Image; Image.open('build/icon.png').convert('RGBA').save('dist/icon-multi.ico', sizes=[(16,16),(24,24),(32,32),(48,48),(64,64),(128,128),(256,256)])"
$PYTHON scripts/pe_ikon_versi.py "$OUT/KOPKU Desktop.exe" dist/icon-multi.ico "$VERSI" \
  "{\"CompanyName\":\"KOPKU\",\"FileDescription\":\"KOPKU Desktop — Keuangan Koperasi Simpan Pinjam\",\"ProductName\":\"KOPKU Desktop\",\"InternalName\":\"KOPKU Desktop\",\"OriginalFilename\":\"KOPKU Desktop.exe\",\"LegalCopyright\":\"© KOPKU\",\"FileVersion\":\"$VERSI.0\",\"ProductVersion\":\"$VERSI\"}" dist/integritas-asar.json
if [ "$TANPA_INTEGRITAS" != "1" ]; then node scripts/verifikasi-fuse.js "$OUT/KOPKU Desktop.exe"; fi
# Installer NSIS (skrip installer asli, tidak diubah)
SETUP="KOPKU-Desktop-$VERSI-$AKHIRAN-Setup.exe"
rm -f "dist/$SETUP"
# Kompresi LZMA lewat argumen (skrip .nsi asli tetap zlib & tidak diubah): ±111 MB vs ±156 MB, build ±6 menit.
(cd installer && NSISDIR="$NSISDIR" "$MAKENSIS" -V2 "-XSetCompressor /SOLID /FINAL lzma" "-XSetCompressorDictSize 64" -DOUT="../dist/$SETUP" kopku-setup.nsi)
$PYTHON scripts/verifikasi-installer.py "dist/$SETUP"
# Versi portable (ZIP)
(cd dist && rm -f "KOPKU-Desktop-$VERSI-$AKHIRAN-Windows-x64.zip" && mv win-unpacked "KOPKU Desktop" && zip -qr -9 "KOPKU-Desktop-$VERSI-$AKHIRAN-Windows-x64.zip" "KOPKU Desktop" && mv "KOPKU Desktop" win-unpacked)
echo "Selesai: dist/$SETUP dan dist/KOPKU-Desktop-$VERSI-$AKHIRAN-Windows-x64.zip"
