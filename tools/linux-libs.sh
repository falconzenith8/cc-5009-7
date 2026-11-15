#!/usr/bin/env bash
# Fetches the system libraries required by Playwright's Chromium build on a
# bare Debian arm64 container (no sudo, no apt root). Extracts .deb payloads
# into .cache/linux-libs without installing anything. Safe to re-run.
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DEST="$ROOT/.cache/linux-libs"
POOL="$ROOT/.cache/debs"
BASE="https://deb.debian.org/debian/pool/main"

if [ "$(uname -m)" != "aarch64" ]; then
  echo "This helper targets arm64; on other arches install Playwright deps normally (npx playwright install-deps)."
  exit 0
fi

mkdir -p "$POOL" "$DEST"
DEBS=(
  "n/nspr/libnspr4_4.35-1_arm64.deb"
  "n/nss/libnss3_3.87.1-1+deb12u2_arm64.deb"
  "a/atk1.0/libatk1.0-0_2.36.0-2_arm64.deb"
  "d/dbus/libdbus-1-3_1.14.10-1~deb12u1_arm64.deb"
  "libx/libxcomposite/libxcomposite1_0.4.5-1_arm64.deb"
  "libx/libxdamage/libxdamage1_1.1.5-2_arm64.deb"
  "libx/libxfixes/libxfixes3_6.0.0-2_arm64.deb"
  "libx/libxrandr/libxrandr2_1.5.2-2+b1_arm64.deb"
  "libx/libxi/libxi6_1.7.10-1_arm64.deb"
  "m/mesa/libgbm1_22.3.6-1+deb12u2_arm64.deb"
  "libx/libxkbcommon/libxkbcommon0_1.5.0-1_arm64.deb"
  "a/alsa-lib/libasound2_1.2.8-1+b1_arm64.deb"
  "a/at-spi2-core/libatspi2.0-0_2.46.0-5_arm64.deb"
  "libd/libdrm/libdrm2_2.4.114-1+b1_arm64.deb"
  "w/wayland/libwayland-server0_1.23.0-1~bpo12+1_arm64.deb"
)

for rel in "${DEBS[@]}"; do
  name="${rel##*/}"
  if [ ! -f "$POOL/$name" ]; then
    echo "fetch $name"
    curl -fsSL -o "$POOL/$name" "$BASE/$rel"
  fi
  dpkg-deb -x "$POOL/$name" "$DEST"
done
echo "Libraries extracted to $DEST"
