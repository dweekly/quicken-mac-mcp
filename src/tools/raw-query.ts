/**
 * raw_query tool — Execute arbitrary read-only SQL.
 *
 * Allows power users to run custom SELECT queries against the Quicken
 * database. Safety measures:
 *   - Only SELECT statements are allowed (checked via regex)
 *   - Dangerous keywords (INSERT, UPDATE, DELETE, DROP, etc.) are blocked
 *   - Results are capped at 500 rows (LIMIT is injected if missing)
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

  // Block write/DDL keywords even inside subqueries or CTEs
  const blocked =
    /\b(INSERT|UPDATE|DELETE|DROP|ALTER|CREATE|REPLACE|ATTACH|DETACH|PRAGMA)\b/i;
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

  const release = await acquireSlot();
  try {
    const rows = await runInChildProcess(db.name, sql, timeoutMs);
    return { row_count: rows.length, rows };
  } finally {
    release();
  }
}
