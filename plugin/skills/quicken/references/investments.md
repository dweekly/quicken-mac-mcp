# Investment holdings and cost basis

Use this workflow for holdings composition, tax lots, cost basis, and quote-based estimates. Do not use it to report an investment account's balance; use `balances.md` and the latest institution statement snapshot instead.

## Holdings with latest quotes

```sql
WITH holdings AS (
    SELECT a.Z_PK AS account_id,
           a.ZNAME AS account_name,
           a.ZCURRENCY AS account_currency,
           sec.Z_PK AS security_id,
           sec.ZNAME AS security_name,
           sec.ZTICKER AS ticker,
           SUM(l.ZLATESTUNITS) AS shares,
           SUM(l.ZLATESTCOSTBASIS) AS cost_basis
    FROM ZLOT l
    JOIN ZPOSITION p ON l.ZPOSITION = p.Z_PK
    JOIN ZSECURITY sec ON p.ZSECURITY = sec.Z_PK
    JOIN ZACCOUNT a ON p.ZACCOUNT = a.Z_PK
    WHERE ABS(COALESCE(l.ZLATESTUNITS, 0)) > 0.000000001
      AND (:account_name IS NULL OR a.ZNAME = :account_name)
    GROUP BY a.Z_PK, a.ZNAME, a.ZCURRENCY,
             sec.Z_PK, sec.ZNAME, sec.ZTICKER
), latest_quote AS (
    SELECT q.ZSECURITY AS security_id,
           q.ZCLOSINGPRICE AS price,
           q.ZQUOTEDATE AS quote_date_raw
    FROM ZSECURITYQUOTE q
    WHERE q.Z_PK = (
        SELECT q2.Z_PK
        FROM ZSECURITYQUOTE q2
        WHERE q2.ZSECURITY = q.ZSECURITY
        ORDER BY q2.ZQUOTEDATE DESC, q2.Z_PK DESC
        LIMIT 1
    )
)
SELECT h.account_name,
       h.account_currency,
       h.security_name,
       h.ticker,
       ROUND(h.shares, 6) AS shares,
       ROUND(h.cost_basis, 2) AS cost_basis,
       q.price,
       date(q.quote_date_raw + 978307200, 'unixepoch') AS quote_date,
       ROUND(h.shares * q.price, 2) AS market_value,
       ROUND(h.shares * q.price - h.cost_basis, 2) AS gain_loss
FROM holdings h
LEFT JOIN latest_quote q ON q.security_id = h.security_id
ORDER BY h.account_name, h.security_name;
```

Use a non-zero units test so short positions are not silently discarded. Group by primary keys as well as names to avoid combining distinct accounts or securities that share a display name.

## Interpretation limits

- Treat quotes as stored historical data, not live market prices. Always report `quote_date`; flag missing or stale quotes.
- Do not sum market values across currencies without an explicit exchange-rate source and valuation date.
- A negative share count can represent a short position. Preserve its sign.
- Lot-derived holdings can omit cash balances, positions without lots, simple-investing representations, or data affected by incomplete cost-basis history. State that limitation rather than calling the result a complete account balance.
- Quicken holdings can disagree with the institution statement because of stale, missing, duplicated, or manually carried positions. Require a statement cross-check when the account is user-identified as unreliable or the value is consequential.
- Options, bonds, and other instruments may require multipliers or face-value treatment not represented by `shares * closing price`. Inspect `ZSECURITY` fields before valuing them.
- A zero or null cost basis does not prove that the economic cost was zero.

## Sanity checks

- Compare the returned securities and share counts with Quicken's portfolio view for a small account.
- Check for multiple positions with the same ticker before grouping across accounts.
- Inspect the oldest quote date and the count of holdings with no quote.
- Keep cost basis, market value, and gain/loss separate; do not present a stored quote estimate as an authoritative tax figure.
- Never replace the statement-snapshot balance with the sum of transaction amounts or this quote-based estimate.
