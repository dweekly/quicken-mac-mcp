/**
 * ETL module: exports Quicken's Core Data schema into a clean, normalized SQLite database.
 *
 * Reads from the messy Z-prefixed Core Data tables and writes human-readable tables
 * with proper column names, ISO 8601 dates, and denormalized fields for convenience.
 */

import Database from "better-sqlite3";
import { openDatabase, CORE_DATA_EPOCH_OFFSET, getCategoryTagEntityId } from "./db.js";

/** Convert a Core Data timestamp to ISO 8601 date string, or null. */
function toIsoDate(ts: number | null | undefined): string | null {
  if (ts == null) return null;
  const unix = ts + CORE_DATA_EPOCH_OFFSET;
  return new Date(unix * 1000).toISOString().split("T")[0];
}

/** Lowercase and normalize account type names for readability. */
function normalizeAccountType(raw: string | null): string {
  if (!raw) return "unknown";
  const map: Record<string, string> = {
    CHECKING: "checking",
    CREDITCARD: "credit_card",
    SAVINGS: "savings",
    MORTGAGE: "mortgage",
    RETIREMENTIRA: "retirement_ira",
    RETIREMENT401K: "retirement_401k",
    ASSET: "asset",
    LIABILITY: "liability",
    LOAN: "loan",
    BROKERAGE: "brokerage",
    CASH: "cash",
  };
  return map[raw.toUpperCase()] ?? raw.toLowerCase();
}

/** Create the clean schema in the output database. */
function createSchema(out: Database.Database): void {
  out.exec(`
    CREATE TABLE accounts (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      type TEXT NOT NULL,
      is_active INTEGER NOT NULL,
      is_closed INTEGER NOT NULL
    );

    CREATE TABLE categories (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      parent_name TEXT,
      full_name TEXT NOT NULL,
      type TEXT NOT NULL
    );

    CREATE TABLE payees (
      id INTEGER PRIMARY KEY,
      name TEXT NOT NULL
    );

    CREATE TABLE transactions (
      id INTEGER PRIMARY KEY,
      date TEXT,
      account_id INTEGER REFERENCES accounts(id),
      account_name TEXT,
      payee_id INTEGER REFERENCES payees(id),
      payee_name TEXT,
      note TEXT,
      total_amount REAL
    );

    CREATE TABLE transaction_splits (
      id INTEGER PRIMARY KEY,
      transaction_id INTEGER NOT NULL REFERENCES transactions(id),
      category_id INTEGER REFERENCES categories(id),
      category_name TEXT,
      parent_category TEXT,
      amount REAL NOT NULL
    );

    CREATE TABLE holdings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      account_name TEXT NOT NULL,
      security_name TEXT NOT NULL,
      ticker TEXT,
      shares REAL NOT NULL,
      cost_basis REAL NOT NULL,
      last_price REAL,
      price_date TEXT,
      market_value REAL,
      gain_loss REAL
    );

    -- Pre-built analysis views

    CREATE VIEW monthly_spending AS
    SELECT
      substr(t.date, 1, 7) AS month,
      ts.parent_category AS category,
      ROUND(SUM(ts.amount), 2) AS total_amount,
      COUNT(*) AS transaction_count
    FROM transactions t
    JOIN transaction_splits ts ON ts.transaction_id = t.id
    JOIN accounts a ON a.id = t.account_id
    WHERE a.type IN ('checking', 'credit_card')
      AND ts.amount < 0
    GROUP BY month, ts.parent_category
    ORDER BY month, total_amount;

    CREATE VIEW cash_flow AS
    SELECT
      substr(t.date, 1, 7) AS month,
      ROUND(SUM(CASE WHEN ts.amount > 0 THEN ts.amount ELSE 0 END), 2) AS income,
      ROUND(SUM(CASE WHEN ts.amount < 0 THEN ts.amount ELSE 0 END), 2) AS expenses,
      ROUND(SUM(ts.amount), 2) AS net
    FROM transactions t
    JOIN transaction_splits ts ON ts.transaction_id = t.id
    JOIN accounts a ON a.id = t.account_id
    WHERE a.type IN ('checking', 'credit_card', 'savings')
    GROUP BY month
    ORDER BY month;

    CREATE VIEW recurring_charges AS
    SELECT
      t.payee_name,
      ROUND(AVG(ts.amount), 2) AS avg_amount,
      COUNT(*) AS occurrence_count,
      MIN(t.date) AS first_seen,
      MAX(t.date) AS last_seen,
      ROUND(
        CAST(julianday(MAX(t.date)) - julianday(MIN(t.date)) AS REAL)
        / NULLIF(COUNT(*) - 1, 0), 1
      ) AS avg_days_between
    FROM transactions t
    JOIN transaction_splits ts ON ts.transaction_id = t.id
    JOIN accounts a ON a.id = t.account_id
    WHERE a.type IN ('checking', 'credit_card')
      AND ts.amount < 0
      AND t.payee_name IS NOT NULL
    GROUP BY t.payee_name
    HAVING COUNT(*) >= 3
      AND avg_days_between BETWEEN 25 AND 35
    ORDER BY avg_amount;

    -- Indexes for common query patterns
    CREATE INDEX idx_transactions_date ON transactions(date);
    CREATE INDEX idx_transactions_account ON transactions(account_id);
    CREATE INDEX idx_transactions_payee ON transactions(payee_name);
    CREATE INDEX idx_splits_transaction ON transaction_splits(transaction_id);
    CREATE INDEX idx_splits_category ON transaction_splits(parent_category);
  `);
}

/** Export accounts from Quicken to clean schema. */
function exportAccounts(src: Database.Database, out: Database.Database): number {
  const rows = src.prepare(`
    SELECT Z_PK, ZNAME, ZTYPENAME, ZACTIVE, ZCLOSED FROM ZACCOUNT ORDER BY ZNAME
  `).all() as Array<{ Z_PK: number; ZNAME: string; ZTYPENAME: string; ZACTIVE: number; ZCLOSED: number }>;

  const insert = out.prepare(`
    INSERT INTO accounts (id, name, type, is_active, is_closed) VALUES (?, ?, ?, ?, ?)
  `);

  for (const r of rows) {
    insert.run(r.Z_PK, r.ZNAME, normalizeAccountType(r.ZTYPENAME), r.ZACTIVE ? 1 : 0, r.ZCLOSED ? 1 : 0);
  }
  return rows.length;
}

/** Export categories from Quicken to clean schema. */
function exportCategories(src: Database.Database, out: Database.Database): number {
  const entityId = getCategoryTagEntityId(src);

  const rows = src.prepare(`
    SELECT
      c.Z_PK, c.ZNAME, c.ZTYPE,
      p.ZNAME as parent_name
    FROM ZTAG c
    LEFT JOIN ZTAG p ON c.ZPARENTCATEGORY = p.Z_PK
    WHERE c.Z_ENT = ?
    ORDER BY COALESCE(p.ZNAME, c.ZNAME), c.ZNAME
  `).all(entityId) as Array<{
    Z_PK: number; ZNAME: string; ZTYPE: number; parent_name: string | null;
  }>;

  const insert = out.prepare(`
    INSERT INTO categories (id, name, parent_name, full_name, type) VALUES (?, ?, ?, ?, ?)
  `);

  const typeMap: Record<number, string> = { 1: "expense", 2: "income" };

  for (const r of rows) {
    const fullName = r.parent_name ? `${r.parent_name} : ${r.ZNAME}` : r.ZNAME;
    const type = typeMap[r.ZTYPE] ?? "other";
    insert.run(r.Z_PK, r.ZNAME, r.parent_name, fullName, type);
  }
  return rows.length;
}

/** Export payees from Quicken to clean schema. */
function exportPayees(src: Database.Database, out: Database.Database): number {
  const rows = src.prepare(`
    SELECT Z_PK, ZNAME FROM ZUSERPAYEE WHERE ZNAME IS NOT NULL ORDER BY ZNAME
  `).all() as Array<{ Z_PK: number; ZNAME: string }>;

  const insert = out.prepare(`
    INSERT INTO payees (id, name) VALUES (?, ?)
  `);

  for (const r of rows) {
    insert.run(r.Z_PK, r.ZNAME);
  }
  return rows.length;
}

/** Export transactions and their splits from Quicken to clean schema. */
function exportTransactions(src: Database.Database, out: Database.Database): { transactions: number; splits: number } {
  const entityId = getCategoryTagEntityId(src);

  // First, export all transactions with their aggregate amounts
  const txRows = src.prepare(`
    SELECT
      t.Z_PK,
      COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE) as date_raw,
      t.ZACCOUNT,
      a.ZNAME as account_name,
      t.ZUSERPAYEE,
      p.ZNAME as payee_name,
      t.ZNOTE
    FROM ZTRANSACTION t
    JOIN ZACCOUNT a ON t.ZACCOUNT = a.Z_PK
    LEFT JOIN ZUSERPAYEE p ON t.ZUSERPAYEE = p.Z_PK
    ORDER BY date_raw
  `).all() as Array<{
    Z_PK: number; date_raw: number | null; ZACCOUNT: number;
    account_name: string; ZUSERPAYEE: number | null; payee_name: string | null;
    ZNOTE: string | null;
  }>;

  const insertTx = out.prepare(`
    INSERT INTO transactions (id, date, account_id, account_name, payee_id, payee_name, note, total_amount)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?)
  `);

  // Get total amounts per transaction
  const amountMap = new Map<number, number>();
  const amountRows = src.prepare(`
    SELECT ZPARENT, ROUND(SUM(ZAMOUNT), 2) as total
    FROM ZCASHFLOWTRANSACTIONENTRY
    GROUP BY ZPARENT
  `).all() as Array<{ ZPARENT: number; total: number }>;
  for (const r of amountRows) {
    amountMap.set(r.ZPARENT, r.total);
  }

  for (const r of txRows) {
    insertTx.run(
      r.Z_PK,
      toIsoDate(r.date_raw),
      r.ZACCOUNT,
      r.account_name,
      r.ZUSERPAYEE,
      r.payee_name,
      r.ZNOTE,
      amountMap.get(r.Z_PK) ?? null
    );
  }

  // Now export splits
  const splitRows = src.prepare(`
    SELECT
      s.Z_PK,
      s.ZPARENT,
      s.ZCATEGORYTAG,
      cat.ZNAME as category_name,
      parent_cat.ZNAME as parent_category,
      ROUND(s.ZAMOUNT, 2) as amount
    FROM ZCASHFLOWTRANSACTIONENTRY s
    LEFT JOIN ZTAG cat ON s.ZCATEGORYTAG = cat.Z_PK AND cat.Z_ENT = ?
    LEFT JOIN ZTAG parent_cat ON cat.ZPARENTCATEGORY = parent_cat.Z_PK
    ORDER BY s.ZPARENT, s.Z_PK
  `).all(entityId) as Array<{
    Z_PK: number; ZPARENT: number; ZCATEGORYTAG: number | null;
    category_name: string | null; parent_category: string | null; amount: number;
  }>;

  const insertSplit = out.prepare(`
    INSERT INTO transaction_splits (id, transaction_id, category_id, category_name, parent_category, amount)
    VALUES (?, ?, ?, ?, ?, ?)
  `);

  for (const r of splitRows) {
    insertSplit.run(r.Z_PK, r.ZPARENT, r.ZCATEGORYTAG, r.category_name, r.parent_category, r.amount);
  }

  return { transactions: txRows.length, splits: splitRows.length };
}

/** Export investment holdings from Quicken to clean schema. */
function exportHoldings(src: Database.Database, out: Database.Database): number {
  // Get holdings grouped by account + security
  const holdingRows = src.prepare(`
    SELECT
      a.ZNAME as account_name,
      s.ZNAME as security_name,
      s.ZTICKER as ticker,
      ROUND(SUM(l.ZLATESTUNITS), 6) as shares,
      ROUND(SUM(l.ZLATESTCOSTBASIS), 2) as cost_basis
    FROM ZLOT l
    JOIN ZPOSITION p ON l.ZPOSITION = p.Z_PK
    JOIN ZSECURITY s ON p.ZSECURITY = s.Z_PK
    JOIN ZACCOUNT a ON p.ZACCOUNT = a.Z_PK
    WHERE l.ZLATESTUNITS > 0
    GROUP BY a.ZNAME, s.ZNAME, s.ZTICKER
    ORDER BY a.ZNAME, s.ZNAME
  `).all() as Array<{
    account_name: string; security_name: string; ticker: string | null;
    shares: number; cost_basis: number;
  }>;

  // Get latest quotes per ticker
  const quoteMap = new Map<string, { price: number; date: number }>();
  try {
    const quoteRows = src.prepare(`
      SELECT
        s.ZTICKER as ticker,
        q.ZCLOSINGPRICE as price,
        q.ZQUOTEDATE as quote_date_raw
      FROM ZSECURITYQUOTE q
      JOIN ZSECURITY s ON q.ZSECURITY = s.Z_PK
      WHERE s.ZTICKER IS NOT NULL
        AND q.ZQUOTEDATE = (
          SELECT MAX(q2.ZQUOTEDATE)
          FROM ZSECURITYQUOTE q2
          WHERE q2.ZSECURITY = s.Z_PK
        )
    `).all() as Array<{ ticker: string; price: number; quote_date_raw: number }>;

    for (const q of quoteRows) {
      quoteMap.set(q.ticker, { price: q.price, date: q.quote_date_raw });
    }
  } catch {
    // Quote tables may not exist in all Quicken databases
  }

  const insert = out.prepare(`
    INSERT INTO holdings (account_name, security_name, ticker, shares, cost_basis, last_price, price_date, market_value, gain_loss)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
  `);

  for (const h of holdingRows) {
    const quote = h.ticker ? quoteMap.get(h.ticker) : undefined;
    const price = quote?.price ?? null;
    const priceDate = quote ? toIsoDate(quote.date) : null;
    const marketValue = price != null ? Math.round(h.shares * price * 100) / 100 : null;
    const gainLoss = marketValue != null ? Math.round((marketValue - h.cost_basis) * 100) / 100 : null;

    insert.run(h.account_name, h.security_name, h.ticker, h.shares, h.cost_basis, price, priceDate, marketValue, gainLoss);
  }

  return holdingRows.length;
}

/** Store metadata about the export. */
function writeMetadata(out: Database.Database, stats: Record<string, number>): void {
  out.exec(`
    CREATE TABLE _export_meta (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL
    );
  `);
  const insert = out.prepare("INSERT INTO _export_meta (key, value) VALUES (?, ?)");
  insert.run("exported_at", new Date().toISOString());
  insert.run("source", "quicken-mac-mcp");
  for (const [k, v] of Object.entries(stats)) {
    insert.run(`count_${k}`, String(v));
  }
}

export interface ExportResult {
  outputPath: string;
  accounts: number;
  categories: number;
  payees: number;
  transactions: number;
  splits: number;
  holdings: number;
}

/**
 * Run the full ETL: read from Quicken's Core Data DB, write clean tables to outputPath.
 */
export function exportDatabase(outputPath: string, srcDbPath?: string): ExportResult {
  const src = openDatabase(srcDbPath);
  const out = new Database(outputPath);

  try {
    // Enable WAL mode for write performance
    out.pragma("journal_mode = WAL");

    createSchema(out);

    // Run all exports inside a transaction for atomicity
    const result = out.transaction(() => {
      const accounts = exportAccounts(src, out);
      const categories = exportCategories(src, out);
      const payees = exportPayees(src, out);
      const { transactions, splits } = exportTransactions(src, out);

      let holdings = 0;
      try {
        holdings = exportHoldings(src, out);
      } catch {
        // Investment tables may not exist in all databases
      }

      writeMetadata(out, { accounts, categories, payees, transactions, splits, holdings });

      return { outputPath, accounts, categories, payees, transactions, splits, holdings };
    })();

    return result;
  } finally {
    out.close();
    src.close();
  }
}
