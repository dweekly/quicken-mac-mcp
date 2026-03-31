/**
 * Database connection and date conversion utilities for Quicken For Mac.
 *
 * Quicken For Mac stores its data in a Core Data SQLite database inside a
 * .quicken bundle (e.g., ~/Documents/MyFinances.quicken/data). This module
 * handles locating the database file, opening it read-only, and converting
 * between ISO 8601 dates and Core Data's timestamp format.
 */

import Database from "better-sqlite3";
import { accessSync, constants, existsSync, readdirSync, statSync } from "fs";
import { homedir } from "os";
import { join, resolve } from "path";

/**
 * Core Data epoch offset: the number of seconds between the Unix epoch
 * (1970-01-01) and the Core Data reference date (2001-01-01).
 * To convert: unixTimestamp = coreDataTimestamp + CORE_DATA_EPOCH_OFFSET
 */
export const CORE_DATA_EPOCH_OFFSET = 978307200;

/**
 * Auto-detect a Quicken database by scanning ~/Documents for .quicken bundles.
 * Returns the path to the `data` file inside the most recently modified bundle.
 * Throws a helpful error if no bundles are found.
 */
export function detectQuickenDb(): string {
  const documentsDir = join(homedir(), "Documents");

  let entries: string[];
  try {
    entries = readdirSync(documentsDir);
  } catch {
    throw new Error(
      `Cannot read ~/Documents. Set QUICKEN_DB_PATH to your Quicken database path.`
    );
  }

  const quickenBundles = entries.filter((e) => e.endsWith(".quicken"));

  if (quickenBundles.length === 0) {
    throw new Error(
      `No .quicken bundles found in ~/Documents.\n\n` +
        `Set the database path when adding the server:\n` +
        `  claude mcp add quicken -e QUICKEN_DB_PATH=~/Documents/YourFile.quicken/data -- npx -y quicken-mac-mcp`
    );
  }

  // Pick the most recently modified bundle
  const sorted = quickenBundles
    .map((name) => {
      const fullPath = resolve(documentsDir, name);
      return { name, mtime: statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  return resolve(documentsDir, sorted[0].name, "data");
}

/**
 * Open the Quicken database in read-only mode.
 *
 * Resolution order for the database path:
 *   1. Explicit `dbPath` argument (e.g., CLI positional arg)
 *   2. QUICKEN_DB_PATH environment variable
 *   3. Auto-detect from ~/Documents/*.quicken/data
 */
export function openDatabase(dbPath?: string): Database.Database {
  const resolvedPath = dbPath || process.env.QUICKEN_DB_PATH || detectQuickenDb();
  return new Database(resolvedPath, { readonly: true });
}

/**
 * Create a lazy database accessor that defers opening until first use.
 *
 * The server can start and register with the MCP host without requiring a
 * valid database path. If the database can't be opened when a tool is called,
 * the error propagates to the tool handler which returns a helpful message.
 *
 * The connection is cached but validated on each access — if Quicken replaces
 * the database file (e.g., after opening/closing the app), we detect the inode
 * change and reconnect.
 */
/**
 * Diagnose why a database path can't be opened. Returns a human-readable
 * explanation without exposing the full filesystem path.
 */
export function diagnosePath(filePath: string): string {
  const hints: string[] = [];

  if (!existsSync(filePath)) {
    hints.push("The database file does not exist at the configured path.");
    // Check if the parent .quicken bundle exists
    const parent = resolve(filePath, "..");
    if (!existsSync(parent)) {
      hints.push(
        "The parent directory (the .quicken bundle) also does not exist. " +
          "Check that the QUICKEN_DB_PATH is correct and includes the /data suffix."
      );
    } else {
      hints.push(
        "The parent directory exists but contains no 'data' file. " +
          "Quicken may not have created its database yet, or the path may be wrong."
      );
    }
  } else {
    // File exists — check permissions
    try {
      accessSync(filePath, constants.R_OK);
    } catch {
      hints.push(
        "The database file exists but is not readable. " +
          "Check file permissions — Quicken databases require read access."
      );
    }

    // Check if it's a regular file
    try {
      const stat = statSync(filePath);
      if (!stat.isFile()) {
        hints.push("The path exists but is not a regular file.");
      } else if (stat.size < 100) {
        hints.push(
          "The database file is very small (" +
            stat.size +
            " bytes) — Quicken may have " +
            "encrypted/locked it. Make sure Quicken For Mac is open and the file is unlocked."
        );
      }
    } catch {
      // statSync failed — already covered above
    }
  }

  if (hints.length === 0) {
    hints.push(
      "The file exists and is readable, but SQLite could not open it. " +
        "It may be encrypted (Quicken is closed) or corrupted."
    );
  }

  return hints.join("\n");
}

export function createDbAccessor(dbPath?: string): () => Database.Database {
  let db: Database.Database | null = null;
  let cachedIno: bigint | null = null;

  return () => {
    const resolvedPath = dbPath || process.env.QUICKEN_DB_PATH || detectQuickenDb();

    // Check if the file on disk has changed (Quicken replaces the file on open/close)
    try {
      const currentIno = statSync(resolvedPath, { bigint: true }).ino;
      if (db && cachedIno !== null && cachedIno !== currentIno) {
        db.close();
        db = null;
      }
      cachedIno = currentIno;
    } catch (err: any) {
      if (err?.code === "ENOENT") {
        // File doesn't exist — let the open below surface a diagnostic error
      } else {
        throw err;
      }
    }

    if (!db) {
      try {
        db = new Database(resolvedPath, { readonly: true });
      } catch (err: any) {
        const diagnosis = diagnosePath(resolvedPath);
        throw new Error(`${err.message}\n\n${diagnosis}`);
      }
    }
    return db;
  };
}

/**
 * Convert an ISO 8601 date string (e.g., "2024-01-15") to a Core Data
 * timestamp (seconds since 2001-01-01 00:00:00 UTC).
 */
export function isoToCoreData(iso: string): number {
  const unix = Math.floor(new Date(iso).getTime() / 1000);
  return unix - CORE_DATA_EPOCH_OFFSET;
}

/**
 * Convert a Core Data timestamp to an ISO 8601 date string (YYYY-MM-DD).
 */
export function coreDataToIso(ts: number): string {
  const unix = ts + CORE_DATA_EPOCH_OFFSET;
  return new Date(unix * 1000).toISOString().split("T")[0];
}

/**
 * Look up the Core Data entity ID for CategoryTag from the Z_PRIMARYKEY table.
 *
 * Core Data assigns entity IDs (Z_ENT) per-database, so they vary between
 * Quicken files. This function reads the actual value instead of hardcoding it.
 * The result is cached for the lifetime of the database connection.
 */
const entityIdCache = new WeakMap<Database.Database, number>();

export function getCategoryTagEntityId(db: Database.Database): number {
  const cached = entityIdCache.get(db);
  if (cached !== undefined) return cached;

  const row = db
    .prepare("SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'CategoryTag'")
    .get() as { Z_ENT: number } | undefined;

  if (!row) {
    throw new Error(
      "Could not find CategoryTag entity in Z_PRIMARYKEY. " +
        "Is this a valid Quicken database?"
    );
  }

  entityIdCache.set(db, row.Z_ENT);
  return row.Z_ENT;
}
