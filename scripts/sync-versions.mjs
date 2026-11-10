#!/usr/bin/env node

/**
 * Propagate package.json's version to every other version-bearing file in
 * the repo. Idempotent — running it twice is a no-op.
 *
 * Wired into the `version` lifecycle hook so `npm version <bump>` and the
 * tests in src/__tests__/versions.test.ts keep server.json, manifest.json,
 * plugin/.claude-plugin/plugin.json and the man page headers in lockstep with package.json. Without this they drift
 * silently across releases (e.g. server.json sat at 1.0.3 across 1.0.3
 * → 1.2.2 before this change).
 */

import { readFileSync, writeFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, resolve } from "node:path";

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const pkg = JSON.parse(readFileSync(resolve(ROOT, "package.json"), "utf8"));
const VERSION = pkg.version;

if (!/^\d+\.\d+\.\d+(?:-[\w.]+)?$/.test(VERSION)) {
  console.error(`Invalid version in package.json: ${VERSION}`);
  process.exit(1);
}

/** Update a JSON file by applying a transformer; preserves trailing newline. */
function updateJson(relPath, mutate) {
  const path = resolve(ROOT, relPath);
  const raw = readFileSync(path, "utf8");
  const trailingNewline = raw.endsWith("\n");
  const data = JSON.parse(raw);
  const before = JSON.stringify(data);
  mutate(data);
  if (JSON.stringify(data) === before) return false;
  writeFileSync(path, JSON.stringify(data, null, 2) + (trailingNewline ? "\n" : ""));
  return true;
}

const changed = [];

if (
  updateJson("manifest.json", (m) => {
    m.version = VERSION;
  })
) {
  changed.push("manifest.json");
}

if (
  updateJson("server.json", (s) => {
    s.version = VERSION;
    if (Array.isArray(s.packages)) {
      for (const p of s.packages) p.version = VERSION;
    }
  })
) {
  changed.push("server.json");
}

if (
  updateJson("plugin/.claude-plugin/plugin.json", (plugin) => {
    plugin.version = VERSION;
  })
) {
  changed.push("plugin/.claude-plugin/plugin.json");
}

// Man pages carry the version in their .TH header: "qmac v1.2.3".
for (const [relPath, name] of [
  ["man/qmac.1", "qmac"],
  ["man/quicken-mac-mcp.1", "quicken-mac-mcp"],
]) {
  const path = resolve(ROOT, relPath);
  const before = readFileSync(path, "utf8");
  const after = before.replace(
    new RegExp(`"${name} v\\d+\\.\\d+\\.\\d+(?:-[\\w.]+)?"`),
    `"${name} v${VERSION}"`
  );
  if (after !== before) {
    writeFileSync(path, after);
    changed.push(relPath);
  }
}

if (changed.length === 0) {
  console.log(`All version files already at ${VERSION}.`);
} else {
  console.log(`Synced to ${VERSION}: ${changed.join(", ")}`);
}
