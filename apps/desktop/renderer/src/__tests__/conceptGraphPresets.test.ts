import { describe, it, expect, beforeEach } from "vitest";
import {
  sanitizePresetName,
  normalizeFilter,
  makePreset,
  upsertPreset,
  upsertPresetByName,
  removePreset,
  findPreset,
  filterMatchesPreset,
  activePresetId,
  parsePresetStore,
  serializePresetStore,
  loadPresetStore,
  savePresetStore,
  defaultPresetStore,
  presetStorageKey,
  newPresetId,
  MAX_PRESET_NAME,
  MAX_PRESETS,
  FALLBACK_PRESET_NAME,
  type PresetFilter,
  type ConceptGraphPreset,
} from "../utils/conceptGraphPresets";

const FILTER: PresetFilter = {
  disabledRelations: ["is_a"],
  disabledStates: ["candidate"],
  scopeFilter: "scope-a",
  localMode: true,
  localHops: 2,
  labelsAll: true,
  decayMode: false,
};

let counter = 0;
const idGen = () => `id-${++counter}`;

beforeEach(() => {
  counter = 0;
  window.localStorage.clear();
});

describe("sanitizePresetName", () => {
  it("trims, collapses whitespace, and bounds length", () => {
    expect(sanitizePresetName("  My   View  ")).toBe("My View");
    expect(sanitizePresetName("x".repeat(MAX_PRESET_NAME + 20)).length).toBe(
      MAX_PRESET_NAME,
    );
  });
  it("falls back when empty after trimming", () => {
    expect(sanitizePresetName("   ")).toBe(FALLBACK_PRESET_NAME);
    expect(sanitizePresetName("")).toBe(FALLBACK_PRESET_NAME);
  });
});

describe("normalizeFilter", () => {
  it("dedupes + validates enums and clamps hops", () => {
    const n = normalizeFilter({
      ...FILTER,
      disabledRelations: ["is_a", "is_a", "bogus" as never],
      disabledStates: ["candidate", "candidate"],
      localHops: 99,
    });
    expect(n.disabledRelations).toEqual(["is_a"]);
    expect(n.disabledStates).toEqual(["candidate"]);
    expect(n.localHops).toBe(3); // clamped to MAX_HOPS
  });
  it("clamps a sub-1 hop count up to 1", () => {
    expect(normalizeFilter({ ...FILTER, localHops: 0 }).localHops).toBe(1);
  });
});

describe("makePreset", () => {
  it("builds a normalized, named, identified preset", () => {
    const p = makePreset("  Tech debt  ", FILTER, idGen);
    expect(p.id).toBe("id-1");
    expect(p.name).toBe("Tech debt");
    expect(p.scopeFilter).toBe("scope-a");
    expect(p.localHops).toBe(2);
  });
});

describe("upsertPreset / removePreset / findPreset", () => {
  it("appends a new preset and replaces by id in place", () => {
    const a = makePreset("A", FILTER, idGen);
    const b = makePreset("B", FILTER, idGen);
    let list = upsertPreset([], a);
    list = upsertPreset(list, b);
    expect(list.map((p) => p.id)).toEqual(["id-1", "id-2"]);
    // Replace 'a' in place (keeps slot 0).
    const a2 = { ...a, name: "A renamed" };
    list = upsertPreset(list, a2);
    expect(list[0].name).toBe("A renamed");
    expect(list).toHaveLength(2);
  });

  it("enforces MAX_PRESETS by dropping the oldest on overflow", () => {
    let list: ConceptGraphPreset[] = [];
    for (let i = 0; i < MAX_PRESETS + 5; i++) {
      list = upsertPreset(list, makePreset(`p${i}`, FILTER, idGen));
    }
    expect(list).toHaveLength(MAX_PRESETS);
    // Oldest (id-1..id-5) dropped; newest kept.
    expect(findPreset(list, "id-1")).toBeNull();
    expect(findPreset(list, `id-${MAX_PRESETS + 5}`)).not.toBeNull();
  });

  it("removes by id and finds by id", () => {
    const a = makePreset("A", FILTER, idGen);
    const list = upsertPreset([], a);
    expect(findPreset(list, a.id)?.name).toBe("A");
    expect(removePreset(list, a.id)).toEqual([]);
    expect(findPreset(list, null)).toBeNull();
  });
});

describe("upsertPresetByName", () => {
  it("updates the preset with the same name in place (no duplicate)", () => {
    const a = makePreset("Hubs only", FILTER, idGen);
    const list = upsertPreset([], a);
    // Re-save under the same name with a diverged filter.
    const next = upsertPresetByName(
      list,
      "  Hubs only  ", // sanitizes to the same name
      { ...FILTER, decayMode: true },
      idGen,
    );
    expect(next).toHaveLength(1);
    expect(next[0].id).toBe(a.id); // id + slot preserved
    expect(next[0].name).toBe("Hubs only");
    expect(next[0].decayMode).toBe(true); // filter updated
  });

  it("appends when the name is new", () => {
    const a = makePreset("A", FILTER, idGen);
    const list = upsertPreset([], a);
    const next = upsertPresetByName(list, "B", FILTER, idGen);
    expect(next.map((p) => p.name)).toEqual(["A", "B"]);
  });

  it("normalizes the saved filter (dedupe/clamp) like makePreset", () => {
    const next = upsertPresetByName(
      [],
      "Messy",
      { ...FILTER, disabledRelations: ["is_a", "is_a"], localHops: 99 },
      idGen,
    );
    expect(next[0].disabledRelations).toEqual(["is_a"]);
    expect(next[0].localHops).toBe(3);
  });
});

describe("filterMatchesPreset / activePresetId", () => {
  it("matches irrespective of enum order/dupes", () => {
    const p = makePreset("A", FILTER, idGen);
    const reordered: PresetFilter = {
      ...FILTER,
      disabledRelations: ["is_a", "is_a"],
    };
    expect(filterMatchesPreset(reordered, p)).toBe(true);
  });
  it("detects divergence in any field", () => {
    const p = makePreset("A", FILTER, idGen);
    expect(filterMatchesPreset({ ...FILTER, labelsAll: false }, p)).toBe(false);
    expect(filterMatchesPreset({ ...FILTER, localHops: 1 }, p)).toBe(false);
    expect(filterMatchesPreset({ ...FILTER, decayMode: true }, p)).toBe(false);
  });
  it("activePresetId returns the matching preset id or null", () => {
    const a = makePreset("A", FILTER, idGen);
    const b = makePreset("B", { ...FILTER, decayMode: true }, idGen);
    const list = [a, b];
    expect(activePresetId(list, FILTER)).toBe(a.id);
    expect(activePresetId(list, { ...FILTER, decayMode: true })).toBe(b.id);
    expect(
      activePresetId(list, { ...FILTER, scopeFilter: "other" }),
    ).toBeNull();
  });
});

describe("parsePresetStore (defensive)", () => {
  it("returns null for absent/garbage/wrong-version blobs", () => {
    expect(parsePresetStore(null)).toBeNull();
    expect(parsePresetStore("not json")).toBeNull();
    expect(parsePresetStore("[]")).toBeNull(); // not an object
    expect(
      parsePresetStore(JSON.stringify({ version: 999, presets: [] })),
    ).toBeNull();
    expect(parsePresetStore(JSON.stringify({ version: 1 }))).toBeNull(); // no presets array
  });

  it("drops individually-bad presets and bogus enum values", () => {
    const blob = JSON.stringify({
      version: 1,
      presets: [
        { id: "ok", name: "Good", disabledRelations: ["is_a", "nope"] },
        { name: "no id" },
        { id: "", name: "empty id" },
        "garbage",
      ],
      defaultPresetId: "ok",
    });
    const store = parsePresetStore(blob);
    expect(store?.presets.map((p) => p.id)).toEqual(["ok"]);
    expect(store?.presets[0].disabledRelations).toEqual(["is_a"]);
    expect(store?.defaultPresetId).toBe("ok");
  });

  it("clears a default that no longer resolves to a surviving preset", () => {
    const blob = JSON.stringify({
      version: 1,
      presets: [{ id: "a", name: "A" }],
      defaultPresetId: "ghost",
    });
    expect(parsePresetStore(blob)?.defaultPresetId).toBeNull();
  });

  it("drops duplicate ids", () => {
    const blob = JSON.stringify({
      version: 1,
      presets: [
        { id: "dup", name: "First" },
        { id: "dup", name: "Second" },
      ],
    });
    expect(parsePresetStore(blob)?.presets).toHaveLength(1);
  });
});

describe("serialize/parse round-trip + load/save", () => {
  it("round-trips a store through serialize→parse", () => {
    const store = {
      presets: [makePreset("A", FILTER, idGen)],
      defaultPresetId: "id-1",
    };
    const parsed = parsePresetStore(serializePresetStore(store));
    expect(parsed).toEqual(store);
  });

  it("load returns an empty store when nothing is persisted", () => {
    expect(loadPresetStore("scope-x")).toEqual(defaultPresetStore());
  });

  it("save then load round-trips through localStorage", () => {
    const store = {
      presets: [makePreset("A", FILTER, idGen)],
      defaultPresetId: "id-1",
    };
    savePresetStore("scope-x", store);
    expect(
      window.localStorage.getItem(presetStorageKey("scope-x")),
    ).toBeTruthy();
    expect(loadPresetStore("scope-x")).toEqual(store);
  });

  it("keeps scopes isolated", () => {
    savePresetStore("scope-1", {
      presets: [makePreset("A", FILTER, idGen)],
      defaultPresetId: null,
    });
    expect(loadPresetStore("scope-2")).toEqual(defaultPresetStore());
  });
});

describe("newPresetId", () => {
  it("produces unique non-empty ids", () => {
    const a = newPresetId();
    const b = newPresetId();
    expect(a).toBeTruthy();
    expect(a).not.toBe(b);
  });
});
