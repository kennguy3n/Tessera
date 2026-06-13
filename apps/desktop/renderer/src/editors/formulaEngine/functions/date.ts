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

const TIME: FunctionImpl = (args, ctx) => {
  if (args.length !== 3) return makeError("#ERR!", "TIME expects 3 arguments");
  const h = singleNumber(args[0], ctx);
  if (isFormulaError(h)) return h;
  const m = singleNumber(args[1], ctx);
  if (isFormulaError(m)) return m;
  const s = singleNumber(args[2], ctx);
  if (isFormulaError(s)) return s;
  const totalSeconds = Math.trunc(h) * 3600 + Math.trunc(m) * 60 + Math.trunc(s);
  // TIME wraps modulo 24h and is always a positive fraction of a day,
  // matching Excel (TIME(25,0,0) == TIME(1,0,0)).
  const dayFraction = ((totalSeconds % 86400) + 86400) % 86400;
  return dayFraction / 86400;
};

/** Extract the time-of-day fraction (0 ≤ f < 1) from a date serial. */
function timeFraction(serial: number): number {
  const frac = serial - Math.floor(serial);
  // Guard against binary-rounding drift pushing us a hair below 0.
  return frac < 0 ? frac + 1 : frac;
}

const HOUR: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "HOUR expects 1 argument");
  const s = singleNumber(args[0], ctx);
  if (isFormulaError(s)) return s;
  return Math.floor(timeFraction(s) * 24);
};

const MINUTE: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "MINUTE expects 1 argument");
  const s = singleNumber(args[0], ctx);
  if (isFormulaError(s)) return s;
  const totalSeconds = Math.round(timeFraction(s) * 86400);
  return Math.floor(totalSeconds / 60) % 60;
};

const SECOND: FunctionImpl = (args, ctx) => {
  if (args.length !== 1) return makeError("#ERR!", "SECOND expects 1 argument");
  const s = singleNumber(args[0], ctx);
  if (isFormulaError(s)) return s;
  const totalSeconds = Math.round(timeFraction(s) * 86400);
  return totalSeconds % 60;
};

const WEEKDAY: FunctionImpl = (args, ctx) => {
  if (args.length < 1 || args.length > 2) {
    return makeError("#ERR!", "WEEKDAY expects 1 or 2 arguments");
  }
  const s = singleNumber(args[0], ctx);
  if (isFormulaError(s)) return s;
  let type = 1;
  if (args.length === 2) {
    const t = singleNumber(args[1], ctx);
    if (isFormulaError(t)) return t;
    type = Math.trunc(t);
  }
  // JS getUTCDay: Sun=0 … Sat=6.
  const dow = serialToDate(Math.floor(s)).getUTCDay();
  switch (type) {
    case 1:
      return dow + 1; // Sun=1 … Sat=7
    case 2:
      return ((dow + 6) % 7) + 1; // Mon=1 … Sun=7
    case 3:
      return (dow + 6) % 7; // Mon=0 … Sun=6
    default:
      return makeError("#NUM!", `WEEKDAY type ${type} not supported`);
  }
};

const WEEKNUM: FunctionImpl = (args, ctx) => {
  if (args.length < 1 || args.length > 2) {
    return makeError("#ERR!", "WEEKNUM expects 1 or 2 arguments");
  }
  const s = singleNumber(args[0], ctx);
  if (isFormulaError(s)) return s;
  let type = 1;
  if (args.length === 2) {
    const t = singleNumber(args[1], ctx);
    if (isFormulaError(t)) return t;
    type = Math.trunc(t);
  }
  // type 1 → weeks start Sunday; type 2 → weeks start Monday.
  let weekStart: number;
  if (type === 1) weekStart = 0;
  else if (type === 2) weekStart = 1;
  else return makeError("#NUM!", `WEEKNUM type ${type} not supported`);
  const date = serialToDate(Math.floor(s));
  const year = date.getUTCFullYear();
  const jan1 = new Date(Date.UTC(year, 0, 1));
  const jan1Dow = jan1.getUTCDay();
  const dayOfYear =
    Math.floor((date.getTime() - jan1.getTime()) / DAY_MS) + 1;
  const offset = (jan1Dow - weekStart + 7) % 7;
  return Math.floor((dayOfYear + offset - 1) / 7) + 1;
};

const EDATE: FunctionImpl = (args, ctx) => {
  if (args.length !== 2) return makeError("#ERR!", "EDATE expects 2 arguments");
  const s = singleNumber(args[0], ctx);
  if (isFormulaError(s)) return s;
  const months = singleNumber(args[1], ctx);
  if (isFormulaError(months)) return months;
  return Math.trunc(dateToSerial(addMonths(serialToDate(Math.floor(s)), Math.trunc(months))));
};

const EOMONTH: FunctionImpl = (args, ctx) => {
  if (args.length !== 2) return makeError("#ERR!", "EOMONTH expects 2 arguments");
  const s = singleNumber(args[0], ctx);
  if (isFormulaError(s)) return s;
  const months = singleNumber(args[1], ctx);
  if (isFormulaError(months)) return months;
  const base = serialToDate(Math.floor(s));
  // Day 0 of (month + months + 1) is the last day of (month + months).
  const eom = new Date(
    Date.UTC(base.getUTCFullYear(), base.getUTCMonth() + Math.trunc(months) + 1, 0),
  );
  return Math.trunc(dateToSerial(eom));
};

/** Add `months` to a date, clamping the day to the target month's length. */
function addMonths(date: Date, months: number): Date {
  const year = date.getUTCFullYear();
  const month = date.getUTCMonth() + months;
  const day = date.getUTCDate();
  const targetLastDay = new Date(Date.UTC(year, month + 1, 0)).getUTCDate();
  return new Date(Date.UTC(year, month, Math.min(day, targetLastDay)));
}

const DAYS: FunctionImpl = (args, ctx) => {
  if (args.length !== 2) return makeError("#ERR!", "DAYS expects 2 arguments");
  const end = singleNumber(args[0], ctx);
  if (isFormulaError(end)) return end;
  const start = singleNumber(args[1], ctx);
  if (isFormulaError(start)) return start;
  return Math.trunc(end) - Math.trunc(start);
};

/** Collect a set of holiday serials from an optional range/scalar arg. */
function collectHolidays(
  arg: AstNode | undefined,
  ctx: EvaluationContext,
): Set<number> | FormulaError {
  const set = new Set<number>();
  if (!arg) return set;
  for (const v of collectValues(arg, ctx)) {
    if (isFormulaError(v)) return v;
    if (v === null) continue;
    const n = toNumber(v);
    if (isFormulaError(n)) return n;
    set.add(Math.floor(n));
  }
  return set;
}

function isWeekend(serial: number): boolean {
  const dow = serialToDate(serial).getUTCDay();
  return dow === 0 || dow === 6; // Sun / Sat
}

const NETWORKDAYS: FunctionImpl = (args, ctx) => {
  if (args.length < 2 || args.length > 3) {
    return makeError("#ERR!", "NETWORKDAYS expects 2 or 3 arguments");
  }
  const a = singleNumber(args[0], ctx);
  if (isFormulaError(a)) return a;
  const b = singleNumber(args[1], ctx);
  if (isFormulaError(b)) return b;
  const holidays = collectHolidays(args[2], ctx);
  if (isFormulaError(holidays)) return holidays;
  let start = Math.floor(a);
  let end = Math.floor(b);
  let sign = 1;
  if (start > end) {
    [start, end] = [end, start];
    sign = -1;
  }
  let count = 0;
  for (let d = start; d <= end; d++) {
    if (!isWeekend(d) && !holidays.has(d)) count++;
  }
  return sign * count;
};

const WORKDAY: FunctionImpl = (args, ctx) => {
  if (args.length < 2 || args.length > 3) {
    return makeError("#ERR!", "WORKDAY expects 2 or 3 arguments");
  }
  const s = singleNumber(args[0], ctx);
  if (isFormulaError(s)) return s;
  const daysArg = singleNumber(args[1], ctx);
  if (isFormulaError(daysArg)) return daysArg;
  const holidays = collectHolidays(args[2], ctx);
  if (isFormulaError(holidays)) return holidays;
  let remaining = Math.trunc(daysArg);
  let cursor = Math.floor(s);
  const step = remaining >= 0 ? 1 : -1;
  remaining = Math.abs(remaining);
  while (remaining > 0) {
    cursor += step;
    if (!isWeekend(cursor) && !holidays.has(cursor)) remaining--;
  }
  return cursor;
};

export const DATE_FUNCTIONS: Record<string, FunctionImpl> = {
  TODAY,
  NOW,
  DATE,
  YEAR,
  MONTH,
  DAY,
  DATEDIF,
  DATEVALUE,
  TIME,
  HOUR,
  MINUTE,
  SECOND,
  WEEKDAY,
  WEEKNUM,
  EDATE,
  EOMONTH,
  DAYS,
  NETWORKDAYS,
  WORKDAY,
};
