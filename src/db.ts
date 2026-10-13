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
 * Directories Quicken For Mac uses for `.quicken` bundles, in the order they
 * are searched:
 *
 *   1. ~/Documents — the location this project searched originally; also where
 *      a file lands if the user chose it in File → Move To.
 *   2. ~/Library/Application Support/<Quicken folder>/Documents — the default for the
 *      retail/subscription app. Quicken's help ("Learning about data files")
 *      names the "Quicken" folder; Quicken community FAQs show the same path
 *      with "Quicken Beta" for the beta channel and year-suffixed folder names
 *      for older releases, so any folder named "Quicken" or "Quicken <suffix>"
 *      is searched.
 *   3. The Mac App Store build's sandbox container (also from Quicken's help).
 */
export function quickenSearchDirectories(): string[] {
  const home = homedir();
  const dirs = [join(home, "Documents")];

  const appSupport = join(home, "Library", "Application Support");
  for (const entry of readDirectoryIfPresent(appSupport).sort()) {
    if (entry === "Quicken" || entry.startsWith("Quicken ")) {
      dirs.push(join(appSupport, entry, "Documents"));
    }
  }

  dirs.push(
    join(
      home,
      "Library",
      "Containers",
      "com.quicken.QuickenAppStore",
      "Data",
      "Library",
      "Application Support",
      "Quicken",
      "Documents"
    )
  );
  return dirs;
}

/**
 * Read a directory's entries. A directory that does not exist yields []; one
 * that exists but cannot be read (for example ~/Documents without a Files and
 * Folders grant) throws, because silently skipping it could make detection
 * settle on a bundle elsewhere that the user did not intend.
 */
function readDirectoryIfPresent(dir: string): string[] {
  try {
    return readdirSync(dir);
  } catch (err: any) {
    if (err?.code === "ENOENT" || err?.code === "ENOTDIR") return [];
    throw new Error(
      `Cannot read ${dir} (${err?.code ?? err}). Set QUICKEN_DB_PATH to your Quicken database path.`,
      { cause: err }
    );
  }
}

/**
 * Auto-detect a Quicken database by scanning every known Quicken document
 * directory for `.quicken` bundles. Returns the path to the `data` file when
 * exactly one bundle exists across all of them. Refuses to guess when several
 * are present because modification time does not reliably identify the
 * intended or unlocked document.
 */
export function detectQuickenDb(): string {
  const searched = quickenSearchDirectories();
  const bundles: string[] = [];

  for (const dir of searched) {
    for (const entry of readDirectoryIfPresent(dir)) {
      if (entry.endsWith(".quicken")) bundles.push(resolve(dir, entry, "data"));
    }
  }

  if (bundles.length === 0) {
    throw new Error(
      `No .quicken bundles found in any of the usual Quicken locations:\n` +
        searched.map((d) => `  ${d}`).join("\n") +
        `\n\nSet the database path when adding the server:\n` +
        `  claude mcp add quicken -e QUICKEN_DB_PATH=/path/to/YourFile.quicken/data -- npx -y quicken-mac-mcp`
    );
  }

  if (bundles.length > 1) {
    throw new Error(
      `Multiple .quicken bundles found:\n` +
        bundles.map((b) => `  ${b}`).join("\n") +
        `\nSet QUICKEN_DB_PATH to the intended Quicken database path.`
    );
  }

  return bundles[0];
}

/**
 * Open the Quicken database in read-only mode.
 *
 * Resolution order for the database path:
 *   1. Explicit `dbPath` argument (e.g., CLI positional arg)
 *   2. QUICKEN_DB_PATH environment variable
 *   3. Auto-detect: the single `.quicken` bundle across quickenSearchDirectories()
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

/**
 * Probe whether an open Quicken database is decrypted. When Quicken For Mac is
 * closed it may swap the bundle for an encrypted stub that has none of the
 * expected Core Data tables, so the presence of ZACCOUNT is our readiness signal.
 */
export function isQuickenDecrypted(db: Database.Database): boolean {
  const row = db
    .prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='ZACCOUNT' LIMIT 1"
    )
    .get();
  return !!row;
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

        // Eagerly verify the database is decrypted (i.e. Quicken For Mac is
        // running). When Quicken is closed the file may be an encrypted stub with
        // none of the expected tables, so fail fast with a clear message
        // instead of a cryptic "no such table" on the first real query.
        if (!isQuickenDecrypted(db)) {
          throw new Error("Quicken database is encrypted.");
        }
      } catch (err: any) {
        if (db) {
          try {
            db.close();
          } catch {
            /* ignore close error */
          }
          db = null;
        }
        const msg = String(err?.message ?? err);
        if (msg.includes("no such table") || msg.includes("encrypted")) {
          throw new Error(
            "Quicken database is encrypted. Quicken For Mac must be running to decrypt your financial data.",
            { cause: err }
          );
        }
        const diagnosis = diagnosePath(resolvedPath);
        throw new Error(`${msg}\n\n${diagnosis}`, { cause: err });
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
 * Convert an inclusive user-facing ISO date to the exclusive Core Data upper
 * bound at the following day's midnight.
 */
export function inclusiveEndDateToCoreDataExclusive(iso: string): number {
  return isoToCoreData(iso) + 86400;
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
