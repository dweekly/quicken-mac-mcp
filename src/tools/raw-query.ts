/**
 * raw_query tool — Execute arbitrary read-only SQL.
 *
 * Allows power users to run custom SELECT queries against the Quicken
 * database. Safety measures:
 *   - Only SELECT statements are allowed (checked via regex)
 *   - Dangerous keywords (INSERT, UPDATE, DELETE, DROP, etc.) are blocked
 *   - Results are capped at 500 rows (LIMIT is injected if missing)
 *   - The database is opened read-only at the connection level as well
 */

import type Database from "better-sqlite3";

export function rawQuery(db: Database.Database, args: { sql: string }) {
  const trimmed = args.sql.trim();

  // Must start with SELECT
  if (!/^SELECT\s/i.test(trimmed)) {
    throw new Error("Only SELECT queries are allowed");
  }

  // Block write/DDL keywords even inside subqueries or CTEs. The PRAGMA
  // check also matches SQLite's pragma_*() table-valued functions (e.g.
  // pragma_database_list(), pragma_table_info()) — a bare \bPRAGMA\b would
  // miss these since "_" is a word character and prevents the boundary
  // match, letting pragma-derived metadata leak past the blocklist.
  const blocked =
    /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|PRAGMA|PRAGMA_\w*)\b/i;
  if (blocked.test(trimmed)) {
    throw new Error("Query contains disallowed statements");
  }

  // Inject or cap the LIMIT clause (max 500 rows)
  let sql = trimmed;
  const limitMatch = sql.match(/\bLIMIT\s+(\d+)/i);
  if (limitMatch) {
    const n = Math.min(parseInt(limitMatch[1], 10), 500);
    sql = sql.replace(/\bLIMIT\s+\d+/i, `LIMIT ${n}`);
  } else {
    sql = sql.replace(/;?\s*$/, " LIMIT 500");
  }

  const rows = db.prepare(sql).all();
  return { row_count: rows.length, rows };
}
