---
name: quicken
description: Read Quicken For Mac financial data by querying its Core Data SQLite database directly. Use when the user asks about accounts, transactions, spending, budgets, investments, or other personal-finance questions on macOS.
---

You can answer questions about the user's Quicken For Mac data by reading its SQLite database directly with the `sqlite3` CLI (or any SQLite library). This is the canonical, most flexible way to answer Quicken questions on macOS — it works without any MCP server installed and lets you write whatever query the question demands.

If the [`quicken-mac-mcp`](https://github.com/dweekly/quicken-mac-mcp) MCP server is also installed, you can use its prepackaged tools (`list_accounts`, `query_transactions`, `spending_by_category`, etc.) as shortcuts for common queries — but every one of those tools is just a wrapper around the SQL recipes below, so falling back to direct SQL is always fine.

## Prerequisites

- **macOS only.** Quicken For Mac stores data in a `.quicken` bundle (a directory) under `~/Documents/`, containing a Core Data SQLite database at `<bundle>/data`.
- **Quicken For Mac must be running.** The `data` file is encrypted-at-rest and only decrypted while the app is open. If a query returns `"no such table: ZTRANSACTION"` or `"file is encrypted or is not a database"`, prompt the user to open Quicken with `open -a 'Quicken'` and wait a few seconds before retrying.
- **Read-only.** Always open the file with the read-only flag (`sqlite3 -readonly`, or `sqlite3` with the `file:...?mode=ro` URI). Never write — see "Writing back" in the schema reference for the Z_OPT / app-must-be-closed footguns if a user explicitly asks for an enrichment workflow.

## Finding the database

Quicken For Mac stores its data file at `~/Documents/<file>.quicken/data`. (`.quicken` is a directory bundle; the SQLite file is the `data` file inside it.) A user may have multiple `.quicken` bundles — pick the most recently modified one unless they specify a different file.

```bash
# Auto-detect the active Quicken file (most recently modified)
ls -t ~/Documents/*.quicken/data 2>/dev/null | head -1
```

If `QUICKEN_DB_PATH` is set in the environment, prefer it over auto-detection.

## Schema cheatsheet

Quicken uses Apple Core Data conventions. The full schema reference (84 entities, all tables, indexes, foreign keys) lives in [`docs/schema.md`](https://github.com/dweekly/quicken-mac-mcp/blob/main/docs/schema.md) — fetch it when you need a column you don't see below.

### Core Data conventions

- All tables prefixed with `Z`, all columns prefixed with `Z`. Every entity has `Z_PK` (primary key), `Z_ENT` (entity-type discriminator), `Z_OPT` (optimistic-lock counter).
- **Dates** are Core Data epoch: seconds since `2001-01-01 00:00:00 UTC`. Convert to Unix epoch with `+ 978307200`, or to ISO with SQLite's `datetime(col + 978307200, 'unixepoch')`.
- **Amounts** are signed: negative = debit/expense, positive = credit/income.
- **`Z_ENT` values are per-database.** Tables like `ZTAG` hold multiple entity types (`CategoryTag`, `UserTag`, `CashFlowTag`); look up the entity number at runtime: `SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'CategoryTag'`. Do not hardcode.

### Key tables for everyday queries

| Table | Purpose |
|---|---|
| `ZACCOUNT` | Bank, credit card, investment accounts. `ZNAME`, `ZTYPENAME` (`CHECKING`, `CREDITCARD`, …), `ZACTIVE`, `ZCLOSED`. |
| `ZTRANSACTION` | One row per transaction. `ZACCOUNT` → account, `ZUSERPAYEE` → payee. Date columns: `ZPOSTEDDATE`, `ZENTEREDDATE` (use `COALESCE(ZPOSTEDDATE, ZENTEREDDATE)` — imported transactions sometimes lack `ZPOSTEDDATE`). `ZNOTE` = transaction-level memo. |
| `ZCASHFLOWTRANSACTIONENTRY` | Split line items. One transaction → one or more entries. `ZPARENT` → `ZTRANSACTION.Z_PK`, `ZAMOUNT` (signed), `ZCATEGORYTAG` → `ZTAG.Z_PK`, `ZNOTE` = per-split memo. |
| `ZUSERPAYEE` | Payees. `ZNAME`. |
| `ZTAG` | Category/tag hierarchy. Filter to categories via `Z_ENT = (SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'CategoryTag')`. `ZPARENTCATEGORY` → parent `ZTAG.Z_PK`. `ZINCOME` distinguishes income vs expense categories. |
| `ZPOSITION` + `ZSECURITY` + `ZSECURITYQUOTE` | Investment holdings, cost basis, last-known prices. |

### Footguns

- **Splits multiply rows.** A `ZTRANSACTION JOIN ZCASHFLOWTRANSACTIONENTRY` returns one row per split — a single $100 grocery transaction split across "Food" and "Household" produces two rows. Aggregate on `s.ZAMOUNT`, not `t` columns, when summing.
- **Notes live at two levels.** `ZTRANSACTION.ZNOTE` is the transaction-level memo; `ZCASHFLOWTRANSACTIONENTRY.ZNOTE` is per-split. A transaction can look "empty" at the top level but be documented at the split level — surface both when looking for undocumented transactions.
- **Payee names are messy.** Quicken auto-extracts from raw bank descriptions, so the same merchant may appear as `Amazon.com`, `AMZN Mktp US`, and `AMAZON.COM*AMZN.COM/BILL`. Always do a `LIKE '%amazon%'` discovery query before filtering.
- **Account types are uppercase strings.** `CHECKING`, `CREDITCARD`, `SAVINGS`, `MORTGAGE`, `RETIREMENTIRA`, `ASSET`, `LIABILITY`, `LOAN`, etc. Use `UPPER()` on both sides for case-insensitive matching.
- **Default to checking + credit card** for "spending" questions unless the user asks otherwise — including investment, asset, or loan accounts in spending totals double-counts transfers.

## Recipes

These are the SQL bodies of the eight MCP tools, lightly annotated. Run them with `sqlite3 -readonly "$DB_PATH" "<query>"`.

### Resolve the CategoryTag entity ID (used by most recipes)

```sql
SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'CategoryTag';
-- Substitute the result wherever <CAT_ENT> appears below.
```

### List accounts

```sql
SELECT Z_PK as id, ZNAME as name, ZTYPENAME as type,
       (ZACTIVE = 1) as active, (ZCLOSED = 1) as closed
FROM ZACCOUNT
ORDER BY ZNAME;
```

### Query transactions (with notes at both levels)

```sql
SELECT t.Z_PK as transaction_id,
       a.ZNAME as account_name, a.ZTYPENAME as account_type,
       p.ZNAME as payee,
       cat.ZNAME as category, parent_cat.ZNAME as parent_category,
       s.ZAMOUNT as amount,
       date(COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE) + 978307200, 'unixepoch') as posted_date,
       t.ZNOTE as note,                  -- transaction-level memo
       s.ZNOTE as split_note             -- per-split memo
FROM ZTRANSACTION t
JOIN ZACCOUNT a ON t.ZACCOUNT = a.Z_PK
LEFT JOIN ZUSERPAYEE p ON t.ZUSERPAYEE = p.Z_PK
LEFT JOIN ZCASHFLOWTRANSACTIONENTRY s ON s.ZPARENT = t.Z_PK
LEFT JOIN ZTAG cat ON s.ZCATEGORYTAG = cat.Z_PK AND cat.Z_ENT = <CAT_ENT>
LEFT JOIN ZTAG parent_cat ON cat.ZPARENTCATEGORY = parent_cat.Z_PK
WHERE COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE)
      BETWEEN (julianday('2025-01-01') - 2451910.5) * 86400
          AND (julianday('2025-12-31') - 2451910.5) * 86400
ORDER BY COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE) DESC
LIMIT 100;
```

### Spending by category

```sql
SELECT COALESCE(parent_cat.ZNAME, cat.ZNAME) as category,
       SUM(s.ZAMOUNT) as total_amount,
       COUNT(*) as transaction_count
FROM ZTRANSACTION t
JOIN ZACCOUNT a ON t.ZACCOUNT = a.Z_PK
JOIN ZCASHFLOWTRANSACTIONENTRY s ON s.ZPARENT = t.Z_PK
JOIN ZTAG cat ON s.ZCATEGORYTAG = cat.Z_PK AND cat.Z_ENT = <CAT_ENT>
LEFT JOIN ZTAG parent_cat ON cat.ZPARENTCATEGORY = parent_cat.Z_PK
WHERE UPPER(a.ZTYPENAME) IN ('CHECKING', 'CREDITCARD')
  AND s.ZAMOUNT < 0   -- expenses only
  AND COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE) BETWEEN ? AND ?
GROUP BY category
ORDER BY total_amount ASC;   -- most-negative (largest expense) first
```

### Spending over time (monthly)

```sql
SELECT strftime('%Y-%m', COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE) + 978307200, 'unixepoch') as month,
       SUM(s.ZAMOUNT) as total
FROM ZTRANSACTION t
JOIN ZACCOUNT a ON t.ZACCOUNT = a.Z_PK
JOIN ZCASHFLOWTRANSACTIONENTRY s ON s.ZPARENT = t.Z_PK
WHERE UPPER(a.ZTYPENAME) IN ('CHECKING', 'CREDITCARD')
  AND s.ZAMOUNT < 0
GROUP BY month
ORDER BY month;
```

### Search payees

```sql
SELECT p.Z_PK, p.ZNAME, COUNT(t.Z_PK) as txn_count
FROM ZUSERPAYEE p
LEFT JOIN ZTRANSACTION t ON t.ZUSERPAYEE = p.Z_PK
WHERE p.ZNAME LIKE '%amazon%'
GROUP BY p.Z_PK
ORDER BY txn_count DESC;
```

### Investment portfolio

Holdings are reconstructed from `ZLOT` (tax lots), not directly from `ZPOSITION` — Quicken tracks per-lot units and cost basis and rolls them up. The latest stored price comes from `ZSECURITYQUOTE.ZCLOSINGPRICE` for the most recent `ZQUOTEDATE` per security.

```sql
-- Holdings: shares + cost basis, summed across lots per (account, security)
SELECT a.ZNAME as account,
       sec.ZNAME as security,
       sec.ZTICKER as ticker,
       ROUND(SUM(l.ZLATESTUNITS), 6) as current_shares,
       ROUND(SUM(l.ZLATESTCOSTBASIS), 2) as cost_basis
FROM ZLOT l
JOIN ZPOSITION pos ON l.ZPOSITION = pos.Z_PK
JOIN ZSECURITY sec ON pos.ZSECURITY = sec.Z_PK
JOIN ZACCOUNT a ON pos.ZACCOUNT = a.Z_PK
WHERE l.ZLATESTUNITS > 0
GROUP BY a.ZNAME, sec.ZNAME, sec.ZTICKER
ORDER BY a.ZNAME, sec.ZNAME;

-- Last-known price per security (Quicken's stored quotes — may be days stale)
SELECT sec.ZTICKER as ticker,
       q.ZCLOSINGPRICE as price,
       date(q.ZQUOTEDATE + 978307200, 'unixepoch') as price_date
FROM ZSECURITYQUOTE q
JOIN ZSECURITY sec ON q.ZSECURITY = sec.Z_PK
WHERE sec.ZTICKER IS NOT NULL
  AND q.ZQUOTEDATE = (SELECT MAX(q2.ZQUOTEDATE) FROM ZSECURITYQUOTE q2 WHERE q2.ZSECURITY = sec.Z_PK);
```

## Workflow guidance

1. **Always start by orienting.** List accounts, look up the CategoryTag entity ID, and (if asked about a payee) run a payee discovery query — this is much cheaper than guessing wrong on a payee name and getting an empty result.
2. **Echo the SQL you ran** when the answer is non-trivial. The user can re-run, modify, or audit it.
3. **Be honest about limits.** Quicken's stored prices for investments may be days stale; transfers between accounts can double-count if you sum across all account types.
4. **For enrichment / write workflows** (rare — usually the user just wants to read), see the "Writing back to the database" section in [`docs/schema.md`](https://github.com/dweekly/quicken-mac-mcp/blob/main/docs/schema.md). Always confirm with the user, always back up the `data` file first, always close Quicken before writing, always increment `Z_OPT`.
