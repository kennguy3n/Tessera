/**
 * Regression test for the `appInitComplete` guard on the
 * `window-all-closed` handler in `electron/main.ts`.
 *
 * The bug this test pins:
 *
 *   When `safeStorage` is unavailable (the primary use case for
 *   the password-vault fallback — headless / minimal Linux),
 *   `maybeInitPasswordVault` opens a password prompt BrowserWindow
 *   BEFORE `createWindow()` is called. If the user dismisses this
 *   prompt via the OS title-bar X button, the `closed` event fires
 *   and `reject()` is called synchronously. Immediately after,
 *   Electron fires `window-all-closed` because the prompt was the
 *   only window. The handler used to unconditionally call
 *   `app.quit()` on non-macOS platforms, terminating the app
 *   before the rejection microtasks could propagate back through
 *   `maybeInitPasswordVault`'s catch block and reach
 *   `createWindow()`. End result on Linux/Windows: dismissing the
 *   prompt killed the app silently instead of falling through to
 *   the documented "log warning, continue" path.
 *
 *   The Cancel button path happened to survive because `onCancel`
 *   defers `win.close()` via `setImmediate`, giving the main
 *   process a tick to schedule `createWindow()` before the window
 *   count hits zero. But that was an incidental side-effect of
 *   the IPC-flush deferral — the X button is synchronous and
 *   always raced.
 *
 * The fix is structural: a module-level `appInitComplete` flag
 * that is set to `true` only after `createWindow()` returns.
 * The `window-all-closed` handler is guarded with a leading
 * `if (!appInitComplete) return;` so quit can only fire after
 * the user has seen the main window at least once.
 *
 * These tests are source-text regressions (the same shape used by
 * `rendererPath.test.ts`) because `main.ts` has top-level Electron
 * side-effects that would require a much heavier test harness to
 * exercise as live JS. The text shape is small and stable enough
 * to make accidental regression visible without false positives.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_ROOT = path.resolve(HERE, "..");
const MAIN_TS = path.join(ELECTRON_ROOT, "main.ts");

describe("appInitComplete guard on window-all-closed", () => {
  const source = readFileSync(MAIN_TS, "utf-8");

  it("declares a module-level `appInitComplete` flag initialised to false", () => {
    expect(source).toMatch(/let\s+appInitComplete\s*=\s*false\s*;/);
  });

  it("sets `appInitComplete = true` AFTER `createWindow()` in app.whenReady", () => {
    // The order matters: setting it before createWindow() would
    // re-introduce the race because window-all-closed could fire
    // mid-construction (e.g. if createWindow itself opens a child
    // window that closes before the main window is ready).
    //
    // Search the full source from the `app.whenReady()` anchor
    // forward, rather than carving out a `[\s\S]*?\}\);` block —
    // the whenReady body now contains nested arrow-function blocks
    // (`app.on("activate", () => { ... });`, `setImmediate(() => {
    // ... });`) and the non-greedy regex would clip at the first
    // inner `});`, miss the trailing statements, and fail to find
    // both anchors. `indexOf` from a starting position is robust to
    // future additions of nested closures inside the callback.
    const whenReadyIdx = source.indexOf("app.whenReady()");
    expect(whenReadyIdx, "could not find app.whenReady() in main.ts").toBeGreaterThan(-1);
    // The unconditional top-level `createWindow();` call (not the
    // one inside the activate listener) is what creates the main
    // window on startup. Anchor on the second occurrence after
    // `whenReady`: the FIRST `createWindow();` after `whenReady` is
    // the one inside `app.on("activate", () => { if (…) { createWindow(); } });`
    // (a possible same-tick recovery path); the SECOND is the
    // top-level startup call. Both have `createWindow();` as text,
    // but only the second is followed by `appInitComplete = true`.
    let scanIdx = whenReadyIdx;
    let createWindowIdx = -1;
    for (let i = 0; i < 2; i += 1) {
      createWindowIdx = source.indexOf("createWindow();", scanIdx);
      if (createWindowIdx === -1) break;
      scanIdx = createWindowIdx + 1;
    }
    const flagSetIdx = source.indexOf("appInitComplete = true", whenReadyIdx);
    expect(createWindowIdx, "the top-level `createWindow();` call must be present in whenReady").toBeGreaterThan(-1);
    expect(flagSetIdx, "appInitComplete = true must be set in whenReady").toBeGreaterThan(-1);
    expect(flagSetIdx, "appInitComplete = true must come AFTER the top-level createWindow() call").toBeGreaterThan(
      createWindowIdx,
    );
  });

  it("guards the window-all-closed handler with a leading `if (!appInitComplete) return;`", () => {
    // The guard must be the very first statement in the handler —
    // before the darwin check, before any other side effect. If
    // someone reorders the conditions in a future refactor and the
    // platform check fires first, the guard becomes a no-op on
    // macOS (where window-all-closed doesn't quit anyway) and
    // ineffective on Linux/Windows (where it would still race).
    const handler = source.match(
      /app\.on\(\s*"window-all-closed"\s*,\s*\(\)\s*=>\s*\{([\s\S]*?)\n\}\);/,
    );
    expect(handler, "could not find window-all-closed handler").toBeTruthy();
    if (!handler) return;

    const body = handler[1];
    const guardMatch = body.match(/if\s*\(\s*!appInitComplete\s*\)\s*return\s*;/);
    expect(
      guardMatch,
      `window-all-closed handler is missing the appInitComplete guard.\nHandler body:\n${body}`,
    ).toBeTruthy();
    if (!guardMatch) return;

    const platformCheck = body.match(/process\.platform/);
    expect(platformCheck, "darwin platform check must still be present").toBeTruthy();
    if (!platformCheck || guardMatch.index === undefined || platformCheck.index === undefined) {
      return;
    }
    expect(
      guardMatch.index,
      "the appInitComplete guard must come BEFORE the platform check, not after",
    ).toBeLessThan(platformCheck.index);
  });

  it("exposes a test-only reset hook so test harnesses can simulate fresh startup", () => {
    expect(source).toMatch(/export\s+function\s+_resetAppInitForTests\s*\(\s*\)\s*:\s*void/);
    expect(source).toMatch(/export\s+function\s+_markAppInitCompleteForTests\s*\(\s*\)\s*:\s*void/);
    expect(source).toMatch(/export\s+function\s+_appInitCompleteForTests\s*\(\s*\)\s*:\s*boolean/);
  });
});
