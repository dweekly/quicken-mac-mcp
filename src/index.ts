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
  const { StdioServerTransport } = await import("@modelcontextprotocol/sdk/server/stdio.js");
  const { createDbAccessor } = await import("./db.js");
  const { createServer } = await import("./server.js");

  const dbPath = args[0] || undefined;
  const getDb = createDbAccessor(dbPath);
  const server = createServer(getDb);

  const transport = new StdioServerTransport();
  await server.connect(transport);
}
