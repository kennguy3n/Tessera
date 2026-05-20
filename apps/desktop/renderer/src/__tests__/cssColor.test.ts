import { describe, it, expect } from "vitest";
import { sanitizeCssColor } from "../utils/cssColor";

const FALLBACK = "#7C3AED";

describe("sanitizeCssColor", () => {
  it("accepts standard 6-digit hex", () => {
    expect(sanitizeCssColor("#0EA5E9", FALLBACK)).toBe("#0EA5E9");
  });

  it("accepts 3- and 8-digit hex", () => {
    expect(sanitizeCssColor("#abc", FALLBACK)).toBe("#abc");
    expect(sanitizeCssColor("#abcdef00", FALLBACK)).toBe("#abcdef00");
  });

  it("accepts rgb / rgba", () => {
    expect(sanitizeCssColor("rgb(255, 0, 128)", FALLBACK)).toBe(
      "rgb(255, 0, 128)",
    );
    expect(sanitizeCssColor("rgba(0, 0, 0, 0.5)", FALLBACK)).toBe(
      "rgba(0, 0, 0, 0.5)",
    );
  });

  it("accepts hsl / hsla", () => {
    expect(sanitizeCssColor("hsl(120, 50%, 50%)", FALLBACK)).toBe(
      "hsl(120, 50%, 50%)",
    );
  });

  it("accepts a small set of named keywords", () => {
    expect(sanitizeCssColor("transparent", FALLBACK)).toBe("transparent");
    expect(sanitizeCssColor("currentColor", FALLBACK)).toBe("currentColor");
    expect(sanitizeCssColor("white", FALLBACK)).toBe("white");
  });

  it("rejects values containing a semicolon (CSS-attribute breakout)", () => {
    const attack = "red; background: url(http://evil/)";
    expect(sanitizeCssColor(attack, FALLBACK)).toBe(FALLBACK);
  });

  it("rejects values containing a curly brace", () => {
    expect(sanitizeCssColor("red} body {color:blue", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects values containing quotes or angle brackets", () => {
    expect(sanitizeCssColor('red" onload="x', FALLBACK)).toBe(FALLBACK);
    expect(sanitizeCssColor("red'", FALLBACK)).toBe(FALLBACK);
    expect(sanitizeCssColor("</style><script>", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects values containing CSS comments", () => {
    expect(sanitizeCssColor("red/*comment*/", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects url() function calls", () => {
    expect(sanitizeCssColor("url(http://evil/)", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects non-string values", () => {
    expect(sanitizeCssColor(undefined, FALLBACK)).toBe(FALLBACK);
    expect(sanitizeCssColor(null, FALLBACK)).toBe(FALLBACK);
    expect(sanitizeCssColor(42, FALLBACK)).toBe(FALLBACK);
    expect(sanitizeCssColor({}, FALLBACK)).toBe(FALLBACK);
  });

  it("rejects suspiciously long values", () => {
    const long = "#" + "a".repeat(80);
    expect(sanitizeCssColor(long, FALLBACK)).toBe(FALLBACK);
  });

  it("rejects unknown function names", () => {
    expect(sanitizeCssColor("expression(alert(1))", FALLBACK)).toBe(FALLBACK);
  });

  it("rejects empty / whitespace-only values", () => {
    expect(sanitizeCssColor("", FALLBACK)).toBe(FALLBACK);
    expect(sanitizeCssColor("   ", FALLBACK)).toBe(FALLBACK);
  });
});
