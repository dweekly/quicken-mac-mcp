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
import { isoToCoreData, CORE_DATA_EPOCH_OFFSET } from "../db.js";

interface SpendingOverTimeArgs {
  start_date: string;
  end_date: string;
  account_types?: string[];
  group_by_category?: boolean;
}

export function spendingOverTime(db: Database.Database, args: SpendingOverTimeArgs) {
  const accountTypes = (args.account_types || ["checking", "creditcard"]).map((t) =>
    t.toUpperCase()
  );
  const placeholders = accountTypes.map(() => "?").join(",");

  // Conditionally add category column to SELECT and GROUP BY
  const categorySelect = args.group_by_category
    ? ", COALESCE(parent_cat.ZNAME, cat.ZNAME) as category"
    : "";
  const categoryGroup = args.group_by_category
    ? ", COALESCE(parent_cat.ZNAME, cat.ZNAME)"
    : "";

  const sql = `
    SELECT
      strftime('%Y-%m', t.ZPOSTEDDATE + ${CORE_DATA_EPOCH_OFFSET}, 'unixepoch') as month${categorySelect},
      SUM(s.ZAMOUNT) as total_amount,
      COUNT(*) as transaction_count
    FROM ZTRANSACTION t
    JOIN ZACCOUNT a ON t.ZACCOUNT = a.Z_PK
    LEFT JOIN ZCASHFLOWTRANSACTIONENTRY s ON s.ZPARENT = t.Z_PK
    LEFT JOIN ZTAG cat ON s.ZCATEGORYTAG = cat.Z_PK AND cat.Z_ENT = 79
    LEFT JOIN ZTAG parent_cat ON cat.ZPARENTCATEGORY = parent_cat.Z_PK
    WHERE t.ZPOSTEDDATE >= ?
      AND t.ZPOSTEDDATE <= ?
      AND UPPER(a.ZTYPENAME) IN (${placeholders})
      AND s.ZAMOUNT IS NOT NULL
    GROUP BY month${categoryGroup}
    ORDER BY month ASC${args.group_by_category ? ", total_amount ASC" : ""}
  `;

  const params = [
    isoToCoreData(args.start_date),
    isoToCoreData(args.end_date),
    ...accountTypes,
  ];

  const rows = db.prepare(sql).all(...params);
  return rows.map((r: any) => ({
    ...r,
    total_amount: Math.round(r.total_amount * 100) / 100,
  }));
}
