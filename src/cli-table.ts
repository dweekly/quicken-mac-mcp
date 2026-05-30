/**
 * Pure TypeScript Unicode/ASCII Table Formatter for CLI output.
 *
 * Formats lists of objects as highly-aesthetic double/single-bordered console tables.
 * Auto-sizes column widths, cleans up headers, and aligns data dynamically
 * (right-aligns numbers/currencies, left-aligns text/booleans).
 */

function formatHeader(key: string): string {
  const overrides: Record<string, string> = {
    id: "ID",
    pk: "PK",
    z_pk: "Z_PK",
    tx_count: "Tx Count",
    transaction_count: "Tx Count",
    transaction_id: "Tx ID",
    gain_loss: "Gain/Loss",
    gain_loss_pct: "Gain/Loss %",
    is_active: "Active",
    is_closed: "Closed",
    posted_date: "Date",
    payee_name: "Payee",
    account_name: "Account",
    split_note: "Split Memo",
    total_amount: "Amount",
    security_name: "Security",
    current_shares: "Shares",
  };
  if (overrides[key]) return overrides[key];
  return key
    .split("_")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join(" ");
}

/** Formats a cell value for display, handling nulls/dates/booleans. */
function formatCell(val: any): string {
  if (val === null || val === undefined) return "";
  if (typeof val === "boolean") return val ? "yes" : "no";
  if (typeof val === "number") {
    // If it's a monetary value, format to 2 decimals if it looks like one, or just keep it clean
    if (Number.isInteger(val)) return String(val);
    // Keep decimal representation clean
    return val.toFixed(Math.max(2, (String(val).split(".")[1] || "").length));
  }
  return String(val);
}

export function formatTable(data: unknown): string {
  if (!data) return "No results.";

  // Normalize input
  let rows: Record<string, any>[] = [];
  if (Array.isArray(data)) {
    rows = data;
  } else if (typeof data === "object" && data !== null) {
    const obj = data as Record<string, any>;
    if (Array.isArray(obj.rows)) {
      rows = obj.rows;
    } else {
      // Just a single object
      rows = [obj];
    }
  }

  if (rows.length === 0) {
    return "┌──────────────────┐\n│ No results found │\n└──────────────────┘";
  }

  // Get all unique keys in order of appearance
  const keys: string[] = [];
  for (const r of rows) {
    for (const k of Object.keys(r)) {
      if (!keys.includes(k) && k !== "posted_date_raw") {
        keys.push(k);
      }
    }
  }

  if (keys.length === 0) {
    return "No columns to display.";
  }

  // Determine alignments. A column is right-aligned only when every populated
  // cell is a number, so a stray null or text-leading row can't left-align an
  // otherwise-numeric column (or vice versa). Empty/all-null columns stay left.
  const alignments: Record<string, "left" | "right"> = {};
  for (const k of keys) {
    let sawValue = false;
    let allNumeric = true;
    for (const r of rows) {
      const val = r[k];
      if (val === null || val === undefined) continue;
      sawValue = true;
      if (typeof val !== "number") {
        allNumeric = false;
        break;
      }
    }
    alignments[k] = sawValue && allNumeric ? "right" : "left";
  }

  // Map header labels and calculate column widths
  const headers = keys.map(formatHeader);
  const colWidths: Record<string, number> = {};

  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const h = headers[i];
    let maxWidth = h.length;

    for (const r of rows) {
      const cellStr = formatCell(r[k]);
      if (cellStr.length > maxWidth) {
        maxWidth = cellStr.length;
      }
    }
    colWidths[k] = maxWidth;
  }

  // Define Unicode box characters for high-aesthetic border (single line light)
  const border = {
    topL: "┌",
    topR: "┐",
    bottomL: "└",
    bottomR: "┘",
    midL: "├",
    midR: "┤",
    cross: "┼",
    topT: "┬",
    bottomT: "┴",
    horiz: "─",
    vert: "│",
  };

  const lines: string[] = [];

  // 1. Top border
  let topBorder = border.topL;
  for (let i = 0; i < keys.length; i++) {
    topBorder += border.horiz.repeat(colWidths[keys[i]] + 2);
    if (i < keys.length - 1) topBorder += border.topT;
  }
  topBorder += border.topR;
  lines.push(topBorder);

  // 2. Header row
  let headerRow = border.vert;
  for (let i = 0; i < keys.length; i++) {
    const k = keys[i];
    const h = headers[i];
    const width = colWidths[k];
    const padding = width - h.length;
    // Headers are always center/left aligned for aesthetic
    headerRow += " " + h + " ".repeat(padding) + " " + border.vert;
  }
  lines.push(headerRow);

  // 3. Middle divider
  let midDivider = border.midL;
  for (let i = 0; i < keys.length; i++) {
    midDivider += border.horiz.repeat(colWidths[keys[i]] + 2);
    if (i < keys.length - 1) midDivider += border.cross;
  }
  midDivider += border.midR;
  lines.push(midDivider);

  // 4. Data rows
  for (const r of rows) {
    let dataRow = border.vert;
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const valStr = formatCell(r[k]);
      const width = colWidths[k];
      const padding = width - valStr.length;

      if (alignments[k] === "right") {
        dataRow += " " + " ".repeat(padding) + valStr + " " + border.vert;
      } else {
        dataRow += " " + valStr + " ".repeat(padding) + " " + border.vert;
      }
    }
    lines.push(dataRow);
  }

  // 5. Bottom border
  let bottomBorder = border.bottomL;
  for (let i = 0; i < keys.length; i++) {
    bottomBorder += border.horiz.repeat(colWidths[keys[i]] + 2);
    if (i < keys.length - 1) bottomBorder += border.bottomT;
  }
  bottomBorder += border.bottomR;
  lines.push(bottomBorder);

  return lines.join("\n");
}
