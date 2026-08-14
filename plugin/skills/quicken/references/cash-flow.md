# Cash-flow queries

Use these patterns for transactions, spending, income, payees, and trends. Bind every named parameter through the SQLite library or CLI rather than interpolating user text.

## Contents

- [Date predicates](#date-predicates)
- [Transfer handling](#transfer-handling)
- [Transaction details](#transaction-details)
- [Spending by category](#spending-by-category)
- [Monthly trends](#monthly-trends)
- [Payees and notes](#payees-and-notes)
- [Payroll limits](#payroll-limits)
- [Sanity checks](#sanity-checks)

## Date predicates

Quicken timestamps use the Core Data epoch. Treat an ISO end date as inclusive by comparing to the next day's midnight:

```sql
COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE)
    >= CAST(strftime('%s', :start_date) AS INTEGER) - 978307200
AND COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE)
    < CAST(strftime('%s', :end_date, '+1 day') AS INTEGER) - 978307200
```

Validate that `:start_date` and `:end_date` are ISO `YYYY-MM-DD` values and that the start is not after the end.

## Transfer handling

Restricting results to checking and credit-card accounts does not remove transfers. In particular, a credit-card payment can otherwise be counted alongside the purchases it pays for.

Inspect how the selected file represents transfers before aggregating:

```sql
SELECT t.Z_PK AS transaction_id,
       a.ZNAME AS account_name,
       p.ZNAME AS payee,
       t.ZTARGETACCOUNT AS target_account_id,
       t.ZSENDACCOUNT AS send_account_id,
       s.ZTRANSFER AS split_transfer,
       s.ZAMOUNT AS amount
FROM ZTRANSACTION t
JOIN ZACCOUNT a ON t.ZACCOUNT = a.Z_PK
LEFT JOIN ZUSERPAYEE p ON t.ZUSERPAYEE = p.Z_PK
JOIN ZCASHFLOWTRANSACTIONENTRY s ON s.ZPARENT = t.Z_PK
WHERE t.ZTARGETACCOUNT IS NOT NULL
   OR t.ZSENDACCOUNT IS NOT NULL
   OR NULLIF(TRIM(s.ZTRANSFER), '') IS NOT NULL
LIMIT 50;
```

For consumer-spending reports, use this default exclusion after confirming it matches the file:

```sql
AND t.ZTARGETACCOUNT IS NULL
AND t.ZSENDACCOUNT IS NULL
AND NULLIF(TRIM(s.ZTRANSFER), '') IS NULL
AND COALESCE(t.ZEXCLUDEFROMREPORTS, 0) = 0
```

If the user asks for transfers, cash movement, debt payments, or net cash flow, do not apply that exclusion blindly. Show transfer legs separately and avoid summing both sides as income or expense.

Transfer representation varies by file and download source. Some files populate transaction-level target/send relationships, some populate only `s.ZTRANSFER`, and some may retain only one recognizable transfer leg. Do not assume every transfer has a destination-side row.

Treat category labels as user/download metadata, not proof of economic meaning. Before treating an unusually large income or expense as category activity, inspect its payee, notes, transfer markers, and same-day opposite-signed candidates in other accounts. Report unresolved classification risk instead of silently folding the outlier into spending or income.

## Transaction details

This query returns one row per split and keeps both note levels:

```sql
SELECT t.Z_PK AS transaction_id,
       a.ZNAME AS account_name,
       a.ZTYPENAME AS account_type,
       a.ZCURRENCY AS currency,
       p.ZNAME AS payee,
       cat.ZNAME AS category,
       parent_cat.ZNAME AS parent_category,
       s.ZAMOUNT AS amount,
       date(COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE) + 978307200,
            'unixepoch') AS posted_date,
       t.ZNOTE AS note,
       s.ZNOTE AS split_note
FROM ZTRANSACTION t
JOIN ZACCOUNT a ON t.ZACCOUNT = a.Z_PK
LEFT JOIN ZUSERPAYEE p ON t.ZUSERPAYEE = p.Z_PK
LEFT JOIN ZCASHFLOWTRANSACTIONENTRY s ON s.ZPARENT = t.Z_PK
LEFT JOIN ZTAG cat
       ON s.ZCATEGORYTAG = cat.Z_PK
      AND cat.Z_ENT = (
          SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'CategoryTag'
      )
LEFT JOIN ZTAG parent_cat ON cat.ZPARENTCATEGORY = parent_cat.Z_PK
WHERE COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE)
          >= CAST(strftime('%s', :start_date) AS INTEGER) - 978307200
  AND COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE)
          < CAST(strftime('%s', :end_date, '+1 day') AS INTEGER) - 978307200
  AND (:account_name IS NULL OR a.ZNAME = :account_name)
  AND (:payee_search IS NULL OR p.ZNAME LIKE '%' || :payee_search || '%')
ORDER BY COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE) DESC, t.Z_PK, s.ZSEQUENCENUMBER
LIMIT :row_limit;
```

Do not sum rows from this detail query unless the intended unit is a split.

## Spending by category

This default treats negative splits as expenses, excludes transfers and report-excluded transactions, preserves uncategorized expenses, and keeps currencies separate:

```sql
SELECT COALESCE(parent_cat.ZNAME, cat.ZNAME, '(Uncategorized)') AS category,
       COALESCE(a.ZCURRENCY, '(Unknown)') AS currency,
       ROUND(-SUM(s.ZAMOUNT), 2) AS spent,
       COUNT(DISTINCT t.Z_PK) AS transaction_count,
       COUNT(*) AS split_count
FROM ZTRANSACTION t
JOIN ZACCOUNT a ON t.ZACCOUNT = a.Z_PK
JOIN ZCASHFLOWTRANSACTIONENTRY s ON s.ZPARENT = t.Z_PK
LEFT JOIN ZTAG cat
       ON s.ZCATEGORYTAG = cat.Z_PK
      AND cat.Z_ENT = (
          SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'CategoryTag'
      )
LEFT JOIN ZTAG parent_cat ON cat.ZPARENTCATEGORY = parent_cat.Z_PK
WHERE s.ZAMOUNT < 0
  AND COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE)
          >= CAST(strftime('%s', :start_date) AS INTEGER) - 978307200
  AND COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE)
          < CAST(strftime('%s', :end_date, '+1 day') AS INTEGER) - 978307200
  AND UPPER(a.ZTYPENAME) IN ('CHECKING', 'CREDITCARD')
  AND t.ZTARGETACCOUNT IS NULL
  AND t.ZSENDACCOUNT IS NULL
  AND NULLIF(TRIM(s.ZTRANSFER), '') IS NULL
  AND COALESCE(t.ZEXCLUDEFROMREPORTS, 0) = 0
GROUP BY 1, 2
ORDER BY spent DESC;
```

The `category` expression intentionally rolls subcategories up to their parent whenever one exists; use `cat.ZNAME` instead when sibling categories must remain separate. Prefer explicit account names when the user has identified the spending accounts. Add cash, savings, or other account types only when they contain genuine expenses the user wants included.

## Monthly trends

Use the same account, transfer, report-exclusion, currency, and date predicates as the category query. Bucket only after converting the epoch:

```sql
strftime('%Y-%m',
         COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE) + 978307200,
         'unixepoch') AS month
```

For spending, report `-SUM(s.ZAMOUNT)` over negative splits. For income, report `SUM(s.ZAMOUNT)` over positive splits. Do not call the difference between those two values net cash flow if transfers or relevant account types were excluded.

## Payees and notes

Discover payee variants before filtering:

```sql
SELECT p.Z_PK AS payee_id,
       p.ZNAME AS payee,
       COUNT(t.Z_PK) AS transaction_count
FROM ZUSERPAYEE p
LEFT JOIN ZTRANSACTION t ON t.ZUSERPAYEE = p.Z_PK
WHERE p.ZNAME LIKE '%' || :payee_search || '%'
GROUP BY p.Z_PK, p.ZNAME
ORDER BY transaction_count DESC, p.ZNAME
LIMIT :row_limit;
```

When searching for non-empty notes, treat blank strings as empty:

```sql
WHERE NULLIF(TRIM(t.ZNOTE), '') IS NOT NULL
   OR NULLIF(TRIM(s.ZNOTE), '') IS NOT NULL
```

SQLite's built-in `LIKE` case folding is primarily ASCII. Mention that limitation if non-ASCII merchant names matter.

## Payroll limits

Determine whether a paycheck actually has meaningful splits before answering gross-pay, withholding, tax, or deferral questions:

```sql
SELECT t.Z_PK AS transaction_id,
       date(COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE) + 978307200,
            'unixepoch') AS posted_date,
       p.ZNAME AS payee,
       t.ZAMOUNT AS transaction_amount,
       COUNT(s.Z_PK) AS split_count,
       SUM(s.ZAMOUNT) AS split_total
FROM ZTRANSACTION t
LEFT JOIN ZUSERPAYEE p ON t.ZUSERPAYEE = p.Z_PK
LEFT JOIN ZCASHFLOWTRANSACTIONENTRY s ON s.ZPARENT = t.Z_PK
WHERE t.Z_PK = :transaction_id
GROUP BY t.Z_PK, t.ZPOSTEDDATE, t.ZENTEREDDATE, p.ZNAME, t.ZAMOUNT;
```

A downloaded paycheck may contain only one net deposit with no gross-pay, withholding, benefit, or retirement-deferral breakdown. If meaningful payroll splits are absent, say that Quicken can answer only the net-deposit question and require the paystub for gross or deduction analysis. Never infer missing payroll components from the net amount.

## Sanity checks

- Compare `SUM(s.ZAMOUNT)` with `t.ZAMOUNT` for a few transactions before trusting split aggregation.
- Inspect the largest categories and the `(Uncategorized)` bucket for obvious transfers or balance adjustments.
- Compare transaction and split counts; a large difference indicates many split transactions, not duplicate transactions.
- Confirm that every aggregated row has an intentional currency and account scope.
- Audit large category outliers for transfer markers or plausible cross-account counterparts.
