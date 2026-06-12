import { describe, it, expect, beforeEach } from "vitest";
import {
  computeViewSignature,
  defaultViewState,
  loadViewState,
  parseViewState,
  saveViewState,
  serializeViewState,
  viewStateStorageKey,
  type ConceptGraphViewState,
} from "../utils/conceptGraphViewState";

/**
 * Coverage for the per-scope view-state persistence helper: the round-trip
 * (serialize → parse), the defensive parse boundary (corrupt / partial /
 * schema-drifted blobs never throw and degrade to defaults), the storage
 * key scheme, and the order-independent view fingerprint used to decide
 * whether a persisted viewBox still applies on restore.
 */

function sampleState(): ConceptGraphViewState {
  return {
    disabledRelations: ["is_a", "supersedes"],
    disabledStates: ["deleted"],
    labelsAll: true,
    localMode: true,
    localHops: 2,
    selectedId: "node-7",
    scopeFilter: "scope-a",
    viewBox: { x: -10, y: 5, width: 320, height: 240 },
    viewSignature: 123456,
  };
}

describe("serializeViewState / parseViewState round-trip", () => {
  it("preserves every field across a round-trip", () => {
    const state = sampleState();
    expect(parseViewState(serializeViewState(state))).toEqual(state);
  });
});

describe("parseViewState defensive boundary", () => {
  it("returns null for absent / non-JSON / non-object payloads", () => {
    for (const bad of [null, "", "not json", "[]", "42", '"str"', "null"]) {
      expect(parseViewState(bad)).toBeNull();
    }
  });

  it("returns null when the schema version is missing or wrong", () => {
    expect(parseViewState(JSON.stringify({ labelsAll: true }))).toBeNull();
    expect(
      parseViewState(JSON.stringify({ version: 999, labelsAll: true })),
    ).toBeNull();
  });

  it("filters out bogus relation / state enum values", () => {
    const parsed = parseViewState(
      JSON.stringify({
        version: 1,
        disabledRelations: ["is_a", "BOGUS", 42, null],
        disabledStates: ["deleted", "nope", {}],
      }),
    );
    expect(parsed?.disabledRelations).toEqual(["is_a"]);
    expect(parsed?.disabledStates).toEqual(["deleted"]);
  });

  it("falls back to defaults for individually-bad fields without throwing", () => {
    const parsed = parseViewState(
      JSON.stringify({
        version: 1,
        labelsAll: "yes", // wrong type → default false
        localMode: 1, // wrong type → default false
        localHops: 99, // out of range → clamped to 3
        selectedId: 5, // wrong type → null
        scopeFilter: null, // wrong type → "all"
        viewBox: { x: 0, y: 0, width: 0, height: 10 }, // zero width → null
      }),
    );
    expect(parsed).not.toBeNull();
    expect(parsed?.labelsAll).toBe(false);
    expect(parsed?.localMode).toBe(false);
    expect(parsed?.localHops).toBe(3);
    expect(parsed?.selectedId).toBeNull();
    expect(parsed?.scopeFilter).toBe("all");
    expect(parsed?.viewBox).toBeNull();
  });

  it("clamps localHops into [1, 3] and truncates floats", () => {
    const lo = parseViewState(JSON.stringify({ version: 1, localHops: 0 }));
    const hi = parseViewState(JSON.stringify({ version: 1, localHops: 7 }));
    const frac = parseViewState(JSON.stringify({ version: 1, localHops: 2.9 }));
    expect(lo?.localHops).toBe(1);
    expect(hi?.localHops).toBe(3);
    expect(frac?.localHops).toBe(2);
  });

  it("rejects a viewBox with non-finite numbers", () => {
    const parsed = parseViewState(
      JSON.stringify({
        version: 1,
        viewBox: { x: 0, y: 0, width: Number.POSITIVE_INFINITY, height: 10 },
      }),
    );
    // Infinity does not survive JSON, but a NaN-like value still yields null.
    expect(parsed?.viewBox).toBeNull();
  });
});

describe("computeViewSignature", () => {
  it("is order-independent", () => {
    expect(computeViewSignature(["a", "b", "c"])).toBe(
      computeViewSignature(["c", "a", "b"]),
    );
  });

  it("differs when the node set differs", () => {
    expect(computeViewSignature(["a", "b"])).not.toBe(
      computeViewSignature(["a", "b", "c"]),
    );
    expect(computeViewSignature(["a", "b"])).not.toBe(
      computeViewSignature(["a", "x"]),
    );
  });

  it("is 0 for the empty set and an unsigned 32-bit int otherwise", () => {
    expect(computeViewSignature([])).toBe(0);
    const sig = computeViewSignature(["alpha", "beta"]);
    expect(Number.isInteger(sig)).toBe(true);
    expect(sig).toBeGreaterThanOrEqual(0);
    expect(sig).toBeLessThanOrEqual(0xffffffff);
  });
});

describe("storage key + localStorage wrappers", () => {
  beforeEach(() => window.localStorage.clear());

  it("namespaces the key per scope", () => {
    expect(viewStateStorageKey("scope-a")).toBe(
      "tessera.conceptGraph.viewState.scope-a",
    );
    expect(viewStateStorageKey("__default__")).toBe(
      "tessera.conceptGraph.viewState.__default__",
    );
  });

  it("saves and loads a state for a scope", () => {
    saveViewState("scope-a", sampleState());
    expect(loadViewState("scope-a")).toEqual(sampleState());
  });

  it("keeps scopes isolated from each other", () => {
    saveViewState("scope-a", { ...defaultViewState(), labelsAll: true });
    saveViewState("scope-b", { ...defaultViewState(), labelsAll: false });
    expect(loadViewState("scope-a")?.labelsAll).toBe(true);
    expect(loadViewState("scope-b")?.labelsAll).toBe(false);
  });

  it("returns null for an unknown scope", () => {
    expect(loadViewState("never-saved")).toBeNull();
  });

  it("returns null (not a throw) for a corrupt stored blob", () => {
    window.localStorage.setItem(
      viewStateStorageKey("scope-a"),
      "{ not valid json",
    );
    expect(loadViewState("scope-a")).toBeNull();
  });
});
