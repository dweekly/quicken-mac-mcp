/**
 * MCP server setup and tool registration.
 *
 * Registers all 8 Quicken query tools with the MCP server using Zod schemas
 * for input validation. Each tool handler serializes the result as JSON text.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { createRequire } from "node:module";
import { homedir } from "os";
import { z } from "zod";
import Database from "better-sqlite3";
import { toolsRegistry } from "./tools/registry.js";
import { detectQuickenDb, isQuickenDecrypted } from "./db.js";

// Read the package version at module load so the MCP server's serverInfo
// reports the same version that's published to npm / bundled in the .mcpb,
// instead of a hardcoded literal that drifts every release.
const pkg = createRequire(import.meta.url)("../package.json") as { version: string };

/** Helper to wrap a tool result as MCP text content. */
function jsonContent(data: unknown) {
  return { content: [{ type: "text" as const, text: JSON.stringify(data, null, 2) }] };
}

// Codex's review made the point that a regex is not a privacy guarantee: two
// rounds of leaks (single-segment paths, then spaced folder names) came out of
// treating it as one. So the two values we actually KNOW are sensitive — the
// configured database path and the user's home directory — are redacted by
// exact string match first, which no amount of punctuation, spacing, or
// Unicode in a folder name can defeat. The pattern matching below is a
// fallback for paths we don't know in advance, not the primary defense.
function redactKnownPaths(msg: string): string {
  let out = msg;

  const dbPath = process.env.QUICKEN_DB_PATH?.trim();
  if (dbPath) {
    // The bundle directory identifies the file on its own, so redact it as
    // well as the full "/data" path. Longest first, so the more specific
    // replacement wins.
    const bundleDir = dbPath.replace(/\/data\/?$/, "");
    for (const value of [dbPath, bundleDir].sort((a, b) => b.length - a.length)) {
      if (value.length > 1) out = out.split(value).join("<path>");
    }
  }

  const home = homedir();
  // Leave "~" rather than "<path>": the tail (e.g. "/Documents/My File.quicken")
  // is still identifying, and "~/..." is exactly what the rule below matches.
  if (home.length > 1) out = out.split(home).join("~");

  return out;
}

// Characters allowed inside a path segment. Real Quicken bundle names carry
// spaces and punctuation ("My Finances (2026).quicken", "Antonio's Budget"),
// and a class that stops at the first "(" or "'" leaks the rest of the path
// as trailing plaintext — the same failure shape as the earlier spaced-name
// leak, just with different characters.
const SEG = String.raw`[\p{L}\p{N}_.\-+&'()\[\]{}@#$%!=,^]`;
// A segment may not END on punctuation: that's what keeps a sentence's final
// period, or a comma between two listed paths, outside the redaction.
const SEG_END = String.raw`[\p{L}\p{N}_)\]}]`;
// Chunk lengths are bounded rather than open-ended. Error text can echo
// caller-supplied SQL, so the nested quantifiers are kept from degrading into
// pathological backtracking on a long run of segment characters.
const MID_SEGMENT = String.raw`${SEG}{1,64}(?:[ \t]${SEG}{1,64}){0,3}`;
// Only a segment proven to be mid-path (a following "/") may contain spaces.
// The final segment can hold punctuation but not spaces: with no following
// "/" to prove the path continues, a space allowance would swallow trailing
// prose like "and" in "/foo/bar/baz and /qux".
const FINAL_SEGMENT = String.raw`${SEG}{0,64}${SEG_END}`;
// Excludes a preceding "/" as well as a preceding word character: without it,
// the second "/" of a "://" URL scheme separator would itself qualify as a
// path start (the literal first "/" fails to match on its own, since it's
// immediately followed by another "/" rather than a segment character),
// causing a partial, corrupting redaction like "https://x/y" -> "https:/<path>".
const UNQUOTED_PATH = new RegExp(
  String.raw`(?<![\p{L}\p{N}_/])~?/(?:${MID_SEGMENT}/)*${FINAL_SEGMENT}`,
  "gu"
);

/**
 * Strip filesystem paths from error messages to avoid leaking personal info.
 *
 * Known-sensitive values are removed by exact match; anything else is matched
 * by pattern. The quoted-path rules assume the quote character does not occur
 * inside the path itself, so a single-quoted path containing an apostrophe can
 * still leave a fragment behind — the exact-match pass above is what covers
 * the real database path in that case.
 */
export function sanitizeError(err: any): string {
  const msg = redactKnownPaths(String(err?.message ?? err));
  return msg
    .replace(/'\/[^']+'/g, "'<path>'") // single-quoted paths (e.g., native module errors)
    .replace(/"\/[^"]+"/g, '"<path>"') // double-quoted paths
    .replace(UNQUOTED_PATH, "<path>"); // unquoted paths: single- or multi-segment, ~/-relative, spaces/punctuation/Unicode in names
}

/**
 * Check if the Quicken database is decrypted (i.e. Quicken is running) by
 * looking for core tables. When Quicken is closed it replaces the DB file with
 * a small encrypted stub that has none of the expected tables.
 */
function isDatabaseDecrypted(): boolean {
  try {
    const resolvedPath = process.env.QUICKEN_DB_PATH || detectQuickenDb();
    const db = new Database(resolvedPath, { readonly: true });
    try {
      return isQuickenDecrypted(db);
    } finally {
      db.close();
    }
  } catch {
    return false;
  }
}

/** Format an error for MCP tool response, with extra help for common issues. */
export function formatToolError(err: any) {
  const msg = String(err?.message ?? err);
  let text = `Error: ${sanitizeError(err)}`;

  if (msg.includes("NODE_MODULE_VERSION") || msg.includes("was compiled against")) {
    text =
      `Error: Native module version mismatch — better-sqlite3 was compiled for a different Node.js version.\n\n` +
      `Running: Node.js ${process.version}\n\n` +
      `This typically happens when npx caches a build for one Node.js version, ` +
      `but the MCP host (e.g., Claude Desktop) runs a different one.\n\n` +
      `Fix: run \`rm -rf ~/.npm/_npx\` and restart the MCP server.`;
  } else if (msg.includes("dlopen") || msg.includes("MODULE_NOT_FOUND")) {
    text +=
      "\n\nThe better-sqlite3 native module failed to load. " +
      "Try clearing the npx cache: `rm -rf ~/.npm/_npx` and restart.";
  } else if (msg.includes("unable to open database")) {
    text +=
      "\n\nIf Quicken For Mac is not running, open it first: open -a 'Quicken'\n" +
      "Then wait a few seconds and retry.";
  } else if (msg.includes("no such table") || msg.includes("encrypted")) {
    if (!isDatabaseDecrypted()) {
      text +=
        "\n\nQuicken For Mac is not running. Quicken encrypts its database when " +
        "the app is closed. Please ask the user if they'd like to launch Quicken, " +
        "then run: open -a 'Quicken' and retry.";
    } else {
      text +=
        "\n\nQuicken is running but the database tables are missing. " +
        "The QUICKEN_DB_PATH may be pointing to the wrong file.";
    }
  }
  return {
    isError: true as const,
    content: [{ type: "text" as const, text }],
  };
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
      return formatToolError(err);
    }
  };
}

export function createServer(getDb: () => Database.Database): McpServer {
  const server = new McpServer(
    {
      name: "quicken-mac-mcp",
      version: pkg.version,
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
        "- Use list_portfolio for investment holdings (uses stored Quicken quotes for prices).",
        "- Use raw_query only when the other tools can't answer the question. The database uses Core Data schema — tables are prefixed with Z and columns with Z.",
        "",
        "## Important conventions",
        "- All dates are ISO 8601 (YYYY-MM-DD). The server handles Core Data epoch conversion.",
        "- Amounts are signed: negative = expense/debit, positive = income/credit.",
        "- Account types are case-insensitive. Common types: checking, creditcard, savings, mortgage, retirementira, asset, liability, loan.",
        "- spending_by_category and spending_over_time default to checking + creditcard accounts only. Include other types explicitly if the user asks about all spending.",
        "- Those spending tools include negative splits only, exclude transfers and report-excluded transactions, and preserve uncategorized spending as (Uncategorized). State that scope when reporting results.",
        "- query_transactions returns one row per split entry — a single transaction may produce multiple rows if split across categories.",
        "",
        "## Prerequisites",
        "- IMPORTANT: Quicken For Mac must be open for this server to work. Quicken encrypts its database when the app is closed.",
        "- If a tool returns 'no such table' and Quicken is not running, offer to launch it for the user with: open -a 'Quicken'",
        "- After launching Quicken, wait a few seconds for it to decrypt the database, then retry the tool call.",
        "",
        "## Database auto-detection",
        "- If QUICKEN_DB_PATH is not set, the server auto-detects only when exactly one .quicken bundle exists in ~/Documents.",
        "- If the user has multiple Quicken files, the server refuses to guess. Instruct them to set QUICKEN_DB_PATH explicitly:",
        "    claude mcp add quicken -e QUICKEN_DB_PATH=~/Documents/YourFile.quicken/data -- npx -y quicken-mac-mcp",
      ].join("\n"),
    }
  );

  for (const tool of toolsRegistry) {
    const zodParams: Record<string, z.ZodType<any>> = {};
    for (const [pName, pDef] of Object.entries(tool.parameters)) {
      zodParams[pName] = pDef.zod;
    }
    server.tool(tool.name, tool.description, zodParams, safeTool(getDb, tool.handler));
  }

  return server;
}
