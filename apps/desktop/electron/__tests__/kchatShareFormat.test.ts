/**
 * Unit tests for share-format / delivery selection (Session 8
 * Task 4) — `selectShareDelivery` and its guards.
 */
import { describe, it, expect } from "vitest";
import {
  selectShareDelivery,
  isShareFormat,
  isShareDelivery,
  SHARE_FORMATS,
  SHARE_DELIVERIES,
} from "../kchat/kchatShareFormat";

describe("isShareFormat / isShareDelivery", () => {
  it("accepts every declared format and delivery", () => {
    for (const f of SHARE_FORMATS) expect(isShareFormat(f)).toBe(true);
    for (const d of SHARE_DELIVERIES) expect(isShareDelivery(d)).toBe(true);
  });

  it("rejects unknown / non-string values", () => {
    expect(isShareFormat("rtf")).toBe(false);
    expect(isShareFormat(42)).toBe(false);
    expect(isShareFormat(null)).toBe(false);
    expect(isShareDelivery("email")).toBe(false);
    expect(isShareDelivery(undefined)).toBe(false);
  });
});

describe("selectShareDelivery", () => {
  it("defaults to markdown attachment (backward compatible)", () => {
    expect(selectShareDelivery({})).toEqual({
      delivery: "attachment",
      format: "markdown",
      requiresExport: true,
      isBinary: false,
    });
  });

  it("treats null delivery/format as the defaults", () => {
    expect(selectShareDelivery({ delivery: null, format: null })).toEqual({
      delivery: "attachment",
      format: "markdown",
      requiresExport: true,
      isBinary: false,
    });
  });

  it("flags PDF and DOCX as binary attachments requiring export", () => {
    expect(selectShareDelivery({ format: "pdf" })).toMatchObject({
      format: "pdf",
      isBinary: true,
      requiresExport: true,
    });
    expect(selectShareDelivery({ format: "docx" })).toMatchObject({
      format: "docx",
      isBinary: true,
      requiresExport: true,
    });
  });

  it("treats html/json as non-binary attachments", () => {
    expect(selectShareDelivery({ format: "html" }).isBinary).toBe(false);
    expect(selectShareDelivery({ format: "json" }).isBinary).toBe(false);
  });

  it("deeplink delivery skips export regardless of format", () => {
    const plan = selectShareDelivery({ delivery: "deeplink", format: "pdf" });
    expect(plan.delivery).toBe("deeplink");
    expect(plan.requiresExport).toBe(false);
    // Format is retained (for the audit row) even though no export runs.
    expect(plan.format).toBe("pdf");
    expect(plan.isBinary).toBe(true);
  });

  it("throws on an invalid delivery", () => {
    expect(() => selectShareDelivery({ delivery: "carrier-pigeon" })).toThrow(
      /invalid share delivery/i,
    );
  });

  it("throws on an invalid format", () => {
    expect(() => selectShareDelivery({ format: "rtf" })).toThrow(
      /invalid share format/i,
    );
  });
});
