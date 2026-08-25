/**
 * raw_query tool — Execute arbitrary read-only SQL.
 *
 * Allows power users to run custom SELECT queries against the Quicken
 * database. Safety measures:
 *   - Only SELECT statements are allowed (checked via regex)
 *   - Dangerous keywords (INSERT, UPDATE, DELETE, DROP, etc.) are blocked
 *   - Results are capped at 500 rows via an outer wrapper LIMIT
 *   - The serialized response is capped in size as well, since a handful of
 *     very large TEXT/BLOB values could stay under 500 rows yet still bloat
 *     the response
 *   - The database is opened read-only at the connection level as well
 */

import type Database from "better-sqlite3";

const MAX_ROWS = 500;
const MAX_RESPONSE_BYTES = 2 * 1024 * 1024; // 2 MB

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
  //
  // The wrapper's own closing tokens go on their own line: a trailing `--`
  // line comment in the caller's query (a common, previously-supported
  // pattern) only runs to end-of-line, so if `)`, the alias, and `LIMIT`
  // shared that line they'd be swallowed into the comment too, turning a
  // valid query into a syntax error.
  const inner = trimmed.replace(/;\s*$/, "");
  const sql = `SELECT * FROM (${inner}\n) AS raw_query_result LIMIT ${MAX_ROWS}`;

  const rows = db.prepare(sql).all();

  const responseBytes = Buffer.byteLength(JSON.stringify(rows), "utf8");
  if (responseBytes > MAX_RESPONSE_BYTES) {
    throw new Error(
      `Query result is too large (${(responseBytes / (1024 * 1024)).toFixed(1)} MB, ` +
        `limit ${MAX_RESPONSE_BYTES / (1024 * 1024)} MB). ` +
        "Narrow the query with more filters, fewer columns, or a smaller LIMIT."
    );
  }

  return { row_count: rows.length, rows };
}
