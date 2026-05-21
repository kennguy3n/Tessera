import { describe, it, expect } from "vitest";

import {
  SIDEBAR_ITEMS,
  SIDEBAR_NAV_BY_KEY,
  SIDEBAR_SHORTCUT_HINTS,
} from "../navigation";

/**
 * Lock down the sidebar / keyboard-shortcut invariants.
 *
 * Phase 9 review caught a sibling-file desync where the visual
 * sidebar order and the `Ctrl/Cmd+N` shortcut order had drifted
 * (keys 3 and 4 ended up swapped). The two now derive from a
 * single `SIDEBAR_ITEMS` source of truth in `navigation.ts`; these
 * tests assert they stay aligned no matter how the array evolves.
 */
describe("sidebar navigation", () => {
  it("derives shortcut keys from the visible sidebar order", () => {
    SIDEBAR_ITEMS.forEach((item, idx) => {
      const expectedKey = String(idx + 1);
      expect(SIDEBAR_SHORTCUT_HINTS[item.to]).toBe(expectedKey);
      expect(SIDEBAR_NAV_BY_KEY[expectedKey]).toBe(item.to);
    });
  });

  it("renders the canonical Tessera nav order", () => {
    expect(SIDEBAR_ITEMS.map((i) => i.to)).toEqual([
      "/",
      "/sources",
      "/create",
      "/templates",
      "/tasks",
      "/automations",
      "/settings",
    ]);
  });

  it("uses every key exactly once across both maps", () => {
    const keys = Object.keys(SIDEBAR_NAV_BY_KEY).sort();
    const hintKeys = Object.values(SIDEBAR_SHORTCUT_HINTS).sort();
    expect(keys).toEqual(hintKeys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("starts numbering at 1 and is dense up to SIDEBAR_ITEMS.length", () => {
    const sortedKeys = Object.keys(SIDEBAR_NAV_BY_KEY)
      .map((k) => Number.parseInt(k, 10))
      .sort((a, b) => a - b);
    expect(sortedKeys[0]).toBe(1);
    expect(sortedKeys[sortedKeys.length - 1]).toBe(SIDEBAR_ITEMS.length);
  });
});
