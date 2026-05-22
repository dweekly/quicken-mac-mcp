#!/usr/bin/env python3
"""
Sovereign CSV Exporter for Quicken For Mac.
Transforms the proprietary, encrypted-at-rest Core Data SQLite database into a
clean, normalized, zero-dependency set of standard CSV tables and a relational
schema.json description. 

Supports direct migration to self-hosted/sovereign personal finance setups.
"""

import os
import sys
import csv
import json
import sqlite3
from datetime import datetime

# Epoch offset: Core Data epoch (2001-01-01) to Unix epoch (1970-01-01)
CORE_DATA_EPOCH_OFFSET = 978307200

def log(msg):
    sys.stderr.write(f"[*] {msg}\n")
    sys.stderr.flush()

def detect_quicken_db():
    """Detect the active Quicken database path, checking environment and common folders."""
    env_path = os.environ.get("QUICKEN_DB_PATH")
    if env_path:
        if os.path.exists(env_path):
            return env_path
        log(f"WARNING: QUICKEN_DB_PATH env set to '{env_path}' but file was not found.")

    home = os.path.expanduser("~")
    search_dirs = [
        os.path.join(home, "Documents"),
        os.path.join(home, "Library", "Mobile Documents", "com~apple~CloudDocs", "Documents") # iCloud Drive
    ]

    quicken_bundles = []
    for d in search_dirs:
        if not os.path.exists(d):
            continue
        try:
            for name in os.listdir(d):
                if name.endswith(".quicken"):
                    bundle_path = os.path.join(d, name, "data")
                    if os.path.exists(bundle_path):
                        mtime = os.path.getmtime(bundle_path)
                        quicken_bundles.append((bundle_path, mtime))
        except Exception as e:
            log(f"Error reading directory {d}: {e}")

    if not quicken_bundles:
        raise FileNotFoundError(
            "Could not locate any active .quicken bundles in ~/Documents or iCloud Drive.\n"
            "Please set the QUICKEN_DB_PATH environment variable."
        )

    # Pick the most recently modified bundle
    quicken_bundles.sort(key=lambda x: x[1], reverse=True)
    return quicken_bundles[0][0]

def to_iso_date(ts):
    """Convert Core Data timestamp (seconds since 2001) to ISO date (YYYY-MM-DD)."""
    if ts is None:
        return ""
    try:
        unix = ts + CORE_DATA_EPOCH_OFFSET
        return datetime.utcfromtimestamp(unix).strftime("%Y-%m-%d")
    except Exception:
        return ""

def normalize_account_type(raw):
    """Normalize and lowercase Core Data account types."""
    if not raw:
        return "unknown"
    raw_upper = raw.upper()
    mapping = {
        "CHECKING": "checking",
        "CREDITCARD": "credit_card",
        "SAVINGS": "savings",
        "MORTGAGE": "mortgage",
        "RETIREMENTIRA": "retirement_ira",
        "RETIREMENT401K": "retirement_401k",
        "ASSET": "asset",
        "LIABILITY": "liability",
        "LOAN": "loan",
        "BROKERAGE": "brokerage",
        "CASH": "cash"
    }
    return mapping.get(raw_upper, raw.lower())

def export_table(conn, query, params, output_path, headers, row_transformer=None):
    """Executes a query and writes results to a CSV file."""
    cursor = conn.cursor()
    cursor.execute(query, params)
    
    with open(output_path, "w", newline="", encoding="utf-8") as f:
        writer = csv.writer(f)
        writer.writerow(headers)
        
        row_count = 0
        for row in cursor:
            if row_transformer:
                row = row_transformer(row)
            writer.writerow(row)
            row_count += 1
            
    return row_count

def run_sovereign_export(output_dir):
    """Connects to active DB and exports clean CSV tables + schema.json."""
    os.makedirs(output_dir, exist_ok=True)
    
    db_path = detect_quicken_db()
    log(f"Source Database: {db_path}")
    log(f"Output Directory: {output_dir}")
    
    # Open connection read-only
    conn = sqlite3.connect(f"file:{db_path}?mode=ro", uri=True)
    conn.row_factory = sqlite3.Row
    cursor = conn.cursor()
    
    # Verify DB is decrypted by querying ZACCOUNT
    try:
        cursor.execute("SELECT COUNT(*) FROM ZACCOUNT")
    except sqlite3.OperationalError as e:
        if "encrypted" in str(e) or "no such table" in str(e):
            log("FATAL: The Quicken database is currently encrypted or locked.")
            log("Ensure that the Quicken For Mac application is OPEN and you have logged in.")
            sys.exit(1)
        raise e

    # 1. Dynamically Resolve Entity IDs from Z_PRIMARYKEY
    log("Resolving dynamic entity types...")
    cursor.execute("SELECT Z_ENT, Z_NAME FROM Z_PRIMARYKEY")
    entities = {row["Z_NAME"]: row["Z_ENT"] for row in cursor}
    
    category_tag_ent = entities.get("CategoryTag")
    user_tag_ent = entities.get("UserTag")
    entry_ent = entities.get("CashFlowTransactionEntry")
    
    if not category_tag_ent or not user_tag_ent or not entry_ent:
        log("FATAL: Could not locate critical entities in ZPRIMARYKEY.")
        sys.exit(1)
        
    log(f"Resolved Entity IDs: CategoryTag={category_tag_ent}, UserTag={user_tag_ent}, CashFlowTransactionEntry={entry_ent}")

    # Identify many-to-many user tags join table
    # Standard Core Data naming convention: Z_<EntityID><RelationshipName>
    user_tags_table = f"Z_{entry_ent}USERTAGS"
    
    # Verify if many-to-many join table exists in schema
    cursor.execute("SELECT name FROM sqlite_master WHERE type='table' AND name=?", (user_tags_table,))
    has_user_tags = cursor.fetchone() is not None
    if has_user_tags:
        log(f"Located active User Tags join table: {user_tags_table}")
    else:
        log("No User Tags join table found. Custom tag exporting will be skipped.")

    stats = {}

    # 2. Export: Accounts
    log("Exporting accounts.csv...")
    acc_query = "SELECT Z_PK, ZNAME, ZTYPENAME, ZACTIVE, ZCLOSED FROM ZACCOUNT ORDER BY ZNAME"
    acc_headers = ["account_id", "name", "type", "is_active", "is_closed"]
    def transform_acc(row):
        return [
            row["Z_PK"],
            row["ZNAME"],
            normalize_account_type(row["ZTYPENAME"]),
            1 if row["ZACTIVE"] == 1 else 0,
            1 if row["ZCLOSED"] == 1 else 0
        ]
    stats["accounts"] = export_table(
        conn, acc_query, [], os.path.join(output_dir, "accounts.csv"), acc_headers, transform_acc
    )

    # 3. Export: Categories
    log("Exporting categories.csv...")
    cat_query = """
        SELECT c.Z_PK, c.ZNAME, c.ZTYPE, p.ZNAME as parent_name
        FROM ZTAG c
        LEFT JOIN ZTAG p ON c.ZPARENTCATEGORY = p.Z_PK
        WHERE c.Z_ENT = ?
        ORDER BY COALESCE(parent_name, c.ZNAME), c.ZNAME
    """
    cat_headers = ["category_id", "name", "parent_name", "full_name", "type"]
    def transform_cat(row):
        p_name = row["parent_name"]
        name = row["ZNAME"]
        full_name = f"{p_name} : {name}" if p_name else name
        cat_type = "expense" if row["ZTYPE"] == 1 else ("income" if row["ZTYPE"] == 2 else "other")
        return [row["Z_PK"], name, p_name or "", full_name, cat_type]
        
    stats["categories"] = export_table(
        conn, cat_query, [category_tag_ent], os.path.join(output_dir, "categories.csv"), cat_headers, transform_cat
    )

    # 4. Export: Payees
    log("Exporting payees.csv...")
    payee_query = "SELECT Z_PK, ZNAME FROM ZUSERPAYEE WHERE ZNAME IS NOT NULL ORDER BY ZNAME"
    payee_headers = ["payee_id", "name"]
    def transform_payee(row):
        return [row["Z_PK"], row["ZNAME"]]
        
    stats["payees"] = export_table(
        conn, payee_query, [], os.path.join(output_dir, "payees.csv"), payee_headers, transform_payee
    )

    # 5. Export: Transactions (Top-level Ledger)
    log("Exporting transactions.csv...")
    tx_query = """
        SELECT t.Z_PK, COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE) as date_raw,
               t.ZACCOUNT, a.ZNAME as account_name, a.ZTYPENAME as account_type,
               t.ZUSERPAYEE, p.ZNAME as payee_name, t.ZNOTE
        FROM ZTRANSACTION t
        JOIN ZACCOUNT a ON t.ZACCOUNT = a.Z_PK
        LEFT JOIN ZUSERPAYEE p ON t.ZUSERPAYEE = p.Z_PK
        ORDER BY date_raw DESC
    """
    tx_headers = ["transaction_id", "date", "account_id", "account_name", "account_type", "payee_id", "payee_name", "note", "total_amount"]
    
    # Cache split amount sums per transaction to populate total_amount field
    cursor.execute("SELECT ZPARENT, ROUND(SUM(ZAMOUNT), 2) as total FROM ZCASHFLOWTRANSACTIONENTRY GROUP BY ZPARENT")
    amounts = {row["ZPARENT"]: row["total"] for row in cursor if row["ZPARENT"]}
    
    def transform_tx(row):
        tx_id = row["Z_PK"]
        return [
            tx_id,
            to_iso_date(row["date_raw"]),
            row["ZACCOUNT"],
            row["account_name"],
            normalize_account_type(row["account_type"]),
            row["ZUSERPAYEE"] or "",
            row["payee_name"] or "",
            row["ZNOTE"] or "",
            amounts.get(tx_id, 0.0)
        ]
    stats["transactions"] = export_table(
        conn, tx_query, [], os.path.join(output_dir, "transactions.csv"), tx_headers, transform_tx
    )

    # 6. Export: Transaction Splits (Granular Ledger)
    log("Exporting transaction_splits.csv...")
    split_query = """
        SELECT s.Z_PK, s.ZPARENT, s.ZCATEGORYTAG, cat.ZNAME as category_name,
               parent_cat.ZNAME as parent_category, s.ZAMOUNT, s.ZNOTE
        FROM ZCASHFLOWTRANSACTIONENTRY s
        LEFT JOIN ZTAG cat ON s.ZCATEGORYTAG = cat.Z_PK AND cat.Z_ENT = ?
        LEFT JOIN ZTAG parent_cat ON cat.ZPARENTCATEGORY = parent_cat.Z_PK
        WHERE s.ZPARENT IS NOT NULL
        ORDER BY s.ZPARENT, s.Z_PK
    """
    split_headers = ["split_id", "transaction_id", "category_id", "category_name", "parent_category", "amount", "note"]
    def transform_split(row):
        return [
            row["Z_PK"],
            row["ZPARENT"],
            row["ZCATEGORYTAG"] or "",
            row["category_name"] or "",
            row["parent_category"] or "",
            round(row["ZAMOUNT"], 2),
            row["ZNOTE"] or ""
        ]
    stats["splits"] = export_table(
        conn, split_query, [category_tag_ent], os.path.join(output_dir, "transaction_splits.csv"), split_headers, transform_split
    )

    # 7. Export: Investment Holdings
    log("Exporting holdings.csv...")
    holding_headers = ["account_name", "security_name", "ticker", "shares", "cost_basis", "last_price", "price_date", "market_value", "gain_loss"]
    
    # Cache quotes mapping
    quote_map = {}
    try:
        cursor.execute("""
            SELECT s.ZTICKER as ticker, q.ZCLOSINGPRICE as price, q.ZQUOTEDATE as q_date
            FROM ZSECURITYQUOTE q
            JOIN ZSECURITY s ON q.ZSECURITY = s.Z_PK
            WHERE s.ZTICKER IS NOT NULL
              AND q.ZQUOTEDATE = (SELECT MAX(q2.ZQUOTEDATE) FROM ZSECURITYQUOTE q2 WHERE q2.ZSECURITY = s.Z_PK)
        """)
        quote_map = {row["ticker"]: (row["price"], row["q_date"]) for row in cursor}
    except Exception:
        log("No investment quote table found or accessible. Continuing without quote mapping.")

    # Reconstruct lots
    lot_query = """
        SELECT a.ZNAME as account_name, sec.ZNAME as security_name, sec.ZTICKER as ticker,
               SUM(l.ZLATESTUNITS) as shares, SUM(l.ZLATESTCOSTBASIS) as cost_basis
        FROM ZLOT l
        JOIN ZPOSITION p ON l.ZPOSITION = p.Z_PK
        JOIN ZSECURITY sec ON p.ZSECURITY = sec.Z_PK
        JOIN ZACCOUNT a ON p.ZACCOUNT = a.Z_PK
        WHERE l.ZLATESTUNITS > 0
        GROUP BY account_name, security_name, ticker
        ORDER BY account_name, security_name
    """
    
    def transform_holding(row):
        ticker = row["ticker"]
        shares = row["shares"]
        cost = row["cost_basis"]
        
        quote = quote_map.get(ticker) if ticker else None
        price = quote[0] if quote else None
        p_date = to_iso_date(quote[1]) if quote else ""
        
        market_val = round(shares * price, 2) if price is not None else ""
        gain_loss = round(market_val - cost, 2) if price is not None else ""
        
        return [
            row["account_name"],
            row["security_name"],
            ticker or "",
            round(shares, 6),
            round(cost, 2),
            price or "",
            p_date,
            market_val,
            gain_loss
        ]
        
    try:
        stats["holdings"] = export_table(
            conn, lot_query, [], os.path.join(output_dir, "holdings.csv"), holding_headers, transform_holding
        )
    except Exception as e:
        log(f"Investment holdings export skipped: {e}")
        stats["holdings"] = 0

    # 8. Export: Custom User Tags
    if has_user_tags:
        log("Exporting tags.csv...")
        # Get column names of many-to-many table dynamically to map them
        cursor.execute(f"PRAGMA table_info({user_tags_table})")
        cols = [r["name"] for r in cursor]
        
        # Core Data names: first column links to Split (CashFlowTransactionEntry), second column links to Tag
        split_col = cols[0]
        tag_col = cols[1]
        
        tag_query = f"""
            SELECT jt.{split_col} as split_id, t.ZNAME as tag_name
            FROM {user_tags_table} jt
            JOIN ZTAG t ON jt.{tag_col} = t.Z_PK
            WHERE t.Z_ENT = ?
        """
        tag_headers = ["split_id", "tag_name"]
        def transform_tag(row):
            return [row["split_id"], row["tag_name"]]
            
        stats["tags"] = export_table(
            conn, tag_query, [user_tag_ent], os.path.join(output_dir, "tags.csv"), tag_headers, transform_tag
        )
    else:
        stats["tags"] = 0

    # 9. Generate: Relational schema.json description
    log("Compiling schema.json...")
    schema = {
        "metadata": {
            "exported_at": datetime.utcnow().isoformat() + "Z",
            "source_app": "Quicken For Mac",
            "exporter": "Sovereign Exporter v1.0",
            "row_counts": stats
        },
        "tables": {
            "accounts": {
                "description": "Financial accounts defined in Quicken.",
                "columns": {
                    "account_id": {"type": "integer", "primary_key": True, "description": "Unique identifier of the account."},
                    "name": {"type": "string", "description": "The user-assigned display name of the account."},
                    "type": {"type": "string", "description": "Normalized account category: checking, credit_card, savings, retirement_ira, retirement_401k, asset, liability, loan, brokerage, cash."},
                    "is_active": {"type": "boolean", "description": "1 if the account is currently active, 0 otherwise."},
                    "is_closed": {"type": "boolean", "description": "1 if the account has been marked as closed, 0 otherwise."}
                }
            },
            "categories": {
                "description": "Category tags hierarchy classifying transactions (expense/income classification).",
                "columns": {
                    "category_id": {"type": "integer", "primary_key": True, "description": "Unique identifier of the category."},
                    "name": {"type": "string", "description": "The local name of the subcategory."},
                    "parent_name": {"type": "string", "description": "The name of the parent category, if applicable."},
                    "full_name": {"type": "string", "description": "The complete category path, formatted as 'Parent : Child'."},
                    "type": {"type": "string", "description": "Is this category classified as an 'expense', 'income', or 'other'."}
                }
            },
            "payees": {
                "description": "Registered unique payee names and merchants.",
                "columns": {
                    "payee_id": {"type": "integer", "primary_key": True, "description": "Unique identifier of the payee."},
                    "name": {"type": "string", "description": "Cleaned Merchant / Payee name."}
                }
            },
            "transactions": {
                "description": "The top-level ledger. Contains general transaction metadata.",
                "columns": {
                    "transaction_id": {"type": "integer", "primary_key": True, "description": "Unique identifier of the transaction."},
                    "date": {"type": "date (ISO 8601)", "description": "The posted or entered transaction date formatted as YYYY-MM-DD."},
                    "account_id": {"type": "integer", "references": "accounts.account_id", "description": "Foreign key pointing to the account."},
                    "account_name": {"type": "string", "description": "The name of the account associated with the transaction."},
                    "account_type": {"type": "string", "description": "The normalized type of the account."},
                    "payee_id": {"type": "integer", "references": "payees.payee_id", "description": "Foreign key pointing to the merchant/payee (can be empty)."},
                    "payee_name": {"type": "string", "description": "The name of the merchant/payee."},
                    "note": {"type": "string", "description": "The general transaction memo notes."},
                    "total_amount": {"type": "float", "description": "The combined transaction split amounts. Expenses are signed negative, incomes positive."}
                }
            },
            "transaction_splits": {
                "description": "Granular ledger. A single transaction split across different categories and memos.",
                "columns": {
                    "split_id": {"type": "integer", "primary_key": True, "description": "Unique identifier of the split item."},
                    "transaction_id": {"type": "integer", "references": "transactions.transaction_id", "description": "Foreign key pointing to parent transaction."},
                    "category_id": {"type": "integer", "references": "categories.category_id", "description": "Foreign key pointing to assigned category."},
                    "category_name": {"type": "string", "description": "The subcategory name assigned to this split."},
                    "parent_category": {"type": "string", "description": "The parent category name of the split category."},
                    "amount": {"type": "float", "description": "The split line-item amount. Signed negative for expenses, positive for income."},
                    "note": {"type": "string", "description": "The specific split memo note."}
                }
            },
            "holdings": {
                "description": "Current active investment holdings across brokerage and retirement accounts, reconstructed from tax lots.",
                "columns": {
                    "account_name": {"type": "string", "description": "The name of the investment account."},
                    "security_name": {"type": "string", "description": "The display name of the security (e.g. stock, fund)."},
                    "ticker": {"type": "string", "description": "The asset ticker symbol (e.g. AAPL, VTSAX)."},
                    "shares": {"type": "float", "description": "Total units held in active tax lots."},
                    "cost_basis": {"type": "float", "description": "Calculated cost basis (total purchase price for remaining units)."},
                    "last_price": {"type": "float", "description": "Stated closing price inside Quicken's latest quotes table."},
                    "price_date": {"type": "date (ISO 8601)", "description": "The date of the closing price quote."},
                    "market_value": {"type": "float", "description": "Computed market value (shares multiplied by last_price)."},
                    "gain_loss": {"type": "float", "description": "Computed unrealized gain or loss (market_value minus cost_basis)."}
                }
            },
            "tags": {
                "description": "Custom user-defined tags linked to transaction splits.",
                "columns": {
                    "split_id": {"type": "integer", "references": "transaction_splits.split_id", "description": "Foreign key pointing to the split item."},
                    "tag_name": {"type": "string", "description": "The user-assigned custom tag (e.g. 'Tax Related', 'Reimbursable')."}
                }
            }
        }
    }

    with open(os.path.join(output_dir, "schema.json"), "w", encoding="utf-8") as f:
        json.dump(schema, f, indent=2)

    # 10. Generate: Sovereign Migration README.md
    log("Compiling migration README.md...")
    readme_content = f"""# Quicken Sovereign Export Data

Exported on: {schema["metadata"]["exported_at"]}
Exporter: Sovereign Exporter v1.0
Source: {os.path.basename(db_path)}

This folder contains a complete, beautifully normalized, relational export of your entire Quicken For Mac history.
All dates have been compiled into **ISO 8601 (YYYY-MM-DD)**, all amounts are correctly signed, and splits and custom user tags have been parsed into separate relational tables.

## Row Statistics
* **Accounts**: {stats["accounts"]}
* **Categories**: {stats["categories"]}
* **Payees**: {stats["payees"]}
* **Transactions**: {stats["transactions"]}
* **Transaction Splits**: {stats["splits"]}
* **Investment Holdings**: {stats["holdings"]}
* **Custom User Tags**: {stats["tags"]}

## Files Included
1. `accounts.csv`: Financial checking, credit, and investment accounts.
2. `categories.csv`: Income & expense category path structure.
3. `payees.csv`: Merchants and payees list.
4. `transactions.csv`: Top-level transaction metadata and sums.
5. `transaction_splits.csv`: Categorized line-item splits.
6. `holdings.csv`: Reconstructed active tax lots and unrealized returns.
7. `tags.csv`: Custom user-defined tags linked directly to splits.
8. `schema.json`: Complete relational column and relationship dictionary.

---

## Migration Guide: Loading into Sovereign Analysis Platforms

Because this data is exported as standard, comma-separated values (CSV) with a relational `schema.json`, you can import it instantly into any database, coding environment, or agentic platform.

### Option A: Analyze Instantly with DuckDB (Local-First SQL)
DuckDB is a powerful, local analytical engine. You can query your exported CSVs directly in the terminal:

```bash
# Start DuckDB
duckdb

-- Query checking/credit spending by parent category
SELECT category_name, ROUND(SUM(amount), 2) as total
FROM 'transaction_splits.csv' s
JOIN 'transactions.csv' t ON s.transaction_id = t.transaction_id
WHERE t.account_type IN ('checking', 'credit_card')
  AND s.amount < 0
GROUP BY category_name
ORDER BY total ASC;
```

### Option B: Load into Python (Pandas DataFrames)
For custom data-science models or local charts:

```python
import pandas as pd

transactions = pd.read_csv("transactions.csv")
splits = pd.read_csv("transaction_splits.csv")

# Merge splits and transaction details
df = pd.merge(splits, transactions, on="transaction_id")
print(df.head())
```

### Option C: Import into PostgreSQL / SQLite
To spin up your own local relational database server:

```sql
-- Create database schema and COPY statements
CREATE TABLE accounts (
    account_id INT PRIMARY KEY,
    name VARCHAR,
    type VARCHAR,
    is_active INT,
    is_closed INT
);

COPY accounts FROM 'accounts.csv' DELIMITER ',' CSV HEADER;
```
"""
    
    with open(os.path.join(output_dir, "README.md"), "w", encoding="utf-8") as f:
        f.write(readme_content)

    conn.close()
    log("\nSuccess! Sovereign export completed.")
    log(f"CSV files, schema.json, and migration guide compiled inside: {output_dir}")

if __name__ == "__main__":
    out_dir = os.path.join(os.getcwd(), "quicken_sovereign_export")
    if len(sys.argv) > 1:
        out_dir = sys.argv[1]
    run_sovereign_export(out_dir)
