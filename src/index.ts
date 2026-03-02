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

import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { openDatabase } from "./db.js";
import { createServer } from "./server.js";

const dbPath = process.argv[2] || undefined;
const db = openDatabase(dbPath);
const server = createServer(db);

const transport = new StdioServerTransport();
await server.connect(transport);
