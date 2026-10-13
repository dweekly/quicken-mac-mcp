import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { createSyntheticQuickenDb } from "./fixtures/quicken.js";

const ROOT = resolve(__dirname, "..", "..");
const SCRIPT = join(ROOT, "plugin/skills/quicken/scripts/quicken_db.py");
const VENV_PYTHON = join(ROOT, ".venv/bin/python");
const PYTHON = existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";

describe("quicken_db.py candidates", () => {
  let home: string;

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), "quicken-home-"));
  });

  afterEach(() => {
    rmSync(home, { recursive: true, force: true });
  });

  function candidates() {
    return spawnSync(PYTHON, [SCRIPT, "candidates"], {
      encoding: "utf8",
      env: { ...process.env, HOME: home, QUICKEN_DB_PATH: "" },
    });
  }

  function bundle(relativeDir: string, name: string) {
    const dir = join(home, relativeDir, `${name}.quicken`);
    mkdirSync(dir, { recursive: true });
    createSyntheticQuickenDb(join(dir, "data")).close();
  }

  it("finds a bundle under ~/Library/Application Support/Quicken/Documents", () => {
    bundle("Library/Application Support/Quicken/Documents", "Qdata");
    const result = candidates();
    expect(result.status, result.stderr).toBe(0);
    const payload = JSON.parse(result.stdout);
    expect(payload).toHaveLength(1);
    expect(payload[0].path).toContain(
      "Application Support/Quicken/Documents/Qdata.quicken/data"
    );
  });

  it("finds a beta-channel folder and the App Store container alongside ~/Documents", () => {
    bundle("Documents", "Old");
    bundle("Library/Application Support/Quicken Beta/Documents", "Beta");
    bundle(
      "Library/Containers/com.quicken.QuickenAppStore/Data/Library/Application Support/Quicken/Documents",
      "Store"
    );
    const payload = JSON.parse(candidates().stdout);
    expect(payload.map((c: any) => c.path.split("/").at(-2)).sort()).toEqual([
      "Beta.quicken",
      "Old.quicken",
      "Store.quicken",
    ]);
  });

  it("ignores folders that merely start with 'Quicken'", () => {
    bundle("Library/Application Support/Quickenfoo/Documents", "Foo");
    expect(JSON.parse(candidates().stdout)).toEqual([]);
  });
});

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
