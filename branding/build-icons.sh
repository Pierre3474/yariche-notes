#!/bin/bash
# Génère toutes les icônes depuis les SVG de ce dossier.
# Prérequis : rsvg-convert (brew install librsvg), iconutil (macOS) pour l'.icns.
set -euo pipefail
cd "$(dirname "$0")"
PUBLIC=../client/public
MAC=../macos-app/Resources
mkdir -p "$PUBLIC" "$MAC"

# Web : logo et favicon vectoriels, icônes d'écran d'accueil (iOS, Android, PWA)
cp logo-mark.svg "$PUBLIC/logo.svg"
cp logo-mark.svg "$PUBLIC/favicon.svg"
rsvg-convert -w 180 -h 180 logo-square.svg -o "$PUBLIC/apple-touch-icon.png"
rsvg-convert -w 192 -h 192 logo-square.svg -o "$PUBLIC/icon-192.png"
rsvg-convert -w 512 -h 512 logo-square.svg -o "$PUBLIC/icon-512.png"
rsvg-convert -w 32 -h 32 logo-mark.svg -o "$PUBLIC/favicon-32.png"

# macOS : .icns (toutes les tailles attendues par le Finder et le Dock)
if command -v iconutil >/dev/null; then
  SET=$(mktemp -d)/AppIcon.iconset
  mkdir -p "$SET"
  for size in 16 32 128 256 512; do
    rsvg-convert -w $size -h $size logo-macos.svg -o "$SET/icon_${size}x${size}.png"
    rsvg-convert -w $((size * 2)) -h $((size * 2)) logo-macos.svg -o "$SET/icon_${size}x${size}@2x.png"
  done
  iconutil -c icns "$SET" -o "$MAC/AppIcon.icns"
  rsvg-convert -w 1024 -h 1024 logo-macos.svg -o "$MAC/icon-1024.png"
  rm -rf "$(dirname "$SET")"
fi
echo "Icônes générées."
