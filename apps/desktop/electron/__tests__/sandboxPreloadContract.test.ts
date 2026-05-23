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
  // Normalise to LF so regex anchors and `\n}` patterns work the same on
  // Windows runners (which check out the repo with native CRLF endings).
  const source = readFileSync(CHANNELS_TS, "utf-8").replace(/\r\n/g, "\n");

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

/**
 * Strip JS line and block comments from a source string while
 * preserving line positions and column offsets, so `indexOf`-based
 * substring searches against the result always hit a CODE token,
 * never a JSDoc reference.
 *
 * Phase 10 / Task 13 added rich JSDoc references to
 * `maybeInitPasswordVault()` and `installContentSecurityPolicy()`
 * INSIDE the `app.whenReady().then(async () => { ... })` body —
 * those references appear textually BEFORE the actual call sites,
 * which broke the four "X before Y" ordering tests below. The
 * correct long-term fix is to make these structural-ordering
 * assertions operate on CODE only, so new documentation comments
 * never produce a false regression.
 *
 * The approach is intentionally minimal: replace each comment with
 * an equal-length run of spaces (preserving newlines for line-
 * comments, preserving all newlines inside block comments). This
 * keeps every `source.indexOf(...)` offset valid for downstream
 * positional comparisons and error messages.
 *
 * Quoted strings are preserved verbatim — if a quoted string ever
 * contained a `//` token (e.g. a URL in a literal), it would
 * legitimately be code. The implementation walks character-by-
 * character with a tiny state machine rather than using a single
 * regex because regex alternation can't distinguish `//` inside a
 * string from `//` starting a line comment in the general case.
 */
function stripJsComments(src: string): string {
  const out: string[] = [];
  let i = 0;
  const n = src.length;
  while (i < n) {
    const c = src[i];
    const c2 = i + 1 < n ? src[i + 1] : "";
    if (c === '"' || c === "'" || c === "`") {
      // String/template literal — copy until matching close,
      // respecting backslash escapes (templates can contain
      // newlines, which we preserve).
      const quote = c;
      out.push(c);
      i += 1;
      while (i < n) {
        const k = src[i];
        if (k === "\\" && i + 1 < n) {
          out.push(src[i], src[i + 1]);
          i += 2;
          continue;
        }
        out.push(k);
        i += 1;
        if (k === quote) break;
      }
      continue;
    }
    if (c === "/" && c2 === "/") {
      // Line comment — consume up to (but not including) the
      // newline, replacing each char with a space so column
      // positions for downstream tokens stay aligned.
      while (i < n && src[i] !== "\n") {
        out.push(" ");
        i += 1;
      }
      continue;
    }
    if (c === "/" && c2 === "*") {
      // Block comment — consume up to and including `*/`,
      // preserving every newline and replacing other chars with
      // spaces.
      out.push("  ");
      i += 2;
      while (i < n && !(src[i] === "*" && i + 1 < n && src[i + 1] === "/")) {
        out.push(src[i] === "\n" ? "\n" : " ");
        i += 1;
      }
      if (i < n) {
        out.push("  ");
        i += 2;
      }
      continue;
    }
    out.push(c);
    i += 1;
  }
  return out.join("");
}

describe("CSP session handler hoist: main.ts", () => {
  const rawSource = readFileSync(MAIN_TS, "utf-8").replace(/\r\n/g, "\n");
  // `source` is the comment-stripped view used for structural
  // ordering assertions. The few tests that explicitly want to
  // observe documentation (e.g. the "defines ... as a module-level
  // function" regex on line 97 below) read from `rawSource`.
  const source = stripJsComments(rawSource);

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
    //
    // The closing brace is matched with `\r?\n\}` (CRLF-tolerant)
    // because Windows runners check out the repo with native line
    // endings — a naive `\n\}` here would fail on Windows CI.
    // Normalise to LF for the body extraction so the test is
    // platform-independent.
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
    //
    // Anchor on the full source (`indexOf` from the `app.whenReady()`
    // start) rather than a non-greedy `[\s\S]*?\}\);` whenReady-body
    // regex: the body now contains nested arrow-function blocks
    // (e.g. `app.on("activate", () => { ... });` is registered
    // INSIDE the `whenReady` callback) and the non-greedy variant
    // would clip at the first inner `});` and miss the
    // `await maybeInitPasswordVault()` call.
    const whenReadyIdx = source.indexOf("app.whenReady()");
    expect(whenReadyIdx, "could not find app.whenReady() in main.ts").toBeGreaterThan(-1);
    const cspIdx = source.indexOf("installContentSecurityPolicy()", whenReadyIdx);
    const promptIdx = source.indexOf("maybeInitPasswordVault()", whenReadyIdx);
    expect(cspIdx, "could not find installContentSecurityPolicy() after app.whenReady()").toBeGreaterThan(-1);
    expect(promptIdx, "could not find maybeInitPasswordVault() after app.whenReady()").toBeGreaterThan(-1);
    expect(
      cspIdx,
      "installContentSecurityPolicy() must be called BEFORE maybeInitPasswordVault() so the CSP is in place before any window opens",
    ).toBeLessThan(promptIdx);
  });

  it("registers app.on('activate', ...) BEFORE await maybeInitPasswordVault in app.whenReady", () => {
    // macOS dock-click recovery invariant: if the user dismisses the
    // password prompt and then clicks the dock icon during the brief
    // window between the prompt closing and `whenReady` resuming,
    // Cocoa dispatches `activate` synchronously. With no listener
    // registered yet, the click is silently dropped — the app
    // appears hung until the main window auto-opens. Pinning the
    // registration order here prevents a future refactor from
    // moving the `app.on("activate", ...)` block back below the
    // `await` and re-introducing the race.
    //
    // `createWindow()` is idempotent on the module-level `mainWindow`
    // ref (see its docstring), so a duplicate call from the early
    // activate path + the late unconditional call at the end of
    // `whenReady` is safe — the second call no-ops.
    //
    // Match against the full source rather than a non-greedy
    // whenReady-block regex: the hoisted `app.on("activate", () => {
    // ... });` now appears INSIDE the whenReady callback, and a
    // non-greedy `[\s\S]*?\}\);` would stop at the first inner
    // `});` (the activate close) and clip away the
    // `await maybeInitPasswordVault()` line. Using `source.indexOf`
    // directly is robust to future nested arrow-function bodies.
    const whenReadyIdx = source.indexOf("app.whenReady()");
    expect(whenReadyIdx, "could not find app.whenReady() in main.ts").toBeGreaterThan(-1);
    const activateIdx = source.indexOf('app.on("activate"', whenReadyIdx);
    const awaitPromptIdx = source.indexOf("await maybeInitPasswordVault()", whenReadyIdx);
    expect(activateIdx, "could not find app.on('activate', ...) after app.whenReady()").toBeGreaterThan(-1);
    expect(awaitPromptIdx, "could not find 'await maybeInitPasswordVault()' after app.whenReady()").toBeGreaterThan(-1);
    expect(
      activateIdx,
      "app.on(\"activate\", ...) must be registered BEFORE await maybeInitPasswordVault() so a dock click during the password prompt is not silently dropped on macOS",
    ).toBeLessThan(awaitPromptIdx);
  });

  it("registers IPC handlers BEFORE await maybeInitPasswordVault in app.whenReady", () => {
    // Defense-in-depth invariant for the early-activate path: the
    // hoisted `app.on("activate", ...)` listener may synchronously
    // call `createWindow()` BEFORE the `await maybeInitPasswordVault()`
    // continuation runs. If `createWindow()` loads the renderer
    // against a half-wired IPC surface (because `registerIpcHandlers`
    // hadn't run yet), every `ipcRenderer.invoke(...)` from the
    // renderer fails with "No handler registered for 'foo'". Today
    // the JS microtask ordering happens to prevent this (the await
    // continuation runs to completion before any pending macrotask
    // like `activate` is dispatched), but a future refactor adding a
    // second `await` between the vault step and IPC registration
    // would silently re-introduce the race. Pinning the order at the
    // source level makes the invariant explicit and refactor-proof.
    //
    // `registerIpcHandlers()` only calls `ipcMain.handle(...)` — it
    // does not read vault state at registration time. The
    // vault-aware paths inside individual handlers consult vault
    // state lazily when invoked, so moving registration above the
    // vault prompt does not break the "vault is ready before
    // handler runs" invariant.
    const whenReadyIdx = source.indexOf("app.whenReady()");
    expect(whenReadyIdx, "could not find app.whenReady() in main.ts").toBeGreaterThan(-1);
    const registerIdx = source.indexOf("registerIpcHandlers()", whenReadyIdx);
    const awaitPromptIdx = source.indexOf("await maybeInitPasswordVault()", whenReadyIdx);
    expect(registerIdx, "could not find registerIpcHandlers() after app.whenReady()").toBeGreaterThan(-1);
    expect(awaitPromptIdx, "could not find 'await maybeInitPasswordVault()' after app.whenReady()").toBeGreaterThan(-1);
    expect(
      registerIdx,
      "registerIpcHandlers() must run BEFORE await maybeInitPasswordVault() so a renderer loaded via the early-activate path finds every IPC channel already wired",
    ).toBeLessThan(awaitPromptIdx);
  });

  it("createWindow is idempotent on the mainWindow reference", () => {
    // The hoisted activate listener (see test above) plus the
    // unconditional `createWindow()` call at the end of `whenReady`
    // can both run in a single startup — if the activate listener
    // fires during the prompt-close → whenReady-resume window. The
    // function's idempotency is what makes this safe: regressing it
    // would let a duplicate main window appear on the recovery
    // path. Pin the guard by source-shape match.
    const createWindowBody = source.match(/function\s+createWindow\s*\(\s*\)\s*:\s*void\s*\{[\s\S]*?\n\}\n/);
    expect(createWindowBody, "could not find createWindow body").toBeTruthy();
    if (!createWindowBody) return;
    const body = createWindowBody[0];
    // The early-return clause must reference `mainWindow !== null`
    // AND `isDestroyed()` (so a closed-and-nulled window correctly
    // falls through to creating a fresh one).
    expect(
      body,
      "createWindow() must check `mainWindow !== null && !mainWindow.isDestroyed()` and early-return so the activate-listener early-fire path doesn't create a duplicate window",
    ).toMatch(/mainWindow\s*!==\s*null\s*&&\s*!mainWindow\.isDestroyed\(\)/);
    // And the guard must precede the `new BrowserWindow(` call, not
    // come after it, so the early-return actually short-circuits
    // window creation.
    const guardIdx = body.search(/mainWindow\s*!==\s*null\s*&&\s*!mainWindow\.isDestroyed\(\)/);
    const newWindowIdx = body.indexOf("new BrowserWindow(");
    expect(guardIdx).toBeGreaterThan(-1);
    expect(newWindowIdx).toBeGreaterThan(-1);
    expect(
      guardIdx,
      "the idempotency guard must run BEFORE `new BrowserWindow(...)` so the early-return actually prevents the duplicate window",
    ).toBeLessThan(newWindowIdx);
  });
});
