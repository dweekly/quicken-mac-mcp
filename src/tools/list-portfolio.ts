/**
 * list_portfolio tool — List current investment holdings.
 *
 * Joins ZLOT/ZPOSITION/ZSECURITY/ZACCOUNT to produce a portfolio view
 * with shares, cost basis, and price enrichment from stored Quicken quotes.
 */

import type Database from "better-sqlite3";
import { coreDataToIso } from "../db.js";

interface HoldingRow {
  account: string;
  security: string;
  ticker: string | null;
  current_shares: number;
  cost_basis: number;
}

interface DbQuote {
  price: number;
  quote_date: string;
}

interface PortfolioArgs {
  account_names?: string[];
}

function queryHoldings(db: Database.Database, args: PortfolioArgs): HoldingRow[] {
  const params: string[] = [];
  let filter = "";

  if (args.account_names && args.account_names.length > 0) {
    const placeholders = args.account_names.map(() => "?").join(", ");
    filter = `AND a.ZNAME IN (${placeholders})`;
    params.push(...args.account_names);
  }

  const sql = `
    SELECT
      a.ZNAME as account,
      s.ZNAME as security,
      s.ZTICKER as ticker,
      ROUND(SUM(l.ZLATESTUNITS), 6) as current_shares,
      ROUND(SUM(l.ZLATESTCOSTBASIS), 2) as cost_basis
    FROM ZLOT l
    JOIN ZPOSITION p ON l.ZPOSITION = p.Z_PK
    JOIN ZSECURITY s ON p.ZSECURITY = s.Z_PK
    JOIN ZACCOUNT a ON p.ZACCOUNT = a.Z_PK
    WHERE l.ZLATESTUNITS > 0 ${filter}
    GROUP BY a.ZNAME, s.ZNAME, s.ZTICKER
    ORDER BY a.ZNAME, s.ZNAME
  `;

  return db.prepare(sql).all(...params) as HoldingRow[];
}

function queryDbQuotes(db: Database.Database): Map<string, DbQuote> {
  const sql = `
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
  `;

  const rows = db.prepare(sql).all() as Array<{
    ticker: string;
    price: number;
    quote_date_raw: number;
  }>;

  const map = new Map<string, DbQuote>();
  for (const row of rows) {
    map.set(row.ticker, {
      price: row.price,
      quote_date: coreDataToIso(row.quote_date_raw),
    });
  }
  return map;
}

export function listPortfolio(db: Database.Database, args: PortfolioArgs) {
  const holdings = queryHoldings(db, args);
  const dbQuotes = queryDbQuotes(db);

  return holdings.map((h) => {
    const result: Record<string, unknown> = {
      account: h.account,
      security: h.security,
      ticker: h.ticker,
      current_shares: h.current_shares,
      cost_basis: h.cost_basis,
    };

    if (h.ticker && dbQuotes.has(h.ticker)) {
      const dbq = dbQuotes.get(h.ticker)!;
      result.price = dbq.price;
      result.price_date = dbq.quote_date;
      result.market_value = Math.round(h.current_shares * dbq.price * 100) / 100;

      if (h.cost_basis > 0) {
        const gainLoss =
          Math.round((h.current_shares * dbq.price - h.cost_basis) * 100) / 100;
        result.gain_loss = gainLoss;
        result.gain_loss_pct = Math.round((gainLoss / h.cost_basis) * 10000) / 100;
      }
    }

    return result;
  });
}
