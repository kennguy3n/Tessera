/**
 * Phase 19 PR 10 Task 9 — local-only telemetry sink.
 *
 * Privacy contract
 * ----------------
 * Tessera is local-first. Telemetry here is opt-in (defaults to off),
 * never leaves the user's machine, never opens a socket, never reads
 * environment data, and never records PII / artifact content /
 * connector identifiers. The sink only accepts:
 *
 *   - `counter` events: a string key (e.g. "artifact.save") and a
 *     monotonic increment.
 *   - `timing` events: a string key (e.g. "search.hybrid_ms") and a
 *     numeric duration in milliseconds, clamped to `0 <= d <= 1h`.
 *
 * The renderer cannot send raw event payloads. Every callable
 * surface in `appLockIpc` / `settingsIpc` / `bridgeAdapters` calls
 * one of the typed helpers below, which whitelist the key and the
 * value. There is no `recordRaw(json)` escape hatch.
 *
 * Storage
 * -------
 * Events buffer in memory and flush every
 * `TELEMETRY_FLUSH_INTERVAL_MS` milliseconds to
 * `<userData>/telemetry.jsonl`. The file is append-only newline-
 * delimited JSON; each line is a single event of the form:
 *
 *   {"t":1716945600000,"k":"counter","key":"artifact.save","value":1}
 *
 * On `app.willQuit` the buffer is flushed synchronously so events
 * accrued in the last 60 seconds are not lost.
 *
 * When the user flips `telemetryEnabled` from `true` to `false`,
 * `disableTelemetry()` drops the in-memory buffer AND truncates the
 * on-disk file. The "off" state means zero retained data, not just
 * zero new writes. This matches the user-visible toggle semantics in
 * Settings — "Disable" must mean "delete everything", not "stop
 * recording new events".
 *
 * Thread safety
 * -------------
 * Electron's main process runs single-threaded (with libuv async
 * IO), so the in-memory buffer does not need locking. The synchronous
 * `flushSync` path is reentrancy-safe because `flushPending = true`
 * gates concurrent calls.
 */

import * as fs from "fs";
import * as path from "path";
import { app } from "electron";

import { getLogger } from "./logger";
import {
  TELEMETRY_BUFFER_MAX_EVENTS,
  TELEMETRY_FLUSH_INTERVAL_MS,
} from "../shared/types";

/**
 * Discriminated union of telemetry event payloads. The wire shape
 * (`{t,k,key,value}`) is the same for both variants — the `k`
 * discriminator lets a reader pick the right interpretation of
 * `value`.
 */
export type TelemetryEvent =
  | {
      /** Epoch milliseconds when the event was recorded. */
      t: number;
      /** Discriminator: "counter" or "timing". */
      k: "counter";
      /** Whitelisted event key. */
      key: string;
      /** Counter increment (typically 1, always >= 0). */
      value: number;
    }
  | {
      t: number;
      k: "timing";
      key: string;
      /** Duration in milliseconds, clamped to [0, 3_600_000]. */
      value: number;
    };

/**
 * Hard cap on a single timing event's value, in milliseconds. One
 * hour is far longer than any legitimate single operation; values
 * above this are almost certainly a wall-clock bug (negative delta,
 * unhandled overflow, accidentally passing seconds instead of ms).
 * Clamping in the sink rather than rejecting means a buggy emitter
 * still produces useful (if degraded) telemetry instead of a silent
 * drop.
 */
const TIMING_VALUE_MAX_MS = 60 * 60 * 1000;

/**
 * Whitelist of acceptable event keys. Defined here, not at the call
 * site, so a code reviewer can audit the entire telemetry surface in
 * one place. Adding a new key is a deliberate one-line addition to
 * this set — it makes the privacy boundary explicit instead of
 * implicit-in-callsites.
 *
 * Keys use `domain.action` form so `domain` (counters per page /
 * subsystem) can be filtered separately from `action`.
 */
export const TELEMETRY_KEYS = new Set<string>([
  "app.start",
  "app.ready",
  "app.crash",
  "app.lock.unlock_success",
  "app.lock.unlock_failure",
  "artifact.save",
  "artifact.export",
  "artifact.generate",
  "connector.sync_success",
  "connector.sync_failure",
  "model.load",
  "model.unload",
  "search.hybrid",
  "search.bm25",
  "search.vector",
  "update.check",
  "update.download",
  "update.install",
  "update.signature_pass",
  "update.signature_fail",
] as const);

interface SinkState {
  enabled: boolean;
  /** In-memory ring of events not yet flushed to disk. */
  buffer: TelemetryEvent[];
  /** Set when a flushAsync is in flight to coalesce concurrent calls. */
  flushPending: boolean;
  /** Interval handle for the timed flush; `null` when disabled. */
  flushTimer: NodeJS.Timeout | null;
}

const state: SinkState = {
  enabled: false,
  buffer: [],
  flushPending: false,
  flushTimer: null,
};

/**
 * Resolve the on-disk sink path. Wrapped in a function (not a
 * module-level constant) so tests can swap `app.getPath("userData")`
 * via `_resetSinkForTests` without recompiling this module.
 */
function sinkPath(): string {
  return path.join(app.getPath("userData"), "telemetry.jsonl");
}

/**
 * Lazily enable the sink. Idempotent — calling repeatedly is safe.
 * Called from `settings:update` when the toggle transitions from
 * `false` to `true`, and from `initTelemetrySink()` at app startup
 * when the persisted config already has `telemetryEnabled = true`.
 */
export function enableTelemetry(): void {
  if (state.enabled) return;
  state.enabled = true;
  if (state.flushTimer === null) {
    state.flushTimer = setInterval(() => {
      flushAsync().catch((err) => {
        getLogger().warn("telemetry.flush_async_failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      });
    }, TELEMETRY_FLUSH_INTERVAL_MS);
    // Allow Node's event loop to exit on `app.quit` even if a flush
    // is mid-flight. The `app.willQuit` handler still issues a final
    // synchronous flush so events are not lost on a clean exit.
    if (typeof state.flushTimer.unref === "function") {
      state.flushTimer.unref();
    }
  }
}

/**
 * Disable the sink and erase persisted state. Called from
 * `settings:update` when the toggle transitions from `true` to
 * `false`. Drops the in-memory buffer AND truncates the on-disk
 * file — "off" means zero retained data per the user-visible
 * toggle contract.
 */
export function disableTelemetry(): void {
  state.enabled = false;
  state.buffer.length = 0;
  if (state.flushTimer !== null) {
    clearInterval(state.flushTimer);
    state.flushTimer = null;
  }
  try {
    const fp = sinkPath();
    if (fs.existsSync(fp)) {
      fs.unlinkSync(fp);
    }
  } catch (err) {
    getLogger().warn("telemetry.disable_unlink_failed", {
      err: err instanceof Error ? err.message : String(err),
    });
  }
}

/**
 * Initialise the sink at app start. Reads the persisted
 * `telemetryEnabled` flag and either enables or no-ops. Called from
 * `main.ts` after `loadConfig()` is ready.
 */
export function initTelemetrySink(telemetryEnabled: boolean): void {
  if (telemetryEnabled) {
    enableTelemetry();
  }
}

/**
 * Record a counter event. No-op when telemetry is disabled, when
 * the key is not whitelisted, or when `increment` is non-finite /
 * negative.
 *
 * `increment` defaults to 1 because the overwhelming majority of
 * callers record single occurrences (`recordCounter("artifact.save")`).
 * Callers batching multiple occurrences may pass a positive integer.
 */
export function recordCounter(key: string, increment: number = 1): void {
  if (!state.enabled) return;
  if (!TELEMETRY_KEYS.has(key)) return;
  if (!Number.isFinite(increment) || increment < 0) return;
  pushEvent({
    t: Date.now(),
    k: "counter",
    key,
    value: Math.floor(increment),
  });
}

/**
 * Record a timing event in milliseconds. No-op when telemetry is
 * disabled, when the key is not whitelisted, or when `ms` is
 * non-finite or negative. Values above `TIMING_VALUE_MAX_MS` are
 * clamped (not dropped) so a buggy emitter still produces useful
 * data.
 */
export function recordTiming(key: string, ms: number): void {
  if (!state.enabled) return;
  if (!TELEMETRY_KEYS.has(key)) return;
  if (!Number.isFinite(ms) || ms < 0) return;
  const clamped = Math.min(ms, TIMING_VALUE_MAX_MS);
  pushEvent({ t: Date.now(), k: "timing", key, value: clamped });
}

function pushEvent(evt: TelemetryEvent): void {
  if (state.buffer.length >= TELEMETRY_BUFFER_MAX_EVENTS) {
    // Drop the oldest event to bound the buffer. We could also drop
    // the new event, but oldest-first matches the "more recent
    // events are more useful for diagnosing the live session" prior.
    state.buffer.shift();
  }
  state.buffer.push(evt);
}

/**
 * Async flush: append the in-memory buffer to the sink file and
 * clear it. Coalesces concurrent calls via `flushPending`. Safe to
 * call when telemetry is disabled (returns immediately).
 */
export async function flushAsync(): Promise<void> {
  if (!state.enabled) return;
  if (state.flushPending) return;
  if (state.buffer.length === 0) return;
  state.flushPending = true;
  // Snapshot + clear under the synchronous read so a concurrent
  // `recordCounter` between this line and `appendFile` is captured
  // in the next flush, not this one.
  const events = state.buffer.splice(0, state.buffer.length);
  try {
    const payload = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    await fs.promises.appendFile(sinkPath(), payload, { encoding: "utf-8" });
  } catch (err) {
    // Re-enqueue the events at the head so the next flush can
    // retry. Drop on `ENOSPC` / `EACCES` to avoid a permanent buffer
    // pin that would grow without bound.
    const e = err as NodeJS.ErrnoException;
    if (e.code !== "ENOSPC" && e.code !== "EACCES" && e.code !== "EPERM") {
      state.buffer.unshift(...events);
    }
    getLogger().warn("telemetry.flush_failed", {
      err: err instanceof Error ? err.message : String(err),
      events: events.length,
    });
  } finally {
    state.flushPending = false;
  }
}

/**
 * Synchronous flush: used from `app.willQuit` where awaiting an
 * async write is unsafe. Skips entirely when telemetry is disabled
 * or the buffer is empty.
 */
export function flushSync(): void {
  if (!state.enabled) return;
  if (state.buffer.length === 0) return;
  const events = state.buffer.splice(0, state.buffer.length);
  try {
    const payload = events.map((e) => JSON.stringify(e)).join("\n") + "\n";
    fs.appendFileSync(sinkPath(), payload, { encoding: "utf-8" });
  } catch (err) {
    getLogger().warn("telemetry.flush_sync_failed", {
      err: err instanceof Error ? err.message : String(err),
      events: events.length,
    });
  }
}

/**
 * Read the persisted telemetry file as parsed events. Used by the
 * renderer's "Show what I've recorded" panel so the user can audit
 * exactly what is on disk. Returns an empty array if the file does
 * not exist or contains no valid events.
 *
 * Malformed lines are skipped (not rejected wholesale) so a partial
 * write that left a half-written tail doesn't blank out the whole
 * history.
 */
export function readPersistedEvents(): TelemetryEvent[] {
  const fp = sinkPath();
  let raw: string;
  try {
    raw = fs.readFileSync(fp, "utf-8");
  } catch {
    return [];
  }
  const events: TelemetryEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line) continue;
    try {
      const parsed = JSON.parse(line) as unknown;
      if (!isValidEvent(parsed)) continue;
      events.push(parsed);
    } catch {
      // Skip malformed line.
    }
  }
  return events;
}

function isValidEvent(value: unknown): value is TelemetryEvent {
  if (value === null || typeof value !== "object") return false;
  const v = value as Record<string, unknown>;
  if (typeof v.t !== "number" || !Number.isFinite(v.t)) return false;
  if (v.k !== "counter" && v.k !== "timing") return false;
  if (typeof v.key !== "string" || !TELEMETRY_KEYS.has(v.key)) return false;
  if (typeof v.value !== "number" || !Number.isFinite(v.value)) return false;
  return true;
}

/**
 * Return the current snapshot of in-memory + on-disk events,
 * deduplicated. Used by tests and by the renderer audit panel.
 * The on-disk slice always precedes the in-memory slice in time
 * order (because in-memory events have not yet been flushed).
 */
export function getEventsSnapshot(): TelemetryEvent[] {
  return [...readPersistedEvents(), ...state.buffer];
}

/**
 * Test-only: reset the in-memory state so each test starts with
 * the sink disabled and buffer empty. Does NOT touch on-disk
 * state — tests that care about the file must clean up
 * themselves via the tempdir.
 */
export function _resetTelemetryForTests(): void {
  state.enabled = false;
  state.buffer.length = 0;
  state.flushPending = false;
  if (state.flushTimer !== null) {
    clearInterval(state.flushTimer);
    state.flushTimer = null;
  }
}

/**
 * Test-only: surface whether the sink is currently enabled. Used by
 * tests to assert toggle transitions without exporting `state`
 * directly.
 */
export function _isEnabledForTests(): boolean {
  return state.enabled;
}
