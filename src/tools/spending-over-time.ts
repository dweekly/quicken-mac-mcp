/**
 * spending_over_time tool — Monthly spending totals over a date range.
 *
 * Uses SQLite's strftime to bucket transactions by YYYY-MM month.
 * The Core Data timestamp is converted to Unix time inline in the SQL
 * (adding CORE_DATA_EPOCH_OFFSET) so strftime can process it.
 *
 * When group_by_category is true, results are further broken down by
 * parent category within each month.
 */

import type Database from "better-sqlite3";
import { isoToCoreData, CORE_DATA_EPOCH_OFFSET, getCategoryTagEntityId } from "../db.js";

interface SpendingOverTimeArgs {
  start_date: string;
  end_date: string;
  account_types?: string[];
  account_names?: string[];
  group_by_category?: boolean;
}

export function spendingOverTime(db: Database.Database, args: SpendingOverTimeArgs) {
  const categoryTagEntityId = getCategoryTagEntityId(db);

  // Conditionally add category column to SELECT and GROUP BY
  const categorySelect = args.group_by_category
    ? ", COALESCE(parent_cat.ZNAME, cat.ZNAME) as category"
    : "";
  const categoryGroup = args.group_by_category
    ? ", COALESCE(parent_cat.ZNAME, cat.ZNAME)"
    : "";

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
      strftime('%Y-%m', ${dateExpr} + ${CORE_DATA_EPOCH_OFFSET}, 'unixepoch') as month${categorySelect},
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
    GROUP BY month${categoryGroup}
    ORDER BY month ASC${args.group_by_category ? ", total_amount ASC" : ""}
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
