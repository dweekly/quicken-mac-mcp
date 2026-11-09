# Roadmap

Known issues and planned work. Items land here when they are real but not
blocking the release in flight. Fresh as of 2026-11-09.

## Open

- The export account-type normalizers (`src/export.ts`, `scripts/export_sovereign_csv.py`)
  map `RETIREMENT401K` and `BROKERAGE`, which are not values Quicken stores; real
  subtypes such as `DEFERREDCOMPRETIREMENT401K` and `BROKERAGENORMAL` fall through
  as run-together lowercase (`brokeragenormal`) next to `credit_card`. Fixing it
  changes exported values, so it needs a release note.
- The integer stored in `ZBUDGETTARGET.ZROLLOVERMODE` for each rollover mode is
  unverified; it needs a Quicken file that has budgets (see `docs/schema.md`).

## Deferred dependency work

- Major upgrades for `@types/node` and `typescript` were intentionally deferred
  from 1.6.0. Land them in a separate compatibility-focused change.
- The Intel Claude Desktop bundle built with `better-sqlite3` 13 has not been run:
  the release workflow checks that it contains the x86_64 addon, but nobody has
  loaded it on an Intel Mac. Confirm on the first release after the upgrade.
- `package.json` carries three `overrides` that force patched versions into
  development-only tooling whose own releases still pin vulnerable ones: `minimatch`
  11 under `eslint` / `typescript-eslint`, and `zod` 4 and `tmp` 0.2.7 under
  `@anthropic-ai/mcpb`. Remove each override once the tool publishes a release that
  depends on a patched version itself, then confirm `npm audit` stays clean.

## Done

- ~~Live-DB suites skipped silently on multi-bundle machines~~ — `npm test` now
  runs `scripts/report-live-test-status.mjs` as a pretest and the suites fail
  when `QUICKEN_DB_PATH` is set but unusable (1.6.0).
- ~~`(Uncategorized)` mismatch between the skill and `spending_by_category`~~ —
  both surfaces now emit an explicit bucket (1.6.0).
- ~~MCP spending tool descriptions omitted their scope~~ — both now state the
  negative-split, transfer-excluded, checking/credit-card defaults (1.6.0).
