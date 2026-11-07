#!/usr/bin/env bash
# Rebuild every app icon from docs/design/Lagoon App Icon.html (macOS: needs sips, iconutil; ImageMagick for .ico).
set -euo pipefail
cd "$(dirname "$0")/.."
S=build/icon-src
npx electron scripts/render-icon.cjs "$S" 2>/dev/null | grep png
I=$S/Lagoon.iconset
rm -rf "$I"; mkdir -p "$I"
# small master for 16, 16@2x and 32 (no art, thicker cells), full master for the rest — same rule as the Dylan icon
for spec in "16 icon_16x16 small" "32 icon_16x16@2x small" "32 icon_32x32 small" "64 icon_32x32@2x full" "128 icon_128x128 full" \
            "256 icon_128x128@2x full" "256 icon_256x256 full" "512 icon_256x256@2x full" "512 icon_512x512 full" "1024 icon_512x512@2x full"; do
  set -- $spec
  src=$S/icon-1024.png; [ "$3" = small ] && src=$S/icon-small-1024.png
  sips -z "$1" "$1" "$src" --out "$I/$2.png" >/dev/null
done
iconutil -c icns "$I" -o build/icon.icns
cp "$S/icon-1024.png" build/icon.png
sips -z 512 512 "$S/icon-1024.png" --out resources/icon.png >/dev/null
sips -z 256 256 "$S/icon-1024.png" --out src/renderer/src/assets/icon.png >/dev/null
tmp=$(mktemp -d)
for n in 16 24 32; do magick "$S/icon-small-1024.png" -resize ${n}x${n} "$tmp/$n.png"; done
for n in 48 64 128 256; do magick "$S/icon-1024.png" -resize ${n}x${n} "$tmp/$n.png"; done
magick "$tmp/16.png" "$tmp/24.png" "$tmp/32.png" "$tmp/48.png" "$tmp/64.png" "$tmp/128.png" "$tmp/256.png" build/icon.ico
rm -r "$tmp"
echo "icons written: build/icon.icns build/icon.ico build/icon.png resources/icon.png src/renderer/src/assets/icon.png"
