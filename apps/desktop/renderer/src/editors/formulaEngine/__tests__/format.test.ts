/**
 * Phase 16 Task 14 — cell formatting tests.
 *
 * Covers the `applyCellFormat()` number-format mini-language (currency,
 * percent, decimals, thousands, custom prefixes/suffixes), date-format
 * tokens (`yyyy-mm-dd`, `m/d/yyyy`, `mmm`, `dddd`, `hh:mm:ss`), and
 * the `cellFormatStyle()` CSS payload (alignment + bold/italic/color).
 */
import { describe, expect, it } from "vitest";

import {
  applyCellFormat,
  cellFormatStyle,
  valueToDateSerial,
} from "../format";
import { dateToSerial } from "../functions/date";
import type { FormulaValue } from "../types";

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

  it("coerces numeric strings when the pattern wants a number", () => {
    expect(applyCellFormat("123.4", { numberFormat: "0.00" })).toBe("123.40");
  });
});

describe("applyCellFormat — date formats", () => {
  // Excel serial 36526 = 2000-01-01.
  const newMillennium: FormulaValue = dateToSerial(
    new Date(Date.UTC(2000, 0, 1)),
  );

  it("formats with yyyy-mm-dd", () => {
    expect(
      applyCellFormat(newMillennium, { numberFormat: "yyyy-mm-dd" }),
    ).toBe("2000-01-01");
  });

  it("formats with m/d/yyyy (US-style)", () => {
    expect(
      applyCellFormat(newMillennium, { numberFormat: "m/d/yyyy" }),
    ).toBe("1/1/2000");
  });

  it("renders month name (mmm) and weekday name (dddd)", () => {
    expect(applyCellFormat(newMillennium, { numberFormat: "mmm" })).toBe(
      "Jan",
    );
    expect(applyCellFormat(newMillennium, { numberFormat: "dddd" })).toBe(
      "Saturday",
    );
  });

  it("disambiguates m → minutes after an h token", () => {
    // 2024-06-15 13:45:30 UTC → serial includes the time fraction.
    const ts = dateToSerial(new Date(Date.UTC(2024, 5, 15, 13, 45, 30)));
    expect(applyCellFormat(ts, { numberFormat: "hh:mm:ss" })).toBe("13:45:30");
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
