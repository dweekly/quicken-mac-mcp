#!/usr/bin/env node

import Database from "better-sqlite3";
import { existsSync, readdirSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";

const configured = process.env.QUICKEN_DB_PATH;
let databasePath;
let unavailableReason;

if (configured) {
  databasePath = configured;
} else {
  const documents = join(homedir(), "Documents");
  let bundles = [];
  try {
    bundles = readdirSync(documents).filter((entry) => entry.endsWith(".quicken"));
  } catch {
    unavailableReason = "~/Documents is not readable";
  }

  if (!unavailableReason && bundles.length === 0) {
    unavailableReason = "no .quicken bundles were found in ~/Documents";
  } else if (!unavailableReason && bundles.length > 1) {
    unavailableReason =
      "multiple .quicken bundles were found and auto-detection refuses to guess";
  } else if (!unavailableReason) {
    databasePath = join(documents, bundles[0], "data");
  }
}

if (!unavailableReason && databasePath) {
  if (!existsSync(databasePath)) {
    unavailableReason = "the selected database file does not exist";
  } else {
    let db;
    try {
      db = new Database(databasePath, { readonly: true });
      const table = db
        .prepare(
          "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = 'ZTRANSACTION' LIMIT 1"
        )
        .get();
      if (!table) unavailableReason = "the selected database is locked or invalid";
    } catch {
      unavailableReason = "SQLite could not validate the selected database read-only";
    } finally {
      db?.close();
    }
  }
}

if (unavailableReason) {
  const message = configured
    ? `[live-db] ERROR: QUICKEN_DB_PATH is set, but ${unavailableReason}. Live tests were expected and cannot run.`
    : `[live-db] WARNING: live Quicken suites will be skipped because ${unavailableReason}. Set QUICKEN_DB_PATH to run all tests.`;
  process.stderr.write(`${message}\n`);
  if (configured) process.exitCode = 1;
} else {
  const source = configured ? "QUICKEN_DB_PATH" : "unambiguous auto-detection";
  process.stderr.write(`[live-db] ENABLED via ${source}; live suites are required.\n`);
}
