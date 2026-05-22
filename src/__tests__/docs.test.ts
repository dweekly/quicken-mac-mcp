/**
 * Cross-checks doc references against the live Quicken schema.
 *
 * For every doc that mentions Z-prefixed Core Data identifiers (SKILL.md,
 * docs/schema.md, README.md):
 *   1. every Z-token must resolve to a real table, index, column, or
 *      Core Data universal (Z_PK / Z_ENT / Z_OPT / Z_NAME)
 *   2. every fenced ```sql block must parse and execute (with LIMIT 1)
 *      against the live database
 *
 * Skips gracefully when no Quicken DB is reachable. Run via
 *   npm run check:docs
 * which is a thin wrapper around `vitest run src/__tests__/docs.test.ts`.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import Database from "better-sqlite3";
import { existsSync, readFileSync } from "fs";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import { detectQuickenDb } from "../db.js";

let DB_PATH: string | undefined;
try {
  DB_PATH = process.env.QUICKEN_DB_PATH || detectQuickenDb();
} catch {
  // Auto-detect failed (no .quicken bundles found) — tests will skip below.
}

function hasQuickenTables(path: string): boolean {
  try {
    const testDb = new Database(path, { readonly: true });
    const tables = testDb
      .prepare("SELECT name FROM sqlite_master WHERE type='table' AND name='ZTRANSACTION'")
      .all();
    testDb.close();
    return tables.length > 0;
  } catch {
    return false;
  }
}

const describeWithDb =
  DB_PATH && existsSync(DB_PATH) && hasQuickenTables(DB_PATH) ? describe : describe.skip;

const REPO_ROOT = join(dirname(fileURLToPath(import.meta.url)), "..", "..");
const DOCS = [
  "plugin/skills/quicken/SKILL.md",
  "README.md",
  "docs/schema.md",
];

const CORE_DATA_UNIVERSALS = new Set(["Z_PK", "Z_ENT", "Z_OPT", "Z_NAME"]);

let db: Database.Database;
let knownIdentifiers: Set<string>;
let categoryTagEnt: number;

beforeAll(() => {
  if (!DB_PATH || !existsSync(DB_PATH)) return;
  db = new Database(DB_PATH, { readonly: true });

  const tableNames = db
    .prepare("SELECT name FROM sqlite_master WHERE type='table'")
    .all()
    .map((r: any) => r.name as string);
  const indexNames = db
    .prepare("SELECT name FROM sqlite_master WHERE type='index'")
    .all()
    .map((r: any) => r.name as string);

  knownIdentifiers = new Set<string>([
    ...tableNames,
    ...indexNames,
    ...CORE_DATA_UNIVERSALS,
  ]);
  for (const t of tableNames) {
    for (const c of db.prepare(`PRAGMA table_info(${t})`).all() as Array<{ name: string }>) {
      knownIdentifiers.add(c.name);
    }
  }

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
  return runnable;
}

describeWithDb("docs cross-check: Z-token resolution", () => {
  for (const docPath of DOCS) {
    it(`every Z-token in ${docPath} resolves to a real table/index/column`, () => {
      const text = readFileSync(join(REPO_ROOT, docPath), "utf8");
      const tokens = extractZTokens(text);
      const unknown = [...tokens].filter((t) => !knownIdentifiers.has(t));
      expect(unknown, `Unknown Z-tokens in ${docPath}: ${unknown.join(", ")}`).toEqual([]);
    });
  }
});

describeWithDb("docs cross-check: SQL block execution", () => {
  for (const docPath of DOCS) {
    it(`every \`\`\`sql block in ${docPath} parses and runs against the live DB`, () => {
      const text = readFileSync(join(REPO_ROOT, docPath), "utf8");
      const blocks = extractSqlBlocks(text);
      const failures: string[] = [];

      for (let i = 0; i < blocks.length; i++) {
        const block = blocks[i];
        const stmts = block
          .split(/;\s*\n/)
          .map((s) => s.trim().replace(/;\s*$/, ""))
          .filter((s) => /^SELECT/i.test(s));

        for (const s of stmts) {
          const runnable = makeRunnable(s, categoryTagEnt);
          try {
            db.prepare(runnable).all();
          } catch (e: any) {
            failures.push(
              `${docPath} block #${i + 1}: ${e.message}\n  > ${runnable.slice(0, 120).replace(/\n/g, " ")}`
            );
          }
        }
      }

      expect(failures, `SQL execution failures:\n${failures.join("\n")}`).toEqual([]);
    });
  }
});
