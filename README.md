# quicken-mac-mcp

An [MCP server](https://modelcontextprotocol.io/) that gives Claude read-only access to your [Quicken For Mac](https://www.quicken.com/mac) financial data. Ask Claude about your accounts, transactions, spending by category, monthly trends, and more.

The database is **always opened read-only** — your Quicken data is never modified.

## How it works

Quicken For Mac stores data in a Core Data SQLite database inside a `.quicken` bundle in your Documents folder (e.g., `~/Documents/MyFinances.quicken/data`). This MCP server reads that database directly and exposes 7 query tools to Claude.

## Quick start

### Claude Code

Add to your project's `.mcp.json`:

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

### Claude Desktop

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

Restart Claude Desktop and you'll see a hammer icon with 7 tools available.

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

By default, the server auto-detects your Quicken database by scanning `~/Documents` for `.quicken` bundles. If exactly one is found, it uses that. If multiple are found, it lists them and asks you to specify which one.

## Tools

| Tool | Description |
|------|-------------|
| `list_accounts` | List all accounts with name, type, and active/closed status. Optional type filter. |
| `list_categories` | List all category tags with parent hierarchy. Filter by expense/income. |
| `query_transactions` | Query transactions with filters: date range, account types/names, amount range, payee search, category. Returns one row per split entry. |
| `spending_by_category` | Aggregate spending by category or parent category for a date range. |
| `spending_over_time` | Monthly spending totals, optionally broken down by category. |
| `search_payees` | Search payees by name with transaction counts. |
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
| `ZTAG` (Z_ENT=79) | Category tags with parent hierarchy |
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

## License

MIT
