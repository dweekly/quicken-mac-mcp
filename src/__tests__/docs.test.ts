/**
 * Cross-checks the skill, focused references, README, and schema docs against
 * both a synthetic Quicken-shaped fixture and an optional live Quicken schema.
 *
 * For every doc that mentions Z-prefixed Core Data identifiers:
 *   1. every Z-token must resolve to a real table, index, column, or
 *      Core Data universal (Z_PK / Z_ENT / Z_OPT / Z_NAME)
 *   2. every skill SQL block must execute against a synthetic fixture in CI
 *   3. every fenced ```sql block must parse and execute against a live
 *      database when one is explicitly configured or unambiguously detected
 *
 * Live checks skip with an explicit warning when no database is selected and
 * fail when QUICKEN_DB_PATH was set but is unusable. Run via
 *   npm run check:docs
 * which is a thin wrapper around `vitest run src/__tests__/docs.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { createSyntheticQuickenDb } from "./fixtures/quicken.js";
import { resolveLiveQuickenDb } from "./fixtures/live-quicken.js";

const DB_PATH = resolveLiveQuickenDb("docs.test.ts", ["ZTRANSACTION"]);
const describeWithDb = DB_PATH ? describe : describe.skip;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCS = [
  "plugin/skills/quicken/SKILL.md",
  "plugin/skills/quicken/references/balances.md",
  "plugin/skills/quicken/references/budgets.md",
  "plugin/skills/quicken/references/cash-flow.md",
  "plugin/skills/quicken/references/investments.md",
  "plugin/skills/quicken/references/tags-and-rules.md",
  "README.md",
  "docs/schema.md",
];
const SKILL_DOCS = DOCS.filter((path) => path.startsWith("plugin/skills/quicken/"));

const CORE_DATA_UNIVERSALS = new Set(["Z_PK", "Z_ENT", "Z_OPT", "Z_NAME"]);

let db: Database.Database;
let knownIdentifiers: Set<string>;
let categoryTagEnt: number;

function collectKnownIdentifiers(database: Database.Database): Set<string> {
  const tableNames = database
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r: any) => r.name as string);
  const indexNames = database
    .prepare("SELECT name FROM sqlite_master WHERE type='index'")
    .all()
    .map((r: any) => r.name as string);

  const identifiers = new Set<string>([
    ...tableNames,
    ...indexNames,
    ...CORE_DATA_UNIVERSALS,
  ]);
  for (const t of tableNames) {
    for (const c of database.prepare(`PRAGMA table_info(${t})`).all() as Array<{
      name: string;
    }>) {
      identifiers.add(c.name);
    }
  }
  return identifiers;
}

beforeAll(() => {
  if (!DB_PATH) return;
  db = new Database(DB_PATH, { readonly: true });
  knownIdentifiers = collectKnownIdentifiers(db);

  categoryTagEnt = (
    db.prepare("SELECT Z_ENT FROM Z_PRIMARYKEY WHERE Z_NAME = 'CategoryTag'").get() as {
      Z_ENT: number;
    }
  ).Z_ENT;
});

afterAll(() => {
  db?.close();
});

// Tokens that are intentionally referenced as prose placeholders (regex
// templates etc.) and should not be cross-checked against the schema.
const PROSE_PLACEHOLDERS = new Set(["ZTABLE_ZCOLUMN_INDEX"]);

// Tokens that are part of the broader Quicken schema (e.g. version-dependent
// features like tax-reporting/small business tables) but might not be physically
// present in every live database instance.
const VERSION_DEPENDENT_TOKENS = new Set([
  "ZTAXAGENCYNAME",
  "ZTAXLINEITEM",
  "ZFORM",
  "ZLINENUMBER",
]);

function extractZTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const m of text.matchAll(/\b(Z[A-Z][A-Z_0-9]*)\b/g)) {
    if (!PROSE_PLACEHOLDERS.has(m[1]) && !VERSION_DEPENDENT_TOKENS.has(m[1])) {
      tokens.add(m[1]);
    }
  }
  return tokens;
}

function extractSqlBlocks(text: string): string[] {
  return [...text.matchAll(/```sql\n([\s\S]*?)\n```/g)].map((m) => m[1]);
}

function makeRunnable(stmt: string, catEnt: number): string {
  let runnable = stmt.replace(/<CAT_ENT>/g, String(catEnt));
  // Replace any remaining <PLACEHOLDER> tokens with a harmless string literal
  runnable = runnable.replace(/<[A-Z_]+>/g, "'placeholder'");
  // Replace SQL bind parameters (?) with literal 0
  runnable = runnable.replace(/(?<![\w$:@])\?/g, "0");
  // Replace named parameters with representative safe values.
  runnable = runnable
    .replace(/:start_date\b/g, "'1900-01-01'")
    .replace(/:end_date\b/g, "'1900-01-02'")
    .replace(/:row_limit\b/g, "1")
    .replace(/:[A-Za-z_][A-Za-z0-9_]*\b/g, "NULL");
  return runnable;
}

function sqlExecutionFailures(
  database: Database.Database,
  docPaths: string[],
  catEnt: number
): string[] {
  const failures: string[] = [];

  for (const docPath of docPaths) {
    const text = readFileSync(join(REPO_ROOT, docPath), "utf8");
    const blocks = extractSqlBlocks(text);

    for (let i = 0; i < blocks.length; i++) {
      const stmts = blocks[i]
        .split(/;\s*\n/)
        .map((s) => s.trim().replace(/;\s*$/, ""))
        .filter((s) => /^(SELECT|WITH)\b/i.test(s));

      for (const statement of stmts) {
        // This template requires physical Core Data join identifiers discovered
        // from the selected database by scripts/quicken_db.py.
        if (statement.includes("<validated-")) continue;

        const runnable = makeRunnable(statement, catEnt);
        try {
          database.prepare(runnable).all();
        } catch (error: any) {
          failures.push(
            `${docPath} block #${i + 1}: ${error.message}\n  > ${runnable.slice(0, 120).replace(/\n/g, " ")}`
          );
        }
      }
    }
  }

  return failures;
}

describe("docs cross-check: synthetic SQL execution", () => {
  it("resolves identifiers and runs every skill SQL recipe without a live file", () => {
    const fixture = createSyntheticQuickenDb();
    try {
      const fixtureIdentifiers = collectKnownIdentifiers(fixture);
      const unknown = SKILL_DOCS.flatMap((docPath) => {
        const tokens = extractZTokens(readFileSync(join(REPO_ROOT, docPath), "utf8"));
        return [...tokens].filter((token) => !fixtureIdentifiers.has(token));
      });
      expect([...new Set(unknown)], "Unknown synthetic-fixture Z-tokens").toEqual([]);

      const failures = sqlExecutionFailures(fixture, SKILL_DOCS, 79);
      expect(failures, `SQL execution failures:\n${failures.join("\n")}`).toEqual([]);
    } finally {
      fixture.close();
    }
  });
});

describeWithDb("docs cross-check: Z-token resolution", () => {
  for (const docPath of DOCS) {
    it(`every Z-token in ${docPath} resolves to a real table/index/column`, () => {
      const text = readFileSync(join(REPO_ROOT, docPath), "utf8");
      const tokens = extractZTokens(text);
      const unknown = [...tokens].filter((t) => !knownIdentifiers.has(t));
      expect(unknown, `Unknown Z-tokens in ${docPath}: ${unknown.join(", ")}`).toEqual(
        []
      );
    });
  }
});

describeWithDb("docs cross-check: SQL block execution", () => {
  it("runs every documented SQL recipe against the live DB", () => {
    const failures = sqlExecutionFailures(db, DOCS, categoryTagEnt);
    expect(failures, `SQL execution failures:\n${failures.join("\n")}`).toEqual([]);
  });
});

describe("Quicken skill regression guards", () => {
  const skill = readFileSync(join(REPO_ROOT, "plugin/skills/quicken/SKILL.md"), "utf8");
  const cashFlow = readFileSync(
    join(REPO_ROOT, "plugin/skills/quicken/references/cash-flow.md"),
    "utf8"
  );
  const balances = readFileSync(
    join(REPO_ROOT, "plugin/skills/quicken/references/balances.md"),
    "utf8"
  );
  const investments = readFileSync(
    join(REPO_ROOT, "plugin/skills/quicken/references/investments.md"),
    "utf8"
  );
  const tags = readFileSync(
    join(REPO_ROOT, "plugin/skills/quicken/references/tags-and-rules.md"),
    "utf8"
  );

  it("uses inclusive user-facing end dates via a half-open interval", () => {
    expect(cashFlow).toContain(":end_date, '+1 day'");
    expect(cashFlow).not.toMatch(/BETWEEN[\s\S]{0,160}:end_date/);
  });

  it("distinguishes transfers, transactions, splits, and uncategorized spending", () => {
    expect(cashFlow).toContain("NULLIF(TRIM(s.ZTRANSFER), '') IS NULL");
    expect(cashFlow).toContain("COUNT(DISTINCT t.Z_PK) AS transaction_count");
    expect(cashFlow).toContain("COUNT(*) AS split_count");
    expect(cashFlow).toContain("'(Uncategorized)'");
  });

  it("preserves non-zero short positions", () => {
    expect(investments).toContain("ABS(COALESCE(l.ZLATESTUNITS, 0)) > 0.000000001");
    expect(investments).not.toContain("ZLATESTUNITS > 0");
  });

  it("uses dated institution sources for first-class balance extraction", () => {
    expect(balances).toContain("ZONLINEBANKINGLEDGERBALANCEAMOUNT");
    expect(balances).toContain("ZONLINEBANKINGLEDGERBALANCEDATE");
    expect(balances).toContain("ZONLINEBANKINGLASTCONNECTEDTIMESTAMP");
    expect(balances).toContain("ROW_NUMBER() OVER");
    expect(balances).toContain("ZFISTATEMENT");
    expect(balances).toContain("ZFIPOSITION");
  });

  it("rejects transaction-derived investment balances and zero-position noise", () => {
    expect(balances).toContain("ZONLINEBANKINGLEDGERBALANCEAMOUNT");
    expect(balances).toContain("LEFT JOIN ZFIPOSITION p ON p.ZFISTATEMENT = fs.Z_PK");
    expect(balances).toContain("ABS(COALESCE(p.ZMARKETVALUE, 0)) > 0.000001");
  });

  it("documents payroll and retained-statement limits", () => {
    expect(cashFlow).toContain("COUNT(s.Z_PK) AS split_count");
    expect(balances).toContain("retained_statement_count");
  });

  it("requires dynamic entity and join-table discovery", () => {
    expect(skill).toContain("SELECT Z_ENT FROM Z_PRIMARYKEY");
    expect(tags).toContain("SELECT Z_NAME, Z_ENT");
    expect(tags).toContain("user-tag-schema");
    expect(tags).not.toContain("JOIN Z_15USERTAGS");
  });
});
