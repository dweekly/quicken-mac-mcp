/**
 * Shared result bounds for every MCP tool.
 *
 * raw_query bounds its own results because it runs arbitrary SQL, but the
 * same pressure exists for the curated tools on an unusually large Quicken
 * database: list_categories returns every category, and spending_over_time
 * grouped by category returns one row per month per category, so a
 * long-history file can produce a response far larger than an MCP client can
 * usefully consume. Bounding only raw_query left that gap open, so the caps
 * are applied in one place for all tools instead.
 *
 * Oversized results are rejected rather than truncated. These tools return
 * financial aggregates, and a silently truncated total is a wrong answer —
 * worse than an error that says how to narrow the request.
 */

/** Above every per-tool cap already in use (query_transactions 1000, search_payees 500). */
export const MAX_RESULT_ROWS = 5_000;
/** Matches the raw_query response cap, so all tools fail at the same size. */
export const MAX_RESULT_BYTES = 2 * 1024 * 1024;

/** Longest array in the result: tools return either a bare row array or an object wrapping one. */
function rowCount(result: unknown): number {
  if (Array.isArray(result)) return result.length;
  if (result && typeof result === "object") {
    return Math.max(
      0,
      ...Object.values(result).map((v) => (Array.isArray(v) ? v.length : 0))
    );
  }
  return 0;
}

/**
 * Throw if a tool result exceeds the shared row or byte cap.
 *
 * The byte check serializes the result a second time (the MCP layer
 * serializes it again to build the response). That is deliberate: the cost is
 * proportional to a response that is by definition already bounded, and it is
 * the only way to catch a result that is small in rows but large in bytes.
 */
export function enforceResultLimits<T>(toolName: string, result: T): T {
  const rows = rowCount(result);
  if (rows > MAX_RESULT_ROWS) {
    throw new Error(
      `${toolName} returned too many rows (${rows}, limit ${MAX_RESULT_ROWS}). ` +
        "Narrow the request with a shorter date range, an account filter, or a smaller limit."
    );
  }

  const serialized = JSON.stringify(result);
  const bytes = serialized === undefined ? 0 : Buffer.byteLength(serialized, "utf8");
  if (bytes > MAX_RESULT_BYTES) {
    throw new Error(
      `${toolName} result is too large (${(bytes / (1024 * 1024)).toFixed(1)} MB, ` +
        `limit ${MAX_RESULT_BYTES / (1024 * 1024)} MB). ` +
        "Narrow the request with a shorter date range, an account filter, or a smaller limit."
    );
  }

  return result;
}
