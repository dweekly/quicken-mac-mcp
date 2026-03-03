/**
 * MCP server setup and tool registration.
 *
 * Registers all 8 Quicken query tools with the MCP server using Zod schemas
 * for input validation. Each tool handler serializes the result as JSON text.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";
import type Database from "better-sqlite3";
import { listAccounts } from "./tools/list-accounts.js";
import { listCategories } from "./tools/list-categories.js";
import { queryTransactions } from "./tools/query-transactions.js";
import { spendingByCategory } from "./tools/spending-by-category.js";
import { spendingOverTime } from "./tools/spending-over-time.js";
import { searchPayees } from "./tools/search-payees.js";
import { rawQuery } from "./tools/raw-query.js";
import { listPortfolio } from "./tools/list-portfolio.js";

/** Helper to wrap a tool result as MCP text content. */
function jsonContent(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

/** Strip filesystem paths from error messages to avoid leaking personal info. */
function sanitizeError(err: any): string {
  const msg = String(err?.message ?? err);
  return msg.replace(/(?:\/[\w.-]+){2,}/g, "<path>");
}

/**
 * Wrap a tool handler with database access and error handling.
 * Calls getDb() lazily so the server can start without a valid database.
 * On failure, returns an MCP error response with setup instructions.
 */
function safeTool<A>(
  getDb: () => Database.Database,
  fn: (db: Database.Database, args: A) => unknown
) {
  return (args: A) => {
    try {
      return jsonContent(fn(getDb(), args));
    } catch (err: any) {
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: `Error: ${sanitizeError(err)}` }],
      };
    }
  };
}

/** Async variant of safeTool for tools that return promises. */
function safeToolAsync<A>(
  getDb: () => Database.Database,
  fn: (db: Database.Database, args: A) => Promise<unknown>
) {
  return async (args: A) => {
    try {
      return jsonContent(await fn(getDb(), args));
    } catch (err: any) {
      return {
        isError: true as const,
        content: [{ type: "text" as const, text: `Error: ${sanitizeError(err)}` }],
      };
    }
  };
}

export function createServer(getDb: () => Database.Database): McpServer {
  const server = new McpServer(
    {
      name: "quicken-mac-mcp",
      version: "1.0.0",
    },
    {
      instructions: [
        "You have read-only access to the user's Quicken For Mac financial data.",
        "This server only works on macOS — Quicken For Mac stores data in a Core Data SQLite database inside ~/Documents/*.quicken/data.",
        "",
        "## Tool selection guide",
        "- Start with list_accounts to understand what accounts exist and their types.",
        "- Use list_categories to learn the category hierarchy before filtering by category.",
        "- For specific transactions, use query_transactions with date/amount/payee/category filters.",
        "- For spending analysis, prefer spending_by_category or spending_over_time over raw queries — they handle the category joins and date bucketing correctly.",
        "- Use search_payees to find the exact payee name before filtering transactions (payee names in Quicken are often different from what users expect).",
        "- Use list_portfolio for investment holdings. Set include_quotes=true only if the user asks for current prices (this calls Yahoo Finance).",
        "- Use raw_query only when the other tools can't answer the question. The database uses Core Data schema — tables are prefixed with Z and columns with Z.",
        "",
        "## Important conventions",
        "- All dates are ISO 8601 (YYYY-MM-DD). The server handles Core Data epoch conversion.",
        "- Amounts are signed: negative = expense/debit, positive = income/credit.",
        "- Account types are case-insensitive. Common types: checking, creditcard, savings, mortgage, retirementira, asset, liability, loan.",
        "- spending_by_category and spending_over_time default to checking + creditcard accounts only. Include other types explicitly if the user asks about all spending.",
        "- query_transactions returns one row per split entry — a single transaction may produce multiple rows if split across categories.",
        "",
        "## Database auto-detection",
        "- If QUICKEN_DB_PATH is not set, the server auto-detects by picking the most recently modified .quicken bundle in ~/Documents.",
        "- On first use, confirm with the user which Quicken file they want to use. Call list_accounts and show the user the detected file's accounts so they can verify it's the right one.",
        "- If the user has multiple Quicken files or wants a specific one, instruct them to set the QUICKEN_DB_PATH environment variable:",
        "    claude mcp add quicken -e QUICKEN_DB_PATH=~/Documents/YourFile.quicken/data -- npx -y quicken-mac-mcp",
      ].join("\n"),
    }
  );

  server.tool(
    "list_accounts",
    "List all Quicken accounts with name, type, and active/closed status. Optionally filter by account type (case-insensitive).",
    {
      account_type: z
        .string()
        .optional()
        .describe(
          'Filter by account type, e.g. "checking", "creditcard", "savings", "mortgage"'
        ),
    },
    safeTool(getDb, listAccounts)
  );

  server.tool(
    "list_categories",
    "List all Quicken category tags with their parent category hierarchy. Categories classify transactions (e.g., Food & Dining > Groceries).",
    {
      type: z
        .enum(["expense", "income"])
        .optional()
        .describe('Filter by category type: "expense" or "income"'),
    },
    safeTool(getDb, listCategories)
  );

  server.tool(
    "query_transactions",
    "Query Quicken transactions with flexible filters. Returns one row per split entry — a single transaction may appear multiple times if it has multiple category splits.",
    {
      start_date: z
        .string()
        .optional()
        .describe("Start date (ISO 8601, e.g., 2024-01-01)"),
      end_date: z.string().optional().describe("End date (ISO 8601, e.g., 2024-12-31)"),
      account_types: z
        .array(z.string())
        .optional()
        .describe('Filter by account types, e.g. ["checking", "creditcard"]'),
      account_names: z
        .array(z.string())
        .optional()
        .describe("Filter by specific account names"),
      min_amount: z.number().optional().describe("Minimum transaction amount"),
      max_amount: z.number().optional().describe("Maximum transaction amount"),
      payee_search: z
        .string()
        .optional()
        .describe("Search payee name (LIKE match, case-insensitive)"),
      category: z
        .string()
        .optional()
        .describe("Filter by category or parent category name (LIKE match)"),
      limit: z.number().optional().describe("Max rows to return (default 100, max 1000)"),
    },
    safeTool(getDb, queryTransactions)
  );

  server.tool(
    "spending_by_category",
    "Aggregate spending grouped by category or parent category for a date range. Returns category name, total amount, and transaction count, sorted by amount.",
    {
      start_date: z.string().describe("Start date (ISO 8601)"),
      end_date: z.string().describe("End date (ISO 8601)"),
      account_types: z
        .array(z.string())
        .optional()
        .describe('Account types to include (default: ["checking", "creditcard"])'),
      group_by: z
        .enum(["category", "parent_category"])
        .optional()
        .describe(
          'Group by "category" (subcategory level) or "parent_category" (top-level). Default: "parent_category"'
        ),
    },
    safeTool(getDb, spendingByCategory)
  );

  server.tool(
    "spending_over_time",
    "Monthly spending totals over a date range, optionally broken down by parent category. Useful for trend analysis.",
    {
      start_date: z.string().describe("Start date (ISO 8601)"),
      end_date: z.string().describe("End date (ISO 8601)"),
      account_types: z
        .array(z.string())
        .optional()
        .describe('Account types to include (default: ["checking", "creditcard"])'),
      group_by_category: z
        .boolean()
        .optional()
        .describe("If true, break down each month by parent category (default: false)"),
    },
    safeTool(getDb, spendingOverTime)
  );

  server.tool(
    "search_payees",
    "Search payees by name (case-insensitive LIKE match). Returns payee name and total transaction count, sorted by frequency.",
    {
      query: z.string().describe("Search term for payee name (LIKE match)"),
      limit: z
        .number()
        .optional()
        .describe("Max results to return (default 50, max 500)"),
    },
    safeTool(getDb, searchPayees)
  );

  server.tool(
    "list_portfolio",
    "List current investment holdings across all brokerage/retirement accounts. Shows shares, cost basis, and optionally enriches with current prices (from stored Quicken quotes or live Yahoo Finance data) to compute market value and gain/loss.",
    {
      account_names: z
        .array(z.string())
        .optional()
        .describe("Filter to specific account names"),
      include_quotes: z
        .boolean()
        .optional()
        .describe(
          "Fetch live prices from Yahoo Finance (default: false, uses stored Quicken quotes). Note: sends your ticker symbols to Yahoo's API."
        ),
    },
    safeToolAsync(getDb, listPortfolio)
  );

  server.tool(
    "raw_query",
    "Execute an arbitrary read-only SQL query against the Quicken database. Only SELECT statements are allowed. Results limited to 500 rows. Use this for custom analysis not covered by other tools.",
    {
      sql: z.string().describe("SQL SELECT query to execute"),
    },
    safeTool(getDb, rawQuery)
  );

  return server;
}
