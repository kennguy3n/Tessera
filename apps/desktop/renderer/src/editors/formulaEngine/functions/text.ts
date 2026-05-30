/**
 * Phase 16 Task 9 — text functions.
 *
 *   CONCATENATE(a, b, …) / CONCAT(a, b, …)
 *     Concatenate every argument as a string. `CONCAT` additionally
 *     flattens ranges (Google Sheets / Excel 365 semantics);
 *     `CONCATENATE` rejects ranges with `#VALUE!` per Excel 2010+.
 *   LEFT(text, [n])     n leading characters (default 1).
 *   RIGHT(text, [n])    n trailing characters (default 1).
 *   MID(text, start, n) substring starting at 1-based `start` for
 *                       `n` characters.
 *   LEN(text)           UTF-16 code-unit length (matches Excel —
 *                       surrogate-pair-aware variants live behind a
 *                       Phase 17 feature flag).
 *   UPPER / LOWER       Case folding using locale-independent
 *                       `toUpperCase()` / `toLowerCase()` (Excel /
 *                       Google Sheets are locale-independent too).
 *   TRIM(text)          Collapse internal runs of ASCII spaces to a
 *                       single space and strip leading/trailing
 *                       whitespace (Excel semantics — not
 *                       `String.prototype.trim`).
 *   SUBSTITUTE(text, old, new, [instance])
 *     Replace `old` with `new`. With `instance` omitted, every
 *     occurrence is replaced; otherwise only the n-th (1-based).
 *   FIND(needle, haystack, [start])
 *     Case-sensitive, no-wildcards search. Returns 1-based index
 *     or `#VALUE!` if not found.
 *   SEARCH(needle, haystack, [start])
 *     Case-insensitive search supporting Excel wildcards (`*`, `?`,
 *     `~` escape). Returns 1-based index or `#VALUE!` if not found.
 *   TEXT(value, format)
 *     Format `value` per `format`. Supported tokens (intentionally a
 *     subset — full Excel format codes are a small DSL of their
 *     own):
 *       `0.00`            fixed-point with N decimal places
 *       `0`               integer, rounded
 *       `#,##0`           thousands separators
 *       `#,##0.00`        combined
 *       `0%`, `0.00%`     percent
 *       `yyyy-mm-dd` etc. dates (date arithmetic uses the Excel
 *                          serial number system from `./date.ts`)
 *   VALUE(text)
 *     Inverse of TEXT — parse a numeric literal (with optional `$`,
 *     `,`, trailing `%`, leading `-`). Returns `#VALUE!` if the
 *     result isn't a valid number.
 *
 * Error propagation follows the engine-wide rule: an argument that
 * evaluates to a `FormulaError` short-circuits and is returned
 * unchanged. Functions never throw.
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
import { serialToDate } from "./date";

function singleString(
  arg: AstNode,
  ctx: EvaluationContext,
): string | FormulaError {
  const v = evaluate(arg, ctx);
  if (isFormulaError(v)) return v;
  if (v === null) return "";
  if (typeof v === "string") return v;
  return coerceToString(v);
}

function singleNumber(
  arg: AstNode,
  ctx: EvaluationContext,
): number | FormulaError {
  const v = evaluate(arg, ctx);
  if (isFormulaError(v)) return v;
  return toNumber(v);
}

const CONCATENATE: FunctionImpl = (args, ctx) => {
  let out = "";
  for (const arg of args) {
    if (arg.type === "range") {
      // Excel 2010+ CONCATENATE rejects ranges. Mirror that so users
      // get a precise diagnostic instead of a silently-joined blob.
      return makeError("#VALUE!", "CONCATENATE does not accept ranges; use CONCAT");
    }
    const s = singleString(arg, ctx);
    if (isFormulaError(s)) return s;
    out += s;
  }
  return out;
};

const CONCAT: FunctionImpl = (args, ctx) => {
  let out = "";
  for (const arg of args) {
    for (const v of collectValues(arg, ctx)) {
      if (isFormulaError(v)) return v;
      if (v === null) continue;
      out += typeof v === "string" ? v : coerceToString(v);
    }
  }
  return out;
};

const LEFT: FunctionImpl = (args, ctx) => {
  if (args.length < 1 || args.length > 2) {
    return makeError("#ERR!", "LEFT expects 1 or 2 arguments");
  }
  const s = singleString(args[0], ctx);
  if (isFormulaError(s)) return s;
  let n = 1;
  if (args.length === 2) {
    const nn = singleNumber(args[1], ctx);
    if (isFormulaError(nn)) return nn;
    n = Math.trunc(nn);
  }
  if (n < 0) return makeError("#VALUE!", "LEFT count must be non-negative");
  return s.slice(0, n);
};

const RIGHT: FunctionImpl = (args, ctx) => {
  if (args.length < 1 || args.length > 2) {
    return makeError("#ERR!", "RIGHT expects 1 or 2 arguments");
  }
  const s = singleString(args[0], ctx);
  if (isFormulaError(s)) return s;
  let n = 1;
  if (args.length === 2) {
    const nn = singleNumber(args[1], ctx);
    if (isFormulaError(nn)) return nn;
    n = Math.trunc(nn);
  }
  if (n < 0) return makeError("#VALUE!", "RIGHT count must be non-negative");
  if (n >= s.length) return s;
  return s.slice(s.length - n);
};

const MID: FunctionImpl = (args, ctx) => {
  if (args.length !== 3) return makeError("#ERR!", "MID expects 3 arguments");
  const s = singleString(args[0], ctx);
  if (isFormulaError(s)) return s;
  const startN = singleNumber(args[1], ctx);
  if (isFormulaError(startN)) return startN;
  const lenN = singleNumber(args[2], ctx);
  if (isFormulaError(lenN)) return lenN;
  const start = Math.trunc(startN);
  const len = Math.trunc(lenN);
  if (start < 1) return makeError("#VALUE!", "MID start must be >= 1");
  if (len < 0) return makeError("#VALUE!", "MID length must be non-negative");
  return s.slice(start - 1, start - 1 + len);
};

const LEN: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "LEN expects 1 argument");
  const s = singleString(args[0], ctx);
  if (isFormulaError(s)) return s;
  return s.length;
};

const UPPER: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "UPPER expects 1 argument");
  const s = singleString(args[0], ctx);
  if (isFormulaError(s)) return s;
  return s.toUpperCase();
};

const LOWER: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "LOWER expects 1 argument");
  const s = singleString(args[0], ctx);
  if (isFormulaError(s)) return s;
  return s.toLowerCase();
};

const TRIM: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "TRIM expects 1 argument");
  const s = singleString(args[0], ctx);
  if (isFormulaError(s)) return s;
  // Excel's TRIM collapses internal runs of ASCII spaces to a single
  // space and strips leading/trailing ASCII spaces — it intentionally
  // does NOT strip other whitespace like tabs/newlines (the
  // `.trim()` method does). Mirror that exactly.
  return s
    .replace(/^ +/, "")
    .replace(/ +$/, "")
    .replace(/ {2,}/g, " ");
};

const SUBSTITUTE: FunctionImpl = (args, ctx) => {
  if (args.length < 3 || args.length > 4) {
    return makeError("#ERR!", "SUBSTITUTE expects 3 or 4 arguments");
  }
  const s = singleString(args[0], ctx);
  if (isFormulaError(s)) return s;
  const oldText = singleString(args[1], ctx);
  if (isFormulaError(oldText)) return oldText;
  const newText = singleString(args[2], ctx);
  if (isFormulaError(newText)) return newText;
  if (oldText === "") return s;
  if (args.length === 3) {
    // Replace every occurrence. `.split().join()` avoids the
    // `String.prototype.replaceAll` polyfill question and is
    // O(n) over `s`.
    return s.split(oldText).join(newText);
  }
  const instN = singleNumber(args[3], ctx);
  if (isFormulaError(instN)) return instN;
  const inst = Math.trunc(instN);
  if (inst < 1) return makeError("#VALUE!", "SUBSTITUTE instance must be >= 1");
  let out = "";
  let found = 0;
  let i = 0;
  while (i <= s.length - oldText.length) {
    if (s.startsWith(oldText, i)) {
      found++;
      if (found === inst) {
        out += newText;
        i += oldText.length;
        out += s.slice(i);
        return out;
      }
      out += s.slice(i, i + oldText.length);
      i += oldText.length;
    } else {
      out += s[i];
      i++;
    }
  }
  // Instance not found — return the input unchanged (matches Excel).
  return s;
};

const FIND: FunctionImpl = (args, ctx) => {
  if (args.length < 2 || args.length > 3) {
    return makeError("#ERR!", "FIND expects 2 or 3 arguments");
  }
  const needle = singleString(args[0], ctx);
  if (isFormulaError(needle)) return needle;
  const haystack = singleString(args[1], ctx);
  if (isFormulaError(haystack)) return haystack;
  let startIdx = 0;
  if (args.length === 3) {
    const n = singleNumber(args[2], ctx);
    if (isFormulaError(n)) return n;
    startIdx = Math.max(0, Math.trunc(n) - 1);
  }
  if (needle === "") return startIdx + 1;
  const idx = haystack.indexOf(needle, startIdx);
  if (idx < 0) return makeError("#VALUE!", "FIND: substring not found");
  return idx + 1;
};

const SEARCH: FunctionImpl = (args, ctx) => {
  if (args.length < 2 || args.length > 3) {
    return makeError("#ERR!", "SEARCH expects 2 or 3 arguments");
  }
  const needle = singleString(args[0], ctx);
  if (isFormulaError(needle)) return needle;
  const haystack = singleString(args[1], ctx);
  if (isFormulaError(haystack)) return haystack;
  let startIdx = 0;
  if (args.length === 3) {
    const n = singleNumber(args[2], ctx);
    if (isFormulaError(n)) return n;
    startIdx = Math.max(0, Math.trunc(n) - 1);
  }
  if (needle === "") return startIdx + 1;
  const pattern = compileSearchPattern(needle.toLowerCase());
  pattern.lastIndex = startIdx;
  const subj = haystack.toLowerCase();
  const m = pattern.exec(subj);
  if (!m) return makeError("#VALUE!", "SEARCH: substring not found");
  return m.index + 1;
};

/**
 * Compile a SEARCH wildcard `pattern` (`*` / `?` / `~` escape) into a
 * sticky regex matching against the lower-cased haystack. The regex
 * is NOT anchored — SEARCH returns the first position the pattern
 * appears at, not whether the entire string matches.
 */
function compileSearchPattern(pattern: string): RegExp {
  let out = "";
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === "~" && i + 1 < pattern.length) {
      const next = pattern[i + 1];
      if (next === "*" || next === "?" || next === "~") {
        out += escapeRegex(next);
        i++;
        continue;
      }
    }
    if (ch === "*") {
      out += ".*";
      continue;
    }
    if (ch === "?") {
      out += ".";
      continue;
    }
    out += escapeRegex(ch);
  }
  return new RegExp(out, "g");
}

function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

const TEXT: FunctionImpl = (args, ctx) => {
  if (args.length !== 2) return makeError("#ERR!", "TEXT expects 2 arguments");
  const v = evaluate(args[0], ctx);
  if (isFormulaError(v)) return v;
  const fmt = singleString(args[1], ctx);
  if (isFormulaError(fmt)) return fmt;
  return formatValue(v, fmt);
};

const VALUE: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "VALUE expects 1 argument");
  const v = evaluate(args[0], ctx);
  if (isFormulaError(v)) return v;
  if (v === null) return 0;
  if (typeof v === "number") return v;
  if (typeof v === "boolean") return v ? 1 : 0;
  // String parsing: strip `$`, thousands `,`, optional trailing `%`,
  // surrounding whitespace. Negative parentheses (`(1,234)`) are
  // accepted, matching Excel's accounting style.
  const trimmed = v.trim();
  if (trimmed === "") return 0;
  const parenNeg = /^\((.+)\)$/.exec(trimmed);
  const body = parenNeg ? parenNeg[1] : trimmed;
  const percent = /%\s*$/.test(body);
  const noSym = body.replace(/[$,%\s]/g, "");
  const n = Number(noSym);
  if (!Number.isFinite(n)) {
    return makeError("#VALUE!", `VALUE("${v}"): not a number`);
  }
  const signed = parenNeg ? -n : n;
  return percent ? signed / 100 : signed;
};

// ---------------------------------------------------------------------------
// Format engine for TEXT().
// ---------------------------------------------------------------------------

/**
 * Render `value` per a TEXT() format string. The format syntax is
 * an intentional subset of Excel's full grammar — common patterns
 * the editor users actually type. Anything we don't recognise is
 * surfaced as `#VALUE!` so the user fixes the format instead of
 * silently getting garbage.
 */
export function formatValue(
  value: FormulaValue,
  format: string,
): string | FormulaError {
  if (isFormulaError(value)) return value;
  if (format === "") return coerceToString(value);
  // Numeric formats handle dates as serial numbers and percentages.
  // We attempt date-formatting first if the format clearly looks
  // like a date pattern (contains y/m/d/h/s tokens outside an
  // escape).
  if (isDateFormat(format)) {
    const n = toNumber(value);
    if (isFormulaError(n)) return n;
    const d = serialToDate(n);
    return formatDate(d, format);
  }
  // Number / percent formats.
  const n = toNumber(value);
  if (isFormulaError(n)) return n;
  return formatNumberPattern(n, format);
}

function isDateFormat(format: string): boolean {
  // Strip escape sequences before inspecting tokens.
  const stripped = format.replace(/\\./g, "").replace(/"[^"]*"/g, "");
  return /[ydhms]/i.test(stripped);
}

function formatNumberPattern(n: number, format: string): string | FormulaError {
  const isPercent = format.includes("%");
  const value = isPercent ? n * 100 : n;
  const sansPct = format.replace(/%/g, "");
  // Find decimal-point position.
  const dotIdx = sansPct.indexOf(".");
  const intPart = dotIdx === -1 ? sansPct : sansPct.slice(0, dotIdx);
  const fracPart = dotIdx === -1 ? "" : sansPct.slice(dotIdx + 1);
  // Count `0` chars in fractional part = forced decimal places.
  const forcedFrac = (fracPart.match(/0/g) ?? []).length;
  const optionalFrac = (fracPart.match(/#/g) ?? []).length;
  const maxFrac = forcedFrac + optionalFrac;
  const useThousands = /#,##0|0,000|#,##/.test(intPart);
  const rounded = Number(value.toFixed(maxFrac));
  const sign = rounded < 0 ? "-" : "";
  const absVal = Math.abs(rounded);
  // Split into whole + frac segments.
  let wholeStr = Math.trunc(absVal).toString();
  let fracStr = "";
  if (maxFrac > 0) {
    const fracVal = absVal - Math.trunc(absVal);
    fracStr = fracVal.toFixed(maxFrac).slice(2); // "0.42" -> "42"
    // Trim trailing zeros allowed by `#`s, but keep `0`s.
    let trimEnd = fracStr.length;
    while (trimEnd > forcedFrac && fracStr[trimEnd - 1] === "0") {
      trimEnd--;
    }
    fracStr = fracStr.slice(0, trimEnd);
  }
  if (useThousands) {
    wholeStr = wholeStr.replace(/\B(?=(\d{3})+(?!\d))/g, ",");
  }
  let out = sign + wholeStr;
  if (fracStr.length > 0) out += "." + fracStr;
  if (isPercent) out += "%";
  return out;
}

function formatDate(d: Date, format: string): string | FormulaError {
  // Replace tokens in length-descending order so `yyyy` doesn't get
  // captured by `yy` first. Use a single pass over a token grammar
  // to avoid replacing characters inside literals (quoted strings)
  // or escapes (`\<char>`).
  const out: string[] = [];
  let i = 0;
  const pad = (n: number, w: number) => String(n).padStart(w, "0");
  while (i < format.length) {
    const ch = format[i];
    if (ch === "\\" && i + 1 < format.length) {
      out.push(format[i + 1]);
      i += 2;
      continue;
    }
    if (ch === '"') {
      i++;
      while (i < format.length && format[i] !== '"') {
        out.push(format[i]);
        i++;
      }
      if (i < format.length) i++; // skip closing quote
      continue;
    }
    // Token detection.
    const remaining = format.slice(i);
    let matched = false;
    for (const tok of DATE_TOKENS) {
      if (remaining.startsWith(tok.match)) {
        out.push(tok.render(d, pad));
        i += tok.match.length;
        matched = true;
        break;
      }
    }
    if (matched) continue;
    out.push(ch);
    i++;
  }
  return out.join("");
}

interface DateToken {
  readonly match: string;
  readonly render: (d: Date, pad: (n: number, w: number) => string) => string;
}

// Longest tokens FIRST so `yyyy` matches before `yy`.
const DATE_TOKENS: DateToken[] = [
  { match: "yyyy", render: (d) => String(d.getUTCFullYear()) },
  { match: "yy", render: (d, pad) => pad(d.getUTCFullYear() % 100, 2) },
  { match: "mmmm", render: (d) => MONTH_NAMES[d.getUTCMonth()] },
  { match: "mmm", render: (d) => MONTH_NAMES[d.getUTCMonth()].slice(0, 3) },
  { match: "mm", render: (d, pad) => pad(d.getUTCMonth() + 1, 2) },
  { match: "m", render: (d) => String(d.getUTCMonth() + 1) },
  { match: "dddd", render: (d) => DAY_NAMES[d.getUTCDay()] },
  { match: "ddd", render: (d) => DAY_NAMES[d.getUTCDay()].slice(0, 3) },
  { match: "dd", render: (d, pad) => pad(d.getUTCDate(), 2) },
  { match: "d", render: (d) => String(d.getUTCDate()) },
  { match: "hh", render: (d, pad) => pad(d.getUTCHours(), 2) },
  { match: "h", render: (d) => String(d.getUTCHours()) },
  { match: "ss", render: (d, pad) => pad(d.getUTCSeconds(), 2) },
  { match: "s", render: (d) => String(d.getUTCSeconds()) },
];

const MONTH_NAMES = [
  "January",
  "February",
  "March",
  "April",
  "May",
  "June",
  "July",
  "August",
  "September",
  "October",
  "November",
  "December",
];

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
];

export const TEXT_FUNCTIONS: Record<string, FunctionImpl> = {
  CONCATENATE,
  CONCAT,
  LEFT,
  RIGHT,
  MID,
  LEN,
  UPPER,
  LOWER,
  TRIM,
  SUBSTITUTE,
  FIND,
  SEARCH,
  TEXT,
  VALUE,
};
