/**
 * Phase 16 Task 18 — clipboard serialization for the sheet editor.
 *
 * Excel and Google Sheets both move cells via tab-separated values
 * (TSV) on the system clipboard. Producing and consuming TSV here
 * gives us interop with both apps for free.
 *
 * TSV grammar (Excel-compatible):
 *   - Rows separated by `\n`
 *   - Cells in a row separated by `\t`
 *   - Cells containing `\n`, `\t`, or `"` are wrapped in double
 *     quotes; embedded `"` are doubled (RFC 4180)
 */

import type { SheetTab } from "./sheetEditorTypes";
import type { Selection } from "./sheetSelection";
import { normalizeRange } from "./sheetSelection";
import { updateCellsInRows, type CellEdit } from "./sheetEditorHelpers";

/**
 * Serialise the primary range of `selection` as TSV. Extras
 * (Ctrl+click disjoint cells) are ignored — Excel/Sheets only
 * copy the primary contiguous selection.
 *
 * Empty primary (somehow) returns the empty string.
 */
export function selectionToTSV(
  rows: string[][],
  selection: Selection,
): string {
  const { r1, c1, r2, c2 } = normalizeRange(selection.primary);
  const out: string[] = [];
  for (let r = r1; r <= r2; r++) {
    const cells: string[] = [];
    for (let c = c1; c <= c2; c++) {
      const raw = rows[r]?.[c] ?? "";
      cells.push(escapeTsvCell(raw));
    }
    out.push(cells.join("\t"));
  }
  return out.join("\n");
}

function escapeTsvCell(value: string): string {
  if (
    value.includes("\t") ||
    value.includes("\n") ||
    value.includes('"')
  ) {
    return '"' + value.replace(/"/g, '""') + '"';
  }
  return value;
}

/**
 * Parse a TSV blob into a row-major 2D string grid. Handles
 * quoted fields with embedded `\t`, `\n`, and `""`. Trailing
 * blank lines are stripped (Excel adds one when copying).
 */
export function parseTSV(text: string): string[][] {
  const rows: string[][] = [];
  let i = 0;
  while (i < text.length) {
    const row: string[] = [];
    while (i < text.length) {
      if (text[i] === '"') {
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
        let field = "";
        while (
          i < text.length &&
          text[i] !== "\t" &&
          text[i] !== "\n" &&
          text[i] !== "\r"
        ) {
          field += text[i];
          i++;
        }
        row.push(field);
      }
      if (i < text.length && text[i] === "\t") {
        i++;
      } else {
        break;
      }
    }
    rows.push(row);
    if (text[i] === "\r") i++;
    if (text[i] === "\n") i++;
  }
  while (rows.length > 0 && rows[rows.length - 1].every((c) => c === "")) {
    rows.pop();
  }
  return rows;
}

/**
 * Paste a TSV blob into `sheet` starting at `(anchorRow,
 * anchorCol)`. Grows the grid (rows + columns) as needed so the
 * paste isn't clipped. Returns a NEW SheetTab — never mutates
 * the input.
 *
 * `widenColumns=true` extends `sheet.columns` to cover the paste
 * footprint (filling in with default Excel-style labels). The
 * caller is responsible for invoking the column-label helper on
 * the host component side.
 */
export function applyTSVAt(
  sheet: SheetTab,
  anchorRow: number,
  anchorCol: number,
  tsv: string[][],
  options: { columnLabelFor?: (i: number) => string } = {},
): SheetTab {
  if (tsv.length === 0) return sheet;
  const neededCols =
    anchorCol + Math.max(...tsv.map((r) => r.length), 0);
  // Widen the column header array if the paste extends past the
  // current right edge. Default labels match the Excel-style A..Z,
  // AA, AB... sequence the renderer also uses for unlabelled cols.
  const columns =
    neededCols > sheet.columns.length ? [...sheet.columns] : sheet.columns;
  if (columns !== sheet.columns) {
    while (columns.length < neededCols) {
      columns.push(
        options.columnLabelFor
          ? options.columnLabelFor(columns.length)
          : String(columns.length + 1),
      );
    }
  }
  // Build the paste edit batch — one entry per cell in `tsv`. The
  // edits collectively touch rows `[anchorRow, anchorRow + tsv.length)`
  // only; rows outside that range will keep their reference identity
  // when handed to `updateCellsInRows`, which preserves the
  // `incrementalRecalc` row-skip optimisation also relied on by
  // `updateCell` / Delete / fill-series.
  const edits: CellEdit[] = [];
  for (let r = 0; r < tsv.length; r++) {
    const srcRow = tsv[r];
    for (let c = 0; c < srcRow.length; c++) {
      edits.push({
        row: anchorRow + r,
        col: anchorCol + c,
        value: srcRow[c],
      });
    }
  }
  // `updateCellsInRows` clones only the rows that hold an edit and
  // auto-extends rows past the current end, so the row-count growth
  // (`anchorRow + tsv.length` past `sheet.rows.length`) is handled
  // there with `new Array(columnCount).fill("")` — matching the
  // pre-refactor behaviour. We pass `columns.length` (post-widening)
  // so any newly-pushed rows match the widened column count.
  const rows = updateCellsInRows(sheet.rows, columns.length, edits);
  return { ...sheet, columns, rows };
}
