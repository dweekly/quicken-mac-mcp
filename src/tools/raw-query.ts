/**
 * raw_query tool — Execute arbitrary read-only SQL.
 *
 * Allows power users to run custom SELECT queries against the Quicken
 * database. Safety measures:
 *   - Only SELECT statements are allowed (checked via regex)
 *   - Dangerous keywords (INSERT, UPDATE, DELETE, DROP, etc.) are blocked
 *   - Results are capped at 500 rows via an outer wrapper LIMIT
 *   - The database is opened read-only at the connection level as well
 */

import type Database from "better-sqlite3";

const MAX_ROWS = 500;

export function rawQuery(db: Database.Database, args: { sql: string }) {
  const trimmed = args.sql.trim();

  // Must start with SELECT
  if (!/^SELECT\s/i.test(trimmed)) {
    throw new Error("Only SELECT queries are allowed");
  }

  // Block write/DDL keywords even inside subqueries or CTEs
  const blocked =
    /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|PRAGMA)\b/i;
  if (blocked.test(trimmed)) {
    throw new Error("Query contains disallowed statements");
  }

  // Always run the caller's query as a subquery under a single outer LIMIT.
  // A regex looking for "the" LIMIT clause in the raw SQL can't tell an outer
  // LIMIT from one nested in a subquery/CTE — matching the wrong one would
  // cap an inner result set while leaving the actual output unbounded (e.g.
  // a join against an inner `... LIMIT 100000` subquery). Wrapping instead
  // guarantees the final row count is bounded regardless of what LIMIT
  // clauses, if any, appear inside the caller's query.
  const inner = trimmed.replace(/;\s*$/, "");
  const sql = `SELECT * FROM (${inner}) AS raw_query_result LIMIT ${MAX_ROWS}`;

  const rows = db.prepare(sql).all();
  return { row_count: rows.length, rows };
}
