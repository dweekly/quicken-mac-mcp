/**
 * Database connection and date conversion utilities for Quicken For Mac.
 *
 * Quicken For Mac stores its data in a Core Data SQLite database inside a
 * .quicken bundle (e.g., ~/Documents/MyFinances.quicken/data). This module
 * handles locating the database file, opening it read-only, and converting
 * between ISO 8601 dates and Core Data's timestamp format.
 */

import Database from "better-sqlite3";
import { readdirSync, statSync } from "fs";
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
 */
export function createDbAccessor(dbPath?: string): () => Database.Database {
  let db: Database.Database | null = null;
  return () => {
    if (!db) {
      db = openDatabase(dbPath);
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
