/**
 * query_transactions tool — Flexible transaction query with filters.
 *
 * Joins ZTRANSACTION through ZCASHFLOWTRANSACTIONENTRY (split line items)
 * to retrieve category information. Because Quicken supports split
 * transactions (one transaction allocated across multiple categories),
 * a single transaction may produce multiple rows — one per split entry.
 *
 * Date conversion: ISO 8601 input dates are converted to Core Data
 * timestamps (seconds since 2001-01-01) for the WHERE clause, and
 * converted back to ISO 8601 in the output.
 */

import type Database from "better-sqlite3";
import { isoToCoreData, coreDataToIso, getCategoryTagEntityId } from "../db.js";

interface QueryTransactionsArgs {
  start_date?: string;
  end_date?: string;
  account_types?: string[];
  account_names?: string[];
  min_amount?: number;
  max_amount?: number;
  payee_search?: string;
  category?: string;
  limit?: number;
}

export function queryTransactions(db: Database.Database, args: QueryTransactionsArgs) {
  const categoryTagEntityId = getCategoryTagEntityId(db);
  const conditions: string[] = [];
  const params: any[] = [];

  // Fall back to ZENTEREDDATE when ZPOSTEDDATE is null (e.g., CSV-imported accounts)
  const dateExpr = "COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE)";

  if (args.start_date) {
    conditions.push(`${dateExpr} >= ?`);
    params.push(isoToCoreData(args.start_date));
  }
  if (args.end_date) {
    conditions.push(`${dateExpr} <= ?`);
    params.push(isoToCoreData(args.end_date));
  }
  if (args.account_types?.length) {
    // Case-insensitive account type matching
    conditions.push(
      `UPPER(a.ZTYPENAME) IN (${args.account_types.map(() => "UPPER(?)").join(",")})`
    );
    params.push(...args.account_types);
  }
  if (args.account_names?.length) {
    conditions.push(`a.ZNAME IN (${args.account_names.map(() => "?").join(",")})`);
    params.push(...args.account_names);
  }
  if (args.min_amount !== undefined) {
    conditions.push("s.ZAMOUNT >= ?");
    params.push(args.min_amount);
  }
  if (args.max_amount !== undefined) {
    conditions.push("s.ZAMOUNT <= ?");
    params.push(args.max_amount);
  }
  if (args.payee_search) {
    conditions.push("p.ZNAME LIKE ?");
    params.push(`%${args.payee_search}%`);
  }
  if (args.category) {
    // Match on either the subcategory or the parent category name
    conditions.push("(cat.ZNAME LIKE ? OR parent_cat.ZNAME LIKE ?)");
    params.push(`%${args.category}%`, `%${args.category}%`);
  }

  const limit = Math.min(args.limit || 100, 1000);

  const sql = `
    SELECT
      t.Z_PK as transaction_id,
      a.ZNAME as account_name,
      a.ZTYPENAME as account_type,
      p.ZNAME as payee,
      cat.ZNAME as category,
      parent_cat.ZNAME as parent_category,
      s.ZAMOUNT as amount,
      COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE) as posted_date_raw,
      t.ZNOTE as note
    FROM ZTRANSACTION t
    JOIN ZACCOUNT a ON t.ZACCOUNT = a.Z_PK
    LEFT JOIN ZUSERPAYEE p ON t.ZUSERPAYEE = p.Z_PK
    LEFT JOIN ZCASHFLOWTRANSACTIONENTRY s ON s.ZPARENT = t.Z_PK
    LEFT JOIN ZTAG cat ON s.ZCATEGORYTAG = cat.Z_PK AND cat.Z_ENT = ${categoryTagEntityId}
    LEFT JOIN ZTAG parent_cat ON cat.ZPARENTCATEGORY = parent_cat.Z_PK
    ${conditions.length ? "WHERE " + conditions.join(" AND ") : ""}
    ORDER BY COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE) DESC
    LIMIT ?
  `;
  params.push(limit);

  const rows = db.prepare(sql).all(...params);

  // Convert Core Data timestamps to ISO dates in the output
  return rows.map((r: any) => {
    const { posted_date_raw, ...rest } = r;
    return {
      ...rest,
      posted_date: posted_date_raw != null ? coreDataToIso(posted_date_raw) : null,
    };
  });
}
