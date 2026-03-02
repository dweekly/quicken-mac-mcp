/**
 * list_accounts tool — List all Quicken accounts.
 *
 * Queries the ZACCOUNT table for account name, type, and status.
 * Account type comparison is case-insensitive (Quicken stores them as
 * uppercase like "CHECKING" but users may pass "checking").
 */

import type Database from "better-sqlite3";

export function listAccounts(db: Database.Database, args: { account_type?: string }) {
  let sql = `
    SELECT
      Z_PK as id,
      ZNAME as name,
      ZTYPENAME as type,
      ZACTIVE as active,
      ZCLOSED as closed
    FROM ZACCOUNT
  `;
  const params: string[] = [];

  if (args.account_type) {
    sql += " WHERE UPPER(ZTYPENAME) = UPPER(?)";
    params.push(args.account_type);
  }

  sql += " ORDER BY ZNAME";

  const rows = db.prepare(sql).all(...params);
  return rows.map((r: any) => ({
    ...r,
    active: r.active === 1,
    closed: r.closed === 1,
  }));
}
