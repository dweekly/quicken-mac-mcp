#!/usr/bin/env bash
set -euo pipefail

# Build a clean .mcpb bundle with only production dependencies.
# Usage: ./scripts/pack-mcpb.sh

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
STAGING="$ROOT/.mcpb-staging"
OUTPUT="$ROOT/quicken-mac-mcp.mcpb"

echo "==> Building TypeScript..."
npm run build --prefix "$ROOT"

echo "==> Preparing staging directory..."
rm -rf "$STAGING"
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

# Copy package.json but strip scripts to avoid lifecycle hooks during install
node -e "
  const pkg = require('$ROOT/package.json');
  delete pkg.scripts;
  delete pkg.devDependencies;
  require('fs').writeFileSync('$STAGING/package.json', JSON.stringify(pkg, null, 2));
"

echo "==> Installing production dependencies..."
cd "$STAGING"
npm install --omit=dev --ignore-scripts
# Rebuild better-sqlite3 native addon (required for macOS)
npm rebuild better-sqlite3

echo "==> Packing .mcpb..."
npx @anthropic-ai/mcpb pack "$STAGING" "$OUTPUT"

echo "==> Cleaning up..."
rm -rf "$STAGING"

SIZE=$(du -h "$OUTPUT" | cut -f1)
echo "==> Done! $OUTPUT ($SIZE)"
