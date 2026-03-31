#!/usr/bin/env node

/**
 * Entry point for the Quicken MCP server.
 *
 * Starts a stdio-based MCP server that provides read-only access to a
 * Quicken For Mac database. The database path can be specified as:
 *   - A CLI argument: quicken-mac-mcp /path/to/data
 *   - The QUICKEN_DB_PATH environment variable
 *   - Auto-detected from ~/Documents/*.quicken/data
 */

import Database from "better-sqlite3";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDbAccessor } from "./db.js";
import { createServer } from "./server.js";

// Eagerly validate that the better-sqlite3 native module loads correctly.
// This catches NODE_MODULE_VERSION mismatches (e.g., npx cached a build for
// a different Node.js version) before the MCP server starts, producing a
// clear diagnostic instead of a cryptic error on first tool call.
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

const dbPath = process.argv[2] || undefined;
const getDb = createDbAccessor(dbPath);
const server = createServer(getDb);

const transport = new StdioServerTransport();
await server.connect(transport);
