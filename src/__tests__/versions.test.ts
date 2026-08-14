/**
 * Cross-checks that every version-bearing file in the repo matches
 * package.json. Without this, server.json, manifest.json, and plugin metadata drift
 * across releases — e.g. server.json sat at 1.0.3 from v1.0.3 → v1.2.2.
 *
 * Drift is fixed by `npm run sync:versions` (also wired to the `npm version`
 * lifecycle hook).
 */

import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { toolsRegistry } from "../tools/registry.js";

const ROOT = resolve(__dirname, "..", "..");

function readJson<T>(path: string): T {
  return JSON.parse(readFileSync(resolve(ROOT, path), "utf8")) as T;
}

const pkg = readJson<{ version: string }>("package.json");
const lock = readJson<{ version: string; packages: { "": { version: string } } }>(
  "package-lock.json"
);
const manifest = readJson<{
  version: string;
  tools: Array<{ name: string; description: string }>;
}>("manifest.json");
const server = readJson<{ version: string; packages: Array<{ version: string }> }>(
  "server.json"
);
const plugin = readJson<{ version: string }>("plugin/.claude-plugin/plugin.json");
const formula = readFileSync(resolve(ROOT, "Formula/qmac.rb"), "utf8");

describe("version consistency", () => {
  it("package-lock.json matches package.json (top-level + root package)", () => {
    expect(lock.version).toBe(pkg.version);
    expect(lock.packages[""].version).toBe(pkg.version);
  });

  it("manifest.json version matches package.json", () => {
    expect(manifest.version).toBe(pkg.version);
  });

  it("manifest.json tool metadata matches the runtime registry", () => {
    expect(manifest.tools).toEqual(
      toolsRegistry.map(({ name, description }) => ({ name, description }))
    );
  });

  it("server.json top-level and packages[].version both match package.json", () => {
    expect(server.version).toBe(pkg.version);
    for (const p of server.packages) {
      expect(p.version).toBe(pkg.version);
    }
  });

  it("Claude plugin metadata version matches package.json", () => {
    expect(plugin.version).toBe(pkg.version);
  });

  it("Homebrew formula targets the package version", () => {
    expect(formula).toContain(`quicken-mac-mcp-${pkg.version}.tgz`);
  });
});
