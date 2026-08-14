# Budget queries

Quicken stores budgets, category/account line items, and dated targets separately. Inspect raw target date numbers before mapping them to calendar periods because their representation can vary with model behavior.

## List budgets

```sql
SELECT Z_PK AS budget_id,
       ZNAME AS budget_name,
       ZCURRENCY AS currency,
       ZSTARTMONTH AS start_month,
       ZSHOWCENTS AS show_cents,
       ZDELETIONCOUNT AS deletion_count
FROM ZBUDGET
ORDER BY ZNAME;
```

## Inspect line items and targets

```sql
SELECT b.Z_PK AS budget_id,
       b.ZNAME AS budget_name,
       b.ZCURRENCY AS currency,
       li.Z_PK AS line_item_id,
       cat.ZNAME AS category,
       parent_cat.ZNAME AS parent_category,
       a.ZNAME AS account_name,
       li.ZISTRANSFEROUT AS is_transfer_out,
       li.ZROLLOVER AS rollover,
       li.ZTYPE AS line_item_type,
       target.ZEFFECTIVEDATENUM AS effective_date_number,
       target.ZAMOUNT AS target_amount,
       target.ZROLLOVERRESETAMT AS rollover_reset_amount
FROM ZBUDGET b
JOIN ZBUDGETLINEITEM li ON li.ZBUDGET = b.Z_PK
LEFT JOIN ZTAG cat
       ON li.ZCATEGORYTAG = cat.Z_PK
      AND cat.Z_ENT = (
          SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'CategoryTag'
      )
LEFT JOIN ZTAG parent_cat ON cat.ZPARENTCATEGORY = parent_cat.Z_PK
LEFT JOIN ZACCOUNT a ON li.ZACCOUNT = a.Z_PK
LEFT JOIN ZBUDGETTARGET target ON target.ZLINEITEM = li.Z_PK
WHERE (:budget_name IS NULL OR b.ZNAME = :budget_name)
ORDER BY b.ZNAME,
         COALESCE(parent_cat.ZNAME, cat.ZNAME, a.ZNAME),
         target.ZEFFECTIVEDATENUM;
```

## Interpretation rules

- Keep each budget's currency separate.
- Distinguish category line items, account-specific line items, and transfer-out line items.
- Do not convert `ZEFFECTIVEDATENUM` by guessing. Inspect its distinct values, compare a few targets with the Quicken UI, and document the mapping used for that file.
- Expose rollover behavior separately from the base target amount.
- Do not infer that a non-zero deletion counter always means a tombstone without validating representative records.
- When comparing budget to actual spending, reuse the transfer, account, currency, date, and uncategorized rules from `cash-flow.md`.
