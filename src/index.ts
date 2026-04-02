#!/usr/bin/env node

/**
 * Entry point for the Quicken MCP server and CLI tools.
 *
 * Usage:
 *   quicken-mac-mcp                    Start the MCP server (stdio transport)
 *   quicken-mac-mcp export [output]    Export Quicken data to a clean SQLite database
 *   quicken-mac-mcp [dbpath]           Start the MCP server with explicit DB path
 *
 * The database path can also be set via the QUICKEN_DB_PATH environment variable
 * or auto-detected from ~/Documents/*.quicken/data.
 */

import { homedir } from "os";
import { join } from "path";
import Database from "better-sqlite3";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDbAccessor } from "./db.js";
import { createServer } from "./server.js";

// Eagerly validate that the better-sqlite3 native module loads correctly.
// This catches NODE_MODULE_VERSION mismatches (e.g., npx cached a build for
// a different Node.js version) before either mode starts, producing a clear
// diagnostic instead of a cryptic error on first tool call or export run.
try {
  const testDb = new Database(":memory:");
  testDb.close();
} catch (err: any) {
  const msg = String(err?.message ?? err);
  if (msg.includes("NODE_MODULE_VERSION") || msg.includes("was compiled against")) {
    process.stderr.write(
      `FATAL: better-sqlite3 native module version mismatch.\n` +
      `Running: Node.js ${process.version} (${process.arch})\n\n` +
      `This typically happens when npx caches a build for one Node.js version,\n` +
      `but the MCP host (e.g., Claude Desktop) runs a different one.\n\n` +
      `Fix: rm -rf ~/.npm/_npx && restart the MCP server.\n`
    );
    process.exit(1);
  }
  throw err;
}

const args = process.argv.slice(2);

if (args[0] === "export") {
  // Export mode: ETL Quicken data to clean SQLite
  const { exportDatabase } = await import("./export.js");
  const outputPath = args[1] || join(homedir(), "Documents", "quicken-export.db");
  const srcDbPath = args[2] || undefined;

  console.log(`Exporting Quicken data to ${outputPath}...`);

  try {
    const result = exportDatabase(outputPath, srcDbPath);
    console.log(`\nExport complete:`);
    console.log(`  Accounts:     ${result.accounts}`);
    console.log(`  Categories:   ${result.categories}`);
    console.log(`  Payees:       ${result.payees}`);
    console.log(`  Transactions: ${result.transactions}`);
    console.log(`  Splits:       ${result.splits}`);
    console.log(`  Holdings:     ${result.holdings}`);
    console.log(`\nOutput: ${result.outputPath}`);
    console.log(`\nYou can now query this database with any SQLite tool, or use it with Claude:`);
    console.log(`  sqlite3 "${result.outputPath}"`);
  } catch (err: any) {
    console.error(`Export failed: ${err.message}`);
    if (err.message?.includes("no such table")) {
      console.error(`\nQuicken For Mac must be running (it encrypts its database when closed).`);
      console.error(`Launch it with: open -a 'Quicken'`);
    }
    process.exit(1);
  }
} else {
  // MCP server mode (default)
  const dbPath = args[0] || undefined;
  const getDb = createDbAccessor(dbPath);
  const server = createServer(getDb);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
