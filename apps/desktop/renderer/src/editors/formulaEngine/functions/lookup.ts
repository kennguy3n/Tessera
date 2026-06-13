/**
 * lookup functions.
 *
 *   VLOOKUP(search_key, range, column_index, [is_sorted])
 *     Vertical lookup. `is_sorted` defaults to TRUE (Excel default —
 *     binary-search the first column for the largest value ≤ key).
 *     With `FALSE`, scan linearly for an exact match.
 *   HLOOKUP(search_key, range, row_index, [is_sorted])
 *     Horizontal counterpart.
 *   INDEX(range, row, [col])
 *     Return the cell at (row, col) in `range`, 1-based. If `range`
 *     is 1-D, the second arg is the only index. `0` is allowed
 *     (Excel returns the full row/column array — Tessera collapses
 *     to the first cell of that slice, matching how scalar contexts
 *     handle arrays).
 *   MATCH(search_key, range, [match_type])
 *     `match_type` = 1 (default): largest ≤ key, assumes ascending.
 *                  = 0: exact match.
 *                  = -1: smallest ≥ key, assumes descending.
 *   XLOOKUP(search_key, lookup_range, return_range, [not_found],
 *           [match_mode], [search_mode])
 *     `match_mode` 0 = exact (default), 1 = exact / next-larger,
 *                  -1 = exact / next-smaller, 2 = wildcards.
 *     `search_mode` 1 = first (default), -1 = last,
 *                   2 = binary-search ascending, -2 = binary-search
 *                   descending.
 *
 * All lookup functions return `#N/A` when no match is found and no
 * `not_found` is supplied (for XLOOKUP).
 */
import type { AstNode } from "../parser";
import {
  collectValues,
  evaluate,
  toNumber,
  toString as coerceToString,
  type EvaluationContext,
  type FunctionImpl,
} from "../evaluator";
import {
  isFormulaError,
  makeError,
  type FormulaError,
  type FormulaValue,
} from "../types";

/** Materialise a range AST node into a `rows × cols` matrix of values. */
function rangeToMatrix(
  arg: AstNode,
  ctx: EvaluationContext,
): FormulaValue[][] | FormulaError {
  if (arg.type !== "range") {
    const v = evaluate(arg, ctx);
    if (isFormulaError(v)) return v;
    return [[v]];
  }
  const rows = arg.end.row - arg.start.row + 1;
  const cols = arg.end.col - arg.start.col + 1;
  const matrix: FormulaValue[][] = [];
  let r = 0;
  let c = 0;
  let row: FormulaValue[] = [];
  for (const v of collectValues(arg, ctx)) {
    row.push(v);
    c++;
    if (c === cols) {
      matrix.push(row);
      row = [];
      c = 0;
      r++;
    }
  }
  void r;
  if (matrix.length !== rows) {
    return makeError("#ERR!", "internal: range materialisation shape mismatch");
  }
  return matrix;
}

/**
 * Excel-style "matchable" equality used by lookups. Numbers compare
 * numerically (with string-to-number coercion); strings compare
 * case-insensitively. Errors never match (silently — the caller
 * decides whether to return `#N/A`).
 */
function looksEqual(a: FormulaValue, b: FormulaValue): boolean {
  if (isFormulaError(a) || isFormulaError(b)) return false;
  if (a === null) a = "";
  if (b === null) b = "";
  if (typeof a === "number" && typeof b === "string") {
    const n = Number(b);
    if (Number.isFinite(n)) return a === n;
    return false;
  }
  if (typeof b === "number" && typeof a === "string") {
    const n = Number(a);
    if (Number.isFinite(n)) return b === n;
    return false;
  }
  if (typeof a === "string" && typeof b === "string") {
    return a.toLowerCase() === b.toLowerCase();
  }
  return a === b;
}

/**
 * Compare two `FormulaValue`s as an ordered key per Excel: numbers
 * numerically, strings case-insensitively, booleans `FALSE < TRUE`,
 * blanks treated as `0`. Errors are unorderable and return
 * `undefined`; lookup callers translate that to `#N/A`.
 */
function lookupCompare(a: FormulaValue, b: FormulaValue): number | undefined {
  if (isFormulaError(a) || isFormulaError(b)) return undefined;
  if (a === null) a = 0;
  if (b === null) b = 0;
  if (typeof a === "number" && typeof b === "number") return Math.sign(a - b);
  if (typeof a === "string" && typeof b === "string") {
    const la = a.toLowerCase();
    const lb = b.toLowerCase();
    if (la < lb) return -1;
    if (la > lb) return 1;
    return 0;
  }
  if (typeof a === "boolean" && typeof b === "boolean") {
    return Math.sign((a ? 1 : 0) - (b ? 1 : 0));
  }
  // Numeric vs. string — try number coercion both ways.
  if (typeof a === "number" && typeof b === "string") {
    const n = Number(b);
    if (Number.isFinite(n)) return Math.sign(a - n);
    return -1;
  }
  if (typeof a === "string" && typeof b === "number") {
    const n = Number(a);
    if (Number.isFinite(n)) return Math.sign(n - b);
    return 1;
  }
  return undefined;
}

/** Compile an XLOOKUP `match_mode = 2` wildcard pattern into a predicate. */
function compileWildcard(pattern: string): (s: string) => boolean {
  let body = "^";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "~" && i + 1 < pattern.length) {
      const next = pattern[i + 1];
      if (next === "*" || next === "?" || next === "~") {
        body += next.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
        i++;
        continue;
      }
    }
    if (ch === "*") {
      body += ".*";
      continue;
    }
    if (ch === "?") {
      body += ".";
      continue;
    }
    body += ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  }
  body += "$";
  const re = new RegExp(body, "is");
  return (s) => re.test(s);
}

const VLOOKUP: FunctionImpl = (args, ctx) => {
  if (args.length < 3 || args.length > 4) {
    return makeError("#ERR!", "VLOOKUP expects 3 or 4 arguments");
  }
  const key = evaluate(args[0], ctx);
  if (isFormulaError(key)) return key;
  const table = rangeToMatrix(args[1], ctx);
  if (isFormulaError(table)) return table;
  const colIdxN = toNumber(evaluate(args[2], ctx));
  if (isFormulaError(colIdxN)) return colIdxN;
  const colIdx = Math.trunc(colIdxN);
  if (colIdx < 1) return makeError("#VALUE!", "VLOOKUP column index must be >= 1");
  let isSorted = true;
  if (args.length === 4) {
    const sV = evaluate(args[3], ctx);
    if (isFormulaError(sV)) return sV;
    if (typeof sV === "boolean") isSorted = sV;
    else if (typeof sV === "number") isSorted = sV !== 0;
    else isSorted = true;
  }
  if (table.length === 0 || colIdx > table[0].length) {
    return makeError("#REF!", "VLOOKUP column out of range");
  }
  const colArr = table.map((r) => r[0]);
  let foundIndex = -1;
  if (!isSorted) {
    for (let i = 0; i < colArr.length; i++) {
      if (looksEqual(key, colArr[i])) {
        foundIndex = i;
        break;
      }
    }
  } else {
    foundIndex = binarySearchLargestLE(colArr, key);
  }
  if (foundIndex < 0) return makeError("#N/A", "VLOOKUP: no match");
  return table[foundIndex][colIdx - 1];
};

const HLOOKUP: FunctionImpl = (args, ctx) => {
  if (args.length < 3 || args.length > 4) {
    return makeError("#ERR!", "HLOOKUP expects 3 or 4 arguments");
  }
  const key = evaluate(args[0], ctx);
  if (isFormulaError(key)) return key;
  const table = rangeToMatrix(args[1], ctx);
  if (isFormulaError(table)) return table;
  const rowIdxN = toNumber(evaluate(args[2], ctx));
  if (isFormulaError(rowIdxN)) return rowIdxN;
  const rowIdx = Math.trunc(rowIdxN);
  if (rowIdx < 1) return makeError("#VALUE!", "HLOOKUP row index must be >= 1");
  let isSorted = true;
  if (args.length === 4) {
    const sV = evaluate(args[3], ctx);
    if (isFormulaError(sV)) return sV;
    if (typeof sV === "boolean") isSorted = sV;
    else if (typeof sV === "number") isSorted = sV !== 0;
    else isSorted = true;
  }
  if (table.length === 0 || rowIdx > table.length) {
    return makeError("#REF!", "HLOOKUP row out of range");
  }
  const rowArr = table[0];
  let foundIndex = -1;
  if (!isSorted) {
    for (let i = 0; i < rowArr.length; i++) {
      if (looksEqual(key, rowArr[i])) {
        foundIndex = i;
        break;
      }
    }
  } else {
    foundIndex = binarySearchLargestLE(rowArr, key);
  }
  if (foundIndex < 0) return makeError("#N/A", "HLOOKUP: no match");
  return table[rowIdx - 1][foundIndex];
};

const INDEX: FunctionImpl = (args, ctx) => {
  if (args.length < 2 || args.length > 3) {
    return makeError("#ERR!", "INDEX expects 2 or 3 arguments");
  }
  const table = rangeToMatrix(args[0], ctx);
  if (isFormulaError(table)) return table;
  const rowN = toNumber(evaluate(args[1], ctx));
  if (isFormulaError(rowN)) return rowN;
  const row = Math.trunc(rowN);
  const rows = table.length;
  const cols = rows > 0 ? table[0].length : 0;
  // 1-D special case: if the range is a single row OR single column,
  // the second arg picks the single dimension.
  if (args.length === 2) {
    if (rows === 1) {
      if (row < 1 || row > cols) return makeError("#REF!", "INDEX out of range");
      return table[0][row - 1];
    }
    if (cols === 1) {
      if (row < 1 || row > rows) return makeError("#REF!", "INDEX out of range");
      return table[row - 1][0];
    }
    return makeError("#REF!", "INDEX over 2-D range requires column arg");
  }
  const colN = toNumber(evaluate(args[2], ctx));
  if (isFormulaError(colN)) return colN;
  const col = Math.trunc(colN);
  if (row === 0 && col === 0) return table[0][0];
  if (row === 0) {
    if (col < 1 || col > cols) return makeError("#REF!", "INDEX out of range");
    // Whole-column slice — collapse to first cell in scalar context.
    return table[0][col - 1];
  }
  if (col === 0) {
    if (row < 1 || row > rows) return makeError("#REF!", "INDEX out of range");
    return table[row - 1][0];
  }
  if (row < 1 || row > rows || col < 1 || col > cols) {
    return makeError("#REF!", "INDEX out of range");
  }
  return table[row - 1][col - 1];
};

const MATCH: FunctionImpl = (args, ctx) => {
  if (args.length < 2 || args.length > 3) {
    return makeError("#ERR!", "MATCH expects 2 or 3 arguments");
  }
  const key = evaluate(args[0], ctx);
  if (isFormulaError(key)) return key;
  const table = rangeToMatrix(args[1], ctx);
  if (isFormulaError(table)) return table;
  // MATCH operates on a 1-D vector — collapse single-row or
  // single-column ranges. Reject 2-D ranges.
  let arr: FormulaValue[];
  if (table.length === 1) arr = table[0];
  else if (table[0]?.length === 1) arr = table.map((r) => r[0]);
  else return makeError("#N/A", "MATCH requires a 1-D range");
  let matchType = 1;
  if (args.length === 3) {
    const mN = toNumber(evaluate(args[2], ctx));
    if (isFormulaError(mN)) return mN;
    matchType = Math.sign(Math.trunc(mN));
  }
  if (matchType === 0) {
    for (let i = 0; i < arr.length; i++) {
      if (looksEqual(key, arr[i])) return i + 1;
    }
    return makeError("#N/A", "MATCH: no exact match");
  }
  if (matchType === 1) {
    // Ascending — largest value ≤ key.
    const idx = binarySearchLargestLE(arr, key);
    if (idx < 0) return makeError("#N/A", "MATCH: no value ≤ key");
    return idx + 1;
  }
  // matchType === -1 → descending — smallest value ≥ key.
  let last = -1;
  for (let i = 0; i < arr.length; i++) {
    const c = lookupCompare(arr[i], key);
    if (c === undefined) continue;
    if (c >= 0) last = i;
    else break;
  }
  if (last < 0) return makeError("#N/A", "MATCH: no value ≥ key");
  return last + 1;
};

const XLOOKUP: FunctionImpl = (args, ctx) => {
  if (args.length < 3 || args.length > 6) {
    return makeError("#ERR!", "XLOOKUP expects 3-6 arguments");
  }
  const key = evaluate(args[0], ctx);
  if (isFormulaError(key)) return key;
  const lookup = rangeToMatrix(args[1], ctx);
  if (isFormulaError(lookup)) return lookup;
  const returnTable = rangeToMatrix(args[2], ctx);
  if (isFormulaError(returnTable)) return returnTable;
  // Collapse lookup to 1-D.
  let lookupArr: FormulaValue[];
  let axis: "row" | "col";
  if (lookup.length === 1) {
    lookupArr = lookup[0];
    axis = "row";
  } else if (lookup[0]?.length === 1) {
    lookupArr = lookup.map((r) => r[0]);
    axis = "col";
  } else {
    return makeError("#VALUE!", "XLOOKUP lookup range must be 1-D");
  }
  let matchMode = 0;
  let searchMode = 1;
  if (args.length >= 5) {
    const m = toNumber(evaluate(args[4], ctx));
    if (isFormulaError(m)) return m;
    matchMode = Math.trunc(m);
  }
  if (args.length >= 6) {
    const s = toNumber(evaluate(args[5], ctx));
    if (isFormulaError(s)) return s;
    searchMode = Math.trunc(s);
  }
  // Locate match.
  const indices =
    searchMode === -1
      ? Array.from({ length: lookupArr.length }, (_, i) => lookupArr.length - 1 - i)
      : Array.from({ length: lookupArr.length }, (_, i) => i);
  let hit = -1;
  if (matchMode === 0) {
    for (const i of indices) {
      if (looksEqual(key, lookupArr[i])) {
        hit = i;
        break;
      }
    }
  } else if (matchMode === 2) {
    // Wildcards: pattern from `key` string, applied to lookup
    // values converted to strings.
    const pat = typeof key === "string" ? key : coerceToString(key);
    const test = compileWildcard(pat.toLowerCase());
    for (const i of indices) {
      const v = lookupArr[i];
      if (v === null) continue;
      const sv = (typeof v === "string" ? v : coerceToString(v)).toLowerCase();
      if (test(sv)) {
        hit = i;
        break;
      }
    }
  } else {
    // matchMode 1 (next larger) / -1 (next smaller).
    let bestExact = -1;
    let bestFallback = -1;
    for (const i of indices) {
      if (looksEqual(key, lookupArr[i])) {
        bestExact = i;
        break;
      }
      const c = lookupCompare(lookupArr[i], key);
      if (c === undefined) continue;
      if (matchMode === 1 && c > 0) {
        if (bestFallback === -1) {
          bestFallback = i;
        } else {
          const cur = lookupArr[bestFallback];
          const cmp = lookupCompare(lookupArr[i], cur);
          if (cmp !== undefined && cmp < 0) bestFallback = i;
        }
      } else if (matchMode === -1 && c < 0) {
        if (bestFallback === -1) {
          bestFallback = i;
        } else {
          const cur = lookupArr[bestFallback];
          const cmp = lookupCompare(lookupArr[i], cur);
          if (cmp !== undefined && cmp > 0) bestFallback = i;
        }
      }
    }
    hit = bestExact >= 0 ? bestExact : bestFallback;
  }
  if (hit < 0) {
    if (args.length >= 4) {
      const fb = evaluate(args[3], ctx);
      return fb;
    }
    return makeError("#N/A", "XLOOKUP: no match");
  }
  // Read aligned cell from return_range.
  if (axis === "row") {
    if (returnTable.length < 1 || hit >= returnTable[0].length) {
      return makeError("#REF!", "XLOOKUP return range too small");
    }
    return returnTable[0][hit];
  }
  if (returnTable.length <= hit) {
    return makeError("#REF!", "XLOOKUP return range too small");
  }
  return returnTable[hit][0];
};

/**
 * Excel-style sorted lookup: find the index of the largest value in
 * `arr` that is ≤ `key`. Assumes `arr` is sorted ascending. Returns
 * -1 if every value is greater than `key`.
 *
 * We use linear scan rather than binary search because lookup arrays
 * in a spreadsheet are short (typically <1000 rows) and a real
 * binary search has to handle blank cells / type-mismatched values
 * specially. The linear path matches Excel's documented behaviour
 * exactly with no edge cases.
 */
function binarySearchLargestLE(arr: FormulaValue[], key: FormulaValue): number {
  let best = -1;
  for (let i = 0; i < arr.length; i++) {
    const c = lookupCompare(arr[i], key);
    if (c === undefined) continue;
    if (c <= 0) best = i;
    else break;
  }
  return best;
}

const CHOOSE: FunctionImpl = (args, ctx) => {
  if (args.length < 2) {
    return makeError("#ERR!", "CHOOSE expects an index and at least one value");
  }
  const idxV = evaluate(args[0], ctx);
  if (isFormulaError(idxV)) return idxV;
  const idxN = toNumber(idxV);
  if (isFormulaError(idxN)) return idxN;
  const idx = Math.trunc(idxN);
  // CHOOSE is 1-based; args[0] is the selector, so option k is
  // args[k].
  if (idx < 1 || idx > args.length - 1) {
    return makeError("#VALUE!", "CHOOSE index out of range");
  }
  return evaluate(args[idx], ctx);
};

const ROWS: FunctionImpl = (args) => {
  if (args.length !== 1) return makeError("#ERR!", "ROWS expects 1 argument");
  const arg = args[0];
  if (arg.type === "range") return arg.end.row - arg.start.row + 1;
  if (arg.type === "cell") return 1;
  return makeError("#REF!", "ROWS expects a range or cell reference");
};

const COLUMNS: FunctionImpl = (args) => {
  if (args.length !== 1) return makeError("#ERR!", "COLUMNS expects 1 argument");
  const arg = args[0];
  if (arg.type === "range") return arg.end.col - arg.start.col + 1;
  if (arg.type === "cell") return 1;
  return makeError("#REF!", "COLUMNS expects a range or cell reference");
};

const ROW: FunctionImpl = (args) => {
  if (args.length !== 1) {
    // ROW() with no argument needs the host cell's coordinate, which
    // the pure engine does not carry. Callers that need "this row"
    // should pass an explicit reference.
    return makeError("#N/A", "ROW requires a cell or range reference");
  }
  const arg = args[0];
  if (arg.type === "cell") return arg.row + 1;
  if (arg.type === "range") return arg.start.row + 1;
  return makeError("#REF!", "ROW expects a range or cell reference");
};

const COLUMN: FunctionImpl = (args) => {
  if (args.length !== 1) {
    return makeError("#N/A", "COLUMN requires a cell or range reference");
  }
  const arg = args[0];
  if (arg.type === "cell") return arg.col + 1;
  if (arg.type === "range") return arg.start.col + 1;
  return makeError("#REF!", "COLUMN expects a range or cell reference");
};

/**
 * LOOKUP(search_key, search_range, [result_range]) — the "vector"
 * form. Scans `search_range` for the largest value ≤ `search_key`
 * (assumes ascending order, like Excel) and returns the corresponding
 * value from `result_range` (or from `search_range` itself when no
 * result range is supplied).
 */
const LOOKUP: FunctionImpl = (args, ctx) => {
  if (args.length < 2 || args.length > 3) {
    return makeError("#ERR!", "LOOKUP expects 2 or 3 arguments");
  }
  const key = evaluate(args[0], ctx);
  if (isFormulaError(key)) return key;
  const search: FormulaValue[] = [];
  for (const v of collectValues(args[1], ctx)) {
    if (isFormulaError(v)) return v;
    search.push(v);
  }
  let result = search;
  if (args.length === 3) {
    result = [];
    for (const v of collectValues(args[2], ctx)) {
      if (isFormulaError(v)) return v;
      result.push(v);
    }
  }
  const hit = binarySearchLargestLE(search, key);
  if (hit < 0 || hit >= result.length) {
    return makeError("#N/A", "LOOKUP: no value <= search key");
  }
  return result[hit];
};

export const LOOKUP_FUNCTIONS: Record<string, FunctionImpl> = {
  VLOOKUP,
  HLOOKUP,
  INDEX,
  MATCH,
  XLOOKUP,
  CHOOSE,
  ROWS,
  COLUMNS,
  ROW,
  COLUMN,
  LOOKUP,
};
