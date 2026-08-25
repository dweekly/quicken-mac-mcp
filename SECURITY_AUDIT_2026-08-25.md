# Security Audit Follow-up — 2026-08-25

This report independently validates the reported findings on `main` and reviews
the four proposed fix branches. All branches were built, linted, and tested in
isolation. Live Quicken suites were skipped because no `QUICKEN_DB_PATH` was
configured, so those results do not validate a real Quicken database.

## Branch `fix/raw-query-limit-bypass`

The reported nested-`LIMIT` bypass is valid. The original implementation finds
the first `LIMIT` anywhere in the SQL. An inner subquery limit can therefore be
clamped while no final outer limit is applied, leaving the returned result set
unbounded.

The branch's approach—wrapping the supplied query in an outer `SELECT * FROM
(...) LIMIT 500`—is the correct general direction. It guarantees that the
final result cannot exceed 500 rows, regardless of nested limits.

Do not merge it unchanged. There is an existing additional bypass with a
trailing line comment: `SELECT * FROM t -- comment` causes the current injected
limit to be commented out. The branch closes that bypass only by making the
otherwise valid query fail: the line comment consumes the wrapper's closing
parenthesis. `SELECT ...; -- comment` similarly fails. Normalize a valid final
semicolon/comment before wrapping (using SQL-aware scanning rather than a
simple regex), or explicitly reject it with a clear error.

## Branch `fix/raw-query-pragma-bypass`

The reported `pragma_*()` bypass is valid. `\bPRAGMA\b` does not match
`pragma_database_list()` because `_` is a word character. SQLite table-valued
pragma functions can therefore disclose metadata such as database file paths.

The new `PRAGMA_\w*` alternative blocks these functions and is a suitable
defense-in-depth fix. The impact remains low because the affected functions
are informational rather than a write primitive.

The wider keyword blocklist is still only a coarse policy mechanism: it also
rejects harmless text such as `SELECT 'DROP'`. Prefer a tokenizer/parser-based
single-read-statement policy if raw-query usability matters.

## Branch `fix/raw-query-timeout`

The underlying availability finding is valid. `better-sqlite3` executes
queries synchronously, so an expensive legal `SELECT` can block the MCP server
event loop. A killable child process with a wall-clock timeout is a sound
solution. I verified a normal query in both compiled and `tsx` development
mode, and the deterministic timeout test passes.

The branch changes `rawQuery` from synchronous to asynchronous. The MCP server
and CLI await it correctly, but direct callers and tests must also await it.
Existing validation assertions that use synchronous `toThrow` need to become
`await expect(...).rejects`; the skipped live-database tests currently mask
that gap.

Also add a concurrency bound: several simultaneous raw queries can create
multiple CPU-intensive child processes for up to ten seconds each. Add a
response-byte limit as well as the 500-row limit, since 500 unusually large
text/blob values can still cause substantial child-process, IPC, JSON, and MCP
payload memory pressure.

## Branch `fix/sanitize-error-paths`

The original path-scrubbing gap is valid: single-segment paths such as `/data`
and home-relative paths were not redacted.

The branch fixes those narrow cases, but it is incomplete and introduces
over-redaction. It leaks the suffix of a realistic path with spaces:

```text
/Users/antonio/Documents/My Finances.quicken/data
→ <path> Finances.quicken/data
```

It also corrupts URLs in error messages:

```text
https://example.com/api
→ https:/<path>
```

Do not treat the regex as a complete privacy guarantee. Prefer translating
known filesystem/database failures into controlled, path-free errors. If a
sanitizer remains necessary, test spaces, Unicode names, punctuation, quoted
and unquoted paths, URLs, and multiple paths in one message.

## Additional recommendations

- Integrate the raw-query changes in one branch. The four branches all start
  from `main`; the raw-query branches conflict and should not be blindly
  cherry-picked together. The combined implementation needs the outer row
  cap, `pragma_*` protection, child-process timeout, async callers, and
  corrected tests.
- Add a regression test for the trailing-comment row-cap bypass and for the
  wrapper accepting a legitimate commented query after normalization.
- Use SQL-aware tokenization for statement validation and terminal-comment
  handling. Regex blocklists create both bypass and false-positive risk.
- Consider permitting only one read statement, with explicit handling for
  comments and an optional terminal semicolon. The database's read-only
  connection remains an important second layer of defense.
- Ensure the child-process code has tests for successful execution, syntax
  errors, timeout cleanup, error propagation, and concurrent-request limits.
- Apply resource limits consistently to any other MCP tools that could become
  expensive on unusually large Quicken databases.
- The audit found no separate SQL injection path in the curated tools: their
  caller-controlled values are bound as parameters, and the Quicken database
  is opened read-only. The installed dependency set also reported no known
  vulnerabilities through `npm ci`/audit at the time of review.
