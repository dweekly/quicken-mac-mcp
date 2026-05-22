# quicken-mac-mcp

[![npm version](https://img.shields.io/npm/v/quicken-mac-mcp)](https://www.npmjs.com/package/quicken-mac-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub release](https://img.shields.io/github/v/release/dweekly/quicken-mac-mcp)](https://github.com/dweekly/quicken-mac-mcp/releases)
[![macOS only](https://img.shields.io/badge/platform-macOS-lightgrey)](https://github.com/dweekly/quicken-mac-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP-Registry-blue)](https://registry.modelcontextprotocol.io)

A **Claude Skill + MCP server** that gives Claude read-only access to your [Quicken For Mac](https://www.quicken.com/mac) financial data. Ask Claude about your accounts, transactions, spending by category, monthly trends, investment holdings, and more.

The database is **always opened read-only** — your Quicken data is never modified.

## Skill or MCP — which do I want?

This repo ships two artifacts that share the same schema knowledge ([`docs/schema.md`](docs/schema.md)):

- **Skill** ([`plugin/skills/quicken/SKILL.md`](plugin/skills/quicken/SKILL.md)) — teaches Claude to read the Quicken SQLite database directly with the `sqlite3` CLI. Works in Claude Code and any other Claude surface that loads skills. **No native module install, no MCP server process — just SQL.** This is the recommended path.
- **MCP server** — wraps the same SQL recipes as eight prepackaged tools (`list_accounts`, `query_transactions`, `spending_by_category`, …). Use it when you're working in a non-Claude MCP client (Cursor, Cline, mcp-remote bridges) that can't load skills, or when you'd rather call typed tools than have Claude write SQL.

The Claude Code plugin install (`claude plugin install quicken-mac-mcp`) bundles **both**, with the skill leading and the MCP tools available as shortcuts.

## Requirements

**Quicken For Mac must be open** while using either the skill or the MCP. Quicken encrypts its database file when the app is closed — the data is only readable while Quicken is running.

## How it works

Quicken For Mac stores data in a Core Data SQLite database inside a `.quicken` bundle in your Documents folder (e.g., `~/Documents/MyFinances.quicken/data`). The skill teaches Claude how to query that database directly; the MCP server is a thin wrapper that exposes eight prepackaged queries as tools.

## Install — recommended (Claude Code, plugin)

```bash
claude plugin install quicken-mac-mcp
```

This installs both the `/quicken` skill (recommended path) and the MCP server. Claude will lead with the skill and fall back to the MCP tools when convenient.

## Install — MCP-only paths

Use these if you're in a non-Claude-Code client that can't load skills, or you only want the typed-tool wrapper.

### Claude Code (MCP only)

```bash
claude mcp add quicken -- npx -y quicken-mac-mcp
```

### Claude Desktop (MCPB drag-and-drop)

Download `quicken-mac-mcp.mcpb` from the [latest GitHub release](https://github.com/dweekly/quicken-mac-mcp/releases) and drag it into Claude Desktop. It will prompt you for your database path (or auto-detect it).

### Claude Desktop (manual JSON)

Add to `~/Library/Application Support/Claude/claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "quicken": {
      "command": "npx",
      "args": ["-y", "quicken-mac-mcp"]
    }
  }
}
```

Restart Claude Desktop and you'll see a hammer icon with 8 tools available.

### Custom database path

If you have multiple Quicken files, or your `.quicken` bundle isn't in `~/Documents`, set the `QUICKEN_DB_PATH` environment variable:

```json
{
  "mcpServers": {
    "quicken": {
      "command": "npx",
      "args": ["-y", "quicken-mac-mcp"],
      "env": {
        "QUICKEN_DB_PATH": "/path/to/YourFile.quicken/data"
      }
    }
  }
}
```

By default, the server auto-detects your Quicken database by picking the most recently modified `.quicken` bundle in `~/Documents`.

## MCP tools

These are the eight prepackaged tools the MCP server exposes. The skill covers the same ground (and more) by writing SQL directly against the database — see [`plugin/skills/quicken/SKILL.md`](plugin/skills/quicken/SKILL.md).

| Tool | Description |
|------|-------------|
| `list_accounts` | List all accounts with name, type, and active/closed status. Optional type filter. |
| `list_categories` | List all category tags with parent hierarchy. Filter by expense/income. |
| `query_transactions` | Query transactions with filters: date range, account types/names, amount range, payee search, category. Returns one row per split entry, with `note` (transaction-level) and `split_note` (per-split) memos. |
| `spending_by_category` | Aggregate spending by category or parent category for a date range. |
| `spending_over_time` | Monthly spending totals, optionally broken down by category. |
| `search_payees` | Search payees by name with transaction counts. |
| `list_portfolio` | List investment holdings with shares, cost basis, and stored Quicken price quotes. |
| `raw_query` | Run arbitrary SELECT queries (500-row limit). |

## Example prompts

- "List my accounts"
- "What did I spend on groceries last month?"
- "Show my spending by category for 2024"
- "How has my monthly spending changed over the past year?"
- "Find all transactions from Costco over $100"
- "What are my top 10 payees by transaction count?"
- "Compare my food spending in 2024 vs 2025"

## Database schema

Quicken For Mac uses Core Data with these key tables:

| Table | Purpose |
|-------|---------|
| `ZACCOUNT` | Bank accounts, credit cards, investment accounts |
| `ZTRANSACTION` | Individual transactions (with `ZNOTE` transaction-level memo) |
| `ZCASHFLOWTRANSACTIONENTRY` | Split line items — categories AND per-split `ZNOTE` memos live here |
| `ZTAG` | Category tags with parent hierarchy (Z_ENT looked up at runtime) |
| `ZUSERPAYEE` | Payee names |

Dates use **Core Data epoch** (seconds since 2001-01-01). The MCP server handles all date conversion automatically — you pass ISO 8601 dates, it returns ISO 8601 dates. The skill recipes show the conversion (`+ 978307200`) inline so Claude can write SQL directly.

Account types are stored as uppercase strings: `CHECKING`, `CREDITCARD`, `SAVINGS`, `MORTGAGE`, `RETIREMENTIRA`, `ASSET`, `LIABILITY`, `LOAN`, etc. The tools accept any casing.

For the full schema reference (84 entities, all tables, indexes, foreign keys, and Core Data write semantics including `Z_OPT` optimistic locking), see [`docs/schema.md`](docs/schema.md).

## Development

```bash
git clone https://github.com/dweekly/quicken-mac-mcp.git
cd quicken-mac-mcp
npm install
npm test          # run tests
npm run lint      # eslint
npm run format    # prettier
npm run dev       # run server locally
```

## Docker

```bash
docker build -t quicken-mac-mcp .
docker run --rm -v ~/Documents/YourFile.quicken:/data:ro quicken-mac-mcp
```

## Contributors

- [Manish Mukherjee](https://github.com/manishie) — fixed dynamic `Z_ENT` lookup for CategoryTag ([#4](https://github.com/dweekly/quicken-mac-mcp/pull/4)), added `account_names` filter and date fallback for imported transactions ([#5](https://github.com/dweekly/quicken-mac-mcp/pull/5))
- [Als-Pal](https://gist.github.com/Als-Pal) — [Quicken ↔ Amazon order matcher gist](https://gist.github.com/Als-Pal/3fc9c18949c826c207559939e8d9b90a) surfaced that notes live at two levels (`ZTRANSACTION.ZNOTE` and `ZCASHFLOWTRANSACTIONENTRY.ZNOTE`) and documented the `Z_OPT` write-back semantics now in [`docs/schema.md`](docs/schema.md).

## Disclaimer

This project is an independent, community-developed open-source tool. It is **not** an official Intuit product and is not endorsed by, directly affiliated with, maintained by, or sponsored by Intuit Inc. or any of its subsidiaries. "Quicken" is a registered trademark of Intuit Inc. All product and company names are trademarks or registered trademarks of their respective holders. Use of them does not imply any affiliation with or endorsement by them.

This software is provided "as is," without warranty of any kind. The authors and contributors are not responsible for any damage, data loss, or other issues arising from its use. Always back up your financial data before using third-party tools.

## License

MIT
