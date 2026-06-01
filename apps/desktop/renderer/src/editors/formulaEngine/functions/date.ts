/**
 * date functions.
 *
 * Tessera uses the same date serial-number system as Excel and Google
 * Sheets: the origin is **1899-12-30 UTC** (so `0` is the Lotus 1-2-3
 * leap-year fudge that Excel inherited and `1` is 1900-01-01) and
 * every later date is the integer number of days since the origin.
 * Times are the fractional part — `0.5` is noon, `0.75` is 18:00.
 *
 * Because dates are just numbers, arithmetic "just works": `=A1+30`
 * advances a date by 30 days, `=B1-A1` is a number of days between
 * two dates. Display formatting (e.g. `2024-03-15`) is done by the
 * `TEXT` function from `text.ts`, which formats date serials via
 * `serialToDate`.
 *
 * Functions implemented:
 *
 *   TODAY()           Today's date at midnight UTC.
 *   NOW()             Right now, full precision.
 *   DATE(y, m, d)     Build a serial from components. Out-of-range
 *                     month/day overflows the way Excel does
 *                     (DATE(2024, 13, 1) == DATE(2025, 1, 1)).
 *   YEAR / MONTH / DAY (serial)   Component extraction.
 *   DATEDIF(start, end, unit)
 *     `unit ∈ {"Y","M","D","YM","YD","MD"}` per Excel:
 *       Y   complete years
 *       M   complete months
 *       D   days
 *       YM  months after subtracting whole years
 *       YD  days after subtracting whole years (ignoring year)
 *       MD  days after subtracting whole months
 *   DATEVALUE(text)   Parse `YYYY-MM-DD`, `MM/DD/YYYY`, `D-MMM-YYYY`
 *                     into a date serial. Returns `#VALUE!` on
 *                     unrecognised input.
 *
 * Determinism: TODAY() and NOW() consult `ctx.now` if present, falling
 * back to `new Date()`. Tests inject a fixed clock so date assertions
 * are stable.
 */
import type { AstNode } from "../parser";
import {
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

/**
 * Origin = 1899-12-30 UTC. Excel's quirk: serial `60` is the fictitious
 * 1900-02-29 (it shouldn't exist, but Lotus 1-2-3 thought 1900 was a
 * leap year and Excel preserved the bug for compatibility). We
 * follow Excel's bug-for-bug behaviour so round-tripping XLSX dates
 * works.
 */
// Excel's "day 0" is 1899-12-31; serial 1 = 1900-01-01, serial 60
// is the phantom 1900-02-29 (Lotus 1-2-3 leap-year bug), and serial
// 61 = real 1900-03-01. The previous epoch (1899-12-30) was off by
// one day and produced serial 1 = 1899-12-31, which silently breaks
// against any known Excel reference value.
const EPOCH_MS = Date.UTC(1899, 11, 31, 0, 0, 0, 0);
const DAY_MS = 86_400_000;
const LEAP_BUG_SERIAL = 60; // Excel's phantom 1900-02-29

/**
 * Convert a date serial number to a `Date` (UTC). Exported because
 * `text.ts:TEXT()` and `format.ts` both need it to render
 * `=TEXT(A1, "yyyy-mm-dd")` and per-cell date formats.
 *
 * Excel's leap bug: serials ≥ 60 are shifted by one day because
 * Excel believes there are 60 days in Jan-Feb 1900 (real calendar
 * has 59). We compensate so we always emit a valid calendar date.
 * The phantom serial 60 collapses onto the same real day as 59
 * (1900-02-28) — JavaScript `Date` can't represent the impossible
 * 1900-02-29, and most OOXML readers ship the same compromise.
 */
export function serialToDate(serial: number): Date {
  const adjusted = serial >= LEAP_BUG_SERIAL ? serial - 1 : serial;
  return new Date(EPOCH_MS + adjusted * DAY_MS);
}

/**
 * Convert a `Date` to its Excel-style serial number (days since
 * 1899-12-31 UTC, with Excel's 1900-02-29 leap bug). Inverse of
 * `serialToDate` for any real calendar day; the phantom day is
 * unreachable through this function.
 */
export function dateToSerial(date: Date): number {
  const days = (date.getTime() - EPOCH_MS) / DAY_MS;
  // Anything on or after the real 1900-03-01 needs the leap-bug
  // offset added back so Excel computes the same serial.
  if (days >= LEAP_BUG_SERIAL) return days + 1;
  return days;
}

function clockNow(ctx: EvaluationContext): Date {
  return ctx.now ? ctx.now() : new Date();
}

const TODAY: FunctionImpl = (args, ctx) => {
  if (args.length !== 0) return makeError("#ERR!", "TODAY expects 0 arguments");
  const now = clockNow(ctx);
  const midnight = new Date(
    Date.UTC(now.getUTCFullYear(), now.getUTCMonth(), now.getUTCDate()),
  );
  return Math.trunc(dateToSerial(midnight));
};

const NOW: FunctionImpl = (args, ctx) => {
  if (args.length !== 0) return makeError("#ERR!", "NOW expects 0 arguments");
  return dateToSerial(clockNow(ctx));
};

const DATE: FunctionImpl = (args, ctx) => {
  if (args.length !== 3) return makeError("#ERR!", "DATE expects 3 arguments");
  const y = singleNumber(args[0], ctx);
  if (isFormulaError(y)) return y;
  const m = singleNumber(args[1], ctx);
  if (isFormulaError(m)) return m;
  const d = singleNumber(args[2], ctx);
  if (isFormulaError(d)) return d;
  // Excel/Google Sheets quirk: 0..1899 → 1900..3799 (adds 1900).
  // Negative years and >=10000 are #NUM!.
  let year = Math.trunc(y);
  if (year < 0 || year >= 10000) return makeError("#NUM!", "DATE year out of range");
  if (year < 1900) year += 1900;
  // `Date.UTC` happily overflows month/day so DATE(2024, 13, 1) ==
  // 2025-01-01 — matches Excel's "rolling" behaviour.
  const built = new Date(Date.UTC(year, Math.trunc(m) - 1, Math.trunc(d)));
  return Math.trunc(dateToSerial(built));
};

const YEAR: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "YEAR expects 1 argument");
  const s = singleNumber(args[0], ctx);
  if (isFormulaError(s)) return s;
  return serialToDate(s).getUTCFullYear();
};

const MONTH: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "MONTH expects 1 argument");
  const s = singleNumber(args[0], ctx);
  if (isFormulaError(s)) return s;
  return serialToDate(s).getUTCMonth() + 1;
};

const DAY: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "DAY expects 1 argument");
  const s = singleNumber(args[0], ctx);
  if (isFormulaError(s)) return s;
  return serialToDate(s).getUTCDate();
};

const DATEDIF: FunctionImpl = (args, ctx) => {
  if (args.length !== 3) {
    return makeError("#ERR!", "DATEDIF expects 3 arguments");
  }
  const a = singleNumber(args[0], ctx);
  if (isFormulaError(a)) return a;
  const b = singleNumber(args[1], ctx);
  if (isFormulaError(b)) return b;
  const u = evaluate(args[2], ctx);
  if (isFormulaError(u)) return u;
  if (typeof u !== "string") {
    return makeError("#VALUE!", "DATEDIF unit must be a string");
  }
  if (a > b) return makeError("#NUM!", "DATEDIF: end before start");
  const start = serialToDate(a);
  const end = serialToDate(b);
  const unit = u.toUpperCase();
  switch (unit) {
    case "D":
      return Math.trunc(b) - Math.trunc(a);
    case "Y":
      return wholeYearsBetween(start, end);
    case "M":
      return wholeMonthsBetween(start, end);
    case "YM":
      return wholeMonthsBetween(start, end) % 12;
    case "YD":
      return ydDifference(start, end);
    case "MD":
      return mdDifference(start, end);
    default:
      return makeError("#VALUE!", `DATEDIF unit "${u}" not supported`);
  }
};

function wholeYearsBetween(start: Date, end: Date): number {
  let years = end.getUTCFullYear() - start.getUTCFullYear();
  // Subtract 1 if the end is calendar-before the start anniversary.
  const endMonth = end.getUTCMonth();
  const startMonth = start.getUTCMonth();
  if (
    endMonth < startMonth ||
    (endMonth === startMonth && end.getUTCDate() < start.getUTCDate())
  ) {
    years--;
  }
  return years;
}

function wholeMonthsBetween(start: Date, end: Date): number {
  let months =
    (end.getUTCFullYear() - start.getUTCFullYear()) * 12 +
    (end.getUTCMonth() - start.getUTCMonth());
  if (end.getUTCDate() < start.getUTCDate()) months--;
  return months;
}

function ydDifference(start: Date, end: Date): number {
  // Days from start to end, ignoring year diff (move start onto end's
  // year — or year+1 if that overshoots — then count days).
  const candidate = new Date(
    Date.UTC(end.getUTCFullYear(), start.getUTCMonth(), start.getUTCDate()),
  );
  let diff = (end.getTime() - candidate.getTime()) / DAY_MS;
  if (diff < 0) {
    const prior = new Date(
      Date.UTC(end.getUTCFullYear() - 1, start.getUTCMonth(), start.getUTCDate()),
    );
    diff = (end.getTime() - prior.getTime()) / DAY_MS;
  }
  return Math.trunc(diff);
}

function mdDifference(start: Date, end: Date): number {
  // Excel's MD: days after subtracting whole months. Move `start`
  // forward by the whole-month diff, then count remaining days.
  const months = wholeMonthsBetween(start, end);
  const moved = new Date(start.getTime());
  moved.setUTCMonth(moved.getUTCMonth() + months);
  return Math.trunc((end.getTime() - moved.getTime()) / DAY_MS);
}

const DATEVALUE: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) {
    return makeError("#ERR!", "DATEVALUE expects 1 argument");
  }
  const v = evaluate(args[0], ctx);
  if (isFormulaError(v)) return v;
  const text = coerceToString(v).trim();
  if (text === "") return makeError("#VALUE!", "DATEVALUE: empty input");
  const parsed = parseDateString(text);
  if (parsed === null) {
    return makeError("#VALUE!", `DATEVALUE: unrecognised "${text}"`);
  }
  return Math.trunc(dateToSerial(parsed));
};

function parseDateString(text: string): Date | null {
  // ISO `YYYY-MM-DD` (optionally `YYYY-MM-DDTHH:MM:SS`).
  let m = /^(\d{4})-(\d{1,2})-(\d{1,2})(?:[T ](\d{1,2}):(\d{1,2})(?::(\d{1,2}))?)?$/.exec(
    text,
  );
  if (m) {
    return new Date(
      Date.UTC(
        parseInt(m[1], 10),
        parseInt(m[2], 10) - 1,
        parseInt(m[3], 10),
        m[4] ? parseInt(m[4], 10) : 0,
        m[5] ? parseInt(m[5], 10) : 0,
        m[6] ? parseInt(m[6], 10) : 0,
      ),
    );
  }
  // US-style `MM/DD/YYYY` (year may also be `YY`).
  m = /^(\d{1,2})\/(\d{1,2})\/(\d{2}|\d{4})$/.exec(text);
  if (m) {
    let y = parseInt(m[3], 10);
    if (y < 100) y += y < 30 ? 2000 : 1900;
    return new Date(Date.UTC(y, parseInt(m[1], 10) - 1, parseInt(m[2], 10)));
  }
  // ISO-ish `YYYY/MM/DD`.
  m = /^(\d{4})\/(\d{1,2})\/(\d{1,2})$/.exec(text);
  if (m) {
    return new Date(
      Date.UTC(parseInt(m[1], 10), parseInt(m[2], 10) - 1, parseInt(m[3], 10)),
    );
  }
  // `D-MMM-YYYY` or `D MMM YYYY` (`15-Jan-2024`).
  m = /^(\d{1,2})[ -]([A-Za-z]{3,9})[ -](\d{2}|\d{4})$/.exec(text);
  if (m) {
    const monthIdx = MONTH_LOOKUP[m[2].slice(0, 3).toLowerCase()];
    if (monthIdx !== undefined) {
      let y = parseInt(m[3], 10);
      if (y < 100) y += y < 30 ? 2000 : 1900;
      return new Date(Date.UTC(y, monthIdx, parseInt(m[1], 10)));
    }
  }
  return null;
}

const MONTH_LOOKUP: Record<string, number> = {
  jan: 0,
  feb: 1,
  mar: 2,
  apr: 3,
  may: 4,
  jun: 5,
  jul: 6,
  aug: 7,
  sep: 8,
  oct: 9,
  nov: 10,
  dec: 11,
};

function singleNumber(
  arg: AstNode,
  ctx: EvaluationContext,
): number | FormulaError {
  const v = evaluate(arg, ctx);
  if (isFormulaError(v)) return v;
  return toNumber(v);
}

export const DATE_FUNCTIONS: Record<string, FunctionImpl> = {
  TODAY,
  NOW,
  DATE,
  YEAR,
  MONTH,
  DAY,
  DATEDIF,
  DATEVALUE,
};
