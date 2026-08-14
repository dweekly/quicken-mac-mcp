import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { createSyntheticQuickenDb } from "./fixtures/quicken.js";

const ROOT = resolve(__dirname, "..", "..");
const SCRIPT = join(ROOT, "plugin/skills/quicken/scripts/quicken_db.py");
const VENV_PYTHON = join(ROOT, ".venv/bin/python");
const PYTHON = existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";

describe("quicken_db.py user-tag-schema", () => {
  let directory: string;
  let databasePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "quicken-synthetic-"));
    databasePath = join(directory, "data.sqlite");
    const fixture = createSyntheticQuickenDb(databasePath);
    fixture.close();
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  function discover() {
    return spawnSync(PYTHON, [SCRIPT, "user-tag-schema", "--db", databasePath], {
      encoding: "utf8",
    });
  }

  it("returns one validated join mapping", () => {
    const result = discover();
    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload.matches).toEqual([
      {
        table: "Z_15USERTAGS",
        entry_column: "Z_15CASHFLOWTRANSACTIONENTRIES",
        user_tag_column: "Z_76USERTAGS",
      },
    ]);
  });

  it("fails when no join mapping exists", () => {
    const db = new Database(databasePath);
    db.exec("DROP TABLE Z_15USERTAGS");
    db.close();

    const result = discover();
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ready: false,
      error: expect.stringContaining("No unambiguous user-tag join table"),
    });
  });

  it("fails instead of choosing the first ambiguous join column", () => {
    const db = new Database(databasePath);
    db.exec(
      "ALTER TABLE Z_15USERTAGS ADD COLUMN Z_15CASHFLOWTRANSACTIONENTRIES1 INTEGER"
    );
    db.close();

    const result = discover();
    expect(result.status).toBe(2);
    expect(JSON.parse(result.stdout)).toMatchObject({
      ready: false,
      error: expect.stringContaining("Ambiguous user-tag join columns"),
    });
  });
});
