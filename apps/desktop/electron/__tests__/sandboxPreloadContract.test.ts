/**
 * Regression tests for two structural invariants that Devin Review
 * flagged on round 6 of PR #17:
 *
 *   1. `passwordPromptChannels.ts` MUST remain a constants-only module
 *      with zero imports. It is loaded by the sandboxed password-prompt
 *      preload via `require('./passwordPromptChannels')`. In Electron's
 *      sandboxed preload context, `require` can only load `electron` and
 *      relative JS files whose transitive imports do NOT touch Node.js
 *      APIs (`fs`, `crypto`, `path`, etc.). If a future contributor
 *      adds an import to `passwordPromptChannels.ts` — even something
 *      benign like a shared-type re-export from a file that
 *      transitively imports `fs` — the preload would break silently
 *      at runtime: the prompt window would load with no
 *      `window.tesseraPasswordPrompt` global, the submit button would
 *      be inert, and the app would appear to hang forever waiting on
 *      a vault password. There is no compile-time warning for this
 *      class of regression; the docstring on the channels module is
 *      the only protection. This test makes it a hard CI guard.
 *
 *   2. `installContentSecurityPolicy()` is defined as a module-level
 *      function and called exactly once from `app.whenReady` — NOT
 *      from inside `createWindow()`. The CSP is a session-level
 *      invariant; registering it per-window was harmless (each
 *      `onHeadersReceived` call replaces the previous handler) but
 *      created two subtle smells noted in the docstring on
 *      `installContentSecurityPolicy`. Pinning the call site here
 *      prevents a future refactor from accidentally re-inlining the
 *      registration into `createWindow()` (or worse, leaving both
 *      paths registered).
 *
 * These are source-text regressions — the same shape used by
 * `rendererPath.test.ts` and `windowAllClosedGuard.test.ts` — because
 * the modules under test have top-level Electron side effects that
 * would require a much heavier test harness to exercise as live JS.
 */

import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const HERE = path.dirname(fileURLToPath(import.meta.url));
const ELECTRON_ROOT = path.resolve(HERE, "..");
const CHANNELS_TS = path.join(ELECTRON_ROOT, "passwordPromptChannels.ts");
const MAIN_TS = path.join(ELECTRON_ROOT, "main.ts");

describe("sandboxed preload contract: passwordPromptChannels.ts", () => {
  const source = readFileSync(CHANNELS_TS, "utf-8");

  it("contains no `import` statements (sandbox preload safety)", () => {
    // A bare `import { X } from "Y"` or `import "Y"` would compile to
    // `require("Y")` in CommonJS output, which the sandboxed preload
    // cannot satisfy if Y transitively touches Node.js APIs.
    const importLines = source
      .split("\n")
      .map((line, idx) => ({ line: line.trim(), idx: idx + 1 }))
      .filter(({ line }) => /^\s*import\b/.test(line) && !line.startsWith("//"));
    expect(
      importLines,
      `passwordPromptChannels.ts must have zero imports — found:\n${importLines
        .map((l) => `  line ${l.idx}: ${l.line}`)
        .join("\n")}`,
    ).toHaveLength(0);
  });

  it("contains no `require()` calls (sandbox preload safety)", () => {
    // Same reasoning as imports — a future contributor might bypass
    // the import keyword via `const x = require("y")` for some Node
    // runtime trick. Both forms are banned.
    const requireUses = source.match(/\brequire\s*\(/g) ?? [];
    expect(requireUses).toHaveLength(0);
  });

  it("only exports string-typed constants (no values that drag in Node APIs)", () => {
    // Match every `export const NAME = "..."` line. Any non-string
    // export (object literal, function, computed value) could
    // theoretically pull in Node APIs through its construction.
    const allExports = [...source.matchAll(/^\s*export\s+(const|let|var|function|class)\b.*$/gm)];
    expect(allExports.length, "must have at least one export").toBeGreaterThan(0);
    for (const match of allExports) {
      const line = match[0];
      expect(
        line,
        `passwordPromptChannels.ts may only export string-literal constants. Found non-conforming export: ${line.trim()}`,
      ).toMatch(/^\s*export\s+const\s+[A-Z_]+\s*=\s*"[^"]*"\s*;?\s*$/);
    }
  });
});

describe("CSP session handler hoist: main.ts", () => {
  const source = readFileSync(MAIN_TS, "utf-8");

  it("defines `installContentSecurityPolicy` as a module-level function", () => {
    expect(source).toMatch(/function\s+installContentSecurityPolicy\s*\(\s*\)\s*:\s*void/);
  });

  it("calls `installContentSecurityPolicy()` exactly once, from app.whenReady", () => {
    const calls = source.match(/\binstallContentSecurityPolicy\s*\(\s*\)/g) ?? [];
    // Two matches: the definition's name lookup is matched by a different
    // regex (`function installContentSecurityPolicy(): void` has trailing
    // `: void` so the call-site pattern above with `()` only matches
    // actual call sites + the bare `\binstallContentSecurityPolicy()`
    // form in the call). Tally call sites by stripping the definition.
    const callSites = source.split("\n").filter((line) => {
      return (
        /\binstallContentSecurityPolicy\s*\(\s*\)\s*;?\s*$/.test(line) &&
        !/function\s+installContentSecurityPolicy/.test(line)
      );
    });
    expect(
      calls.length,
      `installContentSecurityPolicy must be present at least once — found 0 references`,
    ).toBeGreaterThan(0);
    expect(
      callSites.length,
      `expected exactly 1 call site for installContentSecurityPolicy, found ${callSites.length}:\n${callSites.join("\n")}`,
    ).toBe(1);

    // The call site must be inside the app.whenReady block.
    const whenReadyBlock = source.match(
      /app\.whenReady\(\)\.then\(async \(\) => \{[\s\S]*?\}\);/,
    );
    expect(whenReadyBlock, "could not find app.whenReady block").toBeTruthy();
    if (!whenReadyBlock) return;
    expect(whenReadyBlock[0]).toMatch(/\binstallContentSecurityPolicy\s*\(\s*\)/);
  });

  it("does NOT call session.defaultSession.webRequest.onHeadersReceived inside createWindow", () => {
    // Pin the hoist: regressing this back into createWindow() would
    // re-introduce the per-call re-registration. Match the body of
    // createWindow() and assert the call is not inside it.
    const createWindowBody = source.match(/function\s+createWindow\s*\(\s*\)\s*:\s*void\s*\{[\s\S]*?\n\}\n/);
    expect(createWindowBody, "could not find createWindow body").toBeTruthy();
    if (!createWindowBody) return;
    expect(createWindowBody[0]).not.toMatch(/onHeadersReceived/);
  });

  it("calls installContentSecurityPolicy BEFORE maybeInitPasswordVault in app.whenReady", () => {
    // Ordering: the password prompt is the FIRST window that may be
    // opened. Even though Electron's webRequest doesn't fire on
    // `data:` URLs (so the prompt currently has no CSP either way),
    // having the registration in place beforehand makes the policy
    // a session-level invariant — a future switch from `data:` to
    // `file:` for the prompt would automatically pick up the CSP
    // without any further wiring.
    const whenReadyBlock = source.match(
      /app\.whenReady\(\)\.then\(async \(\) => \{[\s\S]*?\}\);/,
    );
    expect(whenReadyBlock).toBeTruthy();
    if (!whenReadyBlock) return;
    const body = whenReadyBlock[0];
    const cspIdx = body.indexOf("installContentSecurityPolicy()");
    const promptIdx = body.indexOf("maybeInitPasswordVault()");
    expect(cspIdx).toBeGreaterThan(-1);
    expect(promptIdx).toBeGreaterThan(-1);
    expect(
      cspIdx,
      "installContentSecurityPolicy() must be called BEFORE maybeInitPasswordVault() so the CSP is in place before any window opens",
    ).toBeLessThan(promptIdx);
  });
});
