[![MseeP.ai Security Assessment Badge](https://mseep.net/pr/dweekly-quicken-mac-mcp-badge.png)](https://mseep.ai/app/dweekly-quicken-mac-mcp)

# quicken-mac-mcp

[![npm version](https://img.shields.io/npm/v/quicken-mac-mcp)](https://www.npmjs.com/package/quicken-mac-mcp)
[![License: MIT](https://img.shields.io/badge/License-MIT-yellow.svg)](https://opensource.org/licenses/MIT)
[![GitHub release](https://img.shields.io/github/v/release/dweekly/quicken-mac-mcp)](https://github.com/dweekly/quicken-mac-mcp/releases)
[![macOS only](https://img.shields.io/badge/platform-macOS-lightgrey)](https://github.com/dweekly/quicken-mac-mcp)
[![MCP Registry](https://img.shields.io/badge/MCP-Registry-blue)](https://registry.modelcontextprotocol.io)

An [MCP server](https://modelcontextprotocol.io/) that gives Claude read-only access to your [Quicken For Mac](https://www.quicken.com/mac) financial data. Also listed on the [MCP Server Registry](https://registry.modelcontextprotocol.io). Ask Claude about your accounts, transactions, spending by category, monthly trends, and more.

The database is **always opened read-only** — your Quicken data is never modified.

## Requirements

**Quicken For Mac must be open** while using this server. Quicken encrypts its database file when the app is closed — the data is only readable while Quicken is running.

## How it works

Quicken For Mac stores data in a Core Data SQLite database inside a `.quicken` bundle in your Documents folder (e.g., `~/Documents/MyFinances.quicken/data`). This MCP server reads that database directly and exposes 8 query tools to Claude.

## Install

### Claude Code (one-liner)

```bash
claude mcp add quicken -- npx -y quicken-mac-mcp
```

### Claude Code (plugin)

```bash
claude plugin install quicken-mac-mcp
```

This installs the plugin with the MCP server and a `/quicken` skill that guides Claude on how to best query your data.

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

## Tools

| Tool | Description |
|------|-------------|
| `list_accounts` | List all accounts with name, type, and active/closed status. Optional type filter. |
| `list_categories` | List all category tags with parent hierarchy. Filter by expense/income. |
| `query_transactions` | Query transactions with filters: date range, account types/names, amount range, payee search, category. Returns one row per split entry. |
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
| `ZTRANSACTION` | Individual transactions |
| `ZCASHFLOWTRANSACTIONENTRY` | Split line items (where categories live) |
| `ZTAG` | Category tags with parent hierarchy (Z_ENT looked up at runtime) |
| `ZUSERPAYEE` | Payee names |

Dates use **Core Data epoch** (seconds since 2001-01-01). The server handles all date conversion automatically — you pass ISO 8601 dates, it returns ISO 8601 dates.

Account types are stored as uppercase strings: `CHECKING`, `CREDITCARD`, `SAVINGS`, `MORTGAGE`, `RETIREMENTIRA`, `ASSET`, `LIABILITY`, `LOAN`, etc. The tools accept any casing.

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

## Disclaimer

This project is an independent, community-developed open-source tool. It is **not** an official Intuit product and is not endorsed by, directly affiliated with, maintained by, or sponsored by Intuit Inc. or any of its subsidiaries. "Quicken" is a registered trademark of Intuit Inc. All product and company names are trademarks or registered trademarks of their respective holders. Use of them does not imply any affiliation with or endorsement by them.

This software is provided "as is," without warranty of any kind. The authors and contributors are not responsible for any damage, data loss, or other issues arising from its use. Always back up your financial data before using third-party tools.

## License

MIT
