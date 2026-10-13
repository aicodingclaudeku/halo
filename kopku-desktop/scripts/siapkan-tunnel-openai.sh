#!/bin/sh
# KOPKU Desktop 1.0.31 — siapkan penghubung RESMI OpenAI Secure MCP Tunnel (`tunnel-client-runtime`,
# github.com/openai/tunnel-client, Apache-2.0) untuk dibundel bersama aplikasi.
#
# Hasil: vendor/openai-tunnel/<platform>-<arch>/tunnel-client-runtime[.exe] + LICENSE + NOTICE + SUMBER.txt
#        (vendor/ tidak di-commit; scripts/rakit-win-tanpa-npm.sh menyalinnya ke resources/openai-tunnel).
#
# Dua cara (pilih lewat CARA=rilis|sumber):
#   rilis  (disarankan bila github.com/releases dapat diunduh): unduh arsip rilis resmi
#          tunnel-client-runtime-<RILIS>-windows-amd64.zip + SHA256SUMS.txt, cocokkan SHA256, ekstrak.
#   sumber (bawaan; dipakai bila unduhan rilis diblokir): bangun dari kode sumber resmi pada commit
#          yang DIPATOK di bawah, dengan bendera build persis seperti Makefile resmi (flavor=runtime).
set -e
cd "$(dirname "$0")/.."
REPO=https://github.com/openai/tunnel-client
COMMIT=${TUNNEL_CLIENT_COMMIT:-459013c6fc389be6077efc8ebda4a7074f021c66}
CARA=${CARA:-sumber}
TARGET=${TARGET:-"windows/amd64:win32-x64 linux/amd64:linux-x64"}
KERJA=${KERJA:-dist/tunnel-client-src}

if [ "$CARA" = "rilis" ]; then
  : "${RILIS:?isi RILIS=vX.Y.Z (tag rilis resmi)}"
  mkdir -p dist/tunnel-rilis vendor/openai-tunnel/win32-x64
  base="$REPO/releases/download/$RILIS"
  curl -fsSL -o dist/tunnel-rilis/SHA256SUMS.txt "$base/SHA256SUMS.txt"
  zip="tunnel-client-runtime-$RILIS-windows-amd64.zip"
  curl -fsSL -o "dist/tunnel-rilis/$zip" "$base/$zip"
  (cd dist/tunnel-rilis && grep " $zip\$" SHA256SUMS.txt | sha256sum -c -)
  unzip -o -q "dist/tunnel-rilis/$zip" -d dist/tunnel-rilis/x
  cp "$(find dist/tunnel-rilis/x -name 'tunnel-client-runtime.exe' | head -1)" vendor/openai-tunnel/win32-x64/
  echo "rilis resmi $RILIS ($zip, SHA256 cocok dengan SHA256SUMS.txt)" > vendor/openai-tunnel/win32-x64/SUMBER.txt
  exit 0
fi

rm -rf "$KERJA"
git clone -q "$REPO" "$KERJA"
(cd "$KERJA" && git checkout -q "$COMMIT")
GOVER=$(cd "$KERJA" && go env GOVERSION)
SHA=$(cd "$KERJA" && git rev-parse --short HEAD)
LD="-X github.com/openai/tunnel-client/pkg/version.GitSHA=$SHA -X github.com/openai/tunnel-client/pkg/version.GoVersion=$GOVER -X 'github.com/openai/tunnel-client/pkg/version.BuildFlags=-trimpath -buildvcs=false' -X github.com/openai/tunnel-client/pkg/version.Flavor=runtime"
for t in $TARGET; do
  goosarch=${t%%:*}; tujuan=${t##*:}
  goos=${goosarch%%/*}; goarch=${goosarch##*/}
  ext=""; [ "$goos" = "windows" ] && ext=".exe"
  mkdir -p "vendor/openai-tunnel/$tujuan"
  (cd "$KERJA" && CGO_ENABLED=0 GOOS=$goos GOARCH=$goarch go build -trimpath -buildvcs=false -ldflags "$LD" -o "../../vendor/openai-tunnel/$tujuan/tunnel-client-runtime$ext" ./cmd/client-runtime)
  cp "$KERJA/LICENSE" "$KERJA/NOTICE" "vendor/openai-tunnel/$tujuan/"
  echo "dibangun dari $REPO commit $COMMIT ($GOVER, flavor=runtime) — SHA256 $(sha256sum "vendor/openai-tunnel/$tujuan/tunnel-client-runtime$ext" | cut -d' ' -f1)" > "vendor/openai-tunnel/$tujuan/SUMBER.txt"
  cat "vendor/openai-tunnel/$tujuan/SUMBER.txt"
done
