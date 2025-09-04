#!/usr/bin/env bash
# generate_custom_branding.sh
# Usage: ./generate_custom_branding.sh /path/to/your-logo.png
# Requires: ImageMagick (magick/convert), file, bash
set -euo pipefail

# ---- input validation ----
if [[ $# -lt 1 ]]; then
  echo "Usage: $0 <custom_branding_path>" >&2
  exit 1
fi

SRC="$1"
if [[ ! -f "$SRC" ]]; then
  echo "❌ File not found: $SRC" >&2
  exit 2
fi

# ---- deps check ----
if command -v magick >/dev/null 2>&1; then
  IM="magick"
elif command -v convert >/dev/null 2>&1; then
  IM="convert"
else
  echo "❌ ImageMagick is required (install 'imagemagick')." >&2
  exit 3
fi

# ---- resolve paths ----
# Output dir defaults to repo/branding (next to run_bot.sh). Overridable via env.
SCRIPT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
OUT_DIR="${BRANDING_OUT_DIR:-"$SCRIPT_DIR/branding"}"
mkdir -p "$OUT_DIR"

TIMESTAMP="$(date -u +%Y%m%dT%H%M%SZ)"

# Standard filenames that the bot/runner can pick up later
OUT_BASE="$OUT_DIR/bot_avatar"
PNG="$OUT_BASE.png"
PNG256="${OUT_BASE}_256.png"
PNG128="${OUT_BASE}_128.png"
PNGCIRCLE="${OUT_BASE}_circle.png"
MANIFEST="$OUT_DIR/branding_manifest.json"

# ---- processing pipeline ----
# 1) Square-crop (cover) + resize to 1024, then downscale
# 2) Export 512, 256, 128 PNG with alpha
# 3) Make circular version (transparent outside the circle)

# Create a squared 1024 canvas first
$IM "$SRC" -auto-orient -strip \
  -resize "1024x1024^" \
  -gravity center -extent 1024x1024 \
  -background none "$PNG"

# Derivatives
$IM "$PNG" -resize 256x256 "$PNG256"
$IM "$PNG" -resize 128x128 "$PNG128"

# Circle mask
MASK="$(mktemp /tmp/brandmask.XXXXXX.png)"
$IM -size 1024x1024 xc:none -fill white -draw "circle 512,512 512,0" "$MASK"
$IM "$PNG" "$MASK" -alpha Off -compose CopyOpacity -composite "$PNGCIRCLE"
rm -f "$MASK"

# Manifest for debugging/consumers
cat >"$MANIFEST" <<JSON
{
  "source": "$(realpath "$SRC" 2>/dev/null || echo "$SRC")",
  "generated_at": "$TIMESTAMP",
  "outputs": {
    "square_512": "$(realpath "$PNG" 2>/dev/null || echo "$PNG")",
    "square_256": "$(realpath "$PNG256" 2>/dev/null || echo "$PNG256")",
    "square_128": "$(realpath "$PNG128" 2>/dev/null || echo "$PNG128")",
    "circle_512": "$(realpath "$PNGCIRCLE" 2>/dev/null || echo "$PNGCIRCLE")"
  }
}
JSON

echo "✅ Branding generated in: $OUT_DIR"
echo " - $PNG"
echo " - $PNG256"
echo " - $PNG128"
echo " - $PNGCIRCLE"
