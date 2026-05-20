import { describe, it, expect } from "vitest";
import { sanitizeIconSpec } from "../utils/iconSpec";

describe("sanitizeIconSpec", () => {
  it("accepts well-formed lucide specs", () => {
    expect(sanitizeIconSpec("lucide:home")).toBe("lucide:home");
    expect(sanitizeIconSpec("lucide:check-circle")).toBe(
      "lucide:check-circle",
    );
    expect(sanitizeIconSpec("lucide:TrendingUp")).toBe("lucide:TrendingUp");
    expect(sanitizeIconSpec("lucide:3d-printer")).toBe("lucide:3d-printer");
  });

  it("accepts well-formed phosphor specs", () => {
    expect(sanitizeIconSpec("phosphor:check-circle")).toBe(
      "phosphor:check-circle",
    );
    expect(sanitizeIconSpec("phosphor:House")).toBe("phosphor:House");
  });

  it("rejects unknown icon sets", () => {
    expect(sanitizeIconSpec("material:home")).toBeNull();
    expect(sanitizeIconSpec("fa:check")).toBeNull();
  });

  it("rejects specs that contain }} breakout payload", () => {
    expect(
      sanitizeIconSpec("lucide:check}}<script>alert(1)</script>{{icon:x"),
    ).toBeNull();
  });

  it("rejects specs without a colon separator", () => {
    expect(sanitizeIconSpec("lucidehome")).toBeNull();
    expect(sanitizeIconSpec("home")).toBeNull();
    expect(sanitizeIconSpec(":home")).toBeNull();
    expect(sanitizeIconSpec("lucide:")).toBeNull();
  });

  it("rejects non-string values", () => {
    expect(sanitizeIconSpec(undefined)).toBeNull();
    expect(sanitizeIconSpec(null)).toBeNull();
    expect(sanitizeIconSpec(42)).toBeNull();
    expect(sanitizeIconSpec({})).toBeNull();
  });

  it("rejects overly long specs", () => {
    expect(sanitizeIconSpec(`lucide:${"a".repeat(100)}`)).toBeNull();
  });

  it("rejects names with spaces or angle brackets", () => {
    expect(sanitizeIconSpec("lucide:home sweet")).toBeNull();
    expect(sanitizeIconSpec("lucide:<script>")).toBeNull();
    expect(sanitizeIconSpec("lucide:a>b")).toBeNull();
  });

  it("trims leading/trailing whitespace from the spec", () => {
    expect(sanitizeIconSpec("  lucide:home  ")).toBe("lucide:home");
  });
});
