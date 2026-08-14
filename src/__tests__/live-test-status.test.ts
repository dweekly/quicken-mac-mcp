import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import { createSyntheticQuickenDb } from "./fixtures/quicken.js";

const SCRIPT = resolve(__dirname, "../../scripts/report-live-test-status.mjs");

describe("live-test preflight", () => {
  let directory: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "quicken-live-preflight-"));
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function run(databasePath: string) {
    return spawnSync(process.execPath, [SCRIPT], {
      encoding: "utf8",
      env: { ...process.env, QUICKEN_DB_PATH: databasePath },
    });
  }

  it("fails loudly when an explicitly configured database is missing", () => {
    const result = run(join(directory, "missing.sqlite"));

    expect(result.status).toBe(1);
    expect(result.stderr).toContain("[live-db] ERROR");
    expect(result.stderr).toContain("Live tests were expected and cannot run");
    expect(result.stderr).not.toContain(directory);
  });

  it("enables live suites when the configured database has the expected schema", () => {
    const databasePath = join(directory, "fixture.sqlite");
    createSyntheticQuickenDb(databasePath).close();

    const result = run(databasePath);

    expect(result.status).toBe(0);
    expect(result.stderr).toContain("[live-db] ENABLED via QUICKEN_DB_PATH");
    expect(result.stderr).not.toContain(directory);
  });
});
