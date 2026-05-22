---
name: quicken
description: Read Quicken For Mac financial data by querying its Core Data SQLite database directly. Use when the user asks about accounts, transactions, spending, budgets, investments, or other personal-finance questions on macOS.
---

You can answer questions about the user's Quicken For Mac data by reading its SQLite database directly with the `sqlite3` CLI (or any standard SQLite library). This is the canonical, most flexible, and zero-dependency way to answer Quicken questions on macOS. It operates without any background MCP server processes and lets you write precise, powerful SQL queries tailored to the user's financial questions.

## Prerequisites

- **macOS and Location.** Quicken For Mac stores its data inside a `.quicken` folder bundle (typically under `~/Documents/`), containing a Core Data SQLite database file named `data` inside the bundle.
- **App Must Be Running.** The `data` file is encrypted-at-rest and is only fully decrypted by Quicken while the application is active and unlocked. If a query returns `"no such table: ZTRANSACTION"` or `"file is encrypted or is not a database"`, prompt the user to open Quicken with `open -a 'Quicken'` and wait a few seconds before retrying.
- **Strict Read-Only.** Always open the file using the read-only flag: `sqlite3 -readonly` (or the equivalent read-only query parameter in custom scripts). Never write to the active database.

## Auto-Detecting the Database

Quicken databases are located at `~/Documents/<file>.quicken/data`. A user may have multiple `.quicken` bundles. Pick the most recently modified one:

```bash
# Locate the active Quicken file (most recently modified)
ls -t ~/Documents/*.quicken/data 2>/dev/null | head -1
```

If the `QUICKEN_DB_PATH` environment variable is set, always prioritize it.

---

## Core Database Schema Reference

Quicken uses Apple's Core Data framework. The database follows these standard conventions:
- **`Z_` Prefixed Identifiers**: All table names are prefixed with `Z` (e.g. `ZTRANSACTION`), and all column names are prefixed with `Z` (e.g. `ZNAME`).
- **Universal Metadata Columns**:
  - `Z_PK`: Integer primary key for the table.
  - `Z_ENT`: Entity type discriminator.
  - `Z_OPT`: Optimistic locking counter.
- **Date Format**: Core Data timestamps are represented as seconds since the reference date **2001-01-01 00:00:00 UTC**. Add `978307200` to convert to standard Unix epoch time.
- **Signed Amounts**: Negative amounts represent expenses/debits; positive amounts represent income/credits.

### Key Tables Overview

| Table | Description |
|---|---|
| `ZACCOUNT` | Contains bank, credit card, savings, and investment accounts. |
| `ZTRANSACTION` | Represents individual transactions. Abstract base table for cash flow and investment entries. |
| `ZCASHFLOWTRANSACTIONENTRY` | Stores split line items. A single transaction maps to one or more split entries. |
| `ZTAG` | Contains tags and category hierarchies. Used for grouping and classification. |
| `ZUSERPAYEE` | Contains payee and merchant names. |
| `ZLOT` | Tracks investment tax lots, providing cost basis and current units. |
| `ZPOSITION` | Represents investment positions (linking accounts and securities). |
| `ZSECURITY` | Contains stock, mutual fund, and other investment asset details. |
| `ZSECURITYQUOTE` | Stores historical asset price quotes. |

---

## Query Design Patterns & Anti-Patterns

### 1. Dynamic Entity ID Resolution

#### The Pattern (Best Practice)
Core Data assigns entity numbers (`Z_ENT`) per-database. Multi-entity tables like `ZTAG` (which holds `CategoryTag`, `UserTag`, and `CashFlowTag`) rely on this discriminator. Always dynamically resolve `Z_ENT` for the `CategoryTag` entity by querying the `Z_PRIMARYKEY` table.

```sql
-- Pattern: Dynamic lookup of CategoryTag entity ID
SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'CategoryTag';
```

#### The Anti-Pattern (To Avoid)
Never hardcode `Z_ENT` values (e.g. `Z_ENT = 79`). Hardcoded entity numbers vary across different Quicken data files and will cause queries to return empty sets or incorrect data on other systems.

---

### 2. Temporal Epoch Conversion

#### The Pattern (Best Practice)
Convert Core Data timestamps by adding the epoch offset `978307200`. Use SQLite's date functions to parse and format the resulting standard Unix timestamp.

```sql
-- Pattern: Core Data to ISO Date conversion
SELECT date(COALESCE(ZPOSTEDDATE, ZENTEREDDATE) + 978307200, 'unixepoch') FROM ZTRANSACTION LIMIT 1;
```

#### The Anti-Pattern (To Avoid)
Never compare raw Core Data dates directly to standard Unix epochs or standard date strings without the offset. Doing so will result in temporal math mismatches.

---

### 3. Preventing Split Cartesian Products (Double-Counting)

#### The Pattern (Best Practice)
A single financial transaction can contain multiple split entries (e.g., a grocery transaction split into Food and Home goods). `ZTRANSACTION` stores the top-level transaction, while `ZCASHFLOWTRANSACTIONENTRY` stores individual splits. When calculating aggregates (sums or counts), join to `ZCASHFLOWTRANSACTIONENTRY` and aggregate on the split amount column (`s.ZAMOUNT`), grouping by the transaction ID if necessary.

```sql
-- Pattern: Correct split-aware expense aggregation
SELECT t.Z_PK, SUM(s.ZAMOUNT) as total_spent
FROM ZTRANSACTION t
JOIN ZCASHFLOWTRANSACTIONENTRY s ON s.ZPARENT = t.Z_PK
GROUP BY t.Z_PK
LIMIT 5;
```

#### The Anti-Pattern (To Avoid)
Never join `ZTRANSACTION` to `ZCASHFLOWTRANSACTIONENTRY` and sum the top-level transaction column `t.ZAMOUNT`. If a transaction has three splits, joining the tables creates three duplicate rows, multiplying `t.ZAMOUNT` by three and double-counting the aggregate.

---

### 4. Coalescing Double-Level Notes

#### The Pattern (Best Practice)
Notes and memos can be documented at the transaction level (`ZTRANSACTION.ZNOTE`) or at the individual split level (`ZCASHFLOWTRANSACTIONENTRY.ZNOTE`). For complete visibility, always extract and display both fields.

```sql
-- Pattern: Double-level note extraction
SELECT t.ZNOTE as transaction_note, s.ZNOTE as split_note
FROM ZTRANSACTION t
LEFT JOIN ZCASHFLOWTRANSACTIONENTRY s ON s.ZPARENT = t.Z_PK
WHERE t.ZNOTE IS NOT NULL OR s.ZNOTE IS NOT NULL
LIMIT 5;
```

#### The Anti-Pattern (To Avoid)
Never rely solely on `t.ZNOTE`. A transaction note might be empty, while the split-level memo contains critical, descriptive financial context.

---

### 5. Fuzzy Payee Normalization

#### The Pattern (Best Practice)
Merchants are often imported from raw banking descriptions with variable strings (e.g., `AMZN MKTP US*123` and `Amazon.com`). Always run a frequency-based payee query using case-insensitive fuzzy matches (`LIKE '%payee%'`) to identify clean names before filtering.

```sql
-- Pattern: Fuzzy payee discovery
SELECT p.ZNAME, COUNT(t.Z_PK) as transaction_count
FROM ZUSERPAYEE p
LEFT JOIN ZTRANSACTION t ON t.ZUSERPAYEE = p.Z_PK
WHERE p.ZNAME LIKE '%amazon%'
GROUP BY p.ZNAME
ORDER BY transaction_count DESC;
```

#### The Anti-Pattern (To Avoid)
Never query payees using an exact string match (`ZNAME = 'Amazon'`). This misses raw card reader and online portal transactions, returning incomplete data.

---

### 6. Transfer and Asset Shift Exclusion

#### The Pattern (Best Practice)
To aggregate actual monthly spending or income, isolate calculations to daily operating account types (checking and credit cards). Exclude internal transfers and asset shifts (like moving cash to savings or retirement accounts) to prevent artificial inflation of totals.

```sql
-- Pattern: Isolated expense aggregation
SELECT SUM(s.ZAMOUNT) as expenses
FROM ZTRANSACTION t
JOIN ZACCOUNT a ON t.ZACCOUNT = a.Z_PK
JOIN ZCASHFLOWTRANSACTIONENTRY s ON s.ZPARENT = t.Z_PK
WHERE UPPER(a.ZTYPENAME) IN ('CHECKING', 'CREDITCARD')
  AND s.ZAMOUNT < 0;
```

#### The Anti-Pattern (To Avoid)
Never sum raw negative numbers across all accounts in the database. Doing so treats credit card pay-offs, savings deposits, and loan principal payments as monthly consumer "spending."

---

### 7. Active Tax Lot Consolidation

#### The Pattern (Best Practice)
Investment balances and cost bases are tracked via individual tax lots. To build a robust profile of brokerage and retirement accounts, reconstruct positions by summing active tax lots (`ZLATESTUNITS > 0` in `ZLOT`) joined to positions and securities.

```sql
-- Pattern: Holdings cost basis reconstruction
SELECT a.ZNAME as account_name,
       sec.ZNAME as security_name,
       sec.ZTICKER as ticker,
       SUM(l.ZLATESTUNITS) as current_shares,
       SUM(l.ZLATESTCOSTBASIS) as total_cost
FROM ZLOT l
JOIN ZPOSITION p ON l.ZPOSITION = p.Z_PK
JOIN ZSECURITY sec ON p.ZSECURITY = sec.Z_PK
JOIN ZACCOUNT a ON p.ZACCOUNT = a.Z_PK
WHERE l.ZLATESTUNITS > 0
GROUP BY account_name, security_name, ticker;
```

#### The Anti-Pattern (To Avoid)
Never rely on the top-level `ZPOSITION` table alone. Rolled-up numbers in position records can drift or represent historical figures, failing to accurately reflect remaining active units and cost bases.

---

### 8. Dynamic Many-to-Many Join Tables (User Tags)

#### The Pattern (Best Practice)
Core Data handles many-to-many relationships by generating physical join tables with naming conventions linked directly to internal entity IDs: `Z_<EntityA_ID><RelationshipName>`. For instance, in a database where `CashFlowTransactionEntry` is entity `15` and `UserTag` is entity `76`, the join table is `Z_15USERTAGS` containing the foreign key columns `Z_15CASHFLOWTRANSACTIONENTRIES` and `Z_76USERTAGS`.

To query relationships dynamically across environments, an agent must first query the `Z_PRIMARYKEY` table to resolve the entity IDs, then dynamically build the table and column names:
1. Lookup the `Z_ENT` ID for entity names:
```sql
SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'CashFlowTransactionEntry';
-- E_ENTRY (e.g. returns 15)
SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'UserTag';
-- E_TAG (e.g. returns 76)
```
2. Build the query joining the tables:
```sql
-- Pattern: Dynamic many-to-many lookup (using E_ENTRY=15 and E_TAG=76 as environment-specific examples)
SELECT s.Z_PK, tag.ZNAME
FROM ZCASHFLOWTRANSACTIONENTRY s
JOIN Z_15USERTAGS j ON j.Z_15CASHFLOWTRANSACTIONENTRIES = s.Z_PK
JOIN ZTAG tag ON j.Z_76USERTAGS = tag.Z_PK
LIMIT 1;
```

#### The Anti-Pattern (To Avoid)
Never hardcode table names like `Z_15USERTAGS` or column names like `Z_76USERTAGS` in static queries or tools. These entity IDs are auto-generated by Core Data and vary per Quicken database, which will cause queries to throw "no such table" or "no such column" syntax errors on different user databases.

---

### 9. Querying Auto-Categorization & Quick-Fill Rules

#### The Pattern (Best Practice)
Quicken uses `ZQUICKFILLRULE` to store transaction auto-categorization preferences (quick-fill rules). Each rule defines how transactions for a specific payee should be auto-filled (e.g. amounts, transaction type, default memos). If the rule represents split categories, its components are split across multiple child entries in the `ZQUICKFILLRULESPLITENTRY` table.

To inspect how the auto-categorization engine maps merchants to default codes, run a query joining `ZQUICKFILLRULE` to its split entries:
```sql
-- Pattern: Query quick fill rules with split categories
SELECT q.Z_PK as rule_id,
       q.ZPAYEENAME as payee_name,
       q.ZAMOUNT as amount,
       cat.ZNAME as split_category,
       s.ZSEQUENCENUMBER as split_seq
FROM ZQUICKFILLRULE q
LEFT JOIN ZQUICKFILLRULESPLITENTRY s ON s.ZQUICKFILLRULE = q.Z_PK
LEFT JOIN ZTAG cat ON s.ZCATEGORYTAG = cat.Z_PK
LIMIT 1;
```

#### The Anti-Pattern (To Avoid)
Do not assume categories are stored directly on the `ZQUICKFILLRULE` table itself. Just like live transactions, quick fill rules use a split-entry structure (`ZQUICKFILLRULESPLITENTRY`) to support multi-category distributions.

---

## Annotated Everyday Recipes

Use these robust SQL scripts to answer everyday financial questions directly.

### Recipe A: Query Transactions (With Notes & Dynamic Entity Tag)

Query transactions with custom ranges. Replaces `<CAT_ENT>` with the dynamically resolved CategoryTag entity number.

```sql
SELECT t.Z_PK as transaction_id,
       a.ZNAME as account_name,
       a.ZTYPENAME as account_type,
       p.ZNAME as payee,
       cat.ZNAME as category,
       parent_cat.ZNAME as parent_category,
       s.ZAMOUNT as amount,
       date(COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE) + 978307200, 'unixepoch') as posted_date,
       t.ZNOTE as note,
       s.ZNOTE as split_note
FROM ZTRANSACTION t
JOIN ZACCOUNT a ON t.ZACCOUNT = a.Z_PK
LEFT JOIN ZUSERPAYEE p ON t.ZUSERPAYEE = p.Z_PK
LEFT JOIN ZCASHFLOWTRANSACTIONENTRY s ON s.ZPARENT = t.Z_PK
LEFT JOIN ZTAG cat ON s.ZCATEGORYTAG = cat.Z_PK AND cat.Z_ENT = <CAT_ENT>
LEFT JOIN ZTAG parent_cat ON cat.ZPARENTCATEGORY = parent_cat.Z_PK
WHERE COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE) 
      BETWEEN (julianday('2026-01-01') - 2451910.5) * 86400 
          AND (julianday('2026-12-31') - 2451910.5) * 86400
ORDER BY COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE) DESC
LIMIT 100;
```

### Recipe B: Spending By Category

Analyze expenses grouped by category or parent category.

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
  AND s.ZAMOUNT < 0
  AND COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE) 
      BETWEEN (julianday('2026-01-01') - 2451910.5) * 86400 
          AND (julianday('2026-12-31') - 2451910.5) * 86400
GROUP BY category
ORDER BY total_amount ASC;
```

### Recipe C: Portfolio Value Estimation

Estimated holdings values mapped to the latest stored security quotes.

```sql
SELECT a.ZNAME as account_name,
       sec.ZTICKER as ticker,
       sec.ZNAME as security_name,
       SUM(l.ZLATESTUNITS) as shares,
       SUM(l.ZLATESTCOSTBASIS) as cost_basis,
       q.ZCLOSINGPRICE as last_closing_price,
       date(q.ZQUOTEDATE + 978307200, 'unixepoch') as quote_date,
       (SUM(l.ZLATESTUNITS) * q.ZCLOSINGPRICE) as market_value
FROM ZLOT l
JOIN ZPOSITION p ON l.ZPOSITION = p.Z_PK
JOIN ZSECURITY sec ON p.ZSECURITY = sec.Z_PK
JOIN ZACCOUNT a ON p.ZACCOUNT = a.Z_PK
LEFT JOIN ZSECURITYQUOTE q ON q.ZSECURITY = sec.Z_PK 
  AND q.ZQUOTEDATE = (SELECT MAX(q2.ZQUOTEDATE) FROM ZSECURITYQUOTE q2 WHERE q2.ZSECURITY = sec.Z_PK)
WHERE l.ZLATESTUNITS > 0
GROUP BY account_name, ticker, security_name, last_closing_price, quote_date;
```

### Recipe D: Query Transaction Tags (Dynamic Join Resolution)

Retrieve transaction splits alongside their associated user tags. Uses `Z_15USERTAGS` for splits (entity 15) and tags (entity 76).

```sql
SELECT s.Z_PK as split_id,
       t.Z_PK as transaction_id,
       date(COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE) + 978307200, 'unixepoch') as posted_date,
       p.ZNAME as payee,
       s.ZAMOUNT as amount,
       tag.ZNAME as tag_name
FROM ZCASHFLOWTRANSACTIONENTRY s
JOIN ZTRANSACTION t ON s.ZPARENT = t.Z_PK
LEFT JOIN ZUSERPAYEE p ON t.ZUSERPAYEE = p.Z_PK
JOIN Z_15USERTAGS j ON j.Z_15CASHFLOWTRANSACTIONENTRIES = s.Z_PK
JOIN ZTAG tag ON j.Z_76USERTAGS = tag.Z_PK
LIMIT 100;
```

### Recipe E: Query Active Quick-Fill Rules

Retrieve quick-fill auto-categorization templates configured for your payees, sorted by last used timestamp.

```sql
SELECT q.Z_PK as rule_id,
       q.ZPAYEENAME as payee_name,
       q.ZTRANSACTIONTYPE as transaction_type,
       q.ZAMOUNT as default_amount,
       q.ZMEMO as default_memo,
       s.ZSEQUENCENUMBER as split_seq,
       cat.ZNAME as default_category,
       s.ZAMOUNT as split_amount,
       s.ZMEMO as split_memo,
       date(q.ZLASTUSEDTIMESTAMP + 978307200, 'unixepoch') as last_used
FROM ZQUICKFILLRULE q
LEFT JOIN ZQUICKFILLRULESPLITENTRY s ON s.ZQUICKFILLRULE = q.Z_PK
LEFT JOIN ZTAG cat ON s.ZCATEGORYTAG = cat.Z_PK
ORDER BY q.ZLASTUSEDTIMESTAMP DESC
LIMIT 100;
```

---

## Agent Workflow Guidance

1. **Auto-Detect and Verify Path**: Start by verifying the database location and confirming that the file has a non-zero size (verifying that it is unlocked).
2. **Resolve Entity IDs**: Run the `CategoryTag` dynamic `Z_ENT` query first. Cache the result for subsequent queries.
3. **Run Fuzzy Payee Pre-Queries**: If querying specific payees, perform a fuzzy group search on `ZUSERPAYEE` before filtering transactions to ensure no names are missed.
4. **Enforce Read-Only**: Ensure all agent terminal commands run with `-readonly` flag. Do not attempt modification operations.
