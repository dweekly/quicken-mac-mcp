# Changelog

## 1.3.0

### Added

- New `quicken-mac-mcp export [output] [dbpath]` CLI subcommand that performs an ETL pass over Quicken's Core Data SQLite and writes a clean, normalized output database with human-readable column names, ISO 8601 dates, and denormalized fields. Default output path: `~/Documents/quicken-export.db`.
- Exported tables: `accounts`, `categories`, `payees`, `transactions`, `transaction_splits`, `holdings`, plus `_export_meta` with row counts and an export timestamp.
- Pre-built analysis views: `monthly_spending` (month × parent_category), `cash_flow` (monthly income / expense / net across cash and savings accounts), and `recurring_charges` (payees with 3+ charges spaced 25–35 days apart).
- 19 new tests for the export pipeline (12 unit tests against a synthetic Quicken-shaped fixture, plus 7 live-DB integration tests with FK integrity, aggregate consistency, and view-row checks; the live block auto-skips when no Quicken DB is reachable).

### Fixed

- Export now skips rows in `ZCASHFLOWTRANSACTIONENTRY` whose `ZPARENT` is `NULL` (these would otherwise violate the `transaction_splits.transaction_id NOT NULL` foreign key and abort the export).
- A failed export no longer leaves a partial output file behind. The export refuses to overwrite an existing output path at start, and on any failure removes the partial output along with its `-wal` / `-shm` sidecars so a re-run is unblocked.

## 1.2.2

### Fixed

- Native module version mismatch errors (e.g., npx caching a better-sqlite3 build for a different Node.js version) now produce actionable diagnostics instead of the misleading "unable to open database file" message.
- `sanitizeError` regex no longer swallows diagnostic text after filesystem paths; NODE_MODULE_VERSION info is now preserved in error output.

### Added

- Startup validation: the server eagerly tests the better-sqlite3 native module via an in-memory database and exits with a clear message if there is a version mismatch.
- `formatToolError` now detects `NODE_MODULE_VERSION`, `dlopen`, and `MODULE_NOT_FOUND` errors and suggests `rm -rf ~/.npm/_npx` as a fix.
- `diagnosePath` helper provides detailed diagnostics (file existence, permissions, file size) when the database file cannot be opened.
- 12 new unit tests for error sanitization and error formatting.

## 1.2.1

### Fixed

- Downgraded better-sqlite3 to v11 for Node 18 compatibility (v12 requires Node 20+).

### Changed

- Updated transitive dependencies (node-forge, path-to-regexp, picomatch, flatted).

## 1.2.0

### Added

- 60 integration tests validating cross-tool consistency, category hierarchy, date handling, spending aggregation, portfolio math, raw query safety, and schema integrity.
- `docs/schema.md`: comprehensive 3200-line Quicken 8.5 Core Data schema reference (84 entities, 85 tables, 251 indexes).
- `account_names` filter for `query_transactions`, `spending_by_category`, and `spending_over_time` tools.
- Date fallback: transactions with null `ZPOSTEDDATE` now fall back to `ZTIMESTAMP` (fixes imported/historical accounts).
- Contributor credit for Manish Mukherjee in README.

### Fixed

- Hardcoded `Z_ENT=79` for CategoryTag lookups replaced with dynamic lookup from `Z_PRIMARYKEY` table (contributed by @manishie).

## 1.1.0

### Changed

- Removed live Yahoo Finance quote fetching from `list_portfolio`; uses only stored Quicken quotes. Keeps the MCP focused and avoids external API calls.
- Replaced `pgrep` shell-out with native `ZACCOUNT` table check to detect whether Quicken has decrypted the database.
- Narrowed catch in `createDbAccessor` to only swallow ENOENT, re-throwing permission and other filesystem errors.

## 1.0.3

### Added

- MCP Registry metadata (`server.json`) for discovery via the MCP Registry.

## 1.0.2

### Fixed

- Server no longer crashes on startup when no `.quicken` bundle is found. The MCP server now starts successfully and returns helpful error messages at tool-call time instead of failing during initialization.
- When multiple `.quicken` bundles exist in `~/Documents`, the server auto-selects the most recently modified one instead of crashing with an ambiguous error.
- Documented that Quicken For Mac must be open for the server to work (Quicken encrypts its database when closed). Tool errors now detect the "no such table" symptom and tell the user to open Quicken.

### Changed

- Database connection is now lazy — deferred to first tool call rather than opening eagerly at startup.
- Tool error handling unified via `safeTool` wrapper, removing per-tool try/catch boilerplate.
- MCP server instructions now guide the calling agent to confirm the auto-detected Quicken file with the user and suggest setting `QUICKEN_DB_PATH` to disambiguate.

## 1.0.1

### Changed

- Prepared for open-source release (license, README, packaging).

## 1.0.0

Initial release.
