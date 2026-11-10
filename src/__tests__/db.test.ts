import { describe, it, expect, vi, afterEach } from "vitest";
import {
  isoToCoreData,
  coreDataToIso,
  detectQuickenDb,
  inclusiveEndDateToCoreDataExclusive,
} from "../db.js";
import { readdirSync } from "fs";
import { homedir } from "os";
import { join } from "path";

// Mock fs for auto-detection tests
vi.mock("fs", async () => {
  const actual = await vi.importActual<typeof import("fs")>("fs");
  return {
    ...actual,
    readdirSync: vi.fn(actual.readdirSync),
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

describe("inclusiveEndDateToCoreDataExclusive", () => {
  it("returns midnight after the inclusive calendar date", () => {
    expect(inclusiveEndDateToCoreDataExclusive("2024-01-31")).toBe(
      isoToCoreData("2024-02-01")
    );
  });
});

describe("detectQuickenDb", () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  // Route readdirSync by directory (given relative to the home folder) so each
  // Quicken location can be stubbed independently; unlisted directories behave
  // as absent.
  function stubDirectories(listing: Record<string, string[]>) {
    const byPath = new Map(
      Object.entries(listing).map(([rel, entries]) => [join(homedir(), rel), entries])
    );
    vi.mocked(readdirSync).mockImplementation(((dir: string) => {
      const entries = byPath.get(String(dir));
      if (entries) return entries as any;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }) as any);
  }

  it("throws when no .quicken bundles are found anywhere", () => {
    stubDirectories({ Documents: ["file.txt", "folder"] });
    expect(() => detectQuickenDb()).toThrow("No .quicken bundles found");
    expect(() => detectQuickenDb()).toThrow("QUICKEN_DB_PATH");
  });

  it("refuses to guess when multiple bundles are found in one directory", () => {
    stubDirectories({ Documents: ["Old.quicken", "New.quicken"] });
    expect(() => detectQuickenDb()).toThrow("Multiple .quicken bundles found");
    expect(() => detectQuickenDb()).toThrow("QUICKEN_DB_PATH");
  });

  it("refuses to guess when bundles are spread across directories", () => {
    stubDirectories({
      "Library/Application Support": ["Quicken"],
      "Library/Application Support/Quicken/Documents": ["Current.quicken"],
      Documents: ["Old.quicken"],
    });
    expect(() => detectQuickenDb()).toThrow("Multiple .quicken bundles found");
  });

  it("returns path to data file when exactly one bundle is in ~/Documents", () => {
    stubDirectories({ Documents: ["MyFinances.quicken"] });
    const result = detectQuickenDb();
    expect(result).toContain("MyFinances.quicken");
    expect(result).toMatch(/\/data$/);
  });

  it("finds the retail default under ~/Library/Application Support/Quicken/Documents", () => {
    stubDirectories({
      "Library/Application Support": ["Quicken", "Unrelated"],
      "Library/Application Support/Quicken/Documents": ["Qdata.quicken"],
    });
    const result = detectQuickenDb();
    expect(result).toContain(
      "/Library/Application Support/Quicken/Documents/Qdata.quicken/data"
    );
  });

  it("finds a beta-channel folder such as 'Quicken Beta'", () => {
    stubDirectories({
      "Library/Application Support": ["Quicken Beta"],
      "Library/Application Support/Quicken Beta/Documents": ["Beta.quicken"],
    });
    expect(detectQuickenDb()).toContain("/Quicken Beta/Documents/Beta.quicken/data");
  });

  it("finds the Mac App Store sandbox container", () => {
    stubDirectories({
      "Library/Containers/com.quicken.QuickenAppStore/Data/Library/Application Support/Quicken/Documents":
        ["Store.quicken"],
    });
    expect(detectQuickenDb()).toContain("com.quicken.QuickenAppStore");
  });

  it("ignores Application Support folders that merely start with 'Quicken'", () => {
    stubDirectories({
      "Library/Application Support": ["Quickenfoo", "quicken"],
      "Library/Application Support/Quickenfoo/Documents": ["Foo.quicken"],
      "Library/Application Support/quicken/Documents": ["Lower.quicken"],
    });
    expect(() => detectQuickenDb()).toThrow("No .quicken bundles found");
  });

  it("refuses when a Quicken location exists but cannot be read", () => {
    const byPath = new Map([
      [join(homedir(), "Library/Application Support"), ["Quicken"]],
      [
        join(homedir(), "Library/Application Support/Quicken/Documents"),
        ["Other.quicken"],
      ],
    ]);
    vi.mocked(readdirSync).mockImplementation(((dir: string) => {
      if (String(dir) === join(homedir(), "Documents")) {
        throw Object.assign(new Error("EPERM"), { code: "EPERM" });
      }
      const entries = byPath.get(String(dir));
      if (entries) return entries as any;
      throw Object.assign(new Error("ENOENT"), { code: "ENOENT" });
    }) as any);
    expect(() => detectQuickenDb()).toThrow("Cannot read");
    expect(() => detectQuickenDb()).toThrow("QUICKEN_DB_PATH");
  });

  it("lists every searched directory in the not-found error", () => {
    stubDirectories({});
    expect(() => detectQuickenDb()).toThrow("Application Support");
    expect(() => detectQuickenDb()).toThrow("com.quicken.QuickenAppStore");
  });
});
