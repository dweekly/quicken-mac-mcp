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

- **Skill** ([`plugin/skills/quicken/SKILL.md`](plugin/skills/quicken/SKILL.md)) — teaches Claude to probe and read the Quicken SQLite database directly with Python 3's standard-library SQLite support. Its focused [`references/`](plugin/skills/quicken/references) cover balances, cash flow, investments, budgets, tags, and QuickFill rules. Works in Claude Code and any other Claude surface that loads skills. **No native module install or MCP server process.** This is the recommended path.
- **MCP server** — wraps the same SQL recipes as eight prepackaged tools (`list_accounts`, `query_transactions`, `spending_by_category`, …). Use it when you're working in a non-Claude MCP client (Cursor, Cline, mcp-remote bridges) that can't load skills, or when you'd rather call typed tools than have Claude write SQL.

The Claude Code plugin install (`claude plugin install quicken-mac-mcp`) bundles **both**, with the skill leading and the MCP tools available as shortcuts.

## Requirements

**Quicken For Mac should be open** while using either the skill or the MCP. Depending on the install, Quicken may replace its database file with an encrypted stub when the app is closed; other installs leave the file readable while closed. The probe checks for the `ZACCOUNT` table rather than assuming either way.

- **macOS**, with Quicken For Mac. Tested against Quicken 9.3.1; the older 8.5 database layout is covered by test fixtures.
- **Node.js 22.14 or newer** (23.6 or newer on the 23 line) for the MCP server and `qmac` CLI. The skill alone needs only Python 3.

## How it works

Quicken For Mac stores data in a Core Data SQLite database inside a `.quicken` bundle. The retail/subscription app keeps it in `~/Library/Application Support/Quicken/Documents/` by default (`Quicken Beta` for the beta channel); the Mac App Store build uses its sandbox container; and a file can live anywhere the user chose in File → Move To, for example `~/Documents`. The server looks in all of those (see [Custom database path](#custom-database-path)). The skill teaches Claude how to query that database directly; the MCP server is a thin wrapper that exposes eight prepackaged queries as tools.

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

Download the bundle for your Mac from the [latest GitHub release](https://github.com/dweekly/quicken-mac-mcp/releases) and drag it into Claude Desktop:

- Apple Silicon: `quicken-mac-mcp-arm64.mcpb`
- Intel: `quicken-mac-mcp-x64.mcpb`

It will prompt you for your database path (or auto-detect it).

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

If you have multiple Quicken files, or your `.quicken` bundle is somewhere the server does not look, set the `QUICKEN_DB_PATH` environment variable:

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

By default, the server auto-detects your Quicken database only when exactly one `.quicken` bundle exists across these locations:

- `~/Documents`
- `~/Library/Application Support/Quicken*/Documents` (retail/subscription default; `Quicken`, `Quicken Beta`, or a year-suffixed folder)
- `~/Library/Containers/com.quicken.QuickenAppStore/Data/Library/Application Support/Quicken/Documents` (Mac App Store build)

If multiple bundles exist, it refuses to guess and says how many it found in each location; set `QUICKEN_DB_PATH` explicitly.

## MCP tools

These are the eight prepackaged tools the MCP server exposes. The skill covers the same ground (and more) by writing SQL directly against the database — see [`plugin/skills/quicken/SKILL.md`](plugin/skills/quicken/SKILL.md).

| Tool | Description |
|------|-------------|
| `list_accounts` | List all accounts with name, type, and active/closed status. Optional type filter. |
| `list_categories` | List all category tags with parent hierarchy. Filter by expense/income. |
| `query_transactions` | Query transactions with filters: date range, account types/names, amount range, payee search, category. Returns one row per split entry, with a stable `split_id`, plus `note` (transaction-level) and `split_note` (per-split) memos. |
| `spending_by_category` | Aggregate negative consumer-spending splits by category, excluding transfers and report-excluded rows and preserving `(Uncategorized)`. |
| `spending_over_time` | Monthly negative consumer-spending totals with the same exclusions, optionally broken down by category. |
| `search_payees` | Search payees by name with transaction counts. |
| `list_portfolio` | List investment holdings with shares, cost basis, currency, and stored Quicken price quotes. Positions with a negative share count are included. |
| `raw_query` | Run arbitrary SELECT queries (500-row limit). |

## Self-Documenting Command-Line Interface (`qmac`)

This project includes a fully featured, self-documenting command-line interface `qmac` that allows you to query your Quicken SQLite database directly from the terminal without going through an MCP client.

### Features:
- **Centralized Schema Validation**: Arguments are dynamically coerced to correct types (numbers, booleans, arrays) and validated.
- **Subcommand Help (`--help` / `-h`)**: Easily inspect parameter descriptions and types for any subcommand (e.g. `qmac spending-by-category --help`).
- **Syntax Error Auto-Help**: Providing incorrect syntax or missing required fields outputs a precise error message along with the subcommand's help page.
- **Integrated Manual (`qmac man`)**: Renders the complete, stylized UNIX man page guide right in your shell.
- **Premium ASCII Table Layout**: Columns are dynamically auto-sized, numbers are right-aligned, and headers are formatted for supreme clarity. Use `--json` to get raw data for scripting.

### Example Commands:

```bash
# General help
qmac --help

# Render stylized manual page
qmac man

# List checking accounts
qmac list-accounts --account-type checking

# Find Costco transactions over $100 in 2024
qmac query-transactions --start-date 2024-01-01 --end-date 2024-12-31 --payee-search costco --max-amount -100

# Get subcategory spending breakdown for Q1 2025
qmac spending-by-category --start-date 2025-01-01 --end-date 2025-03-31 --group-by category

# Display investment portfolio holding valuations
qmac list-portfolio
```

## Example prompts

- "List my accounts"
- "What did I spend on groceries last month?"
- "Show my spending by category for 2024"
- "How has my monthly spending changed over the past year?"
- "Find all transactions from Costco over $100"
- "What are my top 10 payees by transaction count?"
- "Compare my food spending in 2024 vs 2025"

## Sovereign Financial Exporter (CSV & relational schema.json)

Want to move your complete personal financial history out of Quicken to your own sovereign, self-hosted, or custom agentic analysis platform?

This project includes a high-speed, zero-dependency, pure Python utility `scripts/export_sovereign_csv.py` that connects to your unlocked Quicken database and extracts it into a cleanly normalized, portable package.

### How to use the exporter:

1. Open your Quicken For Mac application and log in so that the database is decrypted.
2. In your terminal, execute the export script:
   ```bash
   python3 scripts/export_sovereign_csv.py
   ```
3. A new directory `quicken_sovereign_export/` will be generated, containing:
   - `accounts.csv`: Beautifully normalized accounts list (checking, credit, brokerage, retirement, etc.).
   - `categories.csv`: Income & expense category path structure.
   - `payees.csv`: Registered merchant names list.
   - `transactions.csv`: Top-level ledger with post-date, notes, and transaction-level details.
   - `transaction_splits.csv`: Line-item splits showing amounts and category IDs.
   - `holdings.csv`: Active investment holdings reconstructed from your individual tax lots with cost basis and unrealized returns.
   - `tags.csv`: Custom user tags mapped directly to splits.
   - `schema.json`: Complete relational column and foreign key reference dictionary.
   - `README.md`: A detailed migration guide demonstrating how to load and query your financial history instantly in **DuckDB**, **Pandas**, **PostgreSQL**, or other databases.

This allows other agentic platforms (like custom GPTs, self-hosted LLMs, or sovereign database agents) to immediately parse, ingest, and analyze your entire financial history.

---

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

Set `QUICKEN_DB_PATH` before `npm test` if more than one `.quicken` bundle exists across the searched locations; otherwise the live-schema suites skip.

Known issues and planned work live in [`ROADMAP.md`](ROADMAP.md) — open bugs, developer-experience gaps, and deferred dependency upgrades (fresh as of 2026-11-09).

## Docker

```bash
docker build -t quicken-mac-mcp .
docker run --rm -v ~/Documents/YourFile.quicken:/data:ro quicken-mac-mcp
```

## Documentation

Every Markdown document in this repo, with what would make it worth revisiting.

- [Schema reference](docs/schema.md): every table, column, index, entity and join table in the Quicken For Mac database, with the conventions needed to query it and field-level notes on what the values mean and where they mislead. (updated 2026-11-09; update when: a Quicken release changes the database layout, which `npm run schema:check` reports)
- [Quicken skill](plugin/skills/quicken/SKILL.md): the Claude skill's entry point: how to find and open the database safely and which reference to load for a question. (updated 2026-08-13; update when: a reference file is added or removed, or the safe-access steps change)
- [Balances reference](plugin/skills/quicken/references/balances.md): skill recipes for account balances and how fresh they are. (updated 2026-08-13; update when: Quicken changes where it stores institution balances or statements)
- [Budgets reference](plugin/skills/quicken/references/budgets.md): skill recipes for budgets, line items and targets. (updated 2026-11-09; update when: budget tables change, or the stored rollover mode values are verified)
- [Cash flow reference](plugin/skills/quicken/references/cash-flow.md): skill recipes for spending and income by category, payee and period. (updated 2026-08-13; update when: the MCP spending tools change which rows they count, since the two must agree)
- [Investments reference](plugin/skills/quicken/references/investments.md): skill recipes for holdings, tax lots and cost basis. (updated 2026-08-13; update when: position, lot or quote tables change)
- [Tags and rules reference](plugin/skills/quicken/references/tags-and-rules.md): skill recipes for user tags and QuickFill rules, including how to discover the tag join table. (updated 2026-08-13; update when: Quicken changes how tags are joined to transaction splits)
- [Changelog](CHANGELOG.md): user-visible changes by release. (updated 2026-11-09; update when: a change that users of the tools, CLI or skill would notice is merged)
- [Roadmap](ROADMAP.md): known issues, planned work and deliberately deferred upgrades. (updated 2026-11-09; update when: a known gap is found, fixed or reprioritized)
- [Contributing](CONTRIBUTING.md): how to set up, test, version and submit changes, and what to do after a Quicken update. (updated 2026-11-09; update when: the build, test, schema-refresh or release commands change)
- [Developer guidelines for Claude](CLAUDE.md): build commands and code rules for AI coding agents working in this repo. (updated 2026-05-30; update when: commands, code style or the read-only database rule change)
- [Security policy](SECURITY.md): the read-only design principles, supported versions and how to report a vulnerability. (updated 2026-03-02; update when: the reporting contact or supported versions change)
- [Code of conduct](CODE_OF_CONDUCT.md): expected behavior for participants. (updated 2026-03-02; update when: the maintainers adopt a different code or contact)
- [Launch guide](LAUNCHGUIDE.md): the listing copy used when submitting the server to MCP directories: tagline, features, setup and tags. (updated 2026-11-09; update when: tools are added or removed, or setup requirements change)

## Contributors

- [Manish Mukherjee](https://github.com/manishie) — fixed dynamic `Z_ENT` lookup for CategoryTag ([#4](https://github.com/dweekly/quicken-mac-mcp/pull/4)), added `account_names` filter and date fallback for imported transactions ([#5](https://github.com/dweekly/quicken-mac-mcp/pull/5))
- [Als-Pal](https://gist.github.com/Als-Pal) — [Quicken ↔ Amazon order matcher gist](https://gist.github.com/Als-Pal/3fc9c18949c826c207559939e8d9b90a) surfaced that notes live at two levels (`ZTRANSACTION.ZNOTE` and `ZCASHFLOWTRANSACTIONENTRY.ZNOTE`) and documented the `Z_OPT` write-back semantics now in [`docs/schema.md`](docs/schema.md).

## Disclaimer

This project is an independent, community-developed open-source tool. It is **not** an official Quicken product and is not endorsed by, directly affiliated with, maintained by, or sponsored by Quicken Inc. or the owner of the Quicken trademark. "Quicken" is a registered trademark of Rocket Mortgage, LLC. All product and company names are trademarks or registered trademarks of their respective holders. Use of them does not imply any affiliation with or endorsement by them.

This software is provided "as is," without warranty of any kind. The authors and contributors are not responsible for any damage, data loss, or other issues arising from its use. Always back up your financial data before using third-party tools.

## License

MIT
