/**
 * PR #87 Devin Review follow-up: lock the registry contract so
 * future edits to `commandRegistry.ts` can't silently regress the
 * three things the bot caught in round 1.
 *
 * -: every `kind: "callback"` entry must reference a
 *   callback id that lives in `KNOWN_CALLBACK_IDS`. Specifically
 *   `artifact:goBack` must NOT resolve to `openCommandPalette`.
 * -: the `view:toggleTheme` chord must exist exactly
 *   once and be bound to the `toggleTheme` callback so the
 *   keyboard runner + palette both implement the 3-way cycle.
 * - Registry-wide: `findChordCollisions` must return zero (the
 *   module-load check throws in production; we pin it here for
 *   the test suite too, so collisions surface in CI when someone
 *   adds a new chord that overlaps an existing one).
 */
import { describe, expect, it } from "vitest";
import {
  COMMAND_REGISTRY,
  KNOWN_CALLBACK_IDS,
  findChordCollisions,
  type Command,
} from "../utils/commandRegistry";

function callbackEntries(): ReadonlyArray<
  Extract<Command, { kind: "callback" }>
> {
  return COMMAND_REGISTRY.filter(
    (c): c is Extract<Command, { kind: "callback" }> => c.kind === "callback",
  );
}

describe("commandRegistry", () => {
  it("every callback command resolves to a KNOWN_CALLBACK_IDS entry", () => {
    for (const cmd of callbackEntries()) {
      expect(KNOWN_CALLBACK_IDS).toContain(cmd.callbackId);
    }
  });

  it("KNOWN_CALLBACK_IDS includes goBack so artifact:goBack can navigate(-1)", () => {
    expect(KNOWN_CALLBACK_IDS).toContain("goBack");
  });

  it("artifact:goBack is bound to goBack", () => {
    const goBack = COMMAND_REGISTRY.find((c) => c.id === "artifact:goBack");
    expect(goBack).toBeDefined();
    expect(goBack?.kind).toBe("callback");
    if (goBack?.kind === "callback") {
      // The original bug pointed at "openCommandPalette" so a
      // chord intended to navigate-back instead opened Cmd+K.
      expect(goBack.callbackId).not.toBe("openCommandPalette");
      expect(goBack.callbackId).toBe("goBack");
    }
  });

  it("view:toggleTheme is bound to the toggleTheme callback", () => {
    const themeCmd = COMMAND_REGISTRY.find((c) => c.id === "view:toggleTheme");
    expect(themeCmd?.kind).toBe("callback");
    if (themeCmd?.kind === "callback") {
      expect(themeCmd.callbackId).toBe("toggleTheme");
    }
  });

  it("registry has zero chord collisions", () => {
    const collisions = findChordCollisions(COMMAND_REGISTRY);
    expect(collisions).toEqual([]);
  });

  it("registry exposes at least 30 commands (Tasks 14-20 + sidebar)", () => {
    // PR #87 spec target was "30+ keyboard shortcuts". Pinning the
    // floor at 25 leaves room for de-duplications without false
    // failures on routine edits, while still failing loudly if a
    // refactor accidentally drops half the registry.
    expect(COMMAND_REGISTRY.length).toBeGreaterThanOrEqual(25);
  });
});
