import { describe, it, expect } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import Database from "better-sqlite3";
import {
  enforceResultLimits,
  MAX_RESULT_ROWS,
  MAX_RESULT_BYTES,
} from "../tools/limits.js";
import { toolsRegistry } from "../tools/registry.js";

describe("enforceResultLimits", () => {
  it("passes a result at exactly the row cap through unchanged", () => {
    const rows = Array.from({ length: MAX_RESULT_ROWS }, (_, i) => ({ i }));
    expect(enforceResultLimits("t", rows)).toBe(rows);
  });

  it("rejects a bare array over the row cap", () => {
    const rows = Array.from({ length: MAX_RESULT_ROWS + 1 }, (_, i) => ({ i }));
    expect(() => enforceResultLimits("spending_over_time", rows)).toThrow(
      /spending_over_time returned too many rows/
    );
  });

  it("rejects an object wrapping an over-cap array", () => {
    const rows = Array.from({ length: MAX_RESULT_ROWS + 1 }, (_, i) => ({ i }));
    expect(() =>
      enforceResultLimits("raw_query", { row_count: rows.length, rows })
    ).toThrow(/too many rows/);
  });

  it("rejects a result that is small in rows but large in bytes", () => {
    // Well under the row cap, well over the byte cap: the case a row count
    // alone cannot catch.
    const rows = [{ blob: "x".repeat(MAX_RESULT_BYTES + 1) }];
    expect(() => enforceResultLimits("list_portfolio", rows)).toThrow(
      /list_portfolio result is too large/
    );
  });

  it("names the tool and says how to narrow the request", () => {
    const rows = Array.from({ length: MAX_RESULT_ROWS + 1 }, (_, i) => ({ i }));
    try {
      enforceResultLimits("list_categories", rows);
      expect.unreachable("should have thrown");
    } catch (err: any) {
      expect(err.message).toContain("list_categories");
      expect(err.message).toMatch(/narrow the request/i);
    }
  });

  it("handles results with no rows at all", () => {
    expect(enforceResultLimits("t", [])).toEqual([]);
    expect(enforceResultLimits("t", undefined)).toBeUndefined();
  });
});

describe("registry result bounds", () => {
  const byName = (name: string) => {
    const tool = toolsRegistry.find((t) => t.name === name);
    if (!tool) throw new Error(`no such tool: ${name}`);
    return tool;
  };

  it("applies the bounds to a curated tool dispatched through the registry", () => {
    // A stub database standing in for a pathologically large Quicken file:
    // the point is that the tool itself has no LIMIT, so the bound has to
    // come from the dispatch wrapper.
    const overCap = Array.from({ length: MAX_RESULT_ROWS + 1 }, (_, i) => ({
      ZNAME: `Account ${i}`,
    }));
    const stubDb = { prepare: () => ({ all: () => overCap }) } as any;

    expect(() => byName("list_accounts").handler(stubDb, {})).toThrow(
      /list_accounts returned too many rows/
    );
  });

  it("keeps curated tools synchronous and raw_query asynchronous", async () => {
    const dir = mkdtempSync(join(tmpdir(), "qmac-limits-"));
    const dbPath = join(dir, "synthetic.db");
    const seedDb = new Database(dbPath);
    seedDb.exec("CREATE TABLE t (n INTEGER)");
    seedDb.prepare("INSERT INTO t (n) VALUES (1), (2)").run();
    seedDb.close();

    const db = new Database(dbPath, { readonly: true });
    try {
      const stubDb = { prepare: () => ({ all: () => [{ ZNAME: "a" }] }) } as any;
      expect(byName("list_accounts").handler(stubDb, {})).not.toBeInstanceOf(Promise);

      const pending = byName("raw_query").handler(db, { sql: "SELECT n FROM t" });
      expect(pending).toBeInstanceOf(Promise);
      expect((await pending).row_count).toBe(2);
    } finally {
      db.close();
      rmSync(dir, { recursive: true, force: true });
    }
  }, 15_000);
});
