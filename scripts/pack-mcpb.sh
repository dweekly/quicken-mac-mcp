#!/usr/bin/env bash
set -euo pipefail

# Build a clean .mcpb bundle with only production dependencies.
# Usage: ./scripts/pack-mcpb.sh [output-file]

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGING="$ROOT/.mcpb-staging"
OUTPUT="${1:-$ROOT/quicken-mac-mcp.mcpb}"
if [[ "$OUTPUT" != /* ]]; then
  OUTPUT="$ROOT/$OUTPUT"
fi

cleanup() {
  rm -rf "$STAGING"
}
trap cleanup EXIT

echo "==> Building TypeScript..."
npm run build --prefix "$ROOT"

echo "==> Preparing staging directory..."
cleanup
mkdir -p "$STAGING"

# Copy only what the bundle needs
cp "$ROOT/icon.png" "$STAGING/"
cp "$ROOT/LICENSE" "$STAGING/"
cp -r "$ROOT/dist" "$STAGING/dist"

# Sync the manifest version from package.json so the .mcpb advertises the
# same version that's published to npm. The committed manifest.json is the
# source of truth for everything else; only the version field is overridden.
node -e "
  const fs = require('fs');
  const pkg = require('$ROOT/package.json');
  const manifest = require('$ROOT/manifest.json');
  manifest.version = pkg.version;
  fs.writeFileSync('$STAGING/manifest.json', JSON.stringify(manifest, null, 2) + '\n');
  console.log('==> Manifest version synced to ' + pkg.version);
"

# Copy package metadata but strip development-only fields. Keep a matching
# production lockfile so release bundles use the exact reviewed dependencies.
node -e "
  const fs = require('fs');
  const pkg = require('$ROOT/package.json');
  delete pkg.scripts;
  delete pkg.devDependencies;
  fs.writeFileSync('$STAGING/package.json', JSON.stringify(pkg, null, 2) + '\n');

  const lock = require('$ROOT/package-lock.json');
  delete lock.packages[''].devDependencies;
  fs.writeFileSync('$STAGING/package-lock.json', JSON.stringify(lock, null, 2) + '\n');
"

echo "==> Installing production dependencies..."
cd "$STAGING"
npm ci --omit=dev --ignore-scripts
# better-sqlite3 13+ ships prebuilt native addons for every platform inside the
# package and has no install step. Quicken For Mac only runs on macOS, and each
# bundle targets one architecture, so keep only this machine's addon.
ADDON="darwin-$(node -p process.arch).node"
PREBUILDS="node_modules/better-sqlite3/prebuilds"
if [[ ! -f "$PREBUILDS/$ADDON" ]]; then
  echo "error: $PREBUILDS/$ADDON is missing; bundles must be packed on macOS" >&2
  exit 1
fi
find "$PREBUILDS" -type f ! -name "$ADDON" -delete

echo "==> Packing .mcpb..."
"$ROOT/node_modules/.bin/mcpb" pack "$STAGING" "$OUTPUT"

SIZE=$(du -h "$OUTPUT" | cut -f1)
echo "==> Done! $OUTPUT ($SIZE)"
