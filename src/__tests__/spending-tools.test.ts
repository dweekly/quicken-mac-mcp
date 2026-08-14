import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type Database from "better-sqlite3";
import { createSyntheticQuickenDb } from "./fixtures/quicken.js";
import { queryTransactions } from "../tools/query-transactions.js";
import { spendingByCategory } from "../tools/spending-by-category.js";
import { spendingOverTime } from "../tools/spending-over-time.js";
import { toolsRegistry } from "../tools/registry.js";

describe("spending tool correctness", () => {
  let db: Database.Database;

  beforeEach(() => {
    db = createSyntheticQuickenDb();
  });

  afterEach(() => {
    db.close();
  });

  it("includes the entire end date and excludes the following day", () => {
    const rows = queryTransactions(db, {
      start_date: "2024-01-31",
      end_date: "2024-01-31",
      limit: 100,
    }) as Array<{ transaction_id: number }>;
    const ids = rows.map((row) => row.transaction_id);

    expect(ids).toContain(100);
    expect(ids).toContain(106);
    expect(ids).toContain(107);
    expect(ids).not.toContain(104);
  });

  it("counts transactions rather than split rows", () => {
    const rows = spendingOverTime(db, {
      start_date: "2024-01-01",
      end_date: "2024-01-31",
    }) as Array<{ month: string; total_amount: number; transaction_count: number }>;

    expect(rows).toEqual([
      { month: "2024-01", total_amount: -125, transaction_count: 3 },
    ]);
  });

  it("excludes transfers, report-excluded rows, income, and cash by default", () => {
    const rows = spendingByCategory(db, {
      start_date: "2024-01-01",
      end_date: "2024-01-31",
    }) as Array<{
      category: string | null;
      total_amount: number;
      transaction_count: number;
    }>;

    expect(rows).toEqual([
      { category: "Food", total_amount: -120, transaction_count: 2 },
      { category: "(Uncategorized)", total_amount: -5, transaction_count: 1 },
    ]);
  });

  it("includes cash only when explicitly requested", () => {
    const rows = spendingOverTime(db, {
      start_date: "2024-01-01",
      end_date: "2024-01-31",
      account_types: ["checking", "creditcard", "cash"],
    }) as Array<{ total_amount: number; transaction_count: number }>;

    expect(rows[0]).toMatchObject({ total_amount: -140, transaction_count: 4 });
  });

  it("preserves uncategorized spending in monthly category breakdowns", () => {
    const rows = spendingOverTime(db, {
      start_date: "2024-01-01",
      end_date: "2024-01-31",
      group_by_category: true,
    }) as Array<{ category: string | null }>;

    expect(rows.map((row) => row.category)).toContain("(Uncategorized)");
    expect(rows.every((row) => row.category !== null)).toBe(true);
  });

  it("discloses aggregate filtering assumptions in both tool descriptions", () => {
    for (const name of ["spending_by_category", "spending_over_time"]) {
      const description = toolsRegistry.find((tool) => tool.name === name)?.description;
      const normalized = description?.toLowerCase();
      expect(normalized).toContain("negative splits");
      expect(normalized).toContain("transfers");
      expect(normalized).toContain("report-excluded");
      expect(normalized).toContain("uncategorized");
      expect(normalized).toContain("checking + credit-card");
    }
  });
});
