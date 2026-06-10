/**
 * Cold-start performance instrumentation.
 *
 * Records `performance.mark()` entries at every boot stage so we can
 * track regressions against the sub-2s window-visible budget without
 * having to attach a profiler.
 *
 * Naming convention: `tessera:<stage>:start` and `tessera:<stage>:end`
 * so `performance.measure(stage, startMark, endMark)` produces a
 * `PerformanceMeasure` entry under the stage name. Stages:
 *
 *   - `app-ready` — from process spawn to `app.whenReady().then(...)`
 *     callback entry (only the end mark; the start anchor is
 *     `process.hrtime.bigint()` captured at module load).
 *   - `bridge-init` — `initAppState()` (loads the Rust N-API addon,
 *     opens the SharedConnection, applies SQLCipher key).
 *   - `db-open` — substep inside `bridge-init` for the SQLCipher open
 *     itself (recorded by the bridge via `recordPerfMark`).
 *   - `window-show` — from `createWindow()` to `mainWindow.show()`.
 *
 * The full table is emitted to the logger as `startup-perf` once the
 * main window is shown. The data is also retained on
 * `performance.getEntriesByType('measure')` for dev-tools introspection.
 *
 * Disabled in tests by default — pass `enabled: false` to skip the
 * `performance.mark()` calls when running under Vitest so the global
 * `performance` API stays free of test fixture noise.
 */
import { performance } from "perf_hooks";

export interface PerfMark {
  readonly name: string;
  readonly startMs: number;
  readonly endMs: number;
  readonly durationMs: number;
}

const STAGE_PREFIX = "tessera:";

let enabled = true;

/**
 * Disable the global perf instrumentation. Tests call this in their
 * `beforeAll` so a vitest run with many `import('../main')` re-entries
 * does not leak hundreds of marks into the shared `performance`
 * entries buffer.
 */
export function disableStartupPerf(): void {
  enabled = false;
}

/**
 * Re-enable instrumentation after a `disableStartupPerf()` call.
 * Tests that explicitly want to assert on the recorded marks call
 * this in their `beforeEach`.
 */
export function enableStartupPerf(): void {
  enabled = true;
}

/**
 * Record the `<stage>:start` mark. No-op when disabled.
 */
export function markStart(stage: string): void {
  if (!enabled) return;
  try {
    performance.mark(`${STAGE_PREFIX}${stage}:start`);
  } catch {
    // `performance.mark` throws only for invalid name characters,
    // none of which appear in our stage names. The catch keeps the
    // boot path crash-proof against any future runtime change.
  }
}

/**
 * Record the `<stage>:end` mark and the matching measure. No-op when
 * disabled. Returns the duration in ms (or `null` if instrumentation
 * is off or the start mark is missing).
 */
export function markEnd(stage: string): number | null {
  if (!enabled) return null;
  const startName = `${STAGE_PREFIX}${stage}:start`;
  const endName = `${STAGE_PREFIX}${stage}:end`;
  try {
    performance.mark(endName);
    const measure = performance.measure(
      `${STAGE_PREFIX}${stage}`,
      startName,
      endName,
    );
    return measure.duration;
  } catch {
    // `performance.measure` throws when the start mark is absent.
    // Treat as a soft signal — the caller didn't paired the mark
    // correctly, but we don't want to crash the boot path over a
    // missing perf datum.
    return null;
  }
}

/**
 * Collect every Tessera boot measure recorded so far. Returns an
 * ordered list (oldest first). Used by `logStartupPerfTable()` and by
 * tests.
 */
export function collectStartupPerf(): PerfMark[] {
  if (!enabled) return [];
  const measures = performance.getEntriesByType("measure") as Array<
    { name: string; startTime: number; duration: number }
  >;
  return measures
    .filter((entry) => entry.name.startsWith(STAGE_PREFIX))
    .map((entry) => ({
      name: entry.name.slice(STAGE_PREFIX.length),
      startMs: entry.startTime,
      endMs: entry.startTime + entry.duration,
      durationMs: entry.duration,
    }))
    .sort((a, b) => a.startMs - b.startMs);
}

/**
 * The boot stage whose end marks "the renderer produced its first
 * paint" — the cold-start end anchor. Recorded on the main window's
 * `ready-to-show` (see `createWindow` in `main.ts`).
 */
export const FIRST_RENDER_STAGE = "window-show";

/**
 * End anchor for the cold-start total: the first-paint instant.
 *
 * LW-8 moved bridge initialisation (`initAppState` → `open_store` +
 * tombstone replay + FTS purge) OFF the cold-start critical path — it
 * now runs in the background AFTER `createWindow()`, so its
 * `bridge-init` measure ends *later* in wall-clock than `window-show`.
 * Anchoring on "the latest mark" (as this once did) would therefore
 * fold that background work back into the cold-start number, defeating
 * the entire point of the deferral. We instead anchor explicitly on the
 * `window-show` measure's end — the boot-to-first-render instant — and
 * fall back to the latest mark only for a boot that never opened a
 * window (so the number is never `NaN`).
 */
function firstRenderEndMs(marks: PerfMark[]): number {
  const firstRender = marks.find((m) => m.name === FIRST_RENDER_STAGE);
  return firstRender ? firstRender.endMs : marks[marks.length - 1].endMs;
}

/**
 * Total cold-start duration in ms: the span from the earliest Tessera
 * boot mark (`app-ready` start, anchored at main-bundle module load)
 * to the first-paint instant (`window-show` end, recorded on the main
 * window's `ready-to-show`). This is the boot-to-first-render number
 * the cold-start gate asserts against.
 *
 * Note this is deliberately NOT "earliest start → latest end": after
 * LW-8 the background `bridge-init` measure ends after first paint, and
 * it must be excluded (see {@link firstRenderEndMs}).
 *
 * Returns `null` when instrumentation is disabled or no marks have
 * been recorded yet.
 */
export function coldStartTotalMs(): number | null {
  const marks = collectStartupPerf();
  if (marks.length === 0) return null;
  return firstRenderEndMs(marks) - marks[0].startMs;
}

/**
 * Write the boot perf table to the supplied log sink. The sink is the
 * jsonl-emitting logger from `./logger.ts` in production, and a
 * vitest-friendly recorder in tests. Always emitted as a single
 * structured event so log readers can pull the table without parsing
 * multiple lines.
 */
export function logStartupPerfTable(
  log: (event: string, payload: Record<string, unknown>) => void,
): void {
  if (!enabled) return;
  const marks = collectStartupPerf();
  if (marks.length === 0) return;
  log("startup-perf", {
    stages: marks.map((m) => ({
      name: m.name,
      startMs: round2(m.startMs),
      durationMs: round2(m.durationMs),
    })),
    totalMs: round2(firstRenderEndMs(marks) - marks[0].startMs),
  });
}

function round2(value: number): number {
  return Math.round(value * 100) / 100;
}

/**
 * Test helper: clear every Tessera mark and measure from the global
 * `performance` entries buffer. Production code never calls this.
 */
export function _resetStartupPerfForTests(): void {
  try {
    const measures = performance.getEntriesByType("measure") as Array<
      { name: string }
    >;
    for (const m of measures) {
      if (m.name.startsWith(STAGE_PREFIX)) {
        performance.clearMeasures(m.name);
      }
    }
    const marks = performance.getEntriesByType("mark") as Array<
      { name: string }
    >;
    for (const m of marks) {
      if (m.name.startsWith(STAGE_PREFIX)) {
        performance.clearMarks(m.name);
      }
    }
  } catch {
    // Browsers without the full Performance API surface (older
    // jsdom) may not implement `clearMeasures` / `clearMarks`.
    // Test code that depends on a clean slate should fall back to
    // running the test in isolation.
  }
}
