# Tags and QuickFill rules

Core Data many-to-many identifiers can vary between Quicken files and model migrations. Discover physical identifiers from the selected database instead of copying identifiers from an example schema.

## Contents

- [Resolve entity IDs](#resolve-entity-ids)
- [Discover the user-tag join](#discover-the-user-tag-join)
- [Query user tags](#query-user-tags)
- [Inspect QuickFill rules](#inspect-quickfill-rules)

## Resolve entity IDs

```sql
SELECT Z_NAME, Z_ENT
FROM Z_PRIMARYKEY
WHERE Z_NAME IN ('CashFlowTransactionEntry', 'UserTag', 'CategoryTag');
```

Never assume values such as `15`, `76`, or `79` apply to another file.

## Discover the user-tag join

Resolve the helper path relative to the skill's `SKILL.md`, then run the bundled schema-only discovery command:

```bash
python3 <skill-directory>/scripts/quicken_db.py user-tag-schema --db "/path/to/File.quicken/data"
```

The command searches `sqlite_master`, validates every returned identifier, and fails if the join table or either relationship column is missing or ambiguous. To inspect manually:

```sql
SELECT name, sql
FROM sqlite_master
WHERE type = 'table'
  AND name GLOB 'Z_*USERTAGS*';
```

Then run `PRAGMA table_info("<validated-table-name>")`. Numeric entity prefixes help identify relationships, but column suffixes such as `USERTAGS1` can be added during model migrations. Do not derive every identifier from `Z_ENT` alone.

## Query user tags

After discovery, substitute only the validated identifiers returned by the helper. Identifiers cannot be bound as normal SQLite parameters.

```sql
SELECT s.Z_PK AS split_id,
       t.Z_PK AS transaction_id,
       date(COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE) + 978307200,
            'unixepoch') AS posted_date,
       p.ZNAME AS payee,
       s.ZAMOUNT AS amount,
       tag.ZNAME AS tag_name
FROM ZCASHFLOWTRANSACTIONENTRY s
JOIN ZTRANSACTION t ON s.ZPARENT = t.Z_PK
LEFT JOIN ZUSERPAYEE p ON t.ZUSERPAYEE = p.Z_PK
JOIN "<validated-join-table>" j
  ON j."<validated-entry-column>" = s.Z_PK
JOIN ZTAG tag
  ON j."<validated-user-tag-column>" = tag.Z_PK
 AND tag.Z_ENT = (
     SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'UserTag'
 )
ORDER BY COALESCE(t.ZPOSTEDDATE, t.ZENTEREDDATE) DESC
LIMIT :row_limit;
```

Reject discovered identifiers unless they contain only ASCII letters, digits, and underscores, and always quote them as identifiers.

## Inspect QuickFill rules

QuickFill categories live on `ZQUICKFILLRULESPLITENTRY`, not directly on the rule. Do not label every stored rule “active.” Expose the status fields needed to interpret it:

```sql
SELECT q.Z_PK AS rule_id,
       q.ZPAYEENAME AS payee_name,
       q.ZTRANSACTIONTYPE AS transaction_type,
       q.ZAMOUNT AS default_amount,
       q.ZMEMO AS default_memo,
       q.ZNEVERAUTOCATEGORIZE AS never_auto_categorize,
       q.ZUSEFORDOWNLOADEDTRANSACTIONS AS use_for_downloads,
       q.ZDELETIONCOUNT AS deletion_count,
       s.ZSEQUENCENUMBER AS split_sequence,
       cat.ZNAME AS default_category,
       s.ZAMOUNT AS split_amount,
       s.ZMEMO AS split_memo,
       date(q.ZLASTUSEDTIMESTAMP + 978307200, 'unixepoch') AS last_used
FROM ZQUICKFILLRULE q
LEFT JOIN ZQUICKFILLRULESPLITENTRY s ON s.ZQUICKFILLRULE = q.Z_PK
LEFT JOIN ZTAG cat
       ON s.ZCATEGORYTAG = cat.Z_PK
      AND cat.Z_ENT = (
          SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'CategoryTag'
      )
WHERE (:payee_search IS NULL
       OR q.ZPAYEENAME LIKE '%' || :payee_search || '%')
ORDER BY q.ZLASTUSEDTIMESTAMP DESC, q.Z_PK, s.ZSEQUENCENUMBER
LIMIT :row_limit;
```

If the user asks specifically for enabled auto-categorization rules, explain the chosen interpretation and filter the exposed flags accordingly. Confirm the meaning of deletion counters against representative rows before using them as a universal tombstone predicate.
