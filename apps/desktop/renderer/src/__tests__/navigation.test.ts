import { describe, it, expect } from "vitest";

import {
  MAX_SIDEBAR_SHORTCUT_INDEX,
  PRIMARY_SIDEBAR_ITEMS,
  SECONDARY_SIDEBAR_ITEMS,
  SIDEBAR_ITEMS,
  SIDEBAR_NAV_BY_KEY,
  SIDEBAR_SHORTCUT_HINTS,
} from "../navigation";

/**
 * Lock down the sidebar / keyboard-shortcut invariants.
 *
 * review caught a sibling-file desync where the visual
 * sidebar order and the `Ctrl/Cmd+N` shortcut order had drifted
 * (keys 3 and 4 ended up swapped). The two now derive from a
 * single `SIDEBAR_ITEMS` source of truth in `navigation.ts`; these
 * tests assert they stay aligned no matter how the array evolves.
 */
describe("sidebar navigation", () => {
  it("derives shortcut keys from the visible sidebar order (up to the chord cap)", () => {
    SIDEBAR_ITEMS.forEach((item, idx) => {
      const position = idx + 1;
      if (position <= MAX_SIDEBAR_SHORTCUT_INDEX) {
        const expectedKey = String(position);
        expect(SIDEBAR_SHORTCUT_HINTS[item.to]).toBe(expectedKey);
        expect(SIDEBAR_NAV_BY_KEY[expectedKey]).toBe(item.to);
      } else {
        // Positions past the cap can't own a single-keystroke Ctrl+N
        // chord, so they intentionally carry no hint / key mapping.
        expect(SIDEBAR_SHORTCUT_HINTS[item.to]).toBeUndefined();
      }
    });
  });

  it("renders the canonical Tessera nav order", () => {
    // Memory + Knowledge Graph are appended AFTER Settings so the
    // pre-existing 1..8 shortcuts stay pinned to their destinations
    // (Vision=7, Settings=8) and only extend the range by two.
    expect(SIDEBAR_ITEMS.map((i) => i.to)).toEqual([
      "/",
      "/sources",
      "/create",
      "/templates",
      "/tasks",
      "/automations",
      "/vision",
      "/settings",
      "/memory",
      "/knowledge",
    ]);
  });

  it("gives Memory the Ctrl+9 shortcut and leaves Knowledge Graph chord-less", () => {
    // Memory is the 9th item, so it gets the last numeric chord.
    expect(SIDEBAR_NAV_BY_KEY["9"]).toBe("/memory");
    expect(SIDEBAR_SHORTCUT_HINTS["/memory"]).toBe("9");
    // Knowledge Graph is the 10th item. "Ctrl+10" is not a pressable
    // single keystroke, so it gets NO chord and NO hint chip — it is
    // reachable via the sidebar click and the Cmd+K palette instead.
    // (Devin Review PR #120 flagged the previously-rendered dead
    // "Ctrl+10" hint.)
    expect(SIDEBAR_NAV_BY_KEY["10"]).toBeUndefined();
    expect(SIDEBAR_SHORTCUT_HINTS["/knowledge"]).toBeUndefined();
  });

  it("keeps the primary/secondary tiers in sync with SIDEBAR_ITEMS", () => {
    // The tiered sidebar splits SIDEBAR_ITEMS across two arrays for
    // display, but shortcuts/routing still read the full list. Pin the
    // relationship so a future edit can't add a tier item that has no
    // shortcut (only in PRIMARY/SECONDARY) or a routed item that never
    // appears in a tier (only in SIDEBAR_ITEMS).
    const full = SIDEBAR_ITEMS.map((i) => i.to).sort();
    const tiered = [...PRIMARY_SIDEBAR_ITEMS, ...SECONDARY_SIDEBAR_ITEMS]
      .map((i) => i.to)
      .sort();
    expect(tiered).toEqual(full);
    // Tiers must be disjoint — an item belongs to exactly one tier.
    const primary = new Set(PRIMARY_SIDEBAR_ITEMS.map((i) => i.to));
    SECONDARY_SIDEBAR_ITEMS.forEach((i) => {
      expect(primary.has(i.to)).toBe(false);
    });
  });

  it("maps the Vision entry to keyboard shortcut 7 (Settings shifts to 8)", () => {
    // Block E added `/vision` between Automations and Settings —
    // pin the keyboard shortcut so `Ctrl/Cmd+7` lands on the
    // Vision page and `Ctrl/Cmd+8` lands on Settings.
    expect(SIDEBAR_NAV_BY_KEY["7"]).toBe("/vision");
    expect(SIDEBAR_NAV_BY_KEY["8"]).toBe("/settings");
    expect(SIDEBAR_SHORTCUT_HINTS["/vision"]).toBe("7");
    expect(SIDEBAR_SHORTCUT_HINTS["/settings"]).toBe("8");
  });

  it("uses every key exactly once across both maps", () => {
    const keys = Object.keys(SIDEBAR_NAV_BY_KEY).sort();
    const hintKeys = Object.values(SIDEBAR_SHORTCUT_HINTS).sort();
    expect(keys).toEqual(hintKeys);
    expect(new Set(keys).size).toBe(keys.length);
  });

  it("starts numbering at 1 and is dense up to the chord cap", () => {
    const sortedKeys = Object.keys(SIDEBAR_NAV_BY_KEY)
      .map((k) => Number.parseInt(k, 10))
      .sort((a, b) => a - b);
    expect(sortedKeys[0]).toBe(1);
    // The dense range stops at the chord cap (or the list length if
    // there are fewer items than the cap), never advertising a key
    // that can't be pressed.
    const expectedMax = Math.min(SIDEBAR_ITEMS.length, MAX_SIDEBAR_SHORTCUT_INDEX);
    expect(sortedKeys[sortedKeys.length - 1]).toBe(expectedMax);
    expect(sortedKeys.length).toBe(expectedMax);
  });
});
