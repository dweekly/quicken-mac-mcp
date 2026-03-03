import { describe, it, expect, vi, afterEach } from "vitest";
import { isoToCoreData, coreDataToIso, detectQuickenDb } from "../db.js";
import { readdirSync, statSync } from "fs";

// Mock fs for auto-detection tests
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync),
    statSync: vi.fn(actual.statSync),
  };
});

describe("isoToCoreData", () => {
  it("converts Core Data epoch (2001-01-01) to 0", () => {
    expect(isoToCoreData("2001-01-01T00:00:00Z")).toBe(0);
  });

  it("converts 2024-01-01 correctly", () => {
    // 2024-01-01 = Unix 1704067200 => CoreData = 1704067200 - 978307200 = 725760000
    expect(isoToCoreData("2024-01-01T00:00:00Z")).toBe(725760000);
  });

  it("handles date-only strings (no time component)", () => {
    const ts = isoToCoreData("2024-06-15");
    expect(ts).toBeGreaterThan(0);
  });

  it("returns negative values for dates before 2001", () => {
    expect(isoToCoreData("2000-01-01T00:00:00Z")).toBeLessThan(0);
  });
});

describe("coreDataToIso", () => {
  it("converts 0 to 2001-01-01", () => {
    expect(coreDataToIso(0)).toBe("2001-01-01");
  });

  it("converts 725760000 to 2024-01-01", () => {
    expect(coreDataToIso(725760000)).toBe("2024-01-01");
  });

  it("handles negative timestamps (pre-2001 dates)", () => {
    const iso = coreDataToIso(-86400); // one day before Core Data epoch
    expect(iso).toBe("2000-12-31");
  });
});

describe("date round-trips", () => {
  it("round-trips 2024-06-15", () => {
    expect(coreDataToIso(isoToCoreData("2024-06-15"))).toBe("2024-06-15");
  });

  it("round-trips 2001-01-01", () => {
    expect(coreDataToIso(isoToCoreData("2001-01-01"))).toBe("2001-01-01");
  });

  it("round-trips 1999-12-31", () => {
    expect(coreDataToIso(isoToCoreData("1999-12-31"))).toBe("1999-12-31");
  });
});

describe("detectQuickenDb", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("throws when no .quicken bundles are found", () => {
    vi.mocked(readdirSync).mockReturnValue(["file.txt", "folder"] as any);
    expect(() => detectQuickenDb()).toThrow("No .quicken bundles found");
  });

  it("picks most recent bundle when multiple are found", () => {
    vi.mocked(readdirSync).mockReturnValue(["Old.quicken", "New.quicken"] as any);
    vi.mocked(statSync).mockImplementation((p: any) => {
      const path = String(p);
      return { mtimeMs: path.includes("New.quicken") ? 2000 : 1000 } as any;
    });
    const result = detectQuickenDb();
    expect(result).toContain("New.quicken");
    expect(result).toMatch(/\/data$/);
  });

  it("returns path to data file when exactly one bundle is found", () => {
    vi.mocked(readdirSync).mockReturnValue(["MyFinances.quicken"] as any);
    vi.mocked(statSync).mockReturnValue({ mtimeMs: 1000 } as any);
    const result = detectQuickenDb();
    expect(result).toContain("MyFinances.quicken");
    expect(result).toMatch(/\/data$/);
  });
});
