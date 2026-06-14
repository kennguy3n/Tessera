/**
 * cell display formatting.
 *
 * Renders a `FormulaValue` into the string the grid shows, applying
 * a `CellFormat`'s `numberFormat` mini-language. Visual format bits
 * (alignment, bold, italic, color, background) are turned into a
 * `React.CSSProperties` payload via `cellFormatStyle()`.
 *
 * The number-format engine mirrors what the `TEXT()` function
 * exposes — `#,##0`, `0.00`, `0%`, `$#,##0.00`, `yyyy-mm-dd`, etc.
 * Date formats are detected by the presence of any `yyyy`/`yy`/`mm`/
 * `m`/`dd`/`d`/`hh`/`h`/`ss`/`s` token outside a quoted segment;
 * everything else is parsed as a numeric pattern.
 *
 * Keeping this in `formulaEngine/` rather than the renderer keeps
 * the format renderer testable in isolation (no React imports) and
 * lets the Base-editor formula field re-use the same code in Phase
 * 17 without dragging in a UI dependency.
 */
import type { CSSProperties } from "react";

import type { CellFormat } from "../sheetEditorTypes";
import { isFormulaError, makeError, type FormulaError, type FormulaValue } from "./types";
import { dateToSerial, serialToDate } from "./functions/date";

/** Format `value` as a string using `format` (or General if absent). */
export function applyCellFormat(
  value: FormulaValue,
  format: CellFormat | undefined,
): string {
  if (value === null) return "";
  if (isFormulaError(value)) return value.code;
  const pattern = format?.numberFormat;
  if (!pattern) return defaultRender(value);
  // Strings render through the shared pattern engine only when they
  // parse as a number (currency/percent on numeric strings, dates on
  // serial-shaped strings). If they don't parse, fall back to the
  // raw string — cell rendering is forgiving where TEXT() is strict.
  if (typeof value === "string") {
    const out = formatValueWithPattern(value, pattern);
    if (isFormulaError(out)) return value;
    return out;
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  // Number path — the same engine TEXT() uses.
  const out = formatValueWithPattern(value, pattern);
  return isFormulaError(out) ? out.code : out;
}

/**
 * TEXT()-grade renderer: apply an Excel-style format pattern to any
 * `FormulaValue`. Exported so `text.ts:TEXT()` doesn't have to ship
 * a parallel implementation — a single source of truth for date
 * disambiguation (`mm` after `hh` = minutes), AM/PM, currency,
 * percent, thousands separators, etc.
 *
 * Supports the full Excel section grammar: up to four `;`-separated
 * sections `positive;negative;zero;text`. With one section, negatives
 * get a leading minus (back-compat). With a dedicated negative section
 * the magnitude is formatted and the section supplies its own sign
 * (e.g. `#,##0;(#,##0)` → `(1234)`). A bare `@` in the text section
 * echoes the string value. Bracketed directives (`[Red]`, `[$-409]`,
 * conditions) are recognised and stripped so a pasted Excel format
 * renders the number instead of leaking the directive as a literal;
 * colour application itself is intentionally left to the cell style.
 *
 * Empty pattern → default "General" rendering.
 * Errors propagate (`#VALUE!` on unparseable strings).
 */
export function formatValueWithPattern(
  value: FormulaValue,
  pattern: string,
): string | FormulaError {
  if (isFormulaError(value)) return value;
  if (pattern === "") return defaultRender(value);
  const sections = splitFormatSections(pattern);

  // Non-numeric strings route to the text section (`@`) when present;
  // otherwise we keep TEXT()'s strict `#VALUE!` (the cell renderer
  // catches that error and falls back to the raw string).
  if (typeof value === "string" && !isNumericString(value)) {
    const textSection = sections.length >= 4 ? sections[3] : undefined;
    if (textSection !== undefined) return applyTextSection(value, textSection);
    return makeError("#VALUE!", `cannot format "${value}" as a number`);
  }

  const n = coerceToNumberForPattern(value);
  if (isFormulaError(n)) return n;

  const picked = pickNumericSection(sections, n);
  // An explicitly empty section (e.g. the `;;` in `0;-0;;@` to hide
  // zeros) renders nothing — matching Excel.
  if (picked.pattern.trim() === "") return "";
  const cleaned = stripBracketDirectives(picked.pattern);
  const magnitude = picked.useAbs ? Math.abs(n) : n;
  return renderNumberOrDate(magnitude, cleaned);
}

/** True when a string parses as a finite number (blank counts as 0). */
function isNumericString(value: string): boolean {
  const trimmed = value.trim();
  if (trimmed === "") return true;
  return Number.isFinite(Number(trimmed));
}

/**
 * Split a format string into its `;`-delimited sections, ignoring
 * separators inside quoted literals, `\`-escapes, or `[...]` directive
 * brackets. Excel allows at most four sections; extras are ignored.
 */
function splitFormatSections(pattern: string): string[] {
  const sections: string[] = [];
  let current = "";
  let inQuote = false;
  let inBracket = false;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '"') {
      inQuote = !inQuote;
      current += ch;
      continue;
    }
    if (!inQuote && ch === "\\") {
      current += ch;
      if (i + 1 < pattern.length) current += pattern[++i];
      continue;
    }
    if (!inQuote && ch === "[") inBracket = true;
    if (!inQuote && ch === "]") inBracket = false;
    if (!inQuote && !inBracket && ch === ";") {
      sections.push(current);
      current = "";
      continue;
    }
    current += ch;
  }
  sections.push(current);
  return sections.slice(0, 4);
}

/**
 * Choose the section for a numeric value following Excel's rules:
 * - 1 section: used for everything (negatives keep a leading minus).
 * - 2 sections: `positive-or-zero ; negative` (magnitude formatted).
 * - 3+ sections: `positive ; negative ; zero`.
 * `useAbs` is true only when a dedicated negative section is used, so
 * that section owns the sign (parens / explicit `-`).
 */
function pickNumericSection(
  sections: string[],
  n: number,
): { pattern: string; useAbs: boolean } {
  if (sections.length <= 1) {
    return { pattern: sections[0] ?? "", useAbs: false };
  }
  if (n < 0) return { pattern: sections[1], useAbs: true };
  if (n === 0 && sections.length >= 3) {
    return { pattern: sections[2], useAbs: false };
  }
  return { pattern: sections[0], useAbs: false };
}

/**
 * Remove `[...]` directive brackets (colour names, locale/currency
 * codes like `[$-409]`, condition clauses like `[>=100]`) from a
 * section, respecting quotes so a literal `"[x]"` is preserved. We
 * don't evaluate conditions — this keeps an arbitrary pasted format
 * from emitting the bracket text verbatim.
 */
function stripBracketDirectives(section: string): string {
  let out = "";
  let inQuote = false;
  for (let i = 0; i < section.length; i++) {
    const ch = section[i];
    if (ch === '"') {
      inQuote = !inQuote;
      out += ch;
      continue;
    }
    if (!inQuote && ch === "\\") {
      out += ch;
      if (i + 1 < section.length) out += section[++i];
      continue;
    }
    if (!inQuote && ch === "[") {
      while (i < section.length && section[i] !== "]") i++;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Render the text section of a format. `@` is replaced by the string
 * value; quoted literals and `\`-escapes pass through; bracket
 * directives are stripped. A section with no `@` emits its literal
 * text (Excel behaviour).
 */
function applyTextSection(text: string, section: string): string {
  const cleaned = stripBracketDirectives(section);
  let out = "";
  let inQuote = false;
  for (let i = 0; i < cleaned.length; i++) {
    const ch = cleaned[i];
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && ch === "\\") {
      if (i + 1 < cleaned.length) out += cleaned[++i];
      continue;
    }
    if (!inQuote && ch === "@") {
      out += text;
      continue;
    }
    out += ch;
  }
  return out;
}

/**
 * Coerce any non-error `FormulaValue` to a numeric serial for
 * pattern application. `null`/blank → 0, booleans → 0/1, numbers
 * passthrough, parseable strings → their `Number(...)` value.
 * Unparseable strings raise `#VALUE!` so TEXT() reports the user's
 * mistake instead of silently formatting a NaN.
 *
 * Callers must filter out `FormulaError` before invoking (the
 * narrowed type signature enforces this at compile time).
 */
function coerceToNumberForPattern(
  value: Exclude<FormulaValue, FormulaError>,
): number | FormulaError {
  if (value === null) return 0;
  if (typeof value === "number") {
    // A non-finite number (NaN / ±Infinity, e.g. from a result that slipped
    // past error handling) must not render as the literal "NaN"/"Infinity";
    // surface it as an error instead — matching the string path below.
    if (!Number.isFinite(value)) {
      return makeError("#NUM!", "cannot format a non-finite number");
    }
    return value;
  }
  if (typeof value === "boolean") return value ? 1 : 0;
  // String
  const trimmed = value.trim();
  if (trimmed === "") return 0;
  const n = Number(trimmed);
  if (Number.isFinite(n)) return n;
  return makeError("#VALUE!", `cannot format "${value}" as a number`);
}

/** General-format rendering for a `FormulaValue` (no explicit pattern). */
function defaultRender(value: FormulaValue): string {
  if (typeof value === "number") {
    if (Number.isInteger(value)) return value.toString();
    return value.toString();
  }
  if (typeof value === "boolean") return value ? "TRUE" : "FALSE";
  return String(value ?? "");
}

function renderNumberOrDate(value: number, pattern: string): string {
  if (looksLikeDateFormat(pattern)) {
    return formatDate(serialToDate(value), pattern);
  }
  return formatNumberPattern(value, pattern);
}

/**
 * Heuristic: is `pattern` a date/time format (vs. a numeric one)?
 *
 * Date tokens live outside quoted (`"..."`) and escaped (`\x`) segments.
 * `y`/`d`/`h`/`s` are *unambiguous* date/time codes — any of them flips the
 * pattern to date. `m`/`M` is **ambiguous**: it's the month/minute code, but
 * users also write it as a literal magnitude suffix (e.g. `#,##0,,"M"` for
 * millions — common in finance). A real date/time format that uses month or
 * minutes always also carries a `y`/`d` (month) or `h`/`s` (minutes) token, so
 * a lone `m`/`M` sitting next to numeric placeholders (`#`/`0`) is treated as a
 * literal, not a date. Month-name-only patterns (`mmm`, `mmmm`) have no numeric
 * placeholder, so they're still correctly recognised as dates.
 */
function looksLikeDateFormat(pattern: string): boolean {
  let inQuote = false;
  let hasStrongDateToken = false; // y / d / h / s — unambiguous
  let hasMonthToken = false; // m / M — ambiguous (month/minute vs. literal)
  let hasNumericPlaceholder = false; // # / 0
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) continue;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (
      ch === "y" ||
      ch === "Y" ||
      ch === "d" ||
      ch === "D" ||
      ch === "h" ||
      ch === "H" ||
      ch === "s" ||
      ch === "S"
    ) {
      hasStrongDateToken = true;
    } else if (ch === "m" || ch === "M") {
      hasMonthToken = true;
    } else if (ch === "#" || ch === "0") {
      hasNumericPlaceholder = true;
    }
  }
  if (hasStrongDateToken) return true;
  // A bare `m`/`M` is only a date token when it isn't acting as a literal
  // alongside numeric placeholders (so `#,##0M` stays a number; `mmm` stays a date).
  return hasMonthToken && !hasNumericPlaceholder;
}

/** Format `value` as a number using an Excel-style pattern. */
function formatNumberPattern(value: number, pattern: string): string {
  // Percent: any `%` outside quotes multiplies by 100.
  let scaledValue = value;
  if (containsUnquoted(pattern, "%")) scaledValue = value * 100;
  // Currency / literal prefix/suffix: keep everything in pattern,
  // splicing the numeric body into the digit-template region.
  const { prefix, body, suffix } = splitNumericTemplate(pattern);
  // Trailing commas after the last digit placeholder scale the value
  // down by 1000 each (`#,##0,` → thousands, `0.0,,` → millions).
  const { template, scale } = extractScaleCommas(body);
  scaledValue /= scale;
  const numericText = renderNumericBody(scaledValue, template);
  return prefix + numericText + suffix;
}

/**
 * Split "scale" commas off a digit template. A comma divides the value by
 * 1000 apiece when it sits in one of the two positions Excel treats as
 * scaling rather than grouping:
 *   1. after the last digit placeholder of the whole template (trailing:
 *      `#,##0,` → thousands, `0.0,,` → millions), or
 *   2. immediately to the left of the decimal point, with no digit
 *      placeholder between the comma run and the dot (`#,##0,.00` → the
 *      integer is shown in thousands with two decimals).
 * Commas anywhere else (`#,##0`) are thousands grouping separators and are
 * left in place. Indices are collected in a set so a degenerate pattern like
 * `#,##0,.` (a comma that is simultaneously pre-dot and trailing) counts the
 * comma once, not twice.
 */
function extractScaleCommas(body: string): { template: string; scale: number } {
  /** Last index of any digit placeholder strictly before `end`. */
  const lastDigitBefore = (end: number): number =>
    Math.max(
      body.lastIndexOf("0", end - 1),
      body.lastIndexOf("#", end - 1),
      body.lastIndexOf("?", end - 1),
    );

  const scaling = new Set<number>();

  // (1) Trailing commas after the overall last digit placeholder.
  const lastDigit = lastDigitBefore(body.length);
  if (lastDigit === -1) return { template: body, scale: 1 };
  for (let i = lastDigit + 1; i < body.length; i++) {
    if (body[i] === ",") scaling.add(i);
  }

  // (2) The run of commas sitting immediately left of the decimal point.
  const dot = indexOfUnquoted(body, ".");
  if (dot !== -1) {
    const lastIntDigit = lastDigitBefore(dot);
    for (let i = dot - 1; i > lastIntDigit; i--) {
      if (body[i] === ",") scaling.add(i);
      else break;
    }
  }

  if (scaling.size === 0) return { template: body, scale: 1 };
  const template = Array.from(body)
    .filter((_, i) => !scaling.has(i))
    .join("");
  return { template, scale: 1000 ** scaling.size };
}

/** First index of `ch` in `pattern` that is not inside a `"…"` literal. */
function indexOfUnquoted(pattern: string, ch: string): number {
  let inQuote = false;
  for (let i = 0; i < pattern.length; i++) {
    const c = pattern[i];
    if (c === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && c === ch) return i;
  }
  return -1;
}

function containsUnquoted(pattern: string, ch: string): boolean {
  return indexOfUnquoted(pattern, ch) !== -1;
}

/**
 * Find the contiguous digit-template region in `pattern` (the run
 * of characters that includes `#`, `0`, `,`, `.`, `?`). Everything
 * before is prefix; everything after is suffix. Literal characters
 * inside the run (quoted text, escaped chars) are passed through
 * unchanged in the rendered body.
 */
function splitNumericTemplate(pattern: string): {
  prefix: string;
  body: string;
  suffix: string;
} {
  let inQuote = false;
  let start = -1;
  let end = -1;
  for (let i = 0; i < pattern.length; i++) {
    const ch = pattern[i];
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (inQuote) continue;
    if (ch === "\\") {
      i++;
      continue;
    }
    if (ch === "#" || ch === "0" || ch === "." || ch === "," || ch === "?") {
      if (start === -1) start = i;
      end = i;
    }
  }
  if (start === -1) {
    return { prefix: stripQuotes(pattern), body: "", suffix: "" };
  }
  return {
    prefix: stripQuotes(pattern.slice(0, start)),
    body: pattern.slice(start, end + 1),
    suffix: stripQuotes(pattern.slice(end + 1)),
  };
}

function stripQuotes(s: string): string {
  let out = "";
  let inQuote = false;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"') {
      inQuote = !inQuote;
      continue;
    }
    if (!inQuote && ch === "\\") {
      if (i + 1 < s.length) {
        out += s[i + 1];
        i++;
      }
      continue;
    }
    // Drop the `%` marker from the suffix (we already scaled value).
    if (!inQuote && ch === "%") {
      out += "%";
      continue;
    }
    out += ch;
  }
  return out;
}

function renderNumericBody(value: number, body: string): string {
  if (!body) return "";
  // Decimal split.
  const dotIdx = body.indexOf(".");
  const intPart = dotIdx === -1 ? body : body.slice(0, dotIdx);
  const fracPart = dotIdx === -1 ? "" : body.slice(dotIdx + 1);
  const fracDigits = fracPart.replace(/[^0#?]/g, "").length;
  const hasThousands = intPart.includes(",");
  const isNegative = value < 0;
  const abs = Math.abs(value);
  const rounded = abs.toFixed(fracDigits);
  const [rawInt, fracText = ""] = rounded.split(".");
  let intText = rawInt;
  // Pad / trim integer to required minimum width.
  const intRequired = intPart.replace(/[^0]/g, "").length;
  while (intText.length < intRequired) intText = "0" + intText;
  if (hasThousands) intText = withThousands(intText);
  let out = intText;
  if (fracDigits > 0) {
    out += "." + fracText.padEnd(fracDigits, "0");
  }
  if (isNegative) out = "-" + out;
  return out;
}

function withThousands(intText: string): string {
  if (intText.length <= 3) return intText;
  const out: string[] = [];
  for (let i = intText.length; i > 0; i -= 3) {
    out.unshift(intText.slice(Math.max(0, i - 3), i));
  }
  return out.join(",");
}

const DAY_NAMES = [
  "Sunday",
  "Monday",
  "Tuesday",
  "Wednesday",
  "Thursday",
  "Friday",
  "Saturday",
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

/**
 * Format `date` (UTC) using an Excel-style pattern. Supported
 * tokens: `yyyy`, `yy`, `mmmm`, `mmm`, `mm`, `m`, `dd`, `d`,
 * `dddd`, `ddd`, `hh`, `h`, `mm` (when inside hh:mm:ss segment we
 * disambiguate to minutes), `ss`, `s`, `AM/PM`, plus `"literal"`
 * and `\x` escapes.
 */
function formatDate(date: Date, pattern: string): string {
  const Y = date.getUTCFullYear();
  const M = date.getUTCMonth();
  const D = date.getUTCDate();
  const H = date.getUTCHours();
  const Mi = date.getUTCMinutes();
  const S = date.getUTCSeconds();
  const W = date.getUTCDay();
  let out = "";
  let i = 0;
  let sawHour = false;
  while (i < pattern.length) {
    const ch = pattern[i];
    if (ch === '"') {
      // Quoted literal — emit verbatim until next `"`.
      i++;
      while (i < pattern.length && pattern[i] !== '"') {
        out += pattern[i];
        i++;
      }
      i++;
      continue;
    }
    if (ch === "\\" && i + 1 < pattern.length) {
      out += pattern[i + 1];
      i += 2;
      continue;
    }
    // Multi-char date tokens.
    if (pattern.startsWith("yyyy", i)) {
      out += String(Y).padStart(4, "0");
      i += 4;
      continue;
    }
    if (pattern.startsWith("yy", i)) {
      out += String(Y % 100).padStart(2, "0");
      i += 2;
      continue;
    }
    if (pattern.startsWith("mmmm", i)) {
      out += MONTH_NAMES[M];
      i += 4;
      continue;
    }
    if (pattern.startsWith("mmm", i)) {
      out += MONTH_NAMES[M].slice(0, 3);
      i += 3;
      continue;
    }
    if (pattern.startsWith("dddd", i)) {
      out += DAY_NAMES[W];
      i += 4;
      continue;
    }
    if (pattern.startsWith("ddd", i)) {
      out += DAY_NAMES[W].slice(0, 3);
      i += 3;
      continue;
    }
    if (pattern.startsWith("dd", i)) {
      out += String(D).padStart(2, "0");
      i += 2;
      continue;
    }
    if (pattern.startsWith("d", i)) {
      out += String(D);
      i += 1;
      continue;
    }
    if (pattern.startsWith("hh", i)) {
      out += String(H).padStart(2, "0");
      sawHour = true;
      i += 2;
      continue;
    }
    if (pattern.startsWith("h", i)) {
      out += String(H);
      sawHour = true;
      i += 1;
      continue;
    }
    if (pattern.startsWith("ss", i)) {
      out += String(S).padStart(2, "0");
      i += 2;
      continue;
    }
    if (pattern.startsWith("s", i)) {
      out += String(S);
      i += 1;
      continue;
    }
    if (pattern.startsWith("mm", i)) {
      // After an `h`/`hh` we treat `mm` as minutes; otherwise as
      // zero-padded month. Excel uses the same heuristic.
      if (sawHour) {
        out += String(Mi).padStart(2, "0");
      } else {
        out += String(M + 1).padStart(2, "0");
      }
      i += 2;
      continue;
    }
    if (pattern.startsWith("m", i)) {
      if (sawHour) out += String(Mi);
      else out += String(M + 1);
      i += 1;
      continue;
    }
    if (pattern.startsWith("AM/PM", i) || pattern.startsWith("am/pm", i)) {
      out += H >= 12 ? "PM" : "AM";
      i += 5;
      continue;
    }
    out += ch;
    i++;
  }
  return out;
}

/** Translate a `CellFormat` into a `React.CSSProperties` payload. */
export function cellFormatStyle(format: CellFormat | undefined): CSSProperties {
  if (!format) return {};
  const style: CSSProperties = {};
  if (format.align) style.textAlign = format.align;
  if (format.bold) style.fontWeight = 600;
  if (format.italic) style.fontStyle = "italic";
  if (format.underline) style.textDecoration = "underline";
  if (format.color) style.color = format.color;
  if (format.background) style.backgroundColor = format.background;
  return style;
}

/**
 * Coerce a user-entered value into a numeric serial for formatting
 * purposes — exposed for tests / future Excel-paste handling.
 */
export function valueToDateSerial(value: FormulaValue): number | null {
  if (typeof value === "number") return value;
  if (value instanceof Date) return dateToSerial(value);
  return null;
}
