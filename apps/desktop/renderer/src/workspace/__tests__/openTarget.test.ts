/**
 * Unit tests for the pure modifier-gesture mapping that powers the
 * "open in new tab / new split" affordances (Feature 2). Keeping this
 * mapping pure and separately tested means the Sidebar, QuickSwitcher,
 * and any future call site share one audited definition of what a
 * modified click means — no per-component drift.
 */
import { describe, it, expect } from "vitest";
import { openModeFromEvent } from "../useOpenTarget";

type ClickLike = Pick<
  MouseEvent,
  "metaKey" | "ctrlKey" | "shiftKey" | "button"
>;

function ev(partial: Partial<ClickLike>): ClickLike {
  return {
    metaKey: false,
    ctrlKey: false,
    shiftKey: false,
    button: 0,
    ...partial,
  };
}

describe("openModeFromEvent", () => {
  it("a plain primary click opens in the current view", () => {
    expect(openModeFromEvent(ev({}))).toBe("current");
  });

  it("Cmd/Ctrl-click opens in a new tab", () => {
    expect(openModeFromEvent(ev({ metaKey: true }))).toBe("new-tab");
    expect(openModeFromEvent(ev({ ctrlKey: true }))).toBe("new-tab");
  });

  it("Cmd/Ctrl+Shift-click opens in a new split", () => {
    expect(openModeFromEvent(ev({ metaKey: true, shiftKey: true }))).toBe(
      "new-split",
    );
    expect(openModeFromEvent(ev({ ctrlKey: true, shiftKey: true }))).toBe(
      "new-split",
    );
  });

  it("a middle-click opens in a new split regardless of modifiers", () => {
    expect(openModeFromEvent(ev({ button: 1 }))).toBe("new-split");
    expect(openModeFromEvent(ev({ button: 1, metaKey: true }))).toBe(
      "new-split",
    );
  });

  it("Shift alone (no Cmd/Ctrl) stays in the current view", () => {
    // Shift without the platform modifier is a normal click — e.g. it
    // must not hijack range-style interactions elsewhere.
    expect(openModeFromEvent(ev({ shiftKey: true }))).toBe("current");
  });

  it("ignores non-primary, non-middle buttons (e.g. right-click)", () => {
    expect(openModeFromEvent(ev({ button: 2 }))).toBe("current");
  });
});
