import { describe, it, expect } from "vitest";
import { parseCLIArgs } from "../index.js";
import { formatTable } from "../cli-table.js";
import { toolsRegistry, ToolDef } from "../tools/registry.js";

describe("CLI Argument Parser", () => {
  const mockTool: ToolDef = {
    name: "test_tool",
    description: "Mock tool for parsing tests",
    handler: () => {},
    parameters: {
      start_date: {
        type: "string",
        description: "Start Date",
        optional: false,
        zod: null as any,
      },
      limit: {
        type: "number",
        description: "Limit results",
        optional: true,
        zod: null as any,
      },
      account_types: {
        type: "array",
        description: "Account types array",
        optional: true,
        zod: null as any,
      },
      group_by_category: {
        type: "boolean",
        description: "Boolean flag",
        optional: true,
        zod: null as any,
      },
    },
  };

  it("should extract subcommand and global options", () => {
    const raw = ["list-accounts", "--db", "/custom/path.db", "--json"];
    const parsed = parseCLIArgs(raw, mockTool);

    expect(parsed.subcommand).toBe("list-accounts");
    expect(parsed.dbPath).toBe("/custom/path.db");
    expect(parsed.json).toBe(true);
  });

  it("should parse string and enum parameter flags (kebab and camel case conversion)", () => {
    const raw = ["test-tool", "--start-date", "2024-01-01"];
    const parsed = parseCLIArgs(raw, mockTool);

    expect(parsed.commandArgs.start_date).toBe("2024-01-01");

    const rawCamel = ["test-tool", "--startDate", "2024-05-01"];
    const parsedCamel = parseCLIArgs(rawCamel, mockTool);
    expect(parsedCamel.commandArgs.start_date).toBe("2024-05-01");
  });

  it("should parse numeric flags correctly", () => {
    const raw = ["test-tool", "--limit", "25"];
    const parsed = parseCLIArgs(raw, mockTool);

    expect(parsed.commandArgs.limit).toBe(25);
  });

  it("should parse boolean flags correctly (implicit and explicit)", () => {
    const rawImplicit = ["test-tool", "--group-by-category"];
    const parsedImplicit = parseCLIArgs(rawImplicit, mockTool);
    expect(parsedImplicit.commandArgs.group_by_category).toBe(true);

    const rawExplicitFalse = ["test-tool", "--group-by-category", "false"];
    const parsedExplicitFalse = parseCLIArgs(rawExplicitFalse, mockTool);
    expect(parsedExplicitFalse.commandArgs.group_by_category).toBe(false);

    const rawExplicitTrue = ["test-tool", "--group-by-category", "true"];
    const parsedExplicitTrue = parseCLIArgs(rawExplicitTrue, mockTool);
    expect(parsedExplicitTrue.commandArgs.group_by_category).toBe(true);
  });

  it("should parse array parameters in space-separated style", () => {
    const raw = ["test-tool", "--account-types", "checking", "creditcard"];
    const parsed = parseCLIArgs(raw, mockTool);

    expect(parsed.commandArgs.account_types).toEqual(["checking", "creditcard"]);
  });

  it("should parse array parameters in multiple-flag style", () => {
    const raw = [
      "test-tool",
      "--account-types",
      "checking",
      "--account-types",
      "savings",
    ];
    const parsed = parseCLIArgs(raw, mockTool);

    expect(parsed.commandArgs.account_types).toEqual(["checking", "savings"]);
  });

  it("should parse production tool registry schemas correctly", () => {
    const spendingTool = toolsRegistry.find((t) => t.name === "spending_by_category");
    expect(spendingTool).toBeDefined();

    const raw = [
      "spending-by-category",
      "--start-date",
      "2024-01-01",
      "--end-date",
      "2024-12-31",
      "--group-by",
      "category",
    ];
    const parsed = parseCLIArgs(raw, spendingTool);

    expect(parsed.commandArgs.start_date).toBe("2024-01-01");
    expect(parsed.commandArgs.end_date).toBe("2024-12-31");
    expect(parsed.commandArgs.group_by).toBe("category");
  });
});

describe("CLI Table Formatter", () => {
  it("should format list of objects into beautiful aligned tables", () => {
    const data = [
      { id: 1, name: "Checking", amount: -150.5, active: true },
      { id: 2, name: "Credit Card", amount: -3200.75, active: false },
    ];

    const result = formatTable(data);

    // Check borders and rows
    expect(result).toContain("┌");
    expect(result).toContain("Checking");
    expect(result).toContain("Credit Card");
    expect(result).toContain("yes");
    expect(result).toContain("no");

    // Check headers formatted nicely
    expect(result).toContain("Active");
    expect(result).toContain("Amount");
    expect(result).toContain("Name");
    expect(result).toContain("ID");
  });

  it("should handle empty lists elegantly", () => {
    const result = formatTable([]);
    expect(result).toContain("No results found");
  });

  it("should handle null and undefined cells cleanly", () => {
    const data = [
      { name: "Rent", note: null },
      { name: "Salary", note: undefined },
    ];
    const result = formatTable(data);
    expect(result).toContain("Rent");
    expect(result).toContain("Salary");
  });

  it("should align numbers to the right and text to the left", () => {
    const data = [
      { id: 10, name: "A" },
      { id: 5, name: "LongName" },
    ];
    const result = formatTable(data);
    // Align checking: ' id ' header vs data: ' 10 ', '  5 '
    // Since id is right-aligned, it should end up with right padding aligned.
    expect(result).toContain(" 10 ");
    expect(result).toContain("  5 ");
  });
});
