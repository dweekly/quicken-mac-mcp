import Database from "better-sqlite3";
import { existsSync } from "node:fs";
import { detectQuickenDb } from "../../db.js";

/**
 * Resolve an optional live Quicken database for integration tests.
 *
 * Auto-detection failures are loud skips because CI and multi-bundle developer
 * machines may intentionally have no unambiguous database. An explicitly set
 * QUICKEN_DB_PATH is an expectation: an unavailable or invalid configured file
 * fails the suite instead of quietly disabling it.
 */
export function resolveLiveQuickenDb(
  suite: string,
  expectedTables: string[]
): string | undefined {
  const configured = process.env.QUICKEN_DB_PATH;
  let databasePath: string;

  if (configured) {
    databasePath = configured;
  } else {
    try {
      databasePath = detectQuickenDb();
    } catch (error: any) {
      console.warn(
        `[${suite}] Live Quicken checks skipped: ${String(error?.message ?? error)} ` +
          "Set QUICKEN_DB_PATH to run them explicitly."
      );
      return undefined;
    }
  }

  const failOrSkip = (reason: string): undefined => {
    if (configured) {
      throw new Error(
        `[${suite}] QUICKEN_DB_PATH was set, but the live Quicken checks cannot run: ${reason}`
      );
    }
    console.warn(
      `[${suite}] Live Quicken checks skipped: ${reason} ` +
        "Set QUICKEN_DB_PATH to run them explicitly."
    );
    return undefined;
  };

  if (!existsSync(databasePath)) {
    return failOrSkip("the selected database file does not exist.");
  }

  let db: Database.Database | undefined;
  let validationFailure: string | undefined;
  try {
    db = new Database(databasePath, { readonly: true });
    const placeholders = expectedTables.map(() => "?").join(", ");
    const rows = db
      .prepare(
        `SELECT name FROM sqlite_master WHERE type = 'table' AND name IN (${placeholders})`
      )
      .all(...expectedTables) as Array<{ name: string }>;
    const found = new Set(rows.map((row) => row.name));
    const missing = expectedTables.filter((table) => !found.has(table));
    if (missing.length > 0) {
      validationFailure =
        `expected tables are unavailable (${missing.join(", ")}); ` +
        "the file may be locked.";
    }
  } catch (error: any) {
    validationFailure = `SQLite validation failed: ${String(error?.message ?? error)}`;
  } finally {
    db?.close();
  }

  if (validationFailure) return failOrSkip(validationFailure);

  return databasePath;
}
