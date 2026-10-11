#!/bin/bash
# Compile Yariche.app. Par défaut l'app est installée dans /Applications (remplace
# l'ancienne version) : une seule app Yariche sur le Mac.
#   ./build-app.sh                compile + installe dans /Applications
#   ./build-app.sh --no-install   compile seulement (build.noindex/Yariche.app)
#   YARICHE_SERVER_URL=https://notes.exemple.fr ./build-app.sh   adresse par défaut
set -euo pipefail
cd "$(dirname "$0")"

APP_NAME="Yariche"
BIN_NAME="MdCollab"
# Dossier de compilation (vidé après installation : une seule app sur le Mac)
BUILD_DIR="build.noindex"
OUT="$BUILD_DIR/$APP_NAME.app"
INSTALL_DIR="/Applications"

swift build -c release

rm -rf "$OUT"
mkdir -p "$OUT/Contents/MacOS" "$OUT/Contents/Resources"
cp ".build/release/$BIN_NAME" "$OUT/Contents/MacOS/$BIN_NAME"
cp Info.plist "$OUT/Contents/Info.plist"
cp Resources/AppIcon.icns "$OUT/Contents/Resources/AppIcon.icns"
# Adresse du serveur proposée par défaut (sinon demandée au premier lancement) :
#   YARICHE_SERVER_URL=https://notes.exemple.fr ./build-app.sh
# Sans elle, on garde celle de l'app déjà installée : une recompilation ne doit pas faire
# retomber l'app sur http://localhost:5174
INSTALLED_PLIST="$INSTALL_DIR/$APP_NAME.app/Contents/Info.plist"
if [ -z "${YARICHE_SERVER_URL:-}" ] && [ -f "$INSTALLED_PLIST" ]; then
  YARICHE_SERVER_URL=$(/usr/libexec/PlistBuddy -c "Print :YaricheServerURL" "$INSTALLED_PLIST" 2>/dev/null || true)
fi
if [ -n "${YARICHE_SERVER_URL:-}" ]; then
  plutil -insert YaricheServerURL -string "$YARICHE_SERVER_URL" "$OUT/Contents/Info.plist"
  echo "Adresse du serveur par défaut : $YARICHE_SERVER_URL"
fi
# Mode local (serveur dans l'app, sur un dossier du Mac) : Node.js officiel (somme SHA-256
# vérifiée contre la liste de nodejs.org) + le serveur Yariche et ses dépendances de
# production. YARICHE_LOCAL=0 : app sans mode local (bien plus légère).
if [ "${YARICHE_LOCAL:-1}" != "0" ]; then
  case "$(uname -m)" in x86_64) NODE_ARCH=x64 ;; *) NODE_ARCH=arm64 ;; esac
  NODE_VERSION=${NODE_VERSION:-$(curl -fsSL https://nodejs.org/dist/index.json | python3 -c 'import json,sys; print(next(r["version"] for r in json.load(sys.stdin) if r.get("lts")))')}
  CACHE=".cache"
  NODE_DIR="node-$NODE_VERSION-darwin-$NODE_ARCH"
  mkdir -p "$CACHE"
  if [ ! -x "$CACHE/$NODE_DIR/bin/node" ]; then
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/$NODE_DIR.tar.gz" -o "$CACHE/$NODE_DIR.tar.gz"
    curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/SHASUMS256.txt" -o "$CACHE/SHASUMS256-$NODE_VERSION.txt"
    EXPECTED=$(awk -v f="$NODE_DIR.tar.gz" '$2 == f { print $1 }' "$CACHE/SHASUMS256-$NODE_VERSION.txt")
    ACTUAL=$(shasum -a 256 "$CACHE/$NODE_DIR.tar.gz" | cut -d' ' -f1)
    if [ -z "$EXPECTED" ] || [ "$EXPECTED" != "$ACTUAL" ]; then
      echo "Node.js $NODE_VERSION : somme de contrôle invalide" >&2
      rm -f "$CACHE/$NODE_DIR.tar.gz"
      exit 1
    fi
    tar -xzf "$CACHE/$NODE_DIR.tar.gz" -C "$CACHE" "$NODE_DIR/bin/node" "$NODE_DIR/LICENSE"
    rm -f "$CACHE/$NODE_DIR.tar.gz"
  fi
  mkdir -p "$OUT/Contents/Resources/node/bin"
  cp "$CACHE/$NODE_DIR/bin/node" "$OUT/Contents/Resources/node/bin/node"
  cp "$CACHE/$NODE_DIR/LICENSE" "$OUT/Contents/Resources/node/LICENSE"

  # Serveur : code, client compilé, dépendances de production (sans scripts d'installation)
  STAGE="$BUILD_DIR/server-app"
  rm -rf "$STAGE"
  mkdir -p "$STAGE/dist"
  (cd .. && npx vite build >/dev/null)
  cp -R ../server ../package.json ../package-lock.json "$STAGE/"
  cp -R ../dist/client "$STAGE/dist/client"
  (cd "$STAGE" && npm ci --omit=dev --ignore-scripts --no-audit --no-fund >/dev/null 2>&1)
  mv "$STAGE" "$OUT/Contents/Resources/server-app"
  echo "Mode local : Node.js $NODE_VERSION ($NODE_ARCH) et serveur embarqués"
fi

# Signature ad hoc : évite l'avertissement « app endommagée » au premier lancement
codesign --force --deep --sign - "$OUT" >/dev/null 2>&1 || true

LSREGISTER=/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister
# Anciennes compilations rangées à côté du script (avant build.noindex)
if [ -d "$APP_NAME.app" ]; then
  "$LSREGISTER" -u "$PWD/$APP_NAME.app" >/dev/null 2>&1 || true
  rm -rf "$APP_NAME.app"
fi
# L'app compilée n'a pas à apparaître dans Launch Services
"$LSREGISTER" -u "$PWD/$OUT" >/dev/null 2>&1 || true

if [ "${1:-}" = "--no-install" ]; then
  echo "Créée : $PWD/$OUT"
  exit 0
fi

# Installation : on quitte l'app si elle tourne, on remplace, on relance
if pgrep -xq "$BIN_NAME"; then
  osascript -e "quit app \"$APP_NAME\"" >/dev/null 2>&1 || true
  sleep 1
fi
rm -rf "${INSTALL_DIR:?}/$APP_NAME.app"
cp -R "$OUT" "$INSTALL_DIR/"
# Une seule copie sur le Mac : sinon Spotlight propose deux « Yariche »
"$LSREGISTER" -u "$PWD/$OUT" >/dev/null 2>&1 || true
rm -rf "$OUT"
"$LSREGISTER" -f "$INSTALL_DIR/$APP_NAME.app" >/dev/null 2>&1 || true
# Rafraîchit l'icône dans le Dock et le Finder
touch "$INSTALL_DIR/$APP_NAME.app"
echo "Installée : $INSTALL_DIR/$APP_NAME.app"
open "$INSTALL_DIR/$APP_NAME.app"
