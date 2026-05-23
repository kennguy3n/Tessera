import { describe, it, expect, vi } from "vitest";

// `parseListModelsOverrides` validates the untrusted draft-state
// payload sent by the renderer's "List models" button. Tests both
// the happy path (apiUrl + providerType) and the defensive
// path (malformed payloads must not crash the IPC handler — the
// handler degrades to the persisted config in those cases).

vi.mock("electron", () => ({
  ipcMain: {
    removeHandler: vi.fn(),
    handle: vi.fn(),
  },
}));

import { parseListModelsOverrides } from "../ipc/settings";

describe("parseListModelsOverrides — happy paths", () => {
  it("extracts apiUrl when provided as a string", () => {
    expect(
      parseListModelsOverrides({ apiUrl: "https://override.example.com/v1" }),
    ).toEqual({ apiUrl: "https://override.example.com/v1" });
  });

  it("extracts providerType when the value is a known type", () => {
    expect(parseListModelsOverrides({ providerType: "openai_compatible" }))
      .toEqual({ providerType: "openai_compatible" });
    expect(parseListModelsOverrides({ providerType: "anthropic" })).toEqual({
      providerType: "anthropic",
    });
  });

  it("accepts both fields in the same payload", () => {
    expect(
      parseListModelsOverrides({
        apiUrl: "https://x.example.com",
        providerType: "openai_compatible",
      }),
    ).toEqual({
      apiUrl: "https://x.example.com",
      providerType: "openai_compatible",
    });
  });

  it("extracts enabled when provided as a boolean (round 12 ANALYSIS_002)", () => {
    // The form's `enabled` is forwarded as a draft override so a
    // user who has just toggled the provider on in the form (but
    // not yet saved) can still successfully list models. The
    // handler gates on the EFFECTIVE enabled (override merged
    // atop persisted) rather than the persisted-only flag.
    expect(parseListModelsOverrides({ enabled: true })).toEqual({
      enabled: true,
    });
    expect(parseListModelsOverrides({ enabled: false })).toEqual({
      enabled: false,
    });
  });

  it("accepts all three fields in the same payload", () => {
    expect(
      parseListModelsOverrides({
        apiUrl: "https://x.example.com",
        providerType: "anthropic",
        enabled: true,
      }),
    ).toEqual({
      apiUrl: "https://x.example.com",
      providerType: "anthropic",
      enabled: true,
    });
  });

  it("preserves an empty apiUrl (downstream handler decides what to do with it)", () => {
    // The handler explicitly checks `!provider.apiUrl.trim()` and
    // returns a clear error — the parser must not silently drop
    // an empty string, or the user would see the persisted URL
    // get used even though they cleared the form field.
    expect(parseListModelsOverrides({ apiUrl: "" })).toEqual({ apiUrl: "" });
  });
});

describe("parseListModelsOverrides — defensive paths", () => {
  it("returns empty when given undefined / null / non-object", () => {
    expect(parseListModelsOverrides(undefined)).toEqual({});
    expect(parseListModelsOverrides(null)).toEqual({});
    expect(parseListModelsOverrides("openai_compatible")).toEqual({});
    expect(parseListModelsOverrides(42)).toEqual({});
    expect(parseListModelsOverrides(true)).toEqual({});
  });

  it("drops apiUrl when value is not a string", () => {
    expect(parseListModelsOverrides({ apiUrl: 42 })).toEqual({});
    expect(parseListModelsOverrides({ apiUrl: null })).toEqual({});
    expect(parseListModelsOverrides({ apiUrl: { url: "..." } })).toEqual({});
  });

  it("drops providerType when value is not a known type", () => {
    // Unknown providerType from a newer renderer must NOT crash —
    // the field is silently dropped and the handler falls back to
    // the persisted providerType for that field. This is the
    // forward-compat path documented in the parser.
    expect(parseListModelsOverrides({ providerType: "future_provider" }))
      .toEqual({});
    expect(parseListModelsOverrides({ providerType: 1 })).toEqual({});
    expect(parseListModelsOverrides({ providerType: null })).toEqual({});
  });

  it("drops enabled when value is not a boolean (round 12 ANALYSIS_002)", () => {
    // Strings, numbers, null, and undefined all dropped — the
    // handler falls back to the persisted `enabled` for that field
    // (the documented degrade-gracefully invariant).
    expect(parseListModelsOverrides({ enabled: "true" })).toEqual({});
    expect(parseListModelsOverrides({ enabled: 1 })).toEqual({});
    expect(parseListModelsOverrides({ enabled: null })).toEqual({});
    expect(parseListModelsOverrides({ enabled: undefined })).toEqual({});
    expect(parseListModelsOverrides({ enabled: {} })).toEqual({});
  });

  it("ignores unrelated fields without error", () => {
    expect(
      parseListModelsOverrides({
        apiUrl: "https://x",
        apiKey: "should be dropped silently",
        somethingElse: { nested: true },
      }),
    ).toEqual({ apiUrl: "https://x" });
  });

  it("never returns apiKey in the parsed result (security invariant)", () => {
    // Plaintext API keys must NEVER traverse IPC — even if the
    // renderer mistakenly attached one to the payload, the parser
    // drops it. Codified here so a future refactor that adds
    // `apiKey` to the override type triggers a test failure.
    const result = parseListModelsOverrides({ apiKey: "sk-leaked" });
    expect(result).not.toHaveProperty("apiKey");
    expect(Object.keys(result)).not.toContain("apiKey");
  });
});
