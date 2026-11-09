import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { spawnSync } from "node:child_process";
import Database from "better-sqlite3";
import { createSyntheticQuickenDb, QUICKEN_LAYOUTS } from "./fixtures/quicken.js";
import { listPortfolio } from "../tools/list-portfolio.js";
import { exportDatabase } from "../export.js";

const ROOT = resolve(__dirname, "..", "..");
const CSV_EXPORTER = join(ROOT, "scripts/export_sovereign_csv.py");
const VENV_PYTHON = join(ROOT, ".venv/bin/python");
const PYTHON = existsSync(VENV_PYTHON) ? VENV_PYTHON : "python3";

type Holding = Record<string, unknown>;

describe.each(QUICKEN_LAYOUTS)("holdings ($label)", (layout) => {
  let directory: string;
  let sourcePath: string;

  beforeEach(() => {
    directory = mkdtempSync(join(tmpdir(), "quicken-portfolio-"));
    sourcePath = join(directory, "data.sqlite");
    createSyntheticQuickenDb(sourcePath, layout).close();
  });

  afterEach(() => {
    rmSync(directory, { recursive: true, force: true });
  });

  it("list_portfolio reports long and short positions and skips closed lots", () => {
    const db = new Database(sourcePath, { readonly: true });
    const holdings = listPortfolio(db, {}) as Holding[];
    db.close();

    expect(holdings).toHaveLength(2);
    const long = holdings.find((h) => h.ticker === "EXMPL");
    const short = holdings.find((h) => h.ticker === "SHRT");
    expect(long).toMatchObject({ current_shares: 2, cost_basis: 150, market_value: 200 });
    expect(short).toMatchObject({ current_shares: -3, market_value: -60 });
  });

  it("list_portfolio reports a security's currency only where the file records one", () => {
    const db = new Database(sourcePath, { readonly: true });
    const holdings = listPortfolio(db, {}) as Holding[];
    db.close();

    const long = holdings.find((h) => h.ticker === "EXMPL")!;
    const short = holdings.find((h) => h.ticker === "SHRT")!;
    if (layout.hasSecurityCurrency) {
      expect(long.currency).toBe("USD");
    } else {
      expect(long).not.toHaveProperty("currency");
    }
    expect(short).not.toHaveProperty("currency");
  });

  it("the SQLite export keeps the short position", () => {
    const outPath = join(directory, "export.db");
    const result = exportDatabase(outPath, sourcePath);
    expect(result.holdings).toBe(2);

    const out = new Database(outPath, { readonly: true });
    const rows = out
      .prepare("SELECT ticker, shares, market_value FROM holdings ORDER BY ticker")
      .all();
    out.close();
    expect(rows).toEqual([
      { ticker: "EXMPL", shares: 2, market_value: 200 },
      { ticker: "SHRT", shares: -3, market_value: -60 },
    ]);
  });

  it("the CSV export keeps the short position", () => {
    const outDir = join(directory, "csv");
    const result = spawnSync(PYTHON, [CSV_EXPORTER, outDir], {
      encoding: "utf8",
      env: { ...process.env, QUICKEN_DB_PATH: sourcePath },
    });
    expect(result.status, result.stderr).toBe(0);

    const lines = readFileSync(join(outDir, "holdings.csv"), "utf8").trim().split("\n");
    expect(lines).toHaveLength(3);
    expect(lines.find((line) => line.includes("SHRT"))).toContain(",-3.0,");
  });
});
