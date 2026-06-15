/**
 * Locale-aware currency + date number-format presets.
 *
 * Deliverable 3 of the Sheet Template Library: surface common-locale
 * currency and date formats in the number-format menu, reusing `Intl`
 * (no extra dependencies) to derive the locale-correct currency symbol,
 * symbol placement, and decimal-place count.
 *
 * ENGINE CONSTRAINT (documented in ADR 0027): the cell format engine
 * (`formulaEngine/format.ts`) hardcodes `,` as the thousands grouping
 * separator and `.` as the decimal separator, so a preset CANNOT render
 * European-style `1.234,56`. What a preset *can* localise — and what
 * these presets do localise — is:
 *   - the currency symbol (`€`, `£`, `¥`, `₹`, `CA$`, …), via `Intl`;
 *   - whether the symbol is a prefix (`£1,234.56`) or a suffix
 *     (`1,234.56 €`), via `Intl` for the preset's locale;
 *   - the number of decimal places (2 for most, 0 for JPY/KRW), via
 *     `Intl`;
 *   - the date field order + separator (`dd/mm/yyyy`, `dd.mm.yyyy`,
 *     `d mmm yyyy`, …), which the engine's date formatter passes
 *     through verbatim.
 *
 * The currency symbol is derived under a neutral `en` locale so it is
 * stable and unambiguous (e.g. `CA$`, `A$`, `R$`), while placement and
 * fraction digits come from the preset's own locale so the presets stay
 * faithfully locale-aware within the engine's separator limitation.
 */

import { formatValueWithPattern } from "./formulaEngine/format";
import type { NumberFormatPreset } from "./sheetFormatting";

/** optgroup label for the locale currency presets. */
export const LOCALE_CURRENCY_GROUP = "Currency (locale)";

/** optgroup label for the locale date presets. */
export const LOCALE_DATE_GROUP = "Date (locale)";

/** Where a currency symbol sits relative to the number. */
export type CurrencyPlacement = "prefix" | "suffix";

/** The locale-derived inputs that fully determine a currency pattern. */
export interface CurrencyFormatParts {
  symbol: string;
  placement: CurrencyPlacement;
  fractionDigits: number;
}

/** The example value rendered into every preset label. */
const SAMPLE_VALUE = 1234.56;

/** The locale that determines symbol placement + decimals for a preset. */
interface LocaleCurrencySpec {
  id: string;
  /** Human currency name shown in the preset label. */
  name: string;
  /** BCP-47 locale used to derive placement + fraction digits. */
  locale: string;
  /** ISO 4217 currency code. */
  currency: string;
}

/**
 * Curated common-locale currencies. One entry per currency so the menu
 * never shows the same currency twice. Symbols are derived (not
 * hardcoded) so they always match the host's `Intl` data.
 */
export const LOCALE_CURRENCY_SPECS: readonly LocaleCurrencySpec[] = [
  { id: "currency-eur", name: "Euro", locale: "de-DE", currency: "EUR" },
  {
    id: "currency-gbp",
    name: "British pound",
    locale: "en-GB",
    currency: "GBP",
  },
  {
    id: "currency-jpy",
    name: "Japanese yen",
    locale: "ja-JP",
    currency: "JPY",
  },
  { id: "currency-chf", name: "Swiss franc", locale: "de-CH", currency: "CHF" },
  {
    id: "currency-cny",
    name: "Chinese yuan",
    locale: "zh-CN",
    currency: "CNY",
  },
  {
    id: "currency-inr",
    name: "Indian rupee",
    locale: "en-IN",
    currency: "INR",
  },
  {
    id: "currency-cad",
    name: "Canadian dollar",
    locale: "en-CA",
    currency: "CAD",
  },
  {
    id: "currency-aud",
    name: "Australian dollar",
    locale: "en-AU",
    currency: "AUD",
  },
  {
    id: "currency-brl",
    name: "Brazilian real",
    locale: "pt-BR",
    currency: "BRL",
  },
  {
    id: "currency-krw",
    name: "South Korean won",
    locale: "ko-KR",
    currency: "KRW",
  },
  {
    id: "currency-mxn",
    name: "Mexican peso",
    locale: "es-MX",
    currency: "MXN",
  },
] as const;

/**
 * Build the engine format pattern for a currency. Pure + deterministic:
 * the digit body always uses the engine's `,`/`.` separators (the only
 * ones it supports) with `fractionDigits` decimals, and the symbol is
 * spliced as a quoted literal so it survives the engine's quote
 * stripping. A multi-letter prefix symbol (`CHF`) gets a trailing space
 * so it doesn't run into the digits; a suffix symbol always gets a
 * leading space (`1,234.56 €`).
 */
export function buildCurrencyPattern(parts: CurrencyFormatParts): string {
  const { symbol, placement, fractionDigits } = parts;
  const decimals = Math.max(0, Math.min(20, Math.trunc(fractionDigits)));
  const body = decimals > 0 ? `#,##0.${"0".repeat(decimals)}` : "#,##0";
  if (placement === "suffix") {
    return `${body}" ${symbol}"`;
  }
  // A trailing alphanumeric in the symbol would visually collide with the
  // first digit, so pad it; pure-glyph symbols ($, €, £) sit flush.
  const spacer = /[A-Za-z0-9]$/.test(symbol) ? " " : "";
  return `"${symbol}${spacer}"${body}`;
}

/**
 * The currency symbol for `currency`, derived under a neutral `en`
 * locale so it is stable + unambiguous (`CA$`, `A$`, `R$`, `€`, `¥`).
 * Falls back to the ISO code if `Intl` yields no currency part.
 */
export function currencySymbol(currency: string): string {
  const parts = new Intl.NumberFormat("en", {
    style: "currency",
    currency,
    currencyDisplay: "symbol",
  }).formatToParts(SAMPLE_VALUE);
  return parts.find((p) => p.type === "currency")?.value ?? currency;
}

/**
 * Whether `locale` writes `currency` before (`prefix`) or after
 * (`suffix`) the amount, derived from the relative position of the
 * currency + integer parts in `Intl` output.
 */
export function currencyPlacement(
  locale: string,
  currency: string,
): CurrencyPlacement {
  const parts = new Intl.NumberFormat(locale, {
    style: "currency",
    currency,
  }).formatToParts(SAMPLE_VALUE);
  const symbolIndex = parts.findIndex((p) => p.type === "currency");
  const numberIndex = parts.findIndex(
    (p) => p.type === "integer" || p.type === "decimal",
  );
  if (symbolIndex === -1 || numberIndex === -1) return "prefix";
  return symbolIndex < numberIndex ? "prefix" : "suffix";
}

/** The conventional decimal-place count for `currency` (e.g. 0 for JPY). */
export function currencyFractionDigits(currency: string): number {
  const digits = new Intl.NumberFormat("en", {
    style: "currency",
    currency,
  }).resolvedOptions().maximumFractionDigits;
  return typeof digits === "number" ? digits : 2;
}

/** Derive every locale-driven input for one currency spec. */
function currencyFormatParts(spec: LocaleCurrencySpec): CurrencyFormatParts {
  return {
    symbol: currencySymbol(spec.currency),
    placement: currencyPlacement(spec.locale, spec.currency),
    fractionDigits: currencyFractionDigits(spec.currency),
  };
}

/** Render a pattern against the sample value for the preset's label. */
function exampleFor(pattern: string): string {
  const out = formatValueWithPattern(SAMPLE_VALUE, pattern);
  return typeof out === "string" ? out : "";
}

/**
 * Locale currency presets, materialised once at module load from the
 * curated specs above. Each carries a ready-to-store engine pattern and
 * a label showing the live example (e.g. "Euro (1,234.56 €)").
 */
export const LOCALE_CURRENCY_PRESETS: NumberFormatPreset[] =
  LOCALE_CURRENCY_SPECS.map((spec) => {
    const pattern = buildCurrencyPattern(currencyFormatParts(spec));
    const example = exampleFor(pattern);
    return {
      id: spec.id,
      label: example ? `${spec.name} (${example})` : spec.name,
      pattern,
      group: LOCALE_CURRENCY_GROUP,
    };
  });

/**
 * Locale date presets. The engine's date formatter passes separators
 * through verbatim, so field order + separator localise cleanly. The
 * sample date 2024-01-31 is a Wednesday, so the weekday/month-name
 * examples below are accurate.
 */
export const LOCALE_DATE_PRESETS: NumberFormatPreset[] = [
  {
    id: "date-eu",
    label: "Date (31/01/2024)",
    pattern: "dd/mm/yyyy",
    group: LOCALE_DATE_GROUP,
  },
  {
    id: "date-de",
    label: "Date (31.01.2024)",
    pattern: "dd.mm.yyyy",
    group: LOCALE_DATE_GROUP,
  },
  {
    id: "date-dmy",
    label: "Date (31 Jan 2024)",
    pattern: "d mmm yyyy",
    group: LOCALE_DATE_GROUP,
  },
  {
    id: "date-weekday",
    label: "Date (Wed, 31 Jan 2024)",
    pattern: "ddd, d mmm yyyy",
    group: LOCALE_DATE_GROUP,
  },
  {
    id: "date-long",
    label: "Date (January 31, 2024)",
    pattern: "mmmm d, yyyy",
    group: LOCALE_DATE_GROUP,
  },
];

/** All locale presets, currency first, appended to the base menu. */
export const LOCALE_FORMAT_PRESETS: NumberFormatPreset[] = [
  ...LOCALE_CURRENCY_PRESETS,
  ...LOCALE_DATE_PRESETS,
];
