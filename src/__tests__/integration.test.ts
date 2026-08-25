/**
 * Rigorous integration tests against a real unlocked Quicken database.
 *
 * These tests validate structural invariants, cross-tool consistency,
 * data integrity, and edge cases. They never hardcode values specific
 * to any particular Quicken database — all assertions are generic
 * properties that must hold for any valid Quicken data file.
 *
 * Skipped with an explicit warning when no database is configured or can be
 * detected unambiguously. A configured but unusable database fails the suite.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { isoToCoreData, coreDataToIso, getCategoryTagEntityId } from "../db.js";
import { resolveLiveQuickenDb } from "./fixtures/live-quicken.js";
import { listAccounts } from "../tools/list-accounts.js";
import { listCategories } from "../tools/list-categories.js";
import { queryTransactions } from "../tools/query-transactions.js";
import { spendingByCategory } from "../tools/spending-by-category.js";
import { spendingOverTime } from "../tools/spending-over-time.js";
import { searchPayees } from "../tools/search-payees.js";
import { rawQuery } from "../tools/raw-query.js";
import { listPortfolio } from "../tools/list-portfolio.js";

// --- DB setup (same pattern as tools.test.ts) ---

const DB_PATH = resolveLiveQuickenDb("integration.test.ts", ["ZTRANSACTION"]);
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

// Helper: get a reasonable "recent" date range that should have data.
// Uses the most recent transaction date and looks back 12 months.
function getRecentDateRange(db: Database.Database): { start: string; end: string } {
  const row = db
    .prepare(
      "SELECT MAX(COALESCE(ZPOSTEDDATE, ZENTEREDDATE)) as latest FROM ZTRANSACTION WHERE COALESCE(ZPOSTEDDATE, ZENTEREDDATE) IS NOT NULL"
    )
    .get() as { latest: number };
  const end = coreDataToIso(row.latest);
  const endDate = new Date(end);
  endDate.setFullYear(endDate.getFullYear() - 1);
  const start = endDate.toISOString().split("T")[0];
  return { start, end };
}

// ============================================================
// getCategoryTagEntityId
// ============================================================

describeWithDb("getCategoryTagEntityId", () => {
  it("returns a positive integer from Z_PRIMARYKEY", () => {
    const entityId = getCategoryTagEntityId(db);
    expect(Number.isInteger(entityId)).toBe(true);
    expect(entityId).toBeGreaterThan(0);
  });

  it("matches actual CategoryTag rows in ZTAG", () => {
    const entityId = getCategoryTagEntityId(db);
    const { cnt } = db
      .prepare("SELECT COUNT(*) as cnt FROM ZTAG WHERE Z_ENT = ?")
      .get(entityId) as { cnt: number };
    expect(cnt).toBeGreaterThan(0);
  });

  it("is consistent across calls (cached)", () => {
    const first = getCategoryTagEntityId(db);
    const second = getCategoryTagEntityId(db);
    expect(first).toBe(second);
  });
});

// ============================================================
// Category hierarchy integrity
// ============================================================

describeWithDb("category hierarchy integrity", () => {
  it("every category with a parent references a valid parent", () => {
    const categories = listCategories(db, {}) as any[];
    const withParent = categories.filter((c) => c.parent_category != null);
    const allNames = new Set(categories.map((c) => c.name));
    // Parent category names should all exist as category names
    // (parents are top-level categories that also appear in the list)
    for (const c of withParent) {
      expect(allNames.has(c.parent_category)).toBe(true);
    }
  });

  it("no category is its own parent", () => {
    const categories = listCategories(db, {}) as any[];
    for (const c of categories) {
      if (c.parent_category != null) {
        expect(c.name).not.toBe(c.parent_category);
      }
    }
  });

  it("expense and income categories are mutually exclusive", () => {
    const expenses = listCategories(db, { type: "expense" }) as any[];
    const income = listCategories(db, { type: "income" }) as any[];
    const expenseIds = new Set(expenses.map((c) => c.id));
    for (const c of income) {
      expect(expenseIds.has(c.id)).toBe(false);
    }
  });

  it("expense subcategories have expense parents, income subcategories have income parents", () => {
    // Only check expense/income categories — "other" types may mix
    const categories = listCategories(db, {}) as any[];
    const byName = new Map(categories.map((c) => [c.name, c]));
    for (const c of categories) {
      if (
        c.parent_category &&
        byName.has(c.parent_category) &&
        (c.type === "expense" || c.type === "income")
      ) {
        const parent = byName.get(c.parent_category)!;
        if (parent.type === "expense" || parent.type === "income") {
          expect(c.type).toBe(parent.type);
        }
      }
    }
  });
});

// ============================================================
// Cross-tool consistency: accounts
// ============================================================

describeWithDb("cross-tool consistency: accounts", () => {
  it("account types from list_accounts appear in query_transactions", () => {
    const accounts = listAccounts(db, {}) as any[];
    const types = [...new Set(accounts.map((a: any) => a.type.toUpperCase()))];
    // Pick one type that should have transactions
    const checkingAccounts = accounts.filter(
      (a: any) =>
        a.type.toUpperCase() === "CHECKING" || a.type.toUpperCase() === "CREDITCARD"
    );
    if (checkingAccounts.length > 0) {
      const txns = queryTransactions(db, {
        account_types: [checkingAccounts[0].type],
        limit: 5,
      }) as any[];
      if (txns.length > 0) {
        txns.forEach((t) => {
          expect(t.account_type.toUpperCase()).toBe(
            checkingAccounts[0].type.toUpperCase()
          );
        });
      }
    }
    // At minimum, verify types is non-empty
    expect(types.length).toBeGreaterThan(0);
  });

  it("account names from list_accounts can be used in query_transactions", () => {
    const accounts = listAccounts(db, {}) as any[];
    const activeAccounts = accounts.filter((a: any) => a.active);
    expect(activeAccounts.length).toBeGreaterThan(0);

    // Pick an active account and query its transactions
    const targetName = activeAccounts[0].name;
    const txns = queryTransactions(db, {
      account_names: [targetName],
      limit: 10,
    }) as any[];
    txns.forEach((t) => {
      expect(t.account_name).toBe(targetName);
    });
  });

  it("all transaction account names exist in list_accounts", () => {
    const accounts = listAccounts(db, {}) as any[];
    const accountNames = new Set(accounts.map((a: any) => a.name));
    const txns = queryTransactions(db, { limit: 100 }) as any[];
    for (const t of txns) {
      expect(accountNames.has(t.account_name)).toBe(true);
    }
  });
});

// ============================================================
// Cross-tool consistency: spending totals
// ============================================================

describeWithDb("cross-tool consistency: spending totals", () => {
  it("spending_over_time total matches spending_by_category total for same range", () => {
    const range = getRecentDateRange(db);
    const byCategory = spendingByCategory(db, {
      start_date: range.start,
      end_date: range.end,
    }) as any[];
    const overTime = spendingOverTime(db, {
      start_date: range.start,
      end_date: range.end,
    }) as any[];

    const categoryTotal = byCategory.reduce(
      (sum: number, r: any) => sum + r.total_amount,
      0
    );
    const timeTotal = overTime.reduce((sum: number, r: any) => sum + r.total_amount, 0);

    // Totals should match within floating point tolerance
    expect(Math.abs(categoryTotal - timeTotal)).toBeLessThan(0.02);
  });

  it("spending_over_time with category breakdown sums to same total", () => {
    const range = getRecentDateRange(db);
    const flat = spendingOverTime(db, {
      start_date: range.start,
      end_date: range.end,
    }) as any[];
    const byCategory = spendingOverTime(db, {
      start_date: range.start,
      end_date: range.end,
      group_by_category: true,
    }) as any[];

    const flatTotal = flat.reduce((s: number, r: any) => s + r.total_amount, 0);
    const catTotal = byCategory.reduce((s: number, r: any) => s + r.total_amount, 0);
    expect(Math.abs(flatTotal - catTotal)).toBeLessThan(0.02);
  });

  it("transaction count is consistent between flat and category views", () => {
    const range = getRecentDateRange(db);
    const flat = spendingOverTime(db, {
      start_date: range.start,
      end_date: range.end,
    }) as any[];
    const byCategory = spendingOverTime(db, {
      start_date: range.start,
      end_date: range.end,
      group_by_category: true,
    }) as any[];

    const flatCount = flat.reduce((s: number, r: any) => s + r.transaction_count, 0);
    const catCount = byCategory.reduce((s: number, r: any) => s + r.transaction_count, 0);
    expect(flatCount).toBe(catCount);
  });
});

// ============================================================
// Date handling
// ============================================================

describeWithDb("date handling", () => {
  it("all transaction dates fall within the requested range", () => {
    const range = getRecentDateRange(db);
    const txns = queryTransactions(db, {
      start_date: range.start,
      end_date: range.end,
      limit: 200,
    }) as any[];
    for (const t of txns) {
      if (t.posted_date) {
        expect(t.posted_date >= range.start).toBe(true);
        expect(t.posted_date <= range.end).toBe(true);
      }
    }
  });

  it("transactions are sorted newest-first by default", () => {
    const txns = queryTransactions(db, { limit: 50 }) as any[];
    for (let i = 1; i < txns.length; i++) {
      if (txns[i].posted_date && txns[i - 1].posted_date) {
        expect(txns[i].posted_date <= txns[i - 1].posted_date).toBe(true);
      }
    }
  });

  it("empty date range returns no results", () => {
    // A range in the distant future should have no transactions
    const txns = queryTransactions(db, {
      start_date: "2099-01-01",
      end_date: "2099-12-31",
      limit: 10,
    }) as any[];
    expect(txns.length).toBe(0);
  });

  it("narrow date range returns only matching dates", () => {
    // isoToCoreData converts to midnight, so same-day start/end only matches
    // transactions timestamped at exactly midnight. Use a 2-day window instead.
    const recent = queryTransactions(db, {
      account_types: ["checking", "creditcard"],
      limit: 10,
    }) as any[];
    const withDate = recent.filter((t) => t.posted_date != null);
    if (withDate.length > 0) {
      const day = withDate[0].posted_date;
      // Extend end by one day to cover full day's transactions
      const nextDay = new Date(day);
      nextDay.setDate(nextDay.getDate() + 1);
      const end = nextDay.toISOString().split("T")[0];
      const dayTxns = queryTransactions(db, {
        start_date: day,
        end_date: end,
        account_types: ["checking", "creditcard"],
        limit: 100,
      }) as any[];
      expect(dayTxns.length).toBeGreaterThan(0);
      dayTxns.forEach((t) => {
        expect(t.posted_date >= day).toBe(true);
        expect(t.posted_date <= end).toBe(true);
      });
    }
  });

  it("isoToCoreData and coreDataToIso are exact inverses", () => {
    // Test with a date from actual data
    const row = db
      .prepare(
        "SELECT ZPOSTEDDATE FROM ZTRANSACTION WHERE ZPOSTEDDATE IS NOT NULL LIMIT 1"
      )
      .get() as { ZPOSTEDDATE: number };
    const iso = coreDataToIso(row.ZPOSTEDDATE);
    const roundTripped = isoToCoreData(iso);
    // The round-trip might lose time-of-day (coreDataToIso returns date only),
    // but converting back should give a timestamp on the same day
    const originalDate = coreDataToIso(roundTripped);
    expect(originalDate).toBe(iso);
  });

  it("COALESCE date fallback recovers null-ZPOSTEDDATE transactions", () => {
    // Check if this DB has any transactions with null ZPOSTEDDATE
    const { cnt } = db
      .prepare(
        "SELECT COUNT(*) as cnt FROM ZTRANSACTION WHERE ZPOSTEDDATE IS NULL AND ZENTEREDDATE IS NOT NULL"
      )
      .get() as { cnt: number };
    if (cnt > 0) {
      // These transactions should still appear with dates via COALESCE
      const txns = queryTransactions(db, { limit: 1000 }) as any[];
      const withDates = txns.filter((t) => t.posted_date != null);
      // At least some should have dates (mix of ZPOSTEDDATE and ZENTEREDDATE sources)
      expect(withDates.length).toBe(txns.length);
    }
  });
});

// ============================================================
// Transaction data integrity
// ============================================================

describeWithDb("transaction data integrity", () => {
  it("every transaction has an account name and type", () => {
    const txns = queryTransactions(db, { limit: 200 }) as any[];
    for (const t of txns) {
      expect(t.account_name).toBeTruthy();
      expect(t.account_type).toBeTruthy();
    }
  });

  it("all amounts are finite numbers", () => {
    const txns = queryTransactions(db, { limit: 200 }) as any[];
    for (const t of txns) {
      if (t.amount != null) {
        expect(Number.isFinite(t.amount)).toBe(true);
      }
    }
  });

  it("transaction_id is unique per row", () => {
    // Note: transaction_id is NOT unique per result row because of splits,
    // but the combination of (transaction_id, category, amount) should be
    const txns = queryTransactions(db, { limit: 200 }) as any[];
    const keys = txns.map((t) => `${t.transaction_id}|${t.category}|${t.amount}`);
    const uniqueKeys = new Set(keys);
    expect(uniqueKeys.size).toBe(keys.length);
  });

  it("split transactions produce multiple rows with same transaction_id", () => {
    // Look for a transaction_id that appears more than once
    const txns = queryTransactions(db, { limit: 500 }) as any[];
    const idCounts = new Map<number, number>();
    for (const t of txns) {
      idCounts.set(t.transaction_id, (idCounts.get(t.transaction_id) || 0) + 1);
    }
    const splits = [...idCounts.entries()].filter(([, count]) => count > 1);
    if (splits.length > 0) {
      // Verify the split rows share the same account but have different categories or amounts
      const [splitId] = splits[0];
      const splitRows = txns.filter((t) => t.transaction_id === splitId);
      const accounts = new Set(splitRows.map((t) => t.account_name));
      expect(accounts.size).toBe(1); // same account
      // Categories or amounts should differ between split entries
      const catAmtPairs = new Set(splitRows.map((t) => `${t.category}|${t.amount}`));
      expect(catAmtPairs.size).toBeGreaterThan(1);
    }
  });

  it("category field uses dynamic Z_ENT lookup (not hardcoded)", () => {
    // Verify that when categories exist in the DB, they appear in transactions
    const categories = listCategories(db, {}) as any[];
    if (categories.length > 0) {
      const range = getRecentDateRange(db);
      const txns = queryTransactions(db, {
        start_date: range.start,
        end_date: range.end,
        limit: 500,
      }) as any[];
      const categorized = txns.filter((t) => t.category != null);
      // If there are categories in the DB, at least some transactions should be categorized
      expect(categorized.length).toBeGreaterThan(0);

      // All returned category names should exist in the category list
      const categoryNames = new Set(categories.map((c: any) => c.name));
      for (const t of categorized) {
        expect(categoryNames.has(t.category)).toBe(true);
      }
    }
  });
});

// ============================================================
// Spending aggregation integrity
// ============================================================

describeWithDb("spending aggregation integrity", () => {
  it("spending_by_category amounts are sorted ascending (biggest expenses first)", () => {
    const range = getRecentDateRange(db);
    const result = spendingByCategory(db, {
      start_date: range.start,
      end_date: range.end,
    }) as any[];
    for (let i = 1; i < result.length; i++) {
      expect(result[i].total_amount).toBeGreaterThanOrEqual(result[i - 1].total_amount);
    }
  });

  it("spending_by_category transaction counts are positive", () => {
    const range = getRecentDateRange(db);
    const result = spendingByCategory(db, {
      start_date: range.start,
      end_date: range.end,
    }) as any[];
    for (const r of result) {
      expect(r.transaction_count).toBeGreaterThan(0);
    }
  });

  it("spending_over_time months cover the full requested range", () => {
    const range = getRecentDateRange(db);
    const result = spendingOverTime(db, {
      start_date: range.start,
      end_date: range.end,
    }) as any[];
    if (result.length > 0) {
      const firstMonth = result[0].month as string;
      const lastMonth = result[result.length - 1].month as string;
      // String comparison works for YYYY-MM format
      expect(firstMonth <= range.end.slice(0, 7)).toBe(true);
      expect(lastMonth >= range.start.slice(0, 7)).toBe(true);
    }
  });

  it("no duplicate months in spending_over_time (flat view)", () => {
    const range = getRecentDateRange(db);
    const result = spendingOverTime(db, {
      start_date: range.start,
      end_date: range.end,
    }) as any[];
    const months = result.map((r: any) => r.month);
    expect(new Set(months).size).toBe(months.length);
  });

  it("spending_by_category subcategory count >= parent category count", () => {
    const range = getRecentDateRange(db);
    const byParent = spendingByCategory(db, {
      start_date: range.start,
      end_date: range.end,
      group_by: "parent_category",
    }) as any[];
    const bySub = spendingByCategory(db, {
      start_date: range.start,
      end_date: range.end,
      group_by: "category",
    }) as any[];
    expect(bySub.length).toBeGreaterThanOrEqual(byParent.length);
  });

  it("restricting to one account type produces subset of default results", () => {
    const range = getRecentDateRange(db);
    const defaultResult = spendingByCategory(db, {
      start_date: range.start,
      end_date: range.end,
    }) as any[];
    const defaultTotal = defaultResult.reduce(
      (s: number, r: any) => s + Math.abs(r.total_amount),
      0
    );

    // creditcard-only should be <= the default (checking + creditcard)
    const ccOnly = spendingByCategory(db, {
      start_date: range.start,
      end_date: range.end,
      account_types: ["creditcard"],
    }) as any[];
    const ccTotal = ccOnly.reduce((s: number, r: any) => s + Math.abs(r.total_amount), 0);
    expect(ccTotal).toBeLessThanOrEqual(defaultTotal + 0.01);
  });
});

// ============================================================
// Payee search
// ============================================================

describeWithDb("payee search", () => {
  it("search is case-insensitive", () => {
    // Find any payee name first
    const result = searchPayees(db, { query: "a", limit: 1 }) as any[];
    if (result.length > 0) {
      const payeeName = result[0].payee;
      const lower = searchPayees(db, { query: payeeName.toLowerCase() }) as any[];
      const upper = searchPayees(db, { query: payeeName.toUpperCase() }) as any[];
      // Should find at least the same payee in both
      const lowerNames = new Set(lower.map((r: any) => r.payee));
      const upperNames = new Set(upper.map((r: any) => r.payee));
      expect(lowerNames.has(payeeName)).toBe(true);
      expect(upperNames.has(payeeName)).toBe(true);
    }
  });

  it("partial match finds superset of exact match", () => {
    const broad = searchPayees(db, { query: "a" }) as any[];
    if (broad.length > 0) {
      const specificPayee = broad[0].payee;
      const specific = searchPayees(db, { query: specificPayee }) as any[];
      // Specific search should include the payee (and possibly others matching the substring)
      const names = specific.map((r: any) => r.payee);
      expect(names).toContain(specificPayee);
    }
  });

  it("transaction_count is positive for all results", () => {
    const result = searchPayees(db, { query: "a" }) as any[];
    for (const r of result) {
      expect((r as any).transaction_count).toBeGreaterThan(0);
    }
  });

  it("payee names are non-empty strings", () => {
    const result = searchPayees(db, { query: "a" }) as any[];
    for (const r of result) {
      expect(typeof (r as any).payee).toBe("string");
      expect((r as any).payee.length).toBeGreaterThan(0);
    }
  });
});

// ============================================================
// Raw query safety
// ============================================================

// Statement validation is not exercised here: it rejects a query before the
// database is opened, so it needs no live data and belongs in the synthetic
// suite in tools.test.ts, where it runs in every environment. What remains
// are the queries that only mean something against a real Quicken file.
describeWithDb("raw_query against live data", () => {
  it("caps user-specified LIMIT above 500 to 500", async () => {
    const result = await rawQuery(db, {
      sql: "SELECT * FROM ZTRANSACTION LIMIT 9999",
    });
    expect(result.row_count).toBeLessThanOrEqual(500);
  });

  it("handles subqueries in SELECT", async () => {
    const result = await rawQuery(db, {
      sql: "SELECT (SELECT COUNT(*) FROM ZACCOUNT) as account_count, (SELECT COUNT(*) FROM ZTRANSACTION) as txn_count",
    });
    expect(result.row_count).toBe(1);
    expect((result.rows[0] as any).account_count).toBeGreaterThan(0);
    expect((result.rows[0] as any).txn_count).toBeGreaterThan(0);
  });

  it("handles JOIN queries", async () => {
    const result = await rawQuery(db, {
      sql: "SELECT a.ZNAME, COUNT(t.Z_PK) as cnt FROM ZACCOUNT a LEFT JOIN ZTRANSACTION t ON t.ZACCOUNT = a.Z_PK GROUP BY a.ZNAME LIMIT 5",
    });
    expect(result.row_count).toBeGreaterThan(0);
  });
});

// ============================================================
// Portfolio data integrity
// ============================================================

describeWithDb("portfolio data integrity", () => {
  it("all holdings have positive share counts", () => {
    const result = listPortfolio(db, {}) as any[];
    for (const h of result) {
      expect(h.current_shares).toBeGreaterThan(0);
    }
  });

  it("market_value = price * current_shares (within rounding)", () => {
    const result = listPortfolio(db, {}) as any[];
    const priced = result.filter((h: any) => h.price != null && h.market_value != null);
    for (const h of priced) {
      const expected = Math.round(h.price * h.current_shares * 100) / 100;
      expect(Math.abs(h.market_value - expected)).toBeLessThan(0.02);
    }
  });

  it("gain_loss = market_value - cost_basis (when present)", () => {
    const result = listPortfolio(db, {}) as any[];
    const withGain = result.filter(
      (h: any) => h.gain_loss != null && h.market_value != null && h.cost_basis != null
    );
    for (const h of withGain) {
      const expected = Math.round((h.market_value - h.cost_basis) * 100) / 100;
      expect(Math.abs(h.gain_loss - expected)).toBeLessThan(0.02);
    }
  });

  it("gain_loss_pct is correct (when present)", () => {
    const result = listPortfolio(db, {}) as any[];
    const withPct = result.filter(
      (h: any) => h.gain_loss_pct != null && h.cost_basis > 0
    );
    for (const h of withPct) {
      const expected =
        Math.round(((h.market_value - h.cost_basis) / h.cost_basis) * 10000) / 100;
      expect(Math.abs(h.gain_loss_pct - expected)).toBeLessThan(0.02);
    }
  });

  it("price_date is ISO format when present", () => {
    const result = listPortfolio(db, {}) as any[];
    const withDate = result.filter((h: any) => h.price_date != null);
    for (const h of withDate) {
      expect(h.price_date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
    }
  });

  it("tickers are non-empty strings", () => {
    const result = listPortfolio(db, {}) as any[];
    for (const h of result) {
      if (h.ticker != null) {
        expect(typeof h.ticker).toBe("string");
        expect(h.ticker.length).toBeGreaterThan(0);
      }
    }
  });

  it("filtering by multiple account names returns union", () => {
    const all = listPortfolio(db, {}) as any[];
    const accounts = [...new Set(all.map((h: any) => h.account))];
    if (accounts.length >= 2) {
      const single1 = listPortfolio(db, { account_names: [accounts[0]] }) as any[];
      const single2 = listPortfolio(db, { account_names: [accounts[1]] }) as any[];
      const combined = listPortfolio(db, {
        account_names: [accounts[0], accounts[1]],
      }) as any[];
      expect(combined.length).toBe(single1.length + single2.length);
    }
  });
});

// ============================================================
// Schema consistency (Z_PRIMARYKEY)
// ============================================================

describeWithDb("schema consistency", () => {
  it("Z_PRIMARYKEY contains all expected Core Data entities", async () => {
    const result = await rawQuery(db, {
      sql: "SELECT Z_NAME FROM Z_PRIMARYKEY ORDER BY Z_NAME",
    });
    const names = result.rows.map((r: any) => r.Z_NAME);
    // These entities are fundamental to Quicken and must exist
    const required = [
      "Account",
      "Transaction",
      "CashFlowTransactionEntry",
      "Tag",
      "CategoryTag",
      "UserPayee",
      "Security",
      "Position",
    ];
    for (const name of required) {
      expect(names).toContain(name);
    }
  });

  it("all key tables exist in sqlite_master", async () => {
    const result = await rawQuery(db, {
      sql: "SELECT name FROM sqlite_master WHERE type='table' ORDER BY name",
    });
    const tables = result.rows.map((r: any) => r.name);
    const required = [
      "ZACCOUNT",
      "ZTRANSACTION",
      "ZCASHFLOWTRANSACTIONENTRY",
      "ZTAG",
      "ZUSERPAYEE",
      "ZSECURITY",
      "ZPOSITION",
      "ZSECURITYQUOTE",
      "Z_PRIMARYKEY",
    ];
    for (const table of required) {
      expect(tables).toContain(table);
    }
  });

  it("Z_ENT values in Z_PRIMARYKEY are unique", async () => {
    const result = await rawQuery(db, {
      sql: "SELECT Z_ENT, COUNT(*) as cnt FROM Z_PRIMARYKEY GROUP BY Z_ENT HAVING cnt > 1",
    });
    expect(result.row_count).toBe(0);
  });

  it("ZCASHFLOWTRANSACTIONENTRY has ZPARENT column for transaction FK", async () => {
    const result = await rawQuery(db, {
      sql: "SELECT COUNT(*) as cnt FROM ZCASHFLOWTRANSACTIONENTRY WHERE ZPARENT IS NOT NULL",
    });
    expect((result.rows[0] as any).cnt).toBeGreaterThan(0);
  });
});

// ============================================================
// Edge cases and defensive behavior
// ============================================================

describeWithDb("edge cases", () => {
  it("querying with all filters empty returns results", () => {
    const txns = queryTransactions(db, {}) as any[];
    expect(txns.length).toBeGreaterThan(0);
  });

  it("querying with non-overlapping account_types and account_names narrows correctly", () => {
    // account_names should be additive with account_types in query_transactions
    const accounts = listAccounts(db, {}) as any[];
    const checkingAccount = accounts.find(
      (a: any) => a.type.toUpperCase() === "CHECKING" && a.active
    );
    if (checkingAccount) {
      const byName = queryTransactions(db, {
        account_names: [checkingAccount.name],
        limit: 10,
      }) as any[];
      byName.forEach((t) => expect(t.account_name).toBe(checkingAccount.name));
    }
  });

  it("payee_search with special characters doesn't crash", () => {
    // SQL LIKE special chars
    const result = queryTransactions(db, {
      payee_search: "%_'\"\\",
      limit: 5,
    }) as any[];
    // Should either return results or empty, but not throw
    expect(Array.isArray(result)).toBe(true);
  });

  it("category filter with special characters doesn't crash", () => {
    const result = queryTransactions(db, {
      category: "%_'\"\\",
      limit: 5,
    }) as any[];
    expect(Array.isArray(result)).toBe(true);
  });

  it("searchPayees with single character works", () => {
    const result = searchPayees(db, { query: "x" }) as any[];
    expect(Array.isArray(result)).toBe(true);
  });

  it("spending tools handle very old date ranges gracefully", () => {
    const result = spendingByCategory(db, {
      start_date: "1990-01-01",
      end_date: "1990-12-31",
    }) as any[];
    // Should return empty, not error
    expect(Array.isArray(result)).toBe(true);
  });
});
