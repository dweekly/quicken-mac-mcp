import { z } from "zod";
import type Database from "better-sqlite3";
import { listAccounts } from "./list-accounts.js";
import { listCategories } from "./list-categories.js";
import { queryTransactions } from "./query-transactions.js";
import { spendingByCategory } from "./spending-by-category.js";
import { spendingOverTime } from "./spending-over-time.js";
import { searchPayees } from "./search-payees.js";
import { listPortfolio } from "./list-portfolio.js";
import { rawQuery } from "./raw-query.js";
import { enforceResultLimits } from "./limits.js";

/** Parameter type representation for help display and dynamic CLI parsing. */
export type ParamType = "string" | "number" | "boolean" | "enum" | "array";

export interface ToolParamDef {
  type: ParamType;
  description: string;
  optional: boolean;
  enumValues?: string[];
  zod: z.ZodType<any>;
}

export interface ToolDef {
  name: string;
  description: string;
  parameters: Record<string, ToolParamDef>;
  handler: (db: Database.Database, args: any) => any;
}

const toolDefinitions: ToolDef[] = [
  {
    name: "list_accounts",
    description:
      "List all Quicken accounts with name, type, and active/closed status. Optionally filter by account type (case-insensitive).",
    parameters: {
      account_type: {
        type: "string",
        description:
          'Filter by account type, e.g. "checking", "creditcard", "savings", "mortgage"',
        optional: true,
        zod: z.string().optional(),
      },
    },
    handler: listAccounts,
  },
  {
    name: "list_categories",
    description:
      "List all Quicken category tags with their parent category hierarchy. Categories classify transactions (e.g., Food & Dining > Groceries).",
    parameters: {
      type: {
        type: "enum",
        description: 'Filter by category type: "expense" or "income"',
        optional: true,
        enumValues: ["expense", "income"],
        zod: z.enum(["expense", "income"]).optional(),
      },
    },
    handler: listCategories,
  },
  {
    name: "query_transactions",
    description:
      "Query Quicken transactions with flexible filters. Returns one row per split entry — a single transaction may appear multiple times if it has multiple category splits.",
    parameters: {
      start_date: {
        type: "string",
        description: "Start date (ISO 8601, e.g., 2024-01-01)",
        optional: true,
        zod: z.string().optional(),
      },
      end_date: {
        type: "string",
        description: "End date (ISO 8601, e.g., 2024-12-31)",
        optional: true,
        zod: z.string().optional(),
      },
      account_types: {
        type: "array",
        description: 'Filter by account types, e.g. ["checking", "creditcard"]',
        optional: true,
        zod: z.array(z.string()).optional(),
      },
      account_names: {
        type: "array",
        description: "Filter by specific account names",
        optional: true,
        zod: z.array(z.string()).optional(),
      },
      min_amount: {
        type: "number",
        description: "Minimum transaction amount",
        optional: true,
        zod: z.number().optional(),
      },
      max_amount: {
        type: "number",
        description: "Maximum transaction amount",
        optional: true,
        zod: z.number().optional(),
      },
      payee_search: {
        type: "string",
        description: "Search payee name (LIKE match, case-insensitive)",
        optional: true,
        zod: z.string().optional(),
      },
      category: {
        type: "string",
        description: "Filter by category or parent category name (LIKE match)",
        optional: true,
        zod: z.string().optional(),
      },
      limit: {
        type: "number",
        description: "Max rows to return (default 100, max 1000)",
        optional: true,
        zod: z.number().optional(),
      },
    },
    handler: queryTransactions,
  },
  {
    name: "spending_by_category",
    description:
      "Aggregate consumer spending (negative splits) by category for an inclusive date range. Excludes transfers and report-excluded transactions, preserves an (Uncategorized) bucket, and defaults to checking + credit-card accounts.",
    parameters: {
      start_date: {
        type: "string",
        description: "Start date (ISO 8601, e.g., 2024-01-01)",
        optional: false,
        zod: z.string().describe("Start date (ISO 8601)"),
      },
      end_date: {
        type: "string",
        description: "End date (ISO 8601, e.g., 2024-12-31)",
        optional: false,
        zod: z.string().describe("End date (ISO 8601)"),
      },
      account_types: {
        type: "array",
        description: 'Account types to include (default: ["checking", "creditcard"])',
        optional: true,
        zod: z.array(z.string()).optional(),
      },
      account_names: {
        type: "array",
        description:
          "Filter by specific account names (overrides account_types when provided)",
        optional: true,
        zod: z.array(z.string()).optional(),
      },
      group_by: {
        type: "enum",
        description:
          'Group by "category" (subcategory level) or "parent_category" (top-level). Default: "parent_category"',
        optional: true,
        enumValues: ["category", "parent_category"],
        zod: z.enum(["category", "parent_category"]).optional(),
      },
    },
    handler: spendingByCategory,
  },
  {
    name: "spending_over_time",
    description:
      "Monthly consumer-spending totals (negative splits) for an inclusive date range, optionally by parent category. Excludes transfers and report-excluded transactions, labels uncategorized rows when grouped, and defaults to checking + credit-card accounts.",
    parameters: {
      start_date: {
        type: "string",
        description: "Start date (ISO 8601, e.g., 2024-01-01)",
        optional: false,
        zod: z.string().describe("Start date (ISO 8601)"),
      },
      end_date: {
        type: "string",
        description: "End date (ISO 8601, e.g., 2024-12-31)",
        optional: false,
        zod: z.string().describe("End date (ISO 8601)"),
      },
      account_types: {
        type: "array",
        description: 'Account types to include (default: ["checking", "creditcard"])',
        optional: true,
        zod: z.array(z.string()).optional(),
      },
      account_names: {
        type: "array",
        description:
          "Filter by specific account names (overrides account_types when provided)",
        optional: true,
        zod: z.array(z.string()).optional(),
      },
      group_by_category: {
        type: "boolean",
        description: "If true, break down each month by parent category (default: false)",
        optional: true,
        zod: z.boolean().optional(),
      },
    },
    handler: spendingOverTime,
  },
  {
    name: "search_payees",
    description:
      "Search payees by name (case-insensitive LIKE match). Returns payee name and total transaction count, sorted by frequency.",
    parameters: {
      query: {
        type: "string",
        description: "Search term for payee name (LIKE match)",
        optional: false,
        zod: z.string().describe("Search term for payee name (LIKE match)"),
      },
      limit: {
        type: "number",
        description: "Max results to return (default 50, max 500)",
        optional: true,
        zod: z.number().optional(),
      },
    },
    handler: searchPayees,
  },
  {
    name: "list_portfolio",
    description:
      "List current investment holdings across all brokerage/retirement accounts. Shows shares, cost basis, and enriches with stored Quicken quotes to compute market value and gain/loss.",
    parameters: {
      account_names: {
        type: "array",
        description: "Filter to specific account names",
        optional: true,
        zod: z.array(z.string()).optional(),
      },
    },
    handler: listPortfolio,
  },
  {
    name: "raw_query",
    description:
      "Execute an arbitrary read-only SQL query against the Quicken database. Only SELECT statements are allowed. Results limited to 500 rows. Use this for custom analysis not covered by other tools.",
    parameters: {
      sql: {
        type: "string",
        description: "SQL SELECT query to execute",
        optional: false,
        zod: z.string().describe("SQL SELECT query to execute"),
      },
    },
    handler: rawQuery,
  },
];

/**
 * Every tool is dispatched through the shared result bounds, so a tool cannot
 * be added later that returns an unbounded result by omission. Sync handlers
 * stay sync — only raw_query returns a promise, and wrapping it in an async
 * function would change the others' call signature for no reason.
 */
export const toolsRegistry: ToolDef[] = toolDefinitions.map((tool) => ({
  ...tool,
  handler: (db, args) => {
    const result = tool.handler(db, args);
    return result instanceof Promise
      ? result.then((rows) => enforceResultLimits(tool.name, rows))
      : enforceResultLimits(tool.name, result);
  },
}));
