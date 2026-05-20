import { describe, it, expect } from "vitest";
import { sanitizeUrl } from "../utils/safeUrl";

describe("sanitizeUrl", () => {
  it("preserves http and https schemes", () => {
    expect(sanitizeUrl("https://example.com/path?q=1")).toBe(
      "https://example.com/path?q=1",
    );
    expect(sanitizeUrl("http://example.com")).toBe("http://example.com");
  });

  it("preserves mailto and tel schemes", () => {
    expect(sanitizeUrl("mailto:hello@example.com")).toBe(
      "mailto:hello@example.com",
    );
    expect(sanitizeUrl("tel:+1234567890")).toBe("tel:+1234567890");
  });

  it("preserves in-page anchors", () => {
    expect(sanitizeUrl("#section-2")).toBe("#section-2");
  });

  it("preserves protocol-relative and absolute paths", () => {
    expect(sanitizeUrl("//cdn.example.com/img.png")).toBe(
      "//cdn.example.com/img.png",
    );
    expect(sanitizeUrl("/pricing")).toBe("/pricing");
    expect(sanitizeUrl("./about")).toBe("./about");
    expect(sanitizeUrl("../parent")).toBe("../parent");
  });

  it("treats bare paths without a scheme as relative", () => {
    expect(sanitizeUrl("pricing")).toBe("pricing");
    expect(sanitizeUrl("signup?ref=x")).toBe("signup?ref=x");
    expect(sanitizeUrl("page#fragment")).toBe("page#fragment");
  });

  it("rejects javascript: URLs (case-insensitive)", () => {
    expect(sanitizeUrl("javascript:alert(1)")).toBe("#");
    expect(sanitizeUrl("JavaScript:alert(1)")).toBe("#");
    expect(sanitizeUrl("JAVASCRIPT:alert(document.cookie)")).toBe("#");
  });

  it("rejects javascript: URLs even when smuggled past whitespace / control chars", () => {
    // Browsers strip these before parsing the URL — so must we.
    expect(sanitizeUrl(" javascript:alert(1)")).toBe("#");
    expect(sanitizeUrl("\tjavascript:alert(1)")).toBe("#");
    expect(sanitizeUrl("\u0000\u0001javascript:alert(1)")).toBe("#");
    expect(sanitizeUrl("\u000bjavascript:alert(1)")).toBe("#");
    // Spaces between the j and the colon
    expect(sanitizeUrl("java\nscript:alert(1)")).toBe("#");
  });

  it("rejects data: URLs", () => {
    expect(sanitizeUrl("data:text/html,<script>alert(1)</script>")).toBe("#");
    expect(sanitizeUrl("data:image/svg+xml;base64,PHN2Zw==")).toBe("#");
  });

  it("rejects vbscript:, file:, chrome:, about: schemes", () => {
    expect(sanitizeUrl("vbscript:msgbox(1)")).toBe("#");
    expect(sanitizeUrl("file:///etc/passwd")).toBe("#");
    expect(sanitizeUrl("chrome://settings")).toBe("#");
    expect(sanitizeUrl("about:blank")).toBe("#");
  });

  it("returns fallback for non-string and empty inputs", () => {
    expect(sanitizeUrl(undefined)).toBe("#");
    expect(sanitizeUrl(null)).toBe("#");
    expect(sanitizeUrl(42)).toBe("#");
    expect(sanitizeUrl("")).toBe("#");
    // All-whitespace collapses to empty after cleanup
    expect(sanitizeUrl("   \t\n")).toBe("#");
  });

  it("returns fallback for absurdly long URLs", () => {
    const long = "https://example.com/" + "a".repeat(3000);
    expect(sanitizeUrl(long)).toBe("#");
  });

  it("accepts a caller-supplied fallback", () => {
    expect(sanitizeUrl("javascript:1", "/home")).toBe("/home");
  });
});
