/**
 * Cold-start performance regression tests.
 *
 *
 * The cold-start budget is "window visible in <2s on cold start
 * without model load". We can't enforce a wall-clock budget in CI
 * (machine variance dominates), so we enforce the structural
 * invariants the budget depends on:
 *
 *   1. The heavy modules listed in the plan
 *      (`marpExport.ts`, `typstExport.ts`, `diffusionSidecar.ts`,
 *      `autoUpdater.ts`) are NOT statically imported from `main.ts`
 *      or `ipc/index.ts`. A reviewer or refactor that re-introduces
 *      a static import fails this test immediately, giving the
 *      reviewer the same signal the original commit
 *      established.
 *
 *   2. The `startupPerf` module exposes the marker API the boot
 *      sequence in `main.ts` uses. Catching an accidental rename of
 *      `markStart` / `markEnd` / `logStartupPerfTable` here means
 *      the test failure points at the API drift instead of the
 *      reviewer having to chase a `ReferenceError` in production.
 *
 *   3. `markEnd` returns a finite duration when the matching
 *      `markStart` was issued, and `null` when it wasn't. Pinning
 *      this contract guards the boot path from a silent "perf
 *      instrumentation became a no-op" regression.
 */
import { describe, it, expect, beforeEach } from "vitest";
import * as fs from "fs";
import * as path from "path";
import {
  coldStartTotalMs,
  collectStartupPerf,
  enableStartupPerf,
  logStartupPerfTable,
  markEnd,
  markStart,
  _resetStartupPerfForTests,
} from "../startupPerf";

const ELECTRON_DIR = path.resolve(__dirname, "..");

/**
 * Read a TypeScript source file and return its contents. The test
 * intentionally operates on the on-disk source, not on the
 * transpiled output, so the regression catches the human-readable
 * mistake (a contributor writing `import { x } from "./marpExport"`
 * at the top of `main.ts`) before any build step runs.
 */
function read(file: string): string {
  // Normalise CRLF -> LF so the structural source scans below (which embed
  // `\n` in their `indexOf` patterns) match regardless of the line endings
  // git checked out — on Windows the working tree is CRLF, which otherwise
  // makes every multi-line pattern miss and read as -1.
  return fs
    .readFileSync(path.join(ELECTRON_DIR, file), "utf-8")
    .replace(/\r\n/g, "\n");
}

/**
 * Match a static `import` statement (NOT a dynamic `import()`) for a
 * given module path. The regex anchors on a line-leading `import`,
 * a closing `from` followed by the quoted module path, and a
 * terminating semicolon — so it ignores comments referencing the
 * module name and ignores dynamic `import("./x")` calls.
 */
function hasStaticImport(source: string, modulePath: string): boolean {
  // Escape the module path for regex use. The paths we check
  // ("./marpExport", etc.) only contain `.`, `/`, and alphanumeric
  // characters, but the escape keeps the helper safe against
  // future path additions that include regex meta-characters.
  const escaped = modulePath.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // `^import .* from "<path>"` with multi-line flag. We disallow a
  // type-only import (`import type { ... } from`) being treated as a
  // runtime import — TypeScript erases `import type` at compile time,
  // so it does not contribute to cold-start cost. The negative
  // lookahead for `type ` covers `import type {`, `import type *`,
  // and `import type X` styles.
  const pattern = new RegExp(
    String.raw`^\s*import(?!\s+type\b)[^;]*?from\s+["']${escaped}["']\s*;`,
    "m",
  );
  return pattern.test(source);
}

describe("startup performance", () => {
  beforeEach(() => {
    _resetStartupPerfForTests();
    enableStartupPerf();
  });

  describe("heavy module imports are deferred", () => {
    const HEAVY_MODULES = [
      "./marpExport",
      "./typstExport",
      "./diffusionSidecar",
      "./autoUpdater",
    ] as const;

    it.each(HEAVY_MODULES)(
      "main.ts does NOT statically import %s",
      (modulePath) => {
        const source = read("main.ts");
        expect(hasStaticImport(source, modulePath)).toBe(false);
      },
    );

    it.each(HEAVY_MODULES)(
      "ipc/index.ts does NOT statically import %s",
      (modulePath) => {
        const source = read("ipc/index.ts");
        expect(hasStaticImport(source, modulePath)).toBe(false);
      },
    );

    it.each(HEAVY_MODULES)(
      "ipc.ts does NOT statically import %s",
      (modulePath) => {
        const source = read("ipc.ts");
        expect(hasStaticImport(source, modulePath)).toBe(false);
      },
    );

    it("appState.ts only imports diffusionSidecar as a type", () => {
      const source = read("appState.ts");
      // The type-only import is allowed (it erases at compile time)
      // but a runtime import is forbidden — diffusion sidecar setup
      // must happen via dynamic `import("./diffusionSidecar")`
      // inside the demand-load accessor `ensureDiffusionSidecar()`.
      expect(hasStaticImport(source, "./diffusionSidecar")).toBe(false);
      // Type-only import is still present so the field declaration
      // `diffusionSidecar: DiffusionSidecar | null` keeps its type.
      expect(source).toContain(
        'import type { DiffusionSidecar } from "./diffusionSidecar";',
      );
      // The actual lazy load is via a dynamic import — assert it
      // exists so a contributor who deletes the dynamic load also
      // sees this test fail.
      expect(source).toMatch(/import\(\s*["']\.\/diffusionSidecar["']/);
    });

    it("appState.ts demand-loads diffusion in ensureDiffusionSidecar, not at boot in initAppState (LW-1)", () => {
      const source = read("appState.ts");
      // LW-1 parity: the diffusion module graph + `DiffusionSidecar`
      // object must NOT be constructed during `initAppState()` (every
      // boot, even sessions that never generate an image). The single
      // dynamic `import("./diffusionSidecar")` must live in the
      // demand-load accessor `ensureDiffusionSidecar()`, which the
      // imagegen path calls on the first "Generate image" action.
      // Match the actual load KICKOFF (the assignment to
      // `diffusionSidecarLoadPromise`), not bare `import(...)` mentions
      // — the latter also appears in surrounding JSDoc/comments and
      // would make this test count documentation, not code.
      const loadAssignment =
        /diffusionSidecarLoadPromise\s*=\s*import\(\s*["']\.\/diffusionSidecar["']/g;
      const loadMatches = source.match(loadAssignment);
      expect(loadMatches).not.toBeNull();
      // Exactly one real load site keeps the locality assertion below
      // unambiguous — if a second one appears, revisit this test.
      expect(loadMatches).toHaveLength(1);

      const initStart = source.indexOf(
        "export async function initAppState",
      );
      const ensureStart = source.indexOf(
        "export async function ensureDiffusionSidecar",
      );
      const loadIdx = source.search(loadAssignment);
      expect(initStart).toBeGreaterThanOrEqual(0);
      expect(ensureStart).toBeGreaterThan(initStart);
      // The (sole) load kickoff sits inside `ensureDiffusionSidecar`,
      // which is declared well below `initAppState` — so it cannot be
      // part of the boot path.
      expect(loadIdx).toBeGreaterThan(ensureStart);
    });
  });

  describe("perf marker API", () => {
    it("markStart followed by markEnd returns a finite duration", () => {
      markStart("test-stage");
      const dur = markEnd("test-stage");
      expect(dur).not.toBeNull();
      expect(dur).toBeGreaterThanOrEqual(0);
      expect(Number.isFinite(dur ?? Number.NaN)).toBe(true);
    });

    it("markEnd without a matching markStart returns null", () => {
      const dur = markEnd("unstarted-stage");
      expect(dur).toBeNull();
    });

    it("collectStartupPerf returns recorded measures in order", () => {
      markStart("first");
      markEnd("first");
      markStart("second");
      markEnd("second");
      const marks = collectStartupPerf();
      const names = marks.map((m) => m.name);
      expect(names).toEqual(["first", "second"]);
      for (const m of marks) {
        expect(m.durationMs).toBeGreaterThanOrEqual(0);
        expect(m.endMs).toBeGreaterThanOrEqual(m.startMs);
      }
    });

    it("logStartupPerfTable emits one 'startup-perf' event with every stage", () => {
      markStart("alpha");
      markEnd("alpha");
      markStart("beta");
      markEnd("beta");
      const captured: Array<{
        event: string;
        payload: Record<string, unknown>;
      }> = [];
      logStartupPerfTable((event, payload) =>
        captured.push({ event, payload }),
      );
      expect(captured).toHaveLength(1);
      expect(captured[0].event).toBe("startup-perf");
      const stages = captured[0].payload.stages as Array<{ name: string }>;
      expect(stages.map((s) => s.name)).toEqual(["alpha", "beta"]);
      expect(typeof captured[0].payload.totalMs).toBe("number");
    });

    it("logStartupPerfTable is a no-op when no marks have been recorded", () => {
      const captured: Array<{ event: string }> = [];
      logStartupPerfTable((event) => captured.push({ event }));
      expect(captured).toHaveLength(0);
    });

    it("coldStartTotalMs anchors on window-show, excluding background bridge-init (LW-8)", () => {
      // Boot-to-first-render: app-ready then the window paints.
      markStart("app-ready");
      markEnd("app-ready");
      markStart("window-show");
      markEnd("window-show");
      // LW-8: bridge-init now runs OFF the critical path and ends LATER
      // in wall-clock than first paint. Spin briefly so its end mark is
      // strictly after window-show's.
      markStart("bridge-init");
      const t0 = performance.now();
      while (performance.now() - t0 < 2) {
        /* burn ~2ms so bridge-init:end > window-show:end deterministically */
      }
      markEnd("bridge-init");

      const marks = collectStartupPerf();
      const earliestStart = Math.min(...marks.map((m) => m.startMs));
      const windowShow = marks.find((m) => m.name === "window-show");
      const latestEnd = Math.max(...marks.map((m) => m.endMs));
      expect(windowShow).toBeDefined();

      const total = coldStartTotalMs();
      expect(total).not.toBeNull();
      // The total is anchored on the first-paint instant…
      expect(total).toBeCloseTo(
        (windowShow as { endMs: number }).endMs - earliestStart,
        5,
      );
      // …and NOT on the last (background) mark — bridge-init ended later
      // but must not inflate the cold-start number.
      expect(latestEnd).toBeGreaterThan((windowShow as { endMs: number }).endMs);
      expect(total as number).toBeLessThan(latestEnd - earliestStart);
    });

    it("coldStartTotalMs falls back to the last mark when no window-show was recorded", () => {
      // A boot that never opened a window (e.g. headless failure path)
      // must still produce a finite number rather than NaN/null.
      markStart("app-ready");
      markEnd("app-ready");
      markStart("bridge-init");
      markEnd("bridge-init");
      const marks = collectStartupPerf();
      const earliestStart = Math.min(...marks.map((m) => m.startMs));
      const latestEnd = Math.max(...marks.map((m) => m.endMs));
      expect(coldStartTotalMs()).toBeCloseTo(latestEnd - earliestStart, 5);
    });
  });

  describe("main.ts wires the perf markers at the documented stages", () => {
    it("calls markStart('app-ready') before whenReady and markEnd inside the callback", () => {
      const source = read("main.ts");
      // The start anchor lives at module scope so V8 records the
      // mark as close to the binary entrypoint as we can get.
      expect(source).toMatch(/markStart\(["']app-ready["']\)/);
      expect(source).toMatch(/markEnd\(["']app-ready["']\)/);
    });

    it("wraps initAppState in bridge-init marks", () => {
      const source = read("main.ts");
      expect(source).toMatch(
        /markStart\(["']bridge-init["']\)[\s\S]{0,400}await initAppState\(\)[\s\S]{0,200}markEnd\(["']bridge-init["']\)/,
      );
    });

    it("ends the window-show measure on ready-to-show and logs the table", () => {
      const source = read("main.ts");
      expect(source).toMatch(/markStart\(["']window-show["']\)/);
      expect(source).toMatch(
        /ready-to-show[\s\S]{0,500}markEnd\(["']window-show["']\)[\s\S]{0,500}logStartupPerfTable\(/,
      );
    });

    it("creates the window BEFORE kicking off background bridge init (LW-8 window-first)", () => {
      const source = read("main.ts");
      // The cold-start win depends on the window painting before the
      // heavy bridge init runs. Pin the ordering structurally so a
      // refactor that moves `createWindow()` back after the bridge init
      // fails here instead of silently regressing the budget.
      const createIdx = source.indexOf("createWindow();\n  appInitComplete");
      // Match the call SITE (`…();`) — the doc comment also mentions the
      // helper by name, so anchor on the trailing semicolon.
      const bridgeIdx = source.indexOf("void initBridgeAndServices();");
      expect(createIdx).toBeGreaterThan(-1);
      expect(bridgeIdx).toBeGreaterThan(-1);
      expect(createIdx).toBeLessThan(bridgeIdx);
    });

    it("does not await initAppState on the whenReady critical path before the window", () => {
      const source = read("main.ts");
      // `await initAppState()` must live ONLY inside the
      // `initBridgeAndServices` helper (dispatched via `void`), never
      // directly on the `whenReady` path ahead of `createWindow()`.
      const whenReadyIdx = source.indexOf("app.whenReady().then(");
      const createIdx = source.indexOf(
        "createWindow();\n  appInitComplete",
        whenReadyIdx,
      );
      const awaitInitIdx = source.indexOf("await initAppState()");
      expect(whenReadyIdx).toBeGreaterThan(-1);
      expect(createIdx).toBeGreaterThan(-1);
      // The only `await initAppState()` is defined earlier in the file
      // (inside `initBridgeAndServices`, above the whenReady block), so
      // it must NOT appear between whenReady start and createWindow.
      const onCriticalPath =
        awaitInitIdx > whenReadyIdx && awaitInitIdx < createIdx;
      expect(onCriticalPath).toBe(false);
    });
  });
});
