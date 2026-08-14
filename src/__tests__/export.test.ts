/**
 * Unit tests for the ETL export module.
 *
 * Exercises the export pipeline against a synthetic source database shaped
 * like Quicken's Core Data schema, so the tests are deterministic and run
 * without a live Quicken DB.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import Database from "better-sqlite3";
import { existsSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { exportDatabase } from "../export.js";
import { CORE_DATA_EPOCH_OFFSET } from "../db.js";
import { resolveLiveQuickenDb } from "./fixtures/live-quicken.js";

const CATEGORY_TAG_ENT = 79;

function isoToCoreData(iso: string): number {
  return Math.floor(new Date(iso).getTime() / 1000) - CORE_DATA_EPOCH_OFFSET;
}

const FIXTURE_SCHEMA = `
  CREATE TABLE Z_PRIMARYKEY (Z_NAME TEXT, Z_ENT INTEGER);
  CREATE TABLE ZACCOUNT (
    Z_PK INTEGER PRIMARY KEY, ZNAME TEXT, ZTYPENAME TEXT,
    ZACTIVE INTEGER, ZCLOSED INTEGER
  );
  CREATE TABLE ZTAG (
    Z_PK INTEGER PRIMARY KEY, ZNAME TEXT, ZTYPE INTEGER,
    ZPARENTCATEGORY INTEGER, Z_ENT INTEGER
  );
  CREATE TABLE ZUSERPAYEE (Z_PK INTEGER PRIMARY KEY, ZNAME TEXT);
  CREATE TABLE ZTRANSACTION (
    Z_PK INTEGER PRIMARY KEY, ZPOSTEDDATE REAL, ZENTEREDDATE REAL,
    ZACCOUNT INTEGER, ZUSERPAYEE INTEGER, ZNOTE TEXT
  );
  CREATE TABLE ZCASHFLOWTRANSACTIONENTRY (
    Z_PK INTEGER PRIMARY KEY, ZPARENT INTEGER,
    ZCATEGORYTAG INTEGER, ZAMOUNT REAL
  );
`;

interface FixtureOptions {
  nullParentSplits?: number;
}

/**
 * Build a Quicken-shaped source SQLite at `path`. Populates a small,
 * deterministic dataset so tests can make exact assertions.
 */
function buildFixture(path: string, opts: FixtureOptions = {}): void {
  const db = new Database(path);
  db.exec(FIXTURE_SCHEMA);

  db.prepare("INSERT INTO Z_PRIMARYKEY (Z_NAME, Z_ENT) VALUES (?, ?)").run(
    "CategoryTag",
    CATEGORY_TAG_ENT
  );

  // Accounts: one of each common type plus one closed account
  const accounts = [
    [1, "Checking", "CHECKING", 1, 0],
    [2, "Visa", "CREDITCARD", 1, 0],
    [3, "Old Savings", "SAVINGS", 0, 1],
  ] as const;
  const insertAcct = db.prepare("INSERT INTO ZACCOUNT VALUES (?, ?, ?, ?, ?)");
  for (const a of accounts) insertAcct.run(...a);

  // Categories: one parent, two children, one income category
  const categories = [
    [10, "Food & Dining", 1, null, CATEGORY_TAG_ENT],
    [11, "Groceries", 1, 10, CATEGORY_TAG_ENT],
    [12, "Restaurants", 1, 10, CATEGORY_TAG_ENT],
    [20, "Salary", 2, null, CATEGORY_TAG_ENT],
  ] as const;
  const insertTag = db.prepare("INSERT INTO ZTAG VALUES (?, ?, ?, ?, ?)");
  for (const c of categories) insertTag.run(...c);

  // Payees — third has NULL ZNAME, should be filtered by exportPayees
  const insertPayee = db.prepare("INSERT INTO ZUSERPAYEE VALUES (?, ?)");
  insertPayee.run(100, "Whole Foods");
  insertPayee.run(101, "Acme Corp");
  insertPayee.run(102, null);

  // Transactions:
  //   tx 1000: split across Groceries + Restaurants on 2024-06-15
  //   tx 1001: single Salary income on 2024-06-30
  //   tx 1002: ZPOSTEDDATE null → COALESCE picks ZENTEREDDATE
  const insertTx = db.prepare("INSERT INTO ZTRANSACTION VALUES (?, ?, ?, ?, ?, ?)");
  insertTx.run(1000, isoToCoreData("2024-06-15"), null, 1, 100, "weekly grocery");
  insertTx.run(1001, isoToCoreData("2024-06-30"), null, 1, 101, null);
  insertTx.run(1002, null, isoToCoreData("2024-07-01"), 2, 100, null);

  // Splits: 4 real, plus N orphan/null-parent rows that the broken code
  // regresses on (Bug 1).
  const insertSplit = db.prepare(
    "INSERT INTO ZCASHFLOWTRANSACTIONENTRY VALUES (?, ?, ?, ?)"
  );
  insertSplit.run(2000, 1000, 11, -50.0);
  insertSplit.run(2001, 1000, 12, -25.0);
  insertSplit.run(2002, 1001, 20, 1234.56);
  insertSplit.run(2003, 1002, null, -10.0);

  const orphans = opts.nullParentSplits ?? 0;
  for (let i = 0; i < orphans; i++) {
    insertSplit.run(3000 + i, null, 11, -1.0);
  }

  db.close();
}

let tmpDir: string;
let srcPath: string;
let outPath: string;

beforeEach(() => {
  tmpDir = mkdtempSync(join(tmpdir(), "qexp-test-"));
  srcPath = join(tmpDir, "source.db");
  outPath = join(tmpDir, "output.db");
});

afterEach(() => {
  rmSync(tmpDir, { recursive: true, force: true });
});

describe("exportDatabase — schema", () => {
  it("creates the documented tables, views, and indexes", () => {
    buildFixture(srcPath);
    exportDatabase(outPath, srcPath);

    const out = new Database(outPath, { readonly: true });
    const objects = out
      .prepare("SELECT type, name FROM sqlite_master WHERE name NOT LIKE 'sqlite_%'")
      .all() as Array<{ type: string; name: string }>;
    out.close();

    const tables = objects.filter((o) => o.type === "table").map((o) => o.name);
    const views = objects.filter((o) => o.type === "view").map((o) => o.name);
    const indexes = objects.filter((o) => o.type === "index").map((o) => o.name);

    for (const t of [
      "accounts",
      "categories",
      "payees",
      "transactions",
      "transaction_splits",
      "holdings",
      "_export_meta",
    ]) {
      expect(tables).toContain(t);
    }
    for (const v of ["monthly_spending", "cash_flow", "recurring_charges"]) {
      expect(views).toContain(v);
    }
    for (const i of [
      "idx_transactions_date",
      "idx_transactions_account",
      "idx_transactions_payee",
      "idx_splits_transaction",
      "idx_splits_category",
    ]) {
      expect(indexes).toContain(i);
    }
  });

  it("writes _export_meta with row counts and a timestamp", () => {
    buildFixture(srcPath);
    exportDatabase(outPath, srcPath);

    const out = new Database(outPath, { readonly: true });
    const meta = Object.fromEntries(
      (
        out.prepare("SELECT key, value FROM _export_meta").all() as Array<{
          key: string;
          value: string;
        }>
      ).map((r) => [r.key, r.value])
    );
    out.close();

    expect(meta.source).toBe("quicken-mac-mcp");
    expect(meta.exported_at).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(meta.count_accounts).toBe("3");
    expect(meta.count_transactions).toBe("3");
  });
});

describe("exportDatabase — data correctness", () => {
  it("normalizes account types to lowercase canonical names", () => {
    buildFixture(srcPath);
    exportDatabase(outPath, srcPath);

    const out = new Database(outPath, { readonly: true });
    const rows = out
      .prepare("SELECT name, type, is_closed FROM accounts ORDER BY id")
      .all() as Array<{ name: string; type: string; is_closed: number }>;
    out.close();

    expect(rows).toEqual([
      { name: "Checking", type: "checking", is_closed: 0 },
      { name: "Visa", type: "credit_card", is_closed: 0 },
      { name: "Old Savings", type: "savings", is_closed: 1 },
    ]);
  });

  it("converts Core Data timestamps to ISO dates and falls back to ZENTEREDDATE", () => {
    buildFixture(srcPath);
    exportDatabase(outPath, srcPath);

    const out = new Database(outPath, { readonly: true });
    const rows = out
      .prepare("SELECT id, date FROM transactions ORDER BY id")
      .all() as Array<{ id: number; date: string }>;
    out.close();

    expect(rows).toEqual([
      { id: 1000, date: "2024-06-15" },
      { id: 1001, date: "2024-06-30" },
      { id: 1002, date: "2024-07-01" },
    ]);
  });

  it("builds full_name from category hierarchy and joins splits to parents", () => {
    buildFixture(srcPath);
    exportDatabase(outPath, srcPath);

    const out = new Database(outPath, { readonly: true });
    const cats = out
      .prepare("SELECT name, parent_name, full_name, type FROM categories WHERE name = ?")
      .get("Groceries") as {
      name: string;
      parent_name: string;
      full_name: string;
      type: string;
    };
    const split = out
      .prepare(
        "SELECT category_name, parent_category, amount FROM transaction_splits WHERE id = ?"
      )
      .get(2000) as { category_name: string; parent_category: string; amount: number };
    out.close();

    expect(cats).toEqual({
      name: "Groceries",
      parent_name: "Food & Dining",
      full_name: "Food & Dining : Groceries",
      type: "expense",
    });
    expect(split).toEqual({
      category_name: "Groceries",
      parent_category: "Food & Dining",
      amount: -50,
    });
  });

  it("aggregates split amounts into transaction.total_amount", () => {
    buildFixture(srcPath);
    exportDatabase(outPath, srcPath);

    const out = new Database(outPath, { readonly: true });
    const totals = out
      .prepare("SELECT id, total_amount FROM transactions ORDER BY id")
      .all() as Array<{ id: number; total_amount: number }>;
    out.close();

    expect(totals).toEqual([
      { id: 1000, total_amount: -75 },
      { id: 1001, total_amount: 1234.56 },
      { id: 1002, total_amount: -10 },
    ]);
  });

  it("filters payees with NULL ZNAME", () => {
    buildFixture(srcPath);
    exportDatabase(outPath, srcPath);

    const out = new Database(outPath, { readonly: true });
    const count = (out.prepare("SELECT COUNT(*) AS n FROM payees").get() as { n: number })
      .n;
    out.close();
    expect(count).toBe(2);
  });
});

describe("exportDatabase — Bug 1: NULL parent splits filtered", () => {
  it("does not insert splits whose ZPARENT is NULL (would violate FK NOT NULL)", () => {
    buildFixture(srcPath, { nullParentSplits: 5 });

    const result = exportDatabase(outPath, srcPath);

    // 4 real splits in the fixture, 5 orphan rows added — only the 4 should land.
    expect(result.splits).toBe(4);

    const out = new Database(outPath, { readonly: true });
    const orphan = out
      .prepare(
        "SELECT COUNT(*) AS n FROM transaction_splits WHERE transaction_id IS NULL"
      )
      .get() as { n: number };
    out.close();
    expect(orphan.n).toBe(0);
  });
});

describe("exportDatabase — Bug 2: file-handling robustness", () => {
  it("refuses to overwrite an existing output file", () => {
    buildFixture(srcPath);
    writeFileSync(outPath, "pretend this is precious data");

    expect(() => exportDatabase(outPath, srcPath)).toThrow(/already exists/);

    expect(existsSync(outPath)).toBe(true);
  });

  it("removes partial output (and -wal/-shm sidecars) on failure", () => {
    // Source DB without a Z_PRIMARYKEY 'CategoryTag' row →
    // getCategoryTagEntityId throws partway through, leaving a partial output.
    const partialSchema = `
      CREATE TABLE Z_PRIMARYKEY (Z_NAME TEXT, Z_ENT INTEGER);
      CREATE TABLE ZACCOUNT (
        Z_PK INTEGER PRIMARY KEY, ZNAME TEXT, ZTYPENAME TEXT,
        ZACTIVE INTEGER, ZCLOSED INTEGER
      );
      CREATE TABLE ZTAG (
        Z_PK INTEGER PRIMARY KEY, ZNAME TEXT, ZTYPE INTEGER,
        ZPARENTCATEGORY INTEGER, Z_ENT INTEGER
      );
    `;
    const db = new Database(srcPath);
    db.exec(partialSchema);
    db.close();

    expect(() => exportDatabase(outPath, srcPath)).toThrow();

    expect(existsSync(outPath)).toBe(false);
    expect(existsSync(`${outPath}-wal`)).toBe(false);
    expect(existsSync(`${outPath}-shm`)).toBe(false);
  });

  it("a re-run after a failed export succeeds (no leftover state blocks it)", () => {
    const minimalSchema = `CREATE TABLE Z_PRIMARYKEY (Z_NAME TEXT, Z_ENT INTEGER);`;
    const bad = new Database(srcPath);
    bad.exec(minimalSchema);
    bad.close();

    expect(() => exportDatabase(outPath, srcPath)).toThrow();

    rmSync(srcPath);
    buildFixture(srcPath);
    const result = exportDatabase(outPath, srcPath);
    expect(result.transactions).toBe(3);
    expect(existsSync(outPath)).toBe(true);
  });
});

describe("exportDatabase — investment tables", () => {
  it("does not crash when investment tables are missing (holdings = 0)", () => {
    buildFixture(srcPath);
    const result = exportDatabase(outPath, srcPath);
    expect(result.holdings).toBe(0);
  });
});

// ============================================================
// Live-DB integration tests
// ------------------------------------------------------------
// Skipped with an explicit warning when no Quicken DB is selected (e.g. CI).
// A configured but unusable QUICKEN_DB_PATH fails the suite.
// Run locally with Quicken For Mac open. Assertions are generic
// invariants — they don't hardcode anything tied to a specific DB.
// ============================================================

const LIVE_DB_PATH = resolveLiveQuickenDb("export.test.ts", ["ZACCOUNT"]);
const describeWithLiveDb = LIVE_DB_PATH ? describe : describe.skip;

describeWithLiveDb("exportDatabase — live Quicken DB", () => {
  it("exports a real DB end-to-end and produces non-trivial counts", () => {
    const result = exportDatabase(outPath, LIVE_DB_PATH);

    expect(result.accounts).toBeGreaterThan(0);
    expect(result.categories).toBeGreaterThan(0);
    expect(result.payees).toBeGreaterThan(0);
    expect(result.transactions).toBeGreaterThan(0);
    expect(result.splits).toBeGreaterThanOrEqual(result.transactions);
    expect(existsSync(outPath)).toBe(true);
  });

  it("exported counts match counts queried directly from the source", () => {
    const result = exportDatabase(outPath, LIVE_DB_PATH);

    const src = new Database(LIVE_DB_PATH!, { readonly: true });
    const srcCounts = {
      accounts: (src.prepare("SELECT COUNT(*) AS n FROM ZACCOUNT").get() as { n: number })
        .n,
      transactions: (
        src.prepare("SELECT COUNT(*) AS n FROM ZTRANSACTION").get() as { n: number }
      ).n,
      // Splits: count entries with a non-null parent (orphans are filtered).
      splits: (
        src
          .prepare(
            "SELECT COUNT(*) AS n FROM ZCASHFLOWTRANSACTIONENTRY WHERE ZPARENT IS NOT NULL"
          )
          .get() as { n: number }
      ).n,
    };
    src.close();

    expect(result.accounts).toBe(srcCounts.accounts);
    expect(result.transactions).toBe(srcCounts.transactions);
    expect(result.splits).toBe(srcCounts.splits);
  });

  it("every exported split references an existing transaction (FK integrity)", () => {
    exportDatabase(outPath, LIVE_DB_PATH);

    const out = new Database(outPath, { readonly: true });
    const orphanRow = out
      .prepare(
        `SELECT COUNT(*) AS n FROM transaction_splits ts
         LEFT JOIN transactions t ON t.id = ts.transaction_id
         WHERE t.id IS NULL`
      )
      .get() as { n: number };
    out.close();
    expect(orphanRow.n).toBe(0);
  });

  it("transactions.total_amount equals SUM of its splits (within rounding tolerance)", () => {
    exportDatabase(outPath, LIVE_DB_PATH);

    const out = new Database(outPath, { readonly: true });
    const mismatch = out
      .prepare(
        `SELECT COUNT(*) AS n
         FROM transactions t
         JOIN (
           SELECT transaction_id, ROUND(SUM(amount), 2) AS sum_amount
           FROM transaction_splits
           GROUP BY transaction_id
         ) s ON s.transaction_id = t.id
         WHERE ABS(t.total_amount - s.sum_amount) > 0.01`
      )
      .get() as { n: number };
    out.close();
    expect(mismatch.n).toBe(0);
  });

  it("monthly_spending and cash_flow views return rows", () => {
    exportDatabase(outPath, LIVE_DB_PATH);

    const out = new Database(outPath, { readonly: true });
    const monthlyCount = (
      out.prepare("SELECT COUNT(*) AS n FROM monthly_spending").get() as { n: number }
    ).n;
    const cashFlowCount = (
      out.prepare("SELECT COUNT(*) AS n FROM cash_flow").get() as { n: number }
    ).n;
    out.close();

    expect(monthlyCount).toBeGreaterThan(0);
    expect(cashFlowCount).toBeGreaterThan(0);
  });

  it("_export_meta counts match the values returned by exportDatabase", () => {
    const result = exportDatabase(outPath, LIVE_DB_PATH);

    const out = new Database(outPath, { readonly: true });
    const meta = Object.fromEntries(
      (
        out.prepare("SELECT key, value FROM _export_meta").all() as Array<{
          key: string;
          value: string;
        }>
      ).map((r) => [r.key, r.value])
    );
    out.close();

    expect(meta.count_accounts).toBe(String(result.accounts));
    expect(meta.count_transactions).toBe(String(result.transactions));
    expect(meta.count_splits).toBe(String(result.splits));
    expect(meta.count_holdings).toBe(String(result.holdings));
  });

  it("auto-detects Quicken DB when no srcDbPath is given (only when QUICKEN_DB_PATH unset)", () => {
    if (process.env.QUICKEN_DB_PATH) {
      // Auto-detect path is exercised differently when env var is set; skip
      // to avoid asserting against the user's specific environment.
      return;
    }
    const result = exportDatabase(outPath);
    expect(result.accounts).toBeGreaterThan(0);
  });
});
