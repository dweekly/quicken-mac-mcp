import { describe, it, expect } from "vitest";
import { sanitizeError, formatToolError } from "../server.js";

describe("sanitizeError", () => {
  it("strips single-quoted paths (native module errors)", () => {
    const msg =
      "The module '/Users/x/.npm/_npx/abc/node_modules/better-sqlite3/build/Release/better_sqlite3.node' " +
      "was compiled against a different Node.js version using NODE_MODULE_VERSION 141.";
    const result = sanitizeError({ message: msg });
    expect(result).toContain("'<path>'");
    expect(result).toContain("NODE_MODULE_VERSION 141");
    expect(result).not.toContain("/Users/");
  });

  it("strips double-quoted paths", () => {
    const msg = 'Cannot open "/Users/x/Documents/Finances.quicken/data"';
    const result = sanitizeError({ message: msg });
    expect(result).toContain('"<path>"');
    expect(result).not.toContain("/Users/");
  });

  it("strips unquoted multi-segment paths", () => {
    const result = sanitizeError({
      message: "unable to open: /Users/dew/Documents/MyFinances.quicken/data",
    });
    expect(result).toBe("unable to open: <path>");
  });

  it("strips multiple paths in one message", () => {
    const result = sanitizeError({
      message: "Error at /foo/bar/baz and /qux/quux/corge",
    });
    expect(result).toBe("Error at <path> and <path>");
  });

  it("strips unquoted single-segment absolute paths", () => {
    // e.g. the Quicken bundle's inner database file is literally named "data",
    // so a bare filename like "/data" is a realistic unquoted fragment that a
    // multi-segment-only regex would miss.
    const result = sanitizeError({ message: "cannot read /data" });
    expect(result).toBe("cannot read <path>");
  });

  it("strips unquoted ~/-relative paths", () => {
    const result = sanitizeError({
      message: "no bundle found in ~/Documents/MyFinances.quicken",
    });
    expect(result).toBe("no bundle found in <path>");
  });

  it("does not mangle non-path slash content like fractions or versions", () => {
    expect(sanitizeError({ message: "ratio is 3/4 by volume" })).toBe(
      "ratio is 3/4 by volume"
    );
    expect(sanitizeError({ message: "supported on v1.2.3/beta builds" })).toBe(
      "supported on v1.2.3/beta builds"
    );
  });

  it("strips a path containing spaces without leaking the tail", () => {
    // Real Quicken bundle/folder names can contain spaces (e.g. a document
    // named "My Finances.quicken"); a segment that isn't allowed to contain
    // spaces splits at the first one and leaks everything after it.
    const result = sanitizeError({
      message: "cannot open /Users/antonio/Documents/My Finances.quicken/data",
    });
    expect(result).toBe("cannot open <path>");
  });

  it("strips a path with Unicode characters in a folder name", () => {
    const result = sanitizeError({
      message: "cannot open /Users/x/Documents/Café Finances.quicken/data",
    });
    expect(result).toBe("cannot open <path>");
  });

  it("does not corrupt an unrelated URL in the message", () => {
    // The "//" after the scheme previously caused a partial match starting
    // at the second slash, leaving a stray "/" behind: "https:/<path>".
    const result = sanitizeError({ message: "fetch failed for https://example.com/api" });
    expect(result).toBe("fetch failed for https://example.com/api");
  });

  it("preserves messages without paths", () => {
    expect(sanitizeError({ message: "no such table ZACCOUNT" })).toBe(
      "no such table ZACCOUNT"
    );
    expect(sanitizeError({ message: "file is not a database" })).toBe(
      "file is not a database"
    );
  });

  it("does not consume prose text after paths", () => {
    const msg =
      "The module '/some/path/file.node' was compiled against a different Node.js version";
    const result = sanitizeError({ message: msg });
    expect(result).toContain("was compiled against a different Node.js version");
  });

  it("handles non-Error inputs", () => {
    expect(sanitizeError("plain string")).toBe("plain string");
    expect(sanitizeError(null)).toBe("null");
    expect(sanitizeError(undefined)).toBe("undefined");
  });
});

describe("formatToolError", () => {
  it("detects NODE_MODULE_VERSION mismatch and suggests fix", () => {
    const err = new Error(
      "The module '/some/path/better_sqlite3.node' was compiled against a different " +
        "Node.js version using NODE_MODULE_VERSION 141. This version of Node.js requires " +
        "NODE_MODULE_VERSION 108."
    );
    const result = formatToolError(err);
    expect(result.isError).toBe(true);
    const text = result.content[0].text;
    expect(text).toContain("Native module version mismatch");
    expect(text).toContain("rm -rf ~/.npm/_npx");
    expect(text).not.toContain("/some/path");
  });

  it("detects 'was compiled against' variant", () => {
    const err = new Error("was compiled against a different Node.js version");
    const result = formatToolError(err);
    expect(result.content[0].text).toContain("rm -rf ~/.npm/_npx");
  });

  it("detects dlopen failures", () => {
    const err = new Error("dlopen failed: symbol not found");
    const result = formatToolError(err);
    expect(result.content[0].text).toContain("npm/_npx");
  });

  it("handles unable to open database errors", () => {
    const err = new Error("unable to open database file");
    const result = formatToolError(err);
    expect(result.content[0].text).toContain("Quicken");
  });

  it("handles no such table with Quicken not running", () => {
    const err = new Error("no such table: ZACCOUNT");
    const result = formatToolError(err);
    expect(result.isError).toBe(true);
    // Can't easily mock isDatabaseDecrypted, just verify it returns something useful
    expect(result.content[0].text).toContain("no such table");
  });
});
