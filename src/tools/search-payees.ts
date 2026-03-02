/**
 * search_payees tool — Search payees by name.
 *
 * Performs a case-insensitive LIKE search on the ZUSERPAYEE table,
 * counting the number of transactions associated with each matching payee.
 * Results are sorted by transaction count (most frequent first).
 */

import type Database from "better-sqlite3";

export function searchPayees(
  db: Database.Database,
  args: { query: string; limit?: number }
) {
  const limit = Math.min(args.limit || 50, 500);

  const sql = `
    SELECT
      p.ZNAME as payee,
      COUNT(t.Z_PK) as transaction_count
    FROM ZUSERPAYEE p
    LEFT JOIN ZTRANSACTION t ON t.ZUSERPAYEE = p.Z_PK
    WHERE p.ZNAME LIKE ?
    GROUP BY p.Z_PK, p.ZNAME
    ORDER BY transaction_count DESC
    LIMIT ?
  `;

  return db.prepare(sql).all(`%${args.query}%`, limit);
}
