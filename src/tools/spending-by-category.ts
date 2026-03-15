/**
 * spending_by_category tool — Aggregate spending by category.
 *
 * Groups transaction split amounts by category name for a date range.
 * Can group by either the subcategory (e.g., "Groceries") or the parent
 * category (e.g., "Food & Dining"). Results are sorted by total amount
 * ascending (largest expenses first, since outflows are negative).
 */

import type Database from "better-sqlite3";
import { isoToCoreData, getCategoryTagEntityId } from "../db.js";

interface SpendingByCategoryArgs {
  start_date: string;
  end_date: string;
  account_types?: string[];
  account_names?: string[];
  group_by?: "category" | "parent_category";
}

export function spendingByCategory(db: Database.Database, args: SpendingByCategoryArgs) {
  const categoryTagEntityId = getCategoryTagEntityId(db);
  const groupBy = args.group_by || "parent_category";

  // When grouping by parent_category, fall back to the subcategory name
  // for categories that have no parent (i.e., top-level categories).
  const categoryExpr =
    groupBy === "parent_category" ? "COALESCE(parent_cat.ZNAME, cat.ZNAME)" : "cat.ZNAME";

  // Fall back to ZENTEREDDATE when ZPOSTEDDATE is null (e.g., CSV-imported accounts)
  const dateExpr = "COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE)";

  // account_names takes precedence over account_types when provided
  let accountFilter: string;
  let accountParams: any[];
  if (args.account_names?.length) {
    accountFilter = `a.ZNAME IN (${args.account_names.map(() => "?").join(",")})`;
    accountParams = [...args.account_names];
  } else {
    const accountTypes = (args.account_types || ["checking", "creditcard"]).map((t) =>
      t.toUpperCase()
    );
    accountFilter = `UPPER(a.ZTYPENAME) IN (${accountTypes.map(() => "?").join(",")})`;
    accountParams = [...accountTypes];
  }

  const sql = `
    SELECT
      ${categoryExpr} as category,
      SUM(s.ZAMOUNT) as total_amount,
      COUNT(*) as transaction_count
    FROM ZTRANSACTION t
    JOIN ZACCOUNT a ON t.ZACCOUNT = a.Z_PK
    LEFT JOIN ZCASHFLOWTRANSACTIONENTRY s ON s.ZPARENT = t.Z_PK
    LEFT JOIN ZTAG cat ON s.ZCATEGORYTAG = cat.Z_PK AND cat.Z_ENT = ${categoryTagEntityId}
    LEFT JOIN ZTAG parent_cat ON cat.ZPARENTCATEGORY = parent_cat.Z_PK
    WHERE ${dateExpr} >= ?
      AND ${dateExpr} <= ?
      AND ${accountFilter}
      AND s.ZAMOUNT IS NOT NULL
    GROUP BY ${categoryExpr}
    ORDER BY total_amount ASC
  `;

  const params = [
    isoToCoreData(args.start_date),
    isoToCoreData(args.end_date),
    ...accountParams,
  ];

  const rows = db.prepare(sql).all(...params);
  return rows.map((r: any) => ({
    ...r,
    total_amount: Math.round(r.total_amount * 100) / 100,
  }));
}
