import { describe, expect, it } from "vitest";
import {
  LOCALE_CURRENCY_GROUP,
  LOCALE_CURRENCY_PRESETS,
  LOCALE_CURRENCY_SPECS,
  LOCALE_DATE_GROUP,
  LOCALE_DATE_PRESETS,
  LOCALE_FORMAT_PRESETS,
  buildCurrencyPattern,
  currencyFractionDigits,
  currencyPlacement,
  currencySymbol,
} from "../localeNumberFormats";
import { formatValueWithPattern } from "../formulaEngine/format";

const SAMPLE = 1234.56;

describe("buildCurrencyPattern", () => {
  it("places a pure-glyph prefix symbol flush against the digits", () => {
    const pattern = buildCurrencyPattern({
      symbol: "£",
      placement: "prefix",
      fractionDigits: 2,
    });
    expect(pattern).toBe('"£"#,##0.00');
    expect(formatValueWithPattern(SAMPLE, pattern)).toBe("£1,234.56");
  });

  it("pads a multi-letter prefix symbol so it doesn't touch the digits", () => {
    const pattern = buildCurrencyPattern({
      symbol: "CHF",
      placement: "prefix",
      fractionDigits: 2,
    });
    expect(pattern).toBe('"CHF "#,##0.00');
    expect(formatValueWithPattern(SAMPLE, pattern)).toBe("CHF 1,234.56");
  });

  it("renders a suffix symbol after a space", () => {
    const pattern = buildCurrencyPattern({
      symbol: "€",
      placement: "suffix",
      fractionDigits: 2,
    });
    expect(pattern).toBe('#,##0.00" €"');
    expect(formatValueWithPattern(SAMPLE, pattern)).toBe("1,234.56 €");
  });

  it("drops the decimal section when fractionDigits is 0", () => {
    const pattern = buildCurrencyPattern({
      symbol: "¥",
      placement: "prefix",
      fractionDigits: 0,
    });
    expect(pattern).toBe('"¥"#,##0');
    expect(formatValueWithPattern(SAMPLE, pattern)).toBe("¥1,235");
  });

  it("clamps and truncates fractionDigits to [0, 20]", () => {
    expect(
      buildCurrencyPattern({
        symbol: "$",
        placement: "prefix",
        fractionDigits: -3,
      }),
    ).toBe('"$"#,##0');
    expect(
      buildCurrencyPattern({
        symbol: "$",
        placement: "prefix",
        fractionDigits: 2.9,
      }),
    ).toBe('"$"#,##0.00');
    const wide = buildCurrencyPattern({
      symbol: "$",
      placement: "prefix",
      fractionDigits: 99,
    });
    expect(wide).toBe(`"$"#,##0.${"0".repeat(20)}`);
  });
});

describe("Intl-derived currency facts (loose, ICU-stable invariants)", () => {
  it("derives stable symbols under the neutral en locale", () => {
    expect(currencySymbol("USD")).toBe("$");
    expect(currencySymbol("EUR")).toBe("€");
    expect(currencySymbol("GBP")).toBe("£");
    expect(currencySymbol("JPY")).toBe("¥");
  });

  it("uses the conventional fraction-digit count per currency", () => {
    expect(currencyFractionDigits("USD")).toBe(2);
    expect(currencyFractionDigits("EUR")).toBe(2);
    expect(currencyFractionDigits("JPY")).toBe(0);
    expect(currencyFractionDigits("KRW")).toBe(0);
  });

  it("reads symbol placement from the preset's own locale", () => {
    expect(currencyPlacement("en-GB", "GBP")).toBe("prefix");
    expect(currencyPlacement("de-DE", "EUR")).toBe("suffix");
  });
});

describe("LOCALE_CURRENCY_PRESETS", () => {
  it("emits one preset per spec, grouped + non-empty", () => {
    expect(LOCALE_CURRENCY_PRESETS).toHaveLength(LOCALE_CURRENCY_SPECS.length);
    for (const preset of LOCALE_CURRENCY_PRESETS) {
      expect(preset.group).toBe(LOCALE_CURRENCY_GROUP);
      expect(preset.pattern && preset.pattern.length).toBeGreaterThan(0);
      expect(preset.label.length).toBeGreaterThan(0);
    }
  });

  it("preset ids mirror their specs", () => {
    expect(LOCALE_CURRENCY_PRESETS.map((p) => p.id)).toEqual(
      LOCALE_CURRENCY_SPECS.map((s) => s.id),
    );
  });

  it("has no duplicate patterns (so reverse-lookup stays unambiguous)", () => {
    const patterns = LOCALE_FORMAT_PRESETS.map((p) => p.pattern);
    expect(new Set(patterns).size).toBe(patterns.length);
  });
});

describe("LOCALE_DATE_PRESETS", () => {
  it("are all grouped under the locale date label with a pattern", () => {
    expect(LOCALE_DATE_PRESETS.length).toBeGreaterThan(0);
    for (const preset of LOCALE_DATE_PRESETS) {
      expect(preset.group).toBe(LOCALE_DATE_GROUP);
      expect(preset.pattern && preset.pattern.length).toBeGreaterThan(0);
    }
  });
});

describe("LOCALE_FORMAT_PRESETS", () => {
  it("concatenates currency presets before date presets", () => {
    expect(LOCALE_FORMAT_PRESETS).toEqual([
      ...LOCALE_CURRENCY_PRESETS,
      ...LOCALE_DATE_PRESETS,
    ]);
  });
});
