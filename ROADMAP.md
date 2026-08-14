# Roadmap

Known issues and planned work. Items land here when they are real but not
blocking the release in flight. Fresh as of 2026-08-14.

## Deferred dependency work

- Major upgrades for `better-sqlite3`, `@types/better-sqlite3`, `@types/node`,
  and `typescript` were intentionally deferred from 1.6.0. Land them in a
  separate compatibility-focused change.

## Done

- ~~Live-DB suites skipped silently on multi-bundle machines~~ — `npm test` now
  runs `scripts/report-live-test-status.mjs` as a pretest and the suites fail
  when `QUICKEN_DB_PATH` is set but unusable (1.6.0).
- ~~`(Uncategorized)` mismatch between the skill and `spending_by_category`~~ —
  both surfaces now emit an explicit bucket (1.6.0).
- ~~MCP spending tool descriptions omitted their scope~~ — both now state the
  negative-split, transfer-excluded, checking/credit-card defaults (1.6.0).
