#!/usr/bin/env node

/**
 * Entry point for the Quicken MCP server and CLI tools.
 *
 * Usage:
 *   qmac                               Start the MCP server (stdio transport)
 *   qmac export [output]               Export Quicken data to a clean SQLite database
 *   qmac [command] [args]              Run a database query subcommand directly in the CLI
 *   qmac man                           Print the integrated manual guide
 *
 * Supports global flags:
 *   -d, --db <path>                    Explicit Quicken database path
 *   --json                             Output query results as raw JSON instead of tables
 *   -h, --help                         Show help information
 *   -v, --version                      Show program version
 */

import { homedir } from "os";
import { join } from "path";
import Database from "better-sqlite3";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { createDbAccessor } from "./db.js";
import { createServer, sanitizeError } from "./server.js";
import { toolsRegistry, ToolDef } from "./tools/registry.js";
import { formatTable } from "./cli-table.js";
import { createRequire } from "node:module";

// Eagerly validate that the better-sqlite3 native module loads correctly.
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

const require = createRequire(import.meta.url);
const pkg = require("../package.json") as { version: string };

const color = {
  cyan: (str: string) => (process.stdout.isTTY ? `\x1b[36m${str}\x1b[0m` : str),
  yellow: (str: string) => (process.stdout.isTTY ? `\x1b[33m${str}\x1b[0m` : str),
  green: (str: string) => (process.stdout.isTTY ? `\x1b[32m${str}\x1b[0m` : str),
  red: (str: string) => (process.stdout.isTTY ? `\x1b[31m${str}\x1b[0m` : str),
  bold: (str: string) => (process.stdout.isTTY ? `\x1b[1m${str}\x1b[0m` : str),
  dim: (str: string) => (process.stdout.isTTY ? `\x1b[2m${str}\x1b[0m` : str),
};

function printGeneralHelp() {
  const c = color;
  console.log(
    `${c.bold("Quicken Mac CLI (qmac) & MCP Server")} ${c.dim(`(v${pkg.version})`)}`
  );
  console.log();
  console.log(`${c.bold("Usage:")}`);
  console.log(`  qmac [command] [options]`);
  console.log();
  console.log(`${c.bold("Core Commands:")}`);
  console.log(
    `  ${c.cyan("mcp").padEnd(24)} Start the MCP server (stdio transport). Default when run without command.`
  );
  console.log(
    `  ${c.cyan("export [out] [db]").padEnd(24)} Export Quicken data to a clean SQLite database.`
  );
  console.log(
    `  ${c.cyan("man").padEnd(24)} Render the stylized manual page directly in terminal.`
  );
  console.log();
  console.log(`${c.bold("Database Queries:")}`);
  for (const tool of toolsRegistry) {
    const cliCmd = tool.name.replace(/_/g, "-");
    const briefDesc = tool.description.split(".")[0] + ".";
    console.log(`  ${c.cyan(cliCmd).padEnd(24)} ${briefDesc}`);
  }
  console.log();
  console.log(`${c.bold("Global Options:")}`);
  console.log(
    `  -d, --db <path>          Path to Quicken SQLite database (overrides auto-detection).`
  );
  console.log(`  -h, --help               Show this help message.`);
  console.log(`  -v, --version            Show version.`);
  console.log(
    `  --json                   Output results as raw JSON instead of terminal tables.`
  );
  console.log();
  console.log(
    `Try '${c.green("qmac <command> --help")}' to see syntax and parameter descriptions for a specific subcommand.`
  );
}

function printSubcommandHelp(tool: ToolDef) {
  const c = color;
  console.log(`${c.bold("Subcommand:")} ${c.cyan(tool.name)}`);
  console.log(`${c.bold("Description:")}`);
  console.log(`  ${tool.description}`);
  console.log();

  const requiredParams = Object.entries(tool.parameters).filter(([, p]) => !p.optional);
  const optionalParams = Object.entries(tool.parameters).filter(([, p]) => p.optional);

  let usage = `qmac ${tool.name.replace(/_/g, "-")}`;
  for (const [pName] of requiredParams) {
    usage += ` --${pName.replace(/_/g, "-")} <value>`;
  }
  if (optionalParams.length > 0) {
    usage += " [options]";
  }
  console.log(`${c.bold("Usage:")}`);
  console.log(`  ${c.green(usage)}`);
  console.log();

  console.log(`${c.bold("Parameters:")}`);
  for (const [pName, pDef] of Object.entries(tool.parameters)) {
    const reqText = pDef.optional ? "" : ` ${c.red("(Required)")}`;
    const enumText = pDef.enumValues
      ? `\n                              Allowed values: ${pDef.enumValues.join(", ")}`
      : "";
    const typeLabel = `<${pDef.type}>`;
    console.log(
      `  --${pName.replace(/_/g, "-").padEnd(20)} ${c.dim(typeLabel.padEnd(8))}${reqText} ${pDef.description}${enumText}`
    );
  }
  console.log();
  console.log(`${c.bold("Global Options:")}`);
  console.log(`  -d, --db <path>          Path to Quicken SQLite database.`);
  console.log(
    `  --json                   Output results as raw JSON instead of terminal tables.`
  );
}

function printManPage() {
  const c = color;
  const header = `${c.bold("QMAC(1)".padEnd(30))}${c.bold("User Commands".padEnd(20))}${c.bold("QMAC(1)".padStart(30))}`;
  console.log(header);
  console.log();

  console.log(c.bold("NAME"));
  console.log("       qmac - Self-documenting CLI and MCP server for Quicken For Mac");
  console.log();

  console.log(c.bold("SYNOPSIS"));
  console.log(`       ${c.bold("qmac")} [command] [options]`);
  console.log();

  console.log(c.bold("DESCRIPTION"));
  console.log("       qmac is a dual-purpose tool providing read-only access to");
  console.log(
    "       your Quicken For Mac database. It acts as both a Model Context Protocol"
  );
  console.log(
    "       (MCP) server for AI assistants and a self-documenting CLI for direct"
  );
  console.log("       querying.");
  console.log();
  console.log(
    `       ${c.bold("IMPORTANT:")} Quicken For Mac must be running while using this tool.`
  );
  console.log(
    "       Quicken encrypts its database bundle when the application is closed."
  );
  console.log(
    "       The database is only decrypted and readable while Quicken is active."
  );
  console.log();

  console.log(c.bold("GLOBAL OPTIONS"));
  console.log(`       ${c.bold("-d, --db <path>")}`);
  console.log("              Explicit path to the Quicken SQLite database file.");
  console.log("              Overrides environment variables and automatic detection.");
  console.log();
  console.log(`       ${c.bold("--json")}`);
  console.log(
    "              Output result rows as raw, formatted JSON instead of terminal tables."
  );
  console.log();
  console.log(`       ${c.bold("-h, --help")}`);
  console.log("              Show the general help manual or subcommand-specific help.");
  console.log();
  console.log(`       ${c.bold("-v, --version")}`);
  console.log("              Show program version.");
  console.log();

  console.log(c.bold("CORE COMMANDS"));
  console.log(`       ${c.bold("mcp")}`);
  console.log(
    "              Start the Model Context Protocol (MCP) server over standard input/output"
  );
  console.log(
    "              (stdio). This is the default command if no subcommand is supplied."
  );
  console.log();
  console.log(`       ${c.bold("export [output_path] [source_db_path]")}`);
  console.log(
    "              Run the high-speed ETL pipeline to export Quicken's complex Core"
  );
  console.log(
    "              Data tables into a clean, normalized, denormalized SQLite database."
  );
  console.log("              Defaults to saving to ~/Documents/quicken-export.db.");
  console.log();
  console.log(`       ${c.bold("man")}`);
  console.log("              Render this manual page guide directly in your terminal.");
  console.log();

  console.log(c.bold("DATABASE QUERY SUBCOMMANDS"));
  console.log(
    "       All query subcommands accept arguments using either snake_case (--start_date),"
  );
  console.log("       kebab-case (--start-date), or camelCase (--startDate).");
  console.log();

  for (const tool of toolsRegistry) {
    const cliCmd = tool.name.replace(/_/g, "-");
    console.log(`       ${c.bold(cliCmd)}`);
    console.log(`              ${tool.description}`);
    console.log();
  }

  console.log(c.bold("ENVIRONMENT VARIABLES"));
  console.log(`       ${c.bold("QUICKEN_DB_PATH")}`);
  console.log(
    "              Set this environment variable to specify the absolute path to your"
  );
  console.log("              Quicken SQLite file. Avoids needing the --db argument.");
  console.log();

  console.log(c.bold("EXAMPLES"));
  console.log("       Start the MCP server for Claude Desktop:");
  console.log(`              ${c.cyan("qmac")}`);
  console.log();
  console.log("       List checking accounts:");
  console.log(`              ${c.cyan("qmac list-accounts --account-type checking")}`);
  console.log();
  console.log("       Find Costco transactions over $100 in 2024:");
  console.log(
    `              ${c.cyan("qmac query-transactions --start-date 2024-01-01 --end-date 2024-12-31 --payee-search costco --max-amount -100")}`
  );
  console.log();
  console.log("       Get subcategory spending details for Q1 2025:");
  console.log(
    `              ${c.cyan("qmac spending-by-category --start-date 2025-01-01 --end-date 2025-03-31 --group-by category")}`
  );
  console.log();
  console.log("       Read the integrated man page:");
  console.log(`              ${c.cyan("qmac man")}`);
  console.log();
}

// Argument Parsing Engine
interface ParsedArgs {
  subcommand?: string;
  commandArgs: Record<string, any>;
  dbPath?: string;
  json: boolean;
  help: boolean;
  version: boolean;
}

export function parseCLIArgs(args: string[], toolDef?: ToolDef): ParsedArgs {
  let subcommand: string | undefined = undefined;
  const commandArgs: Record<string, any> = {};
  let dbPath: string | undefined = undefined;
  let json = false;
  let help = false;
  let version = false;

  for (let i = 0; i < args.length; i++) {
    const arg = args[i];

    if (arg === "-d" || arg === "--db") {
      dbPath = args[++i];
    } else if (arg === "--json") {
      json = true;
    } else if (arg === "-h" || arg === "--help" || arg === "help") {
      help = true;
    } else if (arg === "-v" || arg === "--version") {
      version = true;
    } else if (arg.startsWith("-")) {
      let name = arg.replace(/^--?/, "");
      // Normalize camelCase and kebab-case into snake_case
      name = name
        .replace(/-([a-z])/g, (_, char) => char.toUpperCase())
        .replace(/[A-Z]/g, (letter) => `_${letter.toLowerCase()}`);

      const paramDef = toolDef?.parameters[name];
      if (paramDef) {
        if (paramDef.type === "boolean") {
          const next = args[i + 1];
          if (next === "true" || next === "yes") {
            commandArgs[name] = true;
            i++;
          } else if (next === "false" || next === "no") {
            commandArgs[name] = false;
            i++;
          } else {
            commandArgs[name] = true;
          }
        } else if (paramDef.type === "number") {
          const val = args[++i];
          commandArgs[name] = val !== undefined ? Number(val) : undefined;
        } else if (paramDef.type === "array") {
          if (!commandArgs[name]) {
            commandArgs[name] = [];
          }
          // Consume space-separated items
          while (i + 1 < args.length && !args[i + 1].startsWith("-")) {
            commandArgs[name].push(args[++i]);
          }
        } else {
          // string or enum
          commandArgs[name] = args[++i];
        }
      } else {
        // Untyped flag
        const next = args[i + 1];
        if (next && !next.startsWith("-")) {
          commandArgs[name] = next;
          i++;
        } else {
          commandArgs[name] = true;
        }
      }
    } else {
      if (!subcommand) {
        subcommand = arg;
      } else {
        // Positional fallback for core commands
        if (subcommand === "export") {
          if (!commandArgs.outputPath) {
            commandArgs.outputPath = arg;
          } else if (!commandArgs.srcDbPath) {
            commandArgs.srcDbPath = arg;
          }
        }
      }
    }
  }

  return { subcommand, commandArgs, dbPath, json, help, version };
}

// Main Dispatcher
async function run() {
  const rawArgs = process.argv.slice(2);

  // Eager check for subcommand to fetch appropriate schema for parsing
  let firstPositional = rawArgs.find((a) => !a.startsWith("-"));
  // Support help commands like "qmac help query-transactions"
  if (firstPositional === "help") {
    const nextIdx = rawArgs.indexOf("help") + 1;
    if (nextIdx < rawArgs.length && !rawArgs[nextIdx].startsWith("-")) {
      firstPositional = rawArgs[nextIdx];
      // Insert --help argument
      rawArgs.push("--help");
    }
  }

  const normSubcommand = firstPositional?.toLowerCase().replace(/-/g, "_");
  const matchedTool = toolsRegistry.find((t) => t.name === normSubcommand);

  // Parse arguments using subcommand metadata if available
  const parsed = parseCLIArgs(rawArgs, matchedTool);
  const { subcommand, commandArgs, dbPath, json, help, version } = parsed;

  if (version) {
    console.log(`qmac v${pkg.version}`);
    process.exit(0);
  }

  const activeSubcommand = subcommand?.toLowerCase().replace(/-/g, "_");

  // 1. General manual rendering command
  if (activeSubcommand === "man") {
    printManPage();
    process.exit(0);
  }

  // 2. Global general Help screen
  if (help && !activeSubcommand) {
    printGeneralHelp();
    process.exit(0);
  }

  // 3. Subcommand-specific help screen
  if (matchedTool && help) {
    printSubcommandHelp(matchedTool);
    process.exit(0);
  }

  // 4. Export database command (Core command)
  if (activeSubcommand === "export") {
    const { exportDatabase } = await import("./export.js");
    const outputPath =
      commandArgs.outputPath || join(homedir(), "Documents", "quicken-export.db");
    const srcDbPath = commandArgs.srcDbPath || dbPath || undefined;

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
      console.log(
        `\nYou can now query this database with any SQLite tool, or use it with Claude:`
      );
      console.log(`  sqlite3 "${result.outputPath}"`);
    } catch (err: any) {
      console.error(`Export failed: ${sanitizeError(err)}`);
      if (err.message?.includes("no such table")) {
        console.error(
          `\nQuicken For Mac must be running (it encrypts its database when closed).`
        );
        console.error(`Launch it with: open -a 'Quicken'`);
      }
      process.exit(1);
    }
    process.exit(0);
  }

  // 5. Query execution mode (CLI subcommands)
  if (matchedTool) {
    // Validate inputs
    const validatedArgs: Record<string, any> = {};
    const errors: string[] = [];

    for (const [pName, pDef] of Object.entries(matchedTool.parameters)) {
      const val = commandArgs[pName];
      if (val === undefined) {
        if (!pDef.optional) {
          errors.push(`Missing required parameter: --${pName.replace(/_/g, "-")}`);
        }
        continue;
      }

      const parseResult = pDef.zod.safeParse(val);
      if (!parseResult.success) {
        const errMsg = parseResult.error.errors.map((e) => e.message).join(", ");
        errors.push(`Invalid value for --${pName.replace(/_/g, "-")}: ${errMsg}`);
      } else {
        validatedArgs[pName] = parseResult.data;
      }
    }

    if (errors.length > 0) {
      console.error(color.red(color.bold("Syntax Error:")));
      errors.forEach((e) => console.error(color.red(`  * ${e}`)));
      console.error();
      // Auto-fallback subcommand help displayed automatically with incorrect syntax
      printSubcommandHelp(matchedTool);
      process.exit(1);
    }

    const getDb = createDbAccessor(dbPath);
    try {
      const db = getDb();
      const result = matchedTool.handler(db, validatedArgs);
      if (json) {
        console.log(JSON.stringify(result, null, 2));
      } else {
        console.log(formatTable(result));
      }
    } catch (err: any) {
      console.error(color.red(color.bold("Database Error:")));
      console.error(color.red(`  ${sanitizeError(err)}`));
      if (
        err.message.includes("no such table") ||
        err.message.includes("unable to open database") ||
        err.message.includes("encrypted")
      ) {
        console.error();
        console.error(color.yellow("Troubleshooting:"));
        console.error(
          "  1. Make sure Quicken For Mac is running. It encrypts its database when closed."
        );
        console.error(
          `  2. If Quicken is closed, launch it with: ${color.cyan("open -a 'Quicken'")}`
        );
        console.error(
          "  3. Wait a few seconds for Quicken to decrypt the database, then try again."
        );
      }
      process.exit(1);
    }
    process.exit(0);
  }

  // 6. MCP server mode (default fallback or explicit 'mcp')
  const isExplicitMcp = activeSubcommand === "mcp";

  // A leftover bareword positional that isn't `mcp` and didn't match a tool is
  // either an explicit DB path (legacy `qmac /path/to/data` contract) or a typo.
  // A real Quicken database path always points inside a .quicken bundle, so it
  // contains a path separator; a mistyped subcommand never does. Treat it as a
  // path only when it looks like one — otherwise report an unknown command
  // instead of silently starting a server pointed at a bogus path.
  const looksLikePath = (s?: string): boolean =>
    !!s && (s.includes("/") || s.includes("\\"));

  // Use the parsed `subcommand` (a positional that survived flag consumption),
  // not the raw first non-dash token — otherwise the value of `-d <path>` would
  // be misread as a command.
  let positionalDbPath: string | undefined;
  if (!isExplicitMcp && subcommand) {
    if (looksLikePath(subcommand)) {
      positionalDbPath = subcommand;
    } else {
      console.error(color.red(`Unknown command: ${subcommand}`));
      console.error();
      printGeneralHelp();
      process.exit(1);
    }
  }

  // Resolution order: explicit -d/--db flag first, then the legacy positional
  // path. (Previously this read rawArgs[0] directly, which clobbered the parsed
  // dbPath with the literal "-d"/"--db" flag string.)
  const explicitDbPath = dbPath || positionalDbPath || undefined;

  const getDb = createDbAccessor(explicitDbPath);
  const server = createServer(getDb);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}

run().catch((err) => {
  console.error("Fatal error:", err);
  process.exit(1);
});
