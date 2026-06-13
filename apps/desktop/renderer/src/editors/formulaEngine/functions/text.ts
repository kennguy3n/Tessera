/**
 * text functions.
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
 *                       feature flag).
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
} from "../types";
import { formatValueWithPattern } from "../format";

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
  // Delegate to the shared pattern engine used by the cell-format
  // renderer in `../format.ts`. Keeping a single implementation
  // guarantees that `=TEXT(A1, "hh:mm:ss")` and a cell with
  // `numberFormat: "hh:mm:ss"` render identically — in particular,
  // the `mm`-after-`hh` minutes disambiguation and AM/PM tokens
  // live in exactly one place.
  return formatValueWithPattern(v, fmt);
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

const PROPER: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "PROPER expects 1 argument");
  const s = singleString(args[0], ctx);
  if (isFormulaError(s)) return s;
  // Capitalise the first letter of every run of letters; everything
  // after a non-letter restarts a word, matching Excel.
  return s.replace(/[A-Za-z\u00C0-\u024F]+/g, (word) =>
    word.charAt(0).toUpperCase() + word.slice(1).toLowerCase(),
  );
};

const REPT: FunctionImpl = (args, ctx) => {
  if (args.length !== 2) return makeError("#ERR!", "REPT expects 2 arguments");
  const s = singleString(args[0], ctx);
  if (isFormulaError(s)) return s;
  const nV = singleNumber(args[1], ctx);
  if (isFormulaError(nV)) return nV;
  const n = Math.trunc(nV);
  if (n < 0) return makeError("#VALUE!", "REPT count must be non-negative");
  // Cap the output to Excel's 32767-character cell limit so a runaway
  // count can't blow up memory.
  if (s.length * n > 32767) {
    return makeError("#VALUE!", "REPT result exceeds 32767 characters");
  }
  return s.repeat(n);
};

const REPLACE: FunctionImpl = (args, ctx) => {
  if (args.length !== 4) return makeError("#ERR!", "REPLACE expects 4 arguments");
  const s = singleString(args[0], ctx);
  if (isFormulaError(s)) return s;
  const startN = singleNumber(args[1], ctx);
  if (isFormulaError(startN)) return startN;
  const lenN = singleNumber(args[2], ctx);
  if (isFormulaError(lenN)) return lenN;
  const repl = singleString(args[3], ctx);
  if (isFormulaError(repl)) return repl;
  const start = Math.trunc(startN);
  const len = Math.trunc(lenN);
  if (start < 1) return makeError("#VALUE!", "REPLACE start must be >= 1");
  if (len < 0) return makeError("#VALUE!", "REPLACE length must be non-negative");
  const i = start - 1;
  return s.slice(0, i) + repl + s.slice(i + len);
};

const EXACT: FunctionImpl = (args, ctx) => {
  if (args.length !== 2) return makeError("#ERR!", "EXACT expects 2 arguments");
  const a = singleString(args[0], ctx);
  if (isFormulaError(a)) return a;
  const b = singleString(args[1], ctx);
  if (isFormulaError(b)) return b;
  return a === b;
};

const CHAR: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "CHAR expects 1 argument");
  const nV = singleNumber(args[0], ctx);
  if (isFormulaError(nV)) return nV;
  const code = Math.trunc(nV);
  if (code < 1 || code > 0x10ffff) {
    return makeError("#VALUE!", "CHAR code out of range");
  }
  return String.fromCodePoint(code);
};

const CODE: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "CODE expects 1 argument");
  const s = singleString(args[0], ctx);
  if (isFormulaError(s)) return s;
  if (s.length === 0) return makeError("#VALUE!", "CODE: empty string");
  return s.codePointAt(0) ?? makeError("#VALUE!", "CODE: empty string");
};

const CLEAN: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "CLEAN expects 1 argument");
  const s = singleString(args[0], ctx);
  if (isFormulaError(s)) return s;
  // Strip the non-printable ASCII control characters (0x00–0x1F), as
  // Excel's CLEAN does.
  // eslint-disable-next-line no-control-regex
  return s.replace(/[\x00-\x1f]/g, "");
};

const T: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "T expects 1 argument");
  const v = evaluate(args[0], ctx);
  if (isFormulaError(v)) return v;
  // T returns its argument if it is text, otherwise an empty string.
  return typeof v === "string" ? v : "";
};

const TEXTJOIN: FunctionImpl = (args, ctx) => {
  if (args.length < 3) {
    return makeError("#ERR!", "TEXTJOIN expects a delimiter, an ignore-empty flag, and at least one value");
  }
  const delim = singleString(args[0], ctx);
  if (isFormulaError(delim)) return delim;
  const ignoreV = evaluate(args[1], ctx);
  if (isFormulaError(ignoreV)) return ignoreV;
  const ignoreEmpty = toBooleanLoose(ignoreV);
  const parts: string[] = [];
  for (let i = 2; i < args.length; i++) {
    for (const v of collectValues(args[i], ctx)) {
      if (isFormulaError(v)) return v;
      if (v === null || v === "") {
        if (!ignoreEmpty) parts.push("");
        continue;
      }
      parts.push(typeof v === "string" ? v : coerceToString(v));
    }
  }
  return parts.join(delim);
};

const JOIN: FunctionImpl = (args, ctx) => {
  // Google Sheets JOIN(delimiter, value_or_array, ...) — like TEXTJOIN
  // but never skips empties.
  if (args.length < 2) {
    return makeError("#ERR!", "JOIN expects a delimiter and at least one value");
  }
  const delim = singleString(args[0], ctx);
  if (isFormulaError(delim)) return delim;
  const parts: string[] = [];
  for (let i = 1; i < args.length; i++) {
    for (const v of collectValues(args[i], ctx)) {
      if (isFormulaError(v)) return v;
      if (v === null) {
        parts.push("");
        continue;
      }
      parts.push(typeof v === "string" ? v : coerceToString(v));
    }
  }
  return parts.join(delim);
};

/** Compile a user regex, returning a `#VALUE!` error on a malformed pattern. */
function compileUserRegex(
  pattern: string,
  flags: string,
): RegExp | FormulaError {
  try {
    return new RegExp(pattern, flags);
  } catch {
    return makeError("#VALUE!", `invalid regular expression: ${pattern}`);
  }
}

const REGEXMATCH: FunctionImpl = (args, ctx) => {
  if (args.length !== 2) return makeError("#ERR!", "REGEXMATCH expects 2 arguments");
  const s = singleString(args[0], ctx);
  if (isFormulaError(s)) return s;
  const pat = singleString(args[1], ctx);
  if (isFormulaError(pat)) return pat;
  const re = compileUserRegex(pat, "");
  if (isFormulaError(re)) return re;
  return re.test(s);
};

const REGEXEXTRACT: FunctionImpl = (args, ctx) => {
  if (args.length !== 2) return makeError("#ERR!", "REGEXEXTRACT expects 2 arguments");
  const s = singleString(args[0], ctx);
  if (isFormulaError(s)) return s;
  const pat = singleString(args[1], ctx);
  if (isFormulaError(pat)) return pat;
  const re = compileUserRegex(pat, "");
  if (isFormulaError(re)) return re;
  const m = re.exec(s);
  if (!m) return makeError("#N/A", "REGEXEXTRACT: no match");
  // Return the first capture group if present, else the whole match —
  // mirroring Google Sheets.
  return m[1] !== undefined ? m[1] : m[0];
};

const REGEXREPLACE: FunctionImpl = (args, ctx) => {
  if (args.length !== 3) return makeError("#ERR!", "REGEXREPLACE expects 3 arguments");
  const s = singleString(args[0], ctx);
  if (isFormulaError(s)) return s;
  const pat = singleString(args[1], ctx);
  if (isFormulaError(pat)) return pat;
  const repl = singleString(args[2], ctx);
  if (isFormulaError(repl)) return repl;
  const re = compileUserRegex(pat, "g");
  if (isFormulaError(re)) return re;
  return s.replace(re, repl);
};

/** Loose boolean coercion for the TEXTJOIN ignore-empty flag. */
function toBooleanLoose(v: ReturnType<typeof evaluate>): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") return v.toUpperCase() === "TRUE";
  return false;
}

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
  PROPER,
  REPT,
  REPLACE,
  EXACT,
  CHAR,
  CODE,
  CLEAN,
  T,
  TEXTJOIN,
  JOIN,
  REGEXMATCH,
  REGEXEXTRACT,
  REGEXREPLACE,
  SUBSTITUTE,
  FIND,
  SEARCH,
  TEXT,
  VALUE,
};
