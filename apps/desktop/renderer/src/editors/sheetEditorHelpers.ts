/**
 * Pure parsers / formula evaluator for `SheetEditor`. Extracted out
 * of the component file so React Fast Refresh can preserve editor
 * state across HMR edits. `import type` is used to break the
 * runtime cycle with the component file (the `SheetContent` type
 * is erased at compile time, so the cycle exists only at the type
 * level).
 */
import type { SheetContent } from "./SheetEditor";

/** Parse CSV text respecting RFC 4180 quoted fields (handles commas inside quotes). */
export function parseCSVLines(text: string): string[][] {
  const rows: string[][] = [];
  let i = 0;
  while (i < text.length) {
    const row: string[] = [];
    while (i < text.length) {
      if (text[i] === '"') {
        // Quoted field
        i++;
        let field = "";
        while (i < text.length) {
          if (text[i] === '"') {
            if (i + 1 < text.length && text[i + 1] === '"') {
              field += '"';
              i += 2;
            } else {
              i++;
              break;
            }
          } else {
            field += text[i];
            i++;
          }
        }
        row.push(field);
      } else {
        // Unquoted field
        let field = "";
        while (
          i < text.length &&
          text[i] !== "," &&
          text[i] !== "\n" &&
          text[i] !== "\r"
        ) {
          field += text[i];
          i++;
        }
        row.push(field);
      }
      if (i < text.length && text[i] === ",") {
        i++;
      } else {
        break;
      }
    }
    // Skip line ending
    if (i < text.length && text[i] === "\r") i++;
    if (i < text.length && text[i] === "\n") i++;
    rows.push(row);
  }
  return rows;
}

/**
 * Decode the artifact's serialized JSON body into the in-memory
 * SheetContent shape the editor mounts. Falls back to a 3×3
 * default grid if the body is empty or malformed JSON.
 *
 * Exported so unit tests can pin this independently of the
 * SheetEditor's render pipeline (full component renders pull in
 * the IPC bridge and a chain of focus / clipboard side effects).
 */
export function parseSheetContent(content: string): SheetContent {
  if (!content) {
    return {
      columns: ["A", "B", "C"],
      rows: [
        ["", "", ""],
        ["", "", ""],
        ["", "", ""],
      ],
    };
  }
  try {
    const parsed = JSON.parse(content) as SheetContent;
    if (parsed.columns && Array.isArray(parsed.columns)) {
      return parsed;
    }
  } catch {
    // Not JSON
  }
  return {
    columns: ["A", "B", "C"],
    rows: [
      ["", "", ""],
      ["", "", ""],
      ["", "", ""],
    ],
  };
}

/**
 * Evaluate a single-cell formula expression against the supplied
 * sheet state and return the computed value. Supports SUM /
 * AVERAGE / COUNT / MIN / MAX over an A1-style cell range. Returns
 * the sentinel string `#ERR` for malformed formulas and `#REF`
 * for ranges that resolve to out-of-bounds cells.
 *
 * Exported for unit-test coverage of the parser / evaluator,
 * separate from the SheetEditor render pipeline.
 */
export function evaluateFormula(
  formula: string,
  sheet: SheetContent,
): string | number {
  const expr = formula.slice(1).trim().toUpperCase();

  const rangeMatch = expr.match(
    /^(SUM|AVERAGE|COUNT|MIN|MAX)\(([A-Z]+\d+):([A-Z]+\d+)\)$/,
  );
  if (!rangeMatch) return "#ERR";

  const [, func, startRef, endRef] = rangeMatch;
  const startCell = parseCellRef(startRef);
  const endCell = parseCellRef(endRef);
  if (!startCell || !endCell) return "#REF";

  const values: number[] = [];
  for (let r = startCell.row; r <= endCell.row; r++) {
    for (let c = startCell.col; c <= endCell.col; c++) {
      const raw = sheet.rows[r]?.[c] ?? "";
      const num = parseFloat(raw);
      if (!isNaN(num)) values.push(num);
    }
  }

  if (values.length === 0) return 0;

  switch (func) {
    case "SUM":
      return values.reduce((a, b) => a + b, 0);
    case "AVERAGE":
      return values.reduce((a, b) => a + b, 0) / values.length;
    case "COUNT":
      return values.length;
    case "MIN":
      return Math.min(...values);
    case "MAX":
      return Math.max(...values);
    default:
      return "#ERR";
  }
}

/**
 * Parse an A1-style cell reference (e.g. `A1`, `AA1`, `AZ100`)
 * into a zero-based `{ row, col }` pair, or return `null` if the
 * input doesn't match the `^[A-Z]+\d+$` shape.
 *
 * Exported for unit-test coverage; this is the canonical place
 * cell references are decoded inside the sheet editor.
 */
export function parseCellRef(
  ref: string,
): { row: number; col: number } | null {
  const match = ref.match(/^([A-Z]+)(\d+)$/);
  if (!match) return null;
  const col =
    match[1].split("").reduce((acc, c) => acc * 26 + c.charCodeAt(0) - 64, 0) -
    1;
  const row = parseInt(match[2], 10) - 1;
  return { row, col };
}
