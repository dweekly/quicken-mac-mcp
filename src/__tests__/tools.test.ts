import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveLiveQuickenDb } from "./fixtures/live-quicken.js";
import { listAccounts } from "../tools/list-accounts.js";
import { listCategories } from "../tools/list-categories.js";
import { queryTransactions } from "../tools/query-transactions.js";
import { spendingByCategory } from "../tools/spending-by-category.js";
import { spendingOverTime } from "../tools/spending-over-time.js";
import { searchPayees } from "../tools/search-payees.js";
import { rawQuery } from "../tools/raw-query.js";
import { listPortfolio } from "../tools/list-portfolio.js";

const DB_PATH = resolveLiveQuickenDb("tools.test.ts", ["ZTRANSACTION"]);
const describeWithDb = DB_PATH ? describe : describe.skip;

let db: Database.Database;

beforeAll(() => {
  if (DB_PATH) {
    db = new Database(DB_PATH, { readonly: true });
  }
});

afterAll(() => {
  db?.close();
});

// --- list_accounts ---

describeWithDb("list_accounts", () => {
  it("returns accounts with expected fields", () => {
    const result = listAccounts(db, {});
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toHaveProperty("id");
    expect(result[0]).toHaveProperty("name");
    expect(result[0]).toHaveProperty("type");
    expect(typeof result[0].active).toBe("boolean");
    expect(typeof result[0].closed).toBe("boolean");
  });

  it("filters by account type (case-insensitive)", () => {
    const lower = listAccounts(db, { account_type: "checking" });
    const upper = listAccounts(db, { account_type: "CHECKING" });
    expect(lower.length).toBeGreaterThan(0);
    expect(lower.length).toBe(upper.length);
    lower.forEach((r: any) => expect(r.type.toUpperCase()).toBe("CHECKING"));
  });

  it("returns empty array for nonexistent account type", () => {
    const result = listAccounts(db, { account_type: "nonexistent" });
    expect(result).toEqual([]);
  });

  it("returns sorted by name", () => {
    const result = listAccounts(db, {});
    const names = result.map((r: any) => r.name);
    const sorted = [...names].sort();
    expect(names).toEqual(sorted);
  });
});

// --- list_categories ---

describeWithDb("list_categories", () => {
  it("returns categories with expected fields", () => {
    const result = listCategories(db, {});
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toHaveProperty("name");
    expect(result[0]).toHaveProperty("type");
    expect(result[0]).toHaveProperty("id");
  });

  it("filters by expense type", () => {
    const result = listCategories(db, { type: "expense" });
    expect(result.length).toBeGreaterThan(0);
    result.forEach((r: any) => expect(r.type).toBe("expense"));
  });

  it("filters by income type", () => {
    const result = listCategories(db, { type: "income" });
    expect(result.length).toBeGreaterThan(0);
    result.forEach((r: any) => expect(r.type).toBe("income"));
  });

  it("returns all types when no filter is set", () => {
    const all = listCategories(db, {});
    const expenses = listCategories(db, { type: "expense" });
    const income = listCategories(db, { type: "income" });
    expect(all.length).toBeGreaterThanOrEqual(expenses.length + income.length);
  });
});

// --- query_transactions ---

describeWithDb("query_transactions", () => {
  it("returns transactions with date range", () => {
    const result = queryTransactions(db, {
      start_date: "2024-01-01",
      end_date: "2024-12-31",
      limit: 10,
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toHaveProperty("transaction_id");
    expect(result[0]).toHaveProperty("posted_date");
    expect(result[0]).toHaveProperty("account_name");
    expect(result[0]).toHaveProperty("amount");
    expect(result[0]).toHaveProperty("note");
    expect(result[0]).toHaveProperty("split_note");
  });

  it("respects limit parameter", () => {
    const result = queryTransactions(db, { limit: 5 });
    expect(result.length).toBeLessThanOrEqual(5);
  });

  it("caps limit at 1000", () => {
    const result = queryTransactions(db, { limit: 5000 });
    expect(result.length).toBeLessThanOrEqual(1000);
  });

  it("defaults limit to 100", () => {
    const result = queryTransactions(db, {});
    expect(result.length).toBeLessThanOrEqual(100);
  });

  it("filters by account type (case-insensitive)", () => {
    const result = queryTransactions(db, {
      account_types: ["checking"],
      limit: 10,
    });
    expect(result.length).toBeGreaterThan(0);
    result.forEach((r: any) => expect(r.account_type.toUpperCase()).toBe("CHECKING"));
  });

  it("filters by amount range", () => {
    const result = queryTransactions(db, {
      min_amount: -50,
      max_amount: -10,
      limit: 10,
    });
    expect(result.length).toBeGreaterThan(0);
    result.forEach((r: any) => {
      expect(r.amount).toBeGreaterThanOrEqual(-50);
      expect(r.amount).toBeLessThanOrEqual(-10);
    });
  });

  it("returns dates in ISO format", () => {
    const result = queryTransactions(db, { limit: 5 });
    result.forEach((r: any) => {
      if (r.posted_date) {
        expect(r.posted_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      }
    });
  });

  it("does not include raw date field in output", () => {
    const result = queryTransactions(db, { limit: 1 });
    expect(result[0]).not.toHaveProperty("posted_date_raw");
  });
});

// --- spending_by_category ---

describeWithDb("spending_by_category", () => {
  it("returns spending aggregated by parent category", () => {
    const result = spendingByCategory(db, {
      start_date: "2024-01-01",
      end_date: "2024-12-31",
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toHaveProperty("category");
    expect(result[0]).toHaveProperty("total_amount");
    expect(result[0]).toHaveProperty("transaction_count");
  });

  it("groups by subcategory when requested", () => {
    const byParent = spendingByCategory(db, {
      start_date: "2024-01-01",
      end_date: "2024-12-31",
      group_by: "parent_category",
    });
    const byCategory = spendingByCategory(db, {
      start_date: "2024-01-01",
      end_date: "2024-12-31",
      group_by: "category",
    });
    // Subcategory grouping should produce more rows than parent grouping
    expect(byCategory.length).toBeGreaterThanOrEqual(byParent.length);
  });

  it("rounds amounts to 2 decimal places", () => {
    const result = spendingByCategory(db, {
      start_date: "2024-01-01",
      end_date: "2024-12-31",
    });
    result.forEach((r: any) => {
      const str = r.total_amount.toString();
      const decimals = str.includes(".") ? str.split(".")[1].length : 0;
      expect(decimals).toBeLessThanOrEqual(2);
    });
  });

  it("accepts custom account types", () => {
    const result = spendingByCategory(db, {
      start_date: "2024-01-01",
      end_date: "2024-12-31",
      account_types: ["creditcard"],
    });
    expect(result.length).toBeGreaterThan(0);
  });
});

// --- spending_over_time ---

describeWithDb("spending_over_time", () => {
  it("returns monthly spending totals", () => {
    const result = spendingOverTime(db, {
      start_date: "2024-01-01",
      end_date: "2024-12-31",
    });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toHaveProperty("month");
    expect(result[0]).toHaveProperty("total_amount");
    expect(result[0]).toHaveProperty("transaction_count");
  });

  it("returns months in YYYY-MM format", () => {
    const result = spendingOverTime(db, {
      start_date: "2024-01-01",
      end_date: "2024-12-31",
    });
    result.forEach((r: any) => expect(r.month).toMatch(/^\d{4}-\d{2}$/));
  });

  it("returns months in chronological order", () => {
    const result = spendingOverTime(db, {
      start_date: "2024-01-01",
      end_date: "2024-12-31",
    });
    const months = result.map((r: any) => r.month);
    const sorted = [...months].sort();
    expect(months).toEqual(sorted);
  });

  it("breaks down by category when requested", () => {
    const flat = spendingOverTime(db, {
      start_date: "2024-01-01",
      end_date: "2024-06-30",
    });
    const byCategory = spendingOverTime(db, {
      start_date: "2024-01-01",
      end_date: "2024-06-30",
      group_by_category: true,
    });
    expect(byCategory.length).toBeGreaterThan(flat.length);
    expect(byCategory[0]).toHaveProperty("category");
    expect(flat[0]).not.toHaveProperty("category");
  });
});

// --- search_payees ---

describeWithDb("search_payees", () => {
  it("finds payees matching search term", () => {
    const result = searchPayees(db, { query: "a" });
    expect(result.length).toBeGreaterThan(0);
    expect(result[0]).toHaveProperty("payee");
    expect(result[0]).toHaveProperty("transaction_count");
  });

  it("returns results sorted by transaction count descending", () => {
    const result = searchPayees(db, { query: "a" });
    for (let i = 1; i < result.length; i++) {
      expect((result[i] as any).transaction_count).toBeLessThanOrEqual(
        (result[i - 1] as any).transaction_count
      );
    }
  });

  it("respects limit parameter", () => {
    const result = searchPayees(db, { query: "a", limit: 3 });
    expect(result.length).toBeLessThanOrEqual(3);
  });

  it("caps limit at 500", () => {
    const result = searchPayees(db, { query: "a", limit: 1000 });
    expect(result.length).toBeLessThanOrEqual(500);
  });

  it("returns empty for no matches", () => {
    const result = searchPayees(db, { query: "zzzznonexistent99999" });
    expect(result).toEqual([]);
  });
});

// --- raw_query ---

describeWithDb("raw_query", () => {
  it("executes a SELECT query", () => {
    const result = rawQuery(db, {
      sql: "SELECT COUNT(*) as cnt FROM ZACCOUNT",
    });
    expect(result.row_count).toBe(1);
    expect(result.rows[0]).toHaveProperty("cnt");
    expect((result.rows[0] as any).cnt).toBeGreaterThan(0);
  });

  it("rejects non-SELECT queries", () => {
    expect(() => rawQuery(db, { sql: "DROP TABLE ZACCOUNT" })).toThrow(
      "Only SELECT queries are allowed"
    );
  });

  it("rejects INSERT statements", () => {
    expect(() =>
      rawQuery(db, { sql: "INSERT INTO ZACCOUNT (ZNAME) VALUES ('test')" })
    ).toThrow("Only SELECT queries are allowed");
  });

  it("rejects UPDATE statements", () => {
    expect(() => rawQuery(db, { sql: "UPDATE ZACCOUNT SET ZNAME = 'x'" })).toThrow(
      "Only SELECT queries are allowed"
    );
  });

  it("rejects DELETE statements", () => {
    expect(() => rawQuery(db, { sql: "DELETE FROM ZACCOUNT" })).toThrow(
      "Only SELECT queries are allowed"
    );
  });

  it("rejects SELECT with embedded dangerous keywords", () => {
    expect(() =>
      rawQuery(db, {
        sql: "SELECT * FROM ZACCOUNT; DROP TABLE ZACCOUNT",
      })
    ).toThrow("disallowed");
  });

  it("limits results to 500 rows when no LIMIT specified", () => {
    const result = rawQuery(db, { sql: "SELECT * FROM ZTRANSACTION" });
    expect(result.row_count).toBeLessThanOrEqual(500);
  });

  it("respects user-specified LIMIT", () => {
    const result = rawQuery(db, {
      sql: "SELECT * FROM ZTRANSACTION LIMIT 3",
    });
    expect(result.row_count).toBeLessThanOrEqual(3);
  });

  it("caps results at 500 rows even when an inner subquery has a larger LIMIT", () => {
    // A naive "find the LIMIT clause" cap can be fooled by a LIMIT nested in
    // a subquery: it clamps that inner LIMIT and, seeing a LIMIT was already
    // present, never adds an outer bound — leaving a join against the
    // (still large) subquery result unbounded.
    const result = rawQuery(db, {
      sql: "SELECT * FROM (SELECT * FROM ZTRANSACTION LIMIT 100000) t1, ZACCOUNT a",
    });
    expect(result.row_count).toBeLessThanOrEqual(500);
  });

  it("handles queries with trailing semicolons", () => {
    const result = rawQuery(db, {
      sql: "SELECT COUNT(*) as cnt FROM ZACCOUNT;",
    });
    expect(result.row_count).toBe(1);
  });

  it("rejects empty queries", () => {
    expect(() => rawQuery(db, { sql: "" })).toThrow();
  });

  it("rejects whitespace-only queries", () => {
    expect(() => rawQuery(db, { sql: "   " })).toThrow();
  });
});

// This suite doesn't depend on a live Quicken database — it seeds its own
// synthetic on-disk SQLite file so these regressions are caught even in
// environments without a live Quicken bundle (which is exactly how the
// trailing-comment wrapping bug below first slipped through: the equivalent
// live-db-gated test in integration.test.ts was silently skipped here).
describe("raw_query (synthetic db)", () => {
  let dir: string;
  let syntheticDb: Database.Database;

  beforeAll(() => {
    dir = mkdtempSync(join(tmpdir(), "qmac-raw-query-synthetic-"));
    const dbPath = join(dir, "synthetic.db");
    const seedDb = new Database(dbPath);
    seedDb.exec("CREATE TABLE ZACCOUNT (Z_PK INTEGER, ZNAME TEXT)");
    seedDb.prepare("INSERT INTO ZACCOUNT (Z_PK, ZNAME) VALUES (1, 'Checking')").run();
    seedDb.close();
    syntheticDb = new Database(dbPath, { readonly: true });
  });

  afterAll(() => {
    syntheticDb?.close();
    if (dir) rmSync(dir, { recursive: true, force: true });
  });

  it("handles a trailing line comment (regression: comment used to swallow the wrapper's closing LIMIT)", () => {
    const result = rawQuery(syntheticDb, {
      sql: "SELECT COUNT(*) as cnt FROM ZACCOUNT -- this is a comment",
    });
    expect(result.row_count).toBe(1);
    expect((result.rows[0] as any).cnt).toBe(1);
  });

  it("rejects a result set whose serialized size exceeds the response byte cap", () => {
    // A single wide TEXT column can stay comfortably under the 500-row cap
    // while still ballooning the serialized response.
    const bigLiteral = "x".repeat(2_200_000);
    expect(() =>
      rawQuery(syntheticDb, { sql: `SELECT '${bigLiteral}' as blob FROM ZACCOUNT` })
    ).toThrow(/too large/i);
  });
});

// --- list_portfolio ---

describeWithDb("list_portfolio", () => {
  it("returns holdings with expected fields", () => {
    const result = listPortfolio(db, {});
    expect(result.length).toBeGreaterThan(0);
    const first = result[0];
    expect(first).toHaveProperty("account");
    expect(first).toHaveProperty("security");
    expect(first).toHaveProperty("ticker");
    expect(first).toHaveProperty("current_shares");
    expect(first).toHaveProperty("cost_basis");
  });

  it("only returns holdings with non-zero shares", () => {
    const result = listPortfolio(db, {});
    result.forEach((r: any) => {
      expect(r.current_shares).toBeGreaterThan(0);
    });
  });

  it("enriches with DB quotes by default", () => {
    const result = listPortfolio(db, {});
    const withPrice = result.filter((r: any) => r.price != null);
    expect(withPrice.length).toBeGreaterThan(0);
    withPrice.forEach((r: any) => {
      expect(r).toHaveProperty("price_date");
      expect(r).toHaveProperty("market_value");
    });
  });

  it("rounds money values to 2 decimal places", () => {
    const result = listPortfolio(db, {});
    result.forEach((r: any) => {
      if (r.market_value != null) {
        const str = r.market_value.toString();
        const decimals = str.includes(".") ? str.split(".")[1].length : 0;
        expect(decimals).toBeLessThanOrEqual(2);
      }
      if (r.gain_loss != null) {
        const str = r.gain_loss.toString();
        const decimals = str.includes(".") ? str.split(".")[1].length : 0;
        expect(decimals).toBeLessThanOrEqual(2);
      }
    });
  });

  it("filters by account_names", () => {
    const all = listPortfolio(db, {});
    const accounts = [...new Set(all.map((r: any) => r.account))];
    expect(accounts.length).toBeGreaterThan(1);

    const filtered = listPortfolio(db, { account_names: [accounts[0]] });
    expect(filtered.length).toBeGreaterThan(0);
    filtered.forEach((r: any) => {
      expect(r.account).toBe(accounts[0]);
    });
    expect(filtered.length).toBeLessThan(all.length);
  });

  it("returns empty array for nonexistent account", () => {
    const result = listPortfolio(db, { account_names: ["zzz_nonexistent_999"] });
    expect(result).toEqual([]);
  });

  it("omits gain_loss_pct when cost_basis is 0", () => {
    const result = listPortfolio(db, {});
    const zeroCost = result.filter((r: any) => r.cost_basis === 0 && r.price != null);
    zeroCost.forEach((r: any) => {
      expect(r).not.toHaveProperty("gain_loss_pct");
      expect(r).not.toHaveProperty("gain_loss");
    });
  });
});
