# quicken-mac-mcp

## Tagline
Read-only MCP server for querying Quicken For Mac financial data with Claude

## Description
An MCP server that gives Claude read-only access to your Quicken For Mac financial data. It reads the Core Data SQLite database that Quicken stores in your Documents folder and exposes 8 query tools for accounts, transactions, spending analysis, and investment portfolios. Quicken For Mac must be running (it encrypts the database when closed). Your data is never modified — the database is always opened read-only.

## Setup Requirements
- `QUICKEN_DB_PATH` (optional): Path to your `.quicken/data` file. Default: auto-detects the most recently modified `.quicken` bundle in `~/Documents`.

## Category
Finance

## Features
- List all accounts with type, balance, and active/closed status
- Query transactions with flexible filters: date range, account, amount, payee, category
- Aggregate spending by category or parent category for any date range
- Track monthly spending trends over time with optional category breakdowns
- Search payees by name with transaction counts
- View investment holdings with shares, cost basis, and optional live price quotes
- Explore the raw database with arbitrary SELECT queries (500-row limit)
- Auto-detects your Quicken database — no configuration needed for most users
- Always read-only — your financial data is never modified

## Getting Started
- "List my accounts"
- "What did I spend on groceries last month?"
- "Show my spending by category for 2024"
- "How has my monthly spending changed over the past year?"
- "Find all transactions from Costco over $100"
- "What are my top 10 payees by transaction count?"
- "Compare my food spending in 2024 vs 2025"
- Tool: list_accounts — List all accounts with name, type, and active/closed status
- Tool: list_categories — List category tags with parent hierarchy
- Tool: query_transactions — Query transactions with date, amount, payee, and category filters
- Tool: spending_by_category — Aggregate spending by category for a date range
- Tool: spending_over_time — Monthly spending totals with optional category breakdown
- Tool: search_payees — Search payees by name with transaction counts
- Tool: list_portfolio — Investment holdings with shares, cost basis, and optional live quotes
- Tool: raw_query — Run arbitrary SELECT queries (500-row limit)

## Tags
quicken, finance, personal-finance, macos, budgeting, spending, transactions, accounts, investments, portfolio, categories, read-only, sqlite

## Documentation URL
https://github.com/dweekly/quicken-mac-mcp
