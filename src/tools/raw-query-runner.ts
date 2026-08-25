/**
 * Child process entry point for raw_query.
 *
 * better-sqlite3 executes statements synchronously in native code, and
 * there's no way to interrupt or bound an in-progress query from the calling
 * JS thread — not even `worker_threads`' `Worker#terminate()` can preempt a
 * long-running native call; it only takes effect once control returns to
 * JS, and until then it can even block the host process from exiting. A
 * separate OS process, by contrast, can be killed unconditionally with
 * SIGKILL regardless of what it's doing. So an expensive raw_query call (a
 * large cross join, an unbounded join with no useful filter) runs here, in
 * a child process the parent can kill outright if it runs too long.
 */

import Database from "better-sqlite3";

interface RunnerRequest {
  dbPath: string;
  sql: string;
}

interface RunnerResponse {
  ok: boolean;
  rows?: unknown[];
  message?: string;
}

process.once("message", (msg: RunnerRequest) => {
  let response: RunnerResponse;
  try {
    const db = new Database(msg.dbPath, { readonly: true });
    try {
      const rows = db.prepare(msg.sql).all();
      response = { ok: true, rows };
    } finally {
      db.close();
    }
  } catch (err: any) {
    response = { ok: false, message: String(err?.message ?? err) };
  }
  process.send?.(response, () => process.exit(0));
});
