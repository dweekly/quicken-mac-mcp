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
 *     the response. That check lives in the child process, before the rows
 *     cross the IPC channel, so an outsized result is never serialized twice
 *   - The database is opened read-only at the connection level as well
 *   - The query runs in a child process with a wall-clock timeout, so an
 *     expensive query can't hang the whole MCP server (see raw-query-runner.ts)
 *   - At most a few queries run concurrently — each child process can burn
 *     CPU for up to the full timeout, so unbounded concurrency would let a
 *     burst of calls spawn unbounded simultaneous child processes
 */

import type Database from "better-sqlite3";
import { fork, type ChildProcess } from "node:child_process";

const DEFAULT_QUERY_TIMEOUT_MS = 10_000;
const MAX_ROWS = 500;
const MAX_CONCURRENT_QUERIES = 3;

let activeQueries = 0;
const waitQueue: Array<() => void> = [];

/** Acquire one of MAX_CONCURRENT_QUERIES slots, queuing if none are free. */
function acquireSlot(): Promise<() => void> {
  return new Promise((resolve) => {
    const grant = () => {
      activeQueries++;
      resolve(() => {
        activeQueries--;
        const next = waitQueue.shift();
        if (next) next();
      });
    };
    if (activeQueries < MAX_CONCURRENT_QUERIES) {
      grant();
    } else {
      waitQueue.push(grant);
    }
  });
}

// Under `tsx`/dev the running module is the .ts source; under the compiled
// `dist/` build it's .js. The runner is resolved through Node's own module
// loader, so it has to be addressed with whichever extension actually
// exists next to this module at runtime.
function runnerPath(): URL {
  const ext = import.meta.url.endsWith(".ts") ? ".ts" : ".js";
  return new URL(`./raw-query-runner${ext}`, import.meta.url);
}

interface RunnerResponse {
  ok: boolean;
  rows?: unknown[];
  message?: string;
}

function runInChildProcess(
  dbPath: string,
  sql: string,
  timeoutMs: number
): Promise<unknown[]> {
  return new Promise((resolve, reject) => {
    const child = fork(runnerPath(), { stdio: "ignore" });
    _internal.onChildSpawn?.(child);
    let settled = false;

    const settle = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };

    const timer = setTimeout(() => {
      settle(() =>
        reject(
          new Error(
            `Query timed out after ${timeoutMs / 1000}s. ` +
              "Try narrowing the query with more filters or a smaller LIMIT."
          )
        )
      );
      // SIGKILL is the only thing guaranteed to reclaim a process stuck in a
      // long native SQLite call — a graceful signal or Worker#terminate()
      // can't preempt code that never yields back to the JS event loop.
      child.kill("SIGKILL");
    }, timeoutMs);

    child.once("message", (msg: RunnerResponse) => {
      settle(() => (msg.ok ? resolve(msg.rows ?? []) : reject(new Error(msg.message))));
      child.kill();
    });

    child.once("error", (err) => {
      settle(() => reject(err));
    });

    child.once("exit", (code, signal) => {
      settle(() =>
        reject(
          new Error(`Query process exited unexpectedly (code=${code}, signal=${signal})`)
        )
      );
    });

    child.send({ dbPath, sql });
  });
}

/** Exposed for tests only — not part of the tool's public surface. */
export const _internal = {
  /** Lets a test verify the concurrency cap deterministically, without spawning real child processes. */
  acquireSlot,
  MAX_CONCURRENT_QUERIES,
  /**
   * Notified with each child process as it is forked, so a test can hold the
   * handle and assert the timeout path actually reaps it. Left undefined in
   * production, where nothing should be retaining child process references.
   */
  onChildSpawn: undefined as ((child: ChildProcess) => void) | undefined,
};

/**
 * Remove a trailing statement terminator before the query is wrapped.
 *
 * A subquery cannot contain ";", so a caller's trailing semicolon has to go.
 * `/;\s*$/` only reached a semicolon at the very end of the text, so the
 * common "SELECT ...;  -- note" form still failed with an opaque SQLite
 * syntax error, which is the case Codex's review called out.
 *
 * Finding the real end of the statement means knowing which characters are
 * code and which are comment or literal text, so this walks the string once,
 * tracking quoting and comment state. That is deliberately all it does: this
 * is normalization, not validation. The statement policy above is still the
 * regex blocklist, and replacing that with a real parser remains open work.
 */
function stripTrailingTerminator(sql: string): string {
  let inSingle = false;
  let inDouble = false;
  let inBracket = false;
  let inBacktick = false;
  let inLineComment = false;
  let inBlockComment = false;
  // Last character that is part of the statement itself — comment text does
  // not count, but literal text does ("SELECT ';'" ends in a quote, not a
  // terminator).
  let lastCodeIndex = -1;

  for (let i = 0; i < sql.length; i++) {
    const c = sql[i];
    const next = sql[i + 1];

    if (inLineComment) {
      if (c === "\n") inLineComment = false;
      continue;
    }
    if (inBlockComment) {
      if (c === "*" && next === "/") {
        inBlockComment = false;
        i++;
      }
      continue;
    }
    if (inSingle || inDouble || inBacktick) {
      const quote = inSingle ? "'" : inDouble ? '"' : "`";
      if (c === quote) {
        // A doubled quote is an escaped quote, not the end of the literal.
        if (next === quote) i++;
        else if (inSingle) inSingle = false;
        else if (inDouble) inDouble = false;
        else inBacktick = false;
      }
      lastCodeIndex = i;
      continue;
    }
    if (inBracket) {
      if (c === "]") inBracket = false;
      lastCodeIndex = i;
      continue;
    }

    if (c === "-" && next === "-") {
      inLineComment = true;
      i++;
      continue;
    }
    if (c === "/" && next === "*") {
      inBlockComment = true;
      i++;
      continue;
    }
    if (c === "'") inSingle = true;
    else if (c === '"') inDouble = true;
    else if (c === "`") inBacktick = true;
    else if (c === "[") inBracket = true;

    if (!/\s/.test(c)) lastCodeIndex = i;
  }

  if (lastCodeIndex >= 0 && sql[lastCodeIndex] === ";") {
    return sql.slice(0, lastCodeIndex) + sql.slice(lastCodeIndex + 1);
  }
  return sql;
}

export async function rawQuery(
  db: Database.Database,
  args: { sql: string },
  timeoutMs: number = DEFAULT_QUERY_TIMEOUT_MS
) {
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
  const inner = stripTrailingTerminator(trimmed);
  const sql = `SELECT * FROM (${inner}\n) AS raw_query_result LIMIT ${MAX_ROWS}`;

  const release = await acquireSlot();
  try {
    const rows = await runInChildProcess(db.name, sql, timeoutMs);
    return { row_count: rows.length, rows };
  } finally {
    release();
  }
}
