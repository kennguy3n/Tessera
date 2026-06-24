/**
 * cell formatting tests.
 *
 * Covers the `applyCellFormat()` number-format mini-language (currency,
 * percent, decimals, thousands, custom prefixes/suffixes), date-format
 * tokens (`yyyy-mm-dd`, `m/d/yyyy`, `mmm`, `dddd`, `hh:mm:ss`), and
 * the `cellFormatStyle()` CSS payload (alignment + bold/italic/color).
 */
import { describe, expect, it } from "vitest";

import { applyCellFormat, cellFormatStyle, valueToDateSerial } from "../format";
import { dateToSerial } from "../functions/date";
import type { FormulaValue } from "../types";
import {
  NUMBER_FORMAT_PRESETS,
  presetIdForPattern,
} from "../../sheetFormatting";

describe("applyCellFormat — number formats", () => {
  it("renders General when no format is given", () => {
    expect(applyCellFormat(1234.5, undefined)).toBe("1234.5");
    expect(applyCellFormat(0, undefined)).toBe("0");
    expect(applyCellFormat(null, undefined)).toBe("");
  });

  it("formats integers with thousands grouping", () => {
    expect(applyCellFormat(1234567, { numberFormat: "#,##0" })).toBe(
      "1,234,567",
    );
  });

  it("rounds decimals to the specified precision", () => {
    expect(applyCellFormat(3.14159, { numberFormat: "0.00" })).toBe("3.14");
    expect(applyCellFormat(3.145, { numberFormat: "0.00" })).toBe("3.15");
  });

  it("renders percent by scaling the value by 100", () => {
    expect(applyCellFormat(0.25, { numberFormat: "0%" })).toBe("25%");
    expect(applyCellFormat(0.1234, { numberFormat: "0.00%" })).toBe("12.34%");
  });

  it("preserves a currency prefix literal", () => {
    expect(applyCellFormat(1234.5, { numberFormat: "$#,##0.00" })).toBe(
      "$1,234.50",
    );
  });

  it("renders negative numbers with a leading minus", () => {
    expect(applyCellFormat(-42, { numberFormat: "#,##0" })).toBe("-42");
    expect(applyCellFormat(-0.5, { numberFormat: "0.00" })).toBe("-0.50");
  });

  it("does not emit a spurious minus when a negative rounds to zero", () => {
    // -0.0001 under "0.00" rounds to zero; Excel shows "0.00", never "-0.00".
    expect(applyCellFormat(-0.0001, { numberFormat: "0.00" })).toBe("0.00");
    expect(applyCellFormat(-0.4, { numberFormat: "0" })).toBe("0");
    expect(applyCellFormat(-0.001, { numberFormat: "#,##0.00" })).toBe("0.00");
    // A magnitude that survives rounding still keeps its sign.
    expect(applyCellFormat(-0.006, { numberFormat: "0.00" })).toBe("-0.01");
  });

  it("coerces numeric strings when the pattern wants a number", () => {
    expect(applyCellFormat("123.4", { numberFormat: "0.00" })).toBe("123.40");
  });

  it("surfaces a non-finite value as an error, not 'NaN'/'Infinity'", () => {
    expect(applyCellFormat(NaN, { numberFormat: "#,##0.00" })).toBe("#NUM!");
    expect(applyCellFormat(Infinity, { numberFormat: "0.0" })).toBe("#NUM!");
    expect(applyCellFormat(-Infinity, { numberFormat: "0" })).toBe("#NUM!");
  });
});

describe("applyCellFormat — multi-section custom formats", () => {
  it("uses a dedicated negative section without doubling the sign", () => {
    const fmt = { numberFormat: "#,##0.00;(#,##0.00)" };
    expect(applyCellFormat(1234.5, fmt)).toBe("1,234.50");
    expect(applyCellFormat(-1234.5, fmt)).toBe("(1,234.50)");
  });

  it("routes zero to the third section", () => {
    const fmt = { numberFormat: '#,##0;(#,##0);"–"' };
    expect(applyCellFormat(42, fmt)).toBe("42");
    expect(applyCellFormat(-42, fmt)).toBe("(42)");
    expect(applyCellFormat(0, fmt)).toBe("–");
  });

  it("treats zero as positive when there is no zero section", () => {
    const fmt = { numberFormat: "#,##0.00;(#,##0.00)" };
    expect(applyCellFormat(0, fmt)).toBe("0.00");
  });

  it("routes a negative that rounds to zero away from the negative section", () => {
    // -0.0001 under "…;(…)" must render "0.00", never "(0.00)".
    const paren = { numberFormat: "#,##0.00;(#,##0.00)" };
    expect(applyCellFormat(-0.0001, paren)).toBe("0.00");
    // A magnitude that survives rounding still uses the negative section.
    expect(applyCellFormat(-1.5, paren)).toBe("(1.50)");
    // With a dedicated zero section, the rounds-to-zero negative lands there.
    const withZero = { numberFormat: '#,##0.00;(#,##0.00);"zero"' };
    expect(applyCellFormat(-0.0001, withZero)).toBe("zero");
    // Percent + scale sections honour their own display precision.
    expect(applyCellFormat(-0.0001, { numberFormat: "0.0%;(0.0%)" })).toBe(
      "0.0%",
    );
  });

  it("hides values with an empty section", () => {
    // `0;-0;` → zeros render as nothing.
    expect(applyCellFormat(0, { numberFormat: "0;-0;" })).toBe("");
    expect(applyCellFormat(5, { numberFormat: "0;-0;" })).toBe("5");
  });

  it("applies the text section to non-numeric strings", () => {
    const fmt = { numberFormat: '0;-0;0;"» "@' };
    expect(applyCellFormat("note", fmt)).toBe("» note");
    // Numeric strings still go through the numeric sections.
    expect(applyCellFormat("12", fmt)).toBe("12");
  });
});

describe("applyCellFormat — scaling and bracket directives", () => {
  it("scales by 1000 per trailing comma", () => {
    expect(applyCellFormat(1234567, { numberFormat: "#,##0," })).toBe("1,235");
    expect(applyCellFormat(1234567, { numberFormat: '#,##0,"K"' })).toBe(
      "1,235K",
    );
    expect(applyCellFormat(1234567890, { numberFormat: '0.0,,"M"' })).toBe(
      "1234.6M",
    );
  });

  it("treats a comma immediately left of the decimal point as scaling", () => {
    // `#,##0,.00`: the integer is shown in thousands, then two decimals.
    // 1234567 / 1000 = 1234.567 → "1,234.57".
    expect(applyCellFormat(1234567, { numberFormat: "#,##0,.00" })).toBe(
      "1,234.57",
    );
    // Two pre-decimal commas scale by a million.
    expect(applyCellFormat(1234567890, { numberFormat: "#,##0,,.0" })).toBe(
      "1,234.6",
    );
  });

  it("counts a pre-decimal comma once even when it is also trailing", () => {
    // `#,##0,.` has no fractional digit, so the lone comma is simultaneously
    // pre-dot and trailing — it must scale by 1000, not 1,000,000.
    expect(applyCellFormat(1234567, { numberFormat: "#,##0,." })).toBe("1,235");
  });

  it("keeps interior commas as thousands separators (not scaling)", () => {
    expect(applyCellFormat(1234567, { numberFormat: "#,##0" })).toBe(
      "1,234,567",
    );
  });

  it("strips colour / locale brackets instead of emitting them", () => {
    expect(applyCellFormat(1234, { numberFormat: "[Red]#,##0" })).toBe("1,234");
    expect(applyCellFormat(1234, { numberFormat: "[$-409]#,##0" })).toBe(
      "1,234",
    );
    // A negative section with a colour directive renders cleanly.
    expect(applyCellFormat(-99, { numberFormat: "#,##0;[Red](#,##0)" })).toBe(
      "(99)",
    );
  });
});

describe("applyCellFormat — date formats", () => {
  // Excel serial 36526 = 2000-01-01.
  const newMillennium: FormulaValue = dateToSerial(
    new Date(Date.UTC(2000, 0, 1)),
  );

  it("formats with yyyy-mm-dd", () => {
    expect(applyCellFormat(newMillennium, { numberFormat: "yyyy-mm-dd" })).toBe(
      "2000-01-01",
    );
  });

  it("formats with m/d/yyyy (US-style)", () => {
    expect(applyCellFormat(newMillennium, { numberFormat: "m/d/yyyy" })).toBe(
      "1/1/2000",
    );
  });

  it("renders month name (mmm) and weekday name (dddd)", () => {
    expect(applyCellFormat(newMillennium, { numberFormat: "mmm" })).toBe("Jan");
    expect(applyCellFormat(newMillennium, { numberFormat: "dddd" })).toBe(
      "Saturday",
    );
  });

  it("disambiguates m → minutes after an h token", () => {
    // 2024-06-15 13:45:30 UTC → serial includes the time fraction.
    const ts = dateToSerial(new Date(Date.UTC(2024, 5, 15, 13, 45, 30)));
    expect(applyCellFormat(ts, { numberFormat: "hh:mm:ss" })).toBe("13:45:30");
  });

  it("treats an unquoted m/M next to numeric placeholders as a literal, not a date", () => {
    // `#,##0M` (millions suffix, common in finance) must format as a number
    // with a literal "M", not be mis-read as a month-token date.
    expect(applyCellFormat(1234567, { numberFormat: "#,##0M" })).toBe(
      "1,234,567M",
    );
    // With trailing-comma scaling the suffix still rides along as a literal.
    expect(applyCellFormat(1234567, { numberFormat: "0.0,,M" })).toBe("1.2M");
    // A lowercase variant behaves identically.
    expect(applyCellFormat(5000, { numberFormat: "#,##0m" })).toBe("5,000m");
  });

  it("still recognises month-only patterns (no numeric placeholder) as dates", () => {
    expect(applyCellFormat(newMillennium, { numberFormat: "mmmm" })).toBe(
      "January",
    );
  });

  it("renders hours on a 12-hour clock when an AM/PM token is present", () => {
    const at = (h: number, m = 0) =>
      dateToSerial(new Date(Date.UTC(2024, 5, 15, h, m, 0)));
    // Afternoon hour wraps 13 → 1, with the PM marker.
    expect(applyCellFormat(at(13, 30), { numberFormat: "h:mm AM/PM" })).toBe(
      "1:30 PM",
    );
    // Midnight is 12 AM (not 0), noon is 12 PM.
    expect(applyCellFormat(at(0, 0), { numberFormat: "h:mm AM/PM" })).toBe(
      "12:00 AM",
    );
    expect(applyCellFormat(at(12, 0), { numberFormat: "h:mm AM/PM" })).toBe(
      "12:00 PM",
    );
    // `hh` zero-pads the 12-hour value.
    expect(applyCellFormat(at(9, 0), { numberFormat: "hh:mm AM/PM" })).toBe(
      "09:00 AM",
    );
  });

  it("keeps 24-hour rendering when no AM/PM token is present", () => {
    const ts = dateToSerial(new Date(Date.UTC(2024, 5, 15, 13, 30, 0)));
    expect(applyCellFormat(ts, { numberFormat: "hh:mm" })).toBe("13:30");
  });

  it("matches AM/PM case-insensitively and the short A/P form", () => {
    const at = (h: number, m = 0) =>
      dateToSerial(new Date(Date.UTC(2024, 5, 15, h, m, 0)));
    // Lowercase marker -> lowercase output, still 12-hour.
    expect(applyCellFormat(at(13, 30), { numberFormat: "h:mm am/pm" })).toBe(
      "1:30 pm",
    );
    // Mixed case is treated as uppercase (Excel behaviour).
    expect(applyCellFormat(at(9, 0), { numberFormat: "h:mm Am/Pm" })).toBe(
      "9:00 AM",
    );
    // Short A/P form, case-preserving.
    expect(applyCellFormat(at(13, 0), { numberFormat: "h A/P" })).toBe("1 P");
    expect(applyCellFormat(at(9, 0), { numberFormat: "h a/p" })).toBe("9 a");
  });
});

describe("cellFormatStyle", () => {
  it("returns an empty object for an absent format", () => {
    expect(cellFormatStyle(undefined)).toEqual({});
  });

  it("maps align/bold/italic/underline/color/background to CSS", () => {
    const style = cellFormatStyle({
      align: "right",
      bold: true,
      italic: true,
      underline: true,
      color: "#ff0000",
      background: "#ffff00",
    });
    expect(style).toMatchObject({
      textAlign: "right",
      fontWeight: 600,
      fontStyle: "italic",
      textDecoration: "underline",
      color: "#ff0000",
      backgroundColor: "#ffff00",
    });
  });
});

describe("valueToDateSerial", () => {
  it("returns the input when already a number", () => {
    expect(valueToDateSerial(42)).toBe(42);
  });

  it("converts a Date instance back to a serial", () => {
    const d = new Date(Date.UTC(2000, 0, 1));
    expect(valueToDateSerial(d as unknown as FormulaValue)).toBe(
      dateToSerial(d),
    );
  });

  it("returns null for non-numeric, non-Date inputs", () => {
    expect(valueToDateSerial("hello")).toBeNull();
    expect(valueToDateSerial(null)).toBeNull();
    expect(valueToDateSerial(true)).toBeNull();
  });
});

describe("NUMBER_FORMAT_PRESETS — every shipped preset renders", () => {
  // 2024-01-31 14:30:45 UTC, used for the date/time presets.
  const ts = dateToSerial(new Date(Date.UTC(2024, 0, 31, 14, 30, 45)));
  const expected: Record<string, FormulaValue> = {
    general: 1234.567,
    number: 1234.567,
    integer: 1234.567,
    thousands: 1234567,
    millions: 1234567,
    percent: 0.1234,
    "percent-int": 0.1234,
    currency: 1234.567,
    "currency-int": 1234.567,
    accounting: -1234.567,
    date: ts,
    "date-us": ts,
    datetime: ts,
    time: ts,
  };
  const rendered: Record<string, string> = {
    general: "1234.567",
    number: "1,234.57",
    integer: "1,235",
    thousands: "1,235K",
    millions: "1.2M",
    percent: "12.34%",
    "percent-int": "12%",
    currency: "$1,234.57",
    "currency-int": "$1,235",
    accounting: "(1,234.57)",
    date: "2024-01-31",
    "date-us": "1/31/2024",
    datetime: "2024-01-31 14:30",
    time: "14:30:45",
  };

  for (const preset of NUMBER_FORMAT_PRESETS) {
    if (preset.pattern === undefined) continue;
    it(`${preset.id} → ${rendered[preset.id]}`, () => {
      const out = applyCellFormat(expected[preset.id], {
        numberFormat: preset.pattern,
      });
      expect(out).toBe(rendered[preset.id]);
      // No bracket directive or quote artefacts leak into the output.
      expect(out).not.toMatch(/[[\]"]/);
    });
  }
});

describe("presetIdForPattern", () => {
  it("maps known patterns back to their preset id", () => {
    expect(presetIdForPattern(undefined)).toBe("general");
    expect(presetIdForPattern("")).toBe("general");
    expect(presetIdForPattern("#,##0.00")).toBe("number");
    expect(presetIdForPattern("$#,##0")).toBe("currency-int");
    expect(presetIdForPattern("hh:mm:ss")).toBe("time");
  });

  it("returns 'custom' for a hand-entered pattern", () => {
    expect(presetIdForPattern('#,##0;[Red](#,##0);"–"')).toBe("custom");
    expect(presetIdForPattern("0.000")).toBe("custom");
  });
});
