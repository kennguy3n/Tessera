import { describe, it, expect } from "vitest";
import {
  assertString,
  assertOptionalString,
  assertUuid,
  assertId,
  assertProvider,
  assertSafePath,
  assertNumber,
  KNOWN_PROVIDERS,
  DEFAULT_MAX_STRING_LEN,
} from "../ipc/validate";

describe("assertString", () => {
  it("rejects non-strings", () => {
    expect(() => assertString(42, "x")).toThrow(/must be a string/);
    expect(() => assertString(null, "x")).toThrow(/must be a string/);
    expect(() => assertString(undefined, "x")).toThrow(/must be a string/);
  });

  it("rejects empty by default", () => {
    expect(() => assertString("", "x")).toThrow(/must not be empty/);
  });

  it("allows empty when allowEmpty: true", () => {
    expect(assertString("", "x", { allowEmpty: true })).toBe("");
  });

  it("enforces max length", () => {
    expect(() => assertString("a".repeat(11), "x", { maxLen: 10 })).toThrow(
      /exceeds maximum length/,
    );
  });

  it("uses default 1MB cap", () => {
    expect(() =>
      assertString("a".repeat(DEFAULT_MAX_STRING_LEN + 1), "x"),
    ).toThrow(/exceeds maximum length/);
  });

  it("enforces min length", () => {
    expect(() => assertString("ab", "x", { minLen: 5 })).toThrow(
      /at least 5 characters/,
    );
  });

  it("returns the value on success", () => {
    expect(assertString("hello", "x")).toBe("hello");
  });
});

describe("assertOptionalString", () => {
  it("passes through null / undefined", () => {
    expect(assertOptionalString(null, "x")).toBeNull();
    expect(assertOptionalString(undefined, "x")).toBeNull();
  });

  it("validates non-null strings", () => {
    expect(assertOptionalString("hello", "x")).toBe("hello");
    expect(() => assertOptionalString(42, "x")).toThrow(/must be a string/);
  });
});

describe("assertUuid", () => {
  it("accepts a valid v4 UUID", () => {
    expect(assertUuid("550e8400-e29b-41d4-a716-446655440000", "id")).toBe(
      "550e8400-e29b-41d4-a716-446655440000",
    );
  });

  it("accepts v1 / v5 UUIDs (loose UUID match)", () => {
    expect(assertUuid("ec3464d8-58ac-11ee-8c99-0242ac120002", "id")).toMatch(
      /^[0-9a-f-]+$/,
    );
  });

  it("rejects non-UUID strings", () => {
    expect(() => assertUuid("not-a-uuid", "id")).toThrow(/must be a valid UUID/);
    expect(() => assertUuid("123", "id")).toThrow(/must be a valid UUID/);
  });
});

describe("assertId", () => {
  it("accepts slugs / hashes / colon-separated keys", () => {
    expect(assertId("source:abc-123", "x")).toBe("source:abc-123");
    expect(assertId("file_id.bin", "x")).toBe("file_id.bin");
  });

  it("rejects shell metacharacters", () => {
    expect(() => assertId("../etc/passwd", "x")).toThrow(/alphanumerics/);
    expect(() => assertId("evil; rm -rf /", "x")).toThrow(/alphanumerics/);
  });
});

describe("assertProvider", () => {
  it("accepts every known provider", () => {
    for (const provider of KNOWN_PROVIDERS) {
      expect(assertProvider(provider)).toBe(provider);
    }
  });

  it("rejects unknown providers", () => {
    // Freshdesk is audited but intentionally NOT wired (its OAuth
    // endpoint shape is not a verified per-subdomain authorize/token
    // pair), so it stays a useful "unknown" example. Zendesk and
    // ServiceNow, by contrast, ship in tranche 6 on the per-instance
    // URL seam and are asserted as known above.
    expect(() => assertProvider("freshdesk")).toThrow(/Unknown provider/);
    expect(() => assertProvider("google")).toThrow(/Unknown provider/);
  });

  it("uses provided name in errors", () => {
    expect(() => assertProvider(42, "providerArg")).toThrow(/providerArg/);
  });
});

describe("assertSafePath", () => {
  const safeRoots = ["/tmp", "/home/user/Downloads"];

  it("accepts paths inside safe roots", () => {
    expect(assertSafePath("/tmp/output.txt", safeRoots)).toBe("/tmp/output.txt");
    expect(assertSafePath("/home/user/Downloads/x.csv", safeRoots)).toBe(
      "/home/user/Downloads/x.csv",
    );
  });

  it("rejects relative paths", () => {
    expect(() => assertSafePath("relative/path", safeRoots)).toThrow(
      /must be an absolute path/,
    );
  });

  it("rejects path traversal attempts", () => {
    expect(() => assertSafePath("/tmp/../etc/passwd", safeRoots)).toThrow(
      /outside the allowed locations/,
    );
  });

  it("rejects unrelated absolute paths", () => {
    expect(() => assertSafePath("/etc/passwd", safeRoots)).toThrow(
      /outside the allowed locations/,
    );
  });
});

describe("assertNumber", () => {
  it("accepts finite numbers", () => {
    expect(assertNumber(42, "x")).toBe(42);
    expect(assertNumber(0, "x")).toBe(0);
    expect(assertNumber(-3.14, "x")).toBe(-3.14);
  });

  it("rejects non-numbers", () => {
    expect(() => assertNumber("42", "x")).toThrow(/finite number/);
    expect(() => assertNumber(NaN, "x")).toThrow(/finite number/);
    expect(() => assertNumber(Infinity, "x")).toThrow(/finite number/);
  });

  it("enforces ranges", () => {
    expect(() => assertNumber(15, "x", { max: 10 })).toThrow();
    expect(() => assertNumber(-1, "x", { min: 0 })).toThrow();
  });

  it("enforces integer when requested", () => {
    expect(assertNumber(5, "x", { integer: true })).toBe(5);
    expect(() => assertNumber(5.5, "x", { integer: true })).toThrow();
  });
});
