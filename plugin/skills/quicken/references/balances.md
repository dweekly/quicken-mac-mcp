# Balances and freshness

Use dated institution observations for balances. Always report the source and as-of date. Do not reconstruct investment-account balances from transaction sums, tax lots, or quotes.

## Contents

- [Choose the source](#choose-the-source)
- [Depository and credit balances](#depository-and-credit-balances)
- [Investment statement balances](#investment-statement-balances)
- [Statement history](#statement-history)
- [Reliability gates](#reliability-gates)
- [Optional snapshots](#optional-snapshots)

## Choose the source

Label the source explicitly:

- For institution-connected depository and credit accounts, use `ZACCOUNT.ZONLINEBANKINGLEDGERBALANCEAMOUNT` with `ZONLINEBANKINGLEDGERBALANCEDATE`.
- For investment-account balance components, select the latest `ZFISTATEMENT` per account and aggregate its non-zero `ZFIPOSITION.ZMARKETVALUE` rows.
- Keep `ZFISTATEMENT.ZAVAILCASH` separate. Do not add it to position market values until a statement cross-check confirms that cash is not already represented by a position.
- Use tax lots and stored security quotes for holdings composition and cost-basis estimates, not as the authoritative account balance.
- Use transaction sums for activity and register reconciliation only. Never use them to derive a brokerage, retirement, or education-investment balance.

Quicken is a local record of downloaded, entered, and calculated data—not an authority over the institution statement. Call values “institution-reported,” “statement snapshot,” “register-derived,” or “quote estimate,” never simply “live,” unless their dates and source justify that description.

## Depository and credit balances

Emit the balance date, connection date, age, and divergence on every row:

```sql
SELECT a.Z_PK AS account_id,
       a.ZNAME AS account_name,
       a.ZTYPENAME AS account_type,
       a.ZCURRENCY AS currency,
       a.ZONLINEBANKINGLEDGERBALANCEAMOUNT AS institution_ledger_balance,
       date(a.ZONLINEBANKINGLEDGERBALANCEDATE + 978307200,
            'unixepoch') AS balance_as_of,
       datetime(a.ZONLINEBANKINGLASTCONNECTEDTIMESTAMP + 978307200,
                'unixepoch') AS last_connected,
       ROUND((strftime('%s', 'now')
              - (a.ZONLINEBANKINGLEDGERBALANCEDATE + 978307200)) / 86400.0,
             1) AS balance_age_days,
       ROUND((a.ZONLINEBANKINGLASTCONNECTEDTIMESTAMP
              - a.ZONLINEBANKINGLEDGERBALANCEDATE) / 86400.0,
             1) AS connection_balance_gap_days,
       CASE
         WHEN a.ZONLINEBANKINGLEDGERBALANCEAMOUNT IS NULL THEN 'missing-balance'
         WHEN a.ZONLINEBANKINGLEDGERBALANCEDATE IS NULL THEN 'missing-balance-date'
         WHEN a.ZONLINEBANKINGLASTCONNECTEDTIMESTAMP IS NULL THEN 'missing-connection-date'
         WHEN a.ZONLINEBANKINGLASTCONNECTEDTIMESTAMP
                - a.ZONLINEBANKINGLEDGERBALANCEDATE
                > :freshness_gap_days * 86400 THEN 'connection-newer-than-balance'
         ELSE 'dated-balance'
       END AS freshness_status
FROM ZACCOUNT a
WHERE (:account_name IS NULL OR a.ZNAME = :account_name)
ORDER BY a.ZNAME;
```

Use three days as a starting warning threshold unless the user chooses another policy. Also warn when `balance_age_days` itself is large: two old but nearby timestamps do not make a current balance.

Do not assume credit, loan, and liability sign conventions. Compare representative rows with Quicken's UI or an institution statement before aggregating them into net worth.

## Investment statement balances

Choose one statement deterministically per account. Filter the large universe of zero positions while preserving any legitimate negative market values:

```sql
WITH latest_statement AS (
    SELECT fs.*,
           ROW_NUMBER() OVER (
               PARTITION BY fs.ZACCOUNT
               ORDER BY COALESCE(fs.ZDATEASOF, fs.ZMODIFICATIONTIMESTAMP) DESC,
                        fs.Z_PK DESC
           ) AS statement_rank
    FROM ZFISTATEMENT fs
)
SELECT a.Z_PK AS account_id,
       a.ZNAME AS account_name,
       a.ZTYPENAME AS account_type,
       a.ZCURRENCY AS currency,
       date(fs.ZDATEASOF + 978307200, 'unixepoch') AS statement_as_of,
       datetime(a.ZONLINEBANKINGLASTCONNECTEDTIMESTAMP + 978307200,
                'unixepoch') AS last_connected,
       ROUND((strftime('%s', 'now') - (fs.ZDATEASOF + 978307200)) / 86400.0,
             1) AS statement_age_days,
       ROUND((a.ZONLINEBANKINGLASTCONNECTEDTIMESTAMP - fs.ZDATEASOF) / 86400.0,
             1) AS connection_statement_gap_days,
       ROUND(SUM(
           CASE WHEN ABS(COALESCE(p.ZMARKETVALUE, 0)) > 0.000001
                THEN p.ZMARKETVALUE ELSE 0 END
       ), 2) AS statement_positions_market_value,
       COUNT(CASE
           WHEN ABS(COALESCE(p.ZMARKETVALUE, 0)) > 0.000001 THEN 1
       END) AS nonzero_position_count,
       fs.ZAVAILCASH AS available_cash_separate
FROM latest_statement fs
JOIN ZACCOUNT a ON a.Z_PK = fs.ZACCOUNT
LEFT JOIN ZFIPOSITION p ON p.ZFISTATEMENT = fs.Z_PK
WHERE fs.statement_rank = 1
  AND (:account_name IS NULL OR a.ZNAME = :account_name)
GROUP BY a.Z_PK, a.ZNAME, a.ZTYPENAME, a.ZCURRENCY,
         fs.Z_PK, fs.ZDATEASOF, fs.ZAVAILCASH,
         a.ZONLINEBANKINGLASTCONNECTEDTIMESTAMP
ORDER BY a.ZNAME;
```

For security-level detail, select only rows satisfying `ABS(COALESCE(p.ZMARKETVALUE, 0)) > 0.000001`. A strict `> 0` removes zero-universe noise but can also hide a negative short or liability position.

Do not infer that statement positions are complete merely because the query succeeds. Missing sleeves, stale securities, manually carried positions, and institution-feed errors require an external statement comparison.

## Statement history

Audit retention before promising a time series:

```sql
SELECT a.Z_PK AS account_id,
       a.ZNAME AS account_name,
       COUNT(fs.Z_PK) AS retained_statement_count,
       date(MIN(fs.ZDATEASOF) + 978307200, 'unixepoch') AS earliest_as_of,
       date(MAX(fs.ZDATEASOF) + 978307200, 'unixepoch') AS latest_as_of
FROM ZACCOUNT a
JOIN ZFISTATEMENT fs ON fs.ZACCOUNT = a.Z_PK
GROUP BY a.Z_PK, a.ZNAME
ORDER BY a.ZNAME;
```

Quicken files can retain only the latest FI statement snapshot per account. If the count is one, say that historical balances cannot be reconstructed from `ZFISTATEMENT`; transaction history does not repair that limitation for investment valuations.

## Reliability gates

Before reporting a balance as current:

1. Require a non-null value and as-of date.
2. Compare the as-of date with both the current date and last-connected date.
3. Identify manual/offline accounts and any accounts the user has said are unreliable.
4. Cross-check material discrepancies, incomplete position sets, or high-stakes values against an external statement supplied by the user.
5. Keep each currency separate and verify liability signs before computing net worth.

Maintain any known-unreliable account set only in the current task or a user-supplied configuration. Never embed personal account names or discrepancies in the distributable skill. For those accounts, refuse to call Quicken's value live; label it “requires statement verification.”

## Optional snapshots

Because FI statement history may be overwritten, offer an opt-in external snapshot when the user wants a future time series. Obtain permission before creating it and never write into the Quicken database.

Record at least: stable account identifier chosen by the user, source type, amount, currency, source as-of timestamp, observed-at timestamp, connection timestamp, and reliability status. Preserve statement position components separately from available cash so future corrections remain auditable.
