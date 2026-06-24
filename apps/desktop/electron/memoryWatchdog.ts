/**
 * Process RSS watchdog (LW-7).
 *
 * A large initial index can transiently balloon resident memory as the
 * native extraction pool fans out across files and the embedding writer
 * batches chunks. Left unchecked that crowds out the UI and pushes the
 * app well past the lightweight ≤200 MB idle budget. This watchdog polls
 * `process.memoryUsage().rss` on a fixed cadence and, when memory climbs
 * past a high-water mark, flips into a *paused* state that the bulk
 * indexing entry points consult to defer admitting new heavy work.
 *
 * Backpressure with hysteresis, not a hard threshold: we pause at
 * `highWaterMarkBytes` (default 500 MB) and only resume once RSS falls
 * back below `lowWaterMarkBytes` (default 400 MB). The 100 MB gap stops
 * the pause flag from chattering on/off when RSS hovers right at a single
 * threshold — without it, a workload sitting at ~500 MB would flip state
 * on almost every poll, alternately admitting and deferring work.
 *
 * The pause flag gates *admission* of new bulk operations rather than
 * preempting work already running inside the native addon (the bridge
 * exposes no mid-flight cancellation point on this branch). That is the
 * right lever for the problem the plan describes — "prevent a large
 * initial index from crowding out the UI" — because the dominant cost is
 * the *next* batch we are about to start, not the one in flight.
 */

/** Default high-water mark: pause admitting bulk indexing above this RSS. */
export const DEFAULT_HIGH_WATER_MARK_BYTES = 500 * 1024 * 1024;
/** Default low-water mark: resume once RSS falls back below this. */
export const DEFAULT_LOW_WATER_MARK_BYTES = 400 * 1024 * 1024;
/** Default poll cadence. */
export const DEFAULT_POLL_INTERVAL_MS = 10_000;

export interface MemoryWatchdogOptions {
  /** Pause threshold in bytes. Default {@link DEFAULT_HIGH_WATER_MARK_BYTES}. */
  highWaterMarkBytes?: number;
  /** Resume threshold in bytes. Default {@link DEFAULT_LOW_WATER_MARK_BYTES}. */
  lowWaterMarkBytes?: number;
  /** Poll cadence in ms. Default {@link DEFAULT_POLL_INTERVAL_MS}. */
  pollIntervalMs?: number;
  /** RSS sampler. Injectable for tests; defaults to the real process RSS. */
  sampleRssBytes?: () => number;
  /** Notified whenever the paused state flips. */
  onPressureChange?: (paused: boolean, rssBytes: number) => void;
}

/**
 * Pure hysteresis transition: given the *previous* paused state and the
 * latest RSS sample, decide the next paused state.
 *
 *   - Not paused → pause iff `rss >= high`.
 *   - Paused → resume (unpause) iff `rss < low`.
 *   - In the dead-band (`low <= rss < high`) the state is held, which is
 *     the entire point of the two-threshold design.
 *
 * Exported so the policy can be unit tested without timers or a real
 * process. `high` is expected to be `>= low`; if a caller inverts them we
 * still behave sanely (pause dominates) rather than oscillating.
 */
export function nextPausedState(
  prevPaused: boolean,
  rssBytes: number,
  lowWaterMarkBytes: number,
  highWaterMarkBytes: number,
): boolean {
  if (prevPaused) {
    // Stay paused until we've clearly recovered below the low mark.
    return rssBytes >= lowWaterMarkBytes;
  }
  // Not paused: only trip once we breach the high mark.
  return rssBytes >= highWaterMarkBytes;
}

export interface MemoryPressureSnapshot {
  /** Whether bulk indexing admission is currently deferred. */
  paused: boolean;
  /** Most recent RSS sample in bytes (0 before the first poll). */
  rssBytes: number;
  highWaterMarkBytes: number;
  lowWaterMarkBytes: number;
}

/**
 * Periodic RSS sampler with hysteresis. Construct once at boot, call
 * {@link MemoryWatchdog.start}, and consult {@link MemoryWatchdog.isPaused}
 * from bulk indexing admission points.
 */
export class MemoryWatchdog {
  private readonly highWaterMarkBytes: number;
  private readonly lowWaterMarkBytes: number;
  private readonly pollIntervalMs: number;
  private readonly sampleRssBytes: () => number;
  private readonly onPressureChange?: (
    paused: boolean,
    rssBytes: number,
  ) => void;

  private paused = false;
  private lastRssBytes = 0;
  private timer: ReturnType<typeof setInterval> | null = null;

  constructor(options: MemoryWatchdogOptions = {}) {
    const high = options.highWaterMarkBytes ?? DEFAULT_HIGH_WATER_MARK_BYTES;
    let low = options.lowWaterMarkBytes ?? DEFAULT_LOW_WATER_MARK_BYTES;
    // Defend the invariant `low <= high`. An inverted pair would defeat
    // the dead-band and let the flag chatter; clamp low down to high.
    if (low > high) low = high;
    this.highWaterMarkBytes = high;
    this.lowWaterMarkBytes = low;
    this.pollIntervalMs = options.pollIntervalMs ?? DEFAULT_POLL_INTERVAL_MS;
    this.sampleRssBytes =
      options.sampleRssBytes ?? (() => process.memoryUsage().rss);
    this.onPressureChange = options.onPressureChange;
  }

  /** True while RSS pressure is high enough to defer new bulk indexing. */
  isPaused(): boolean {
    return this.paused;
  }

  /** Current pressure snapshot, for the Settings → Resource Usage card. */
  snapshot(): MemoryPressureSnapshot {
    return {
      paused: this.paused,
      rssBytes: this.lastRssBytes,
      highWaterMarkBytes: this.highWaterMarkBytes,
      lowWaterMarkBytes: this.lowWaterMarkBytes,
    };
  }

  /**
   * Take one sample and apply the hysteresis transition. Exposed (and
   * called by the interval) so tests can step the watchdog deterministically
   * without waiting on a timer. Returns the (possibly unchanged) paused state.
   */
  poll(): boolean {
    let rss: number;
    try {
      rss = this.sampleRssBytes();
    } catch {
      // A sampler failure must never wedge indexing — treat it as "no
      // pressure signal" and leave the current state untouched.
      return this.paused;
    }
    this.lastRssBytes = rss;
    const next = nextPausedState(
      this.paused,
      rss,
      this.lowWaterMarkBytes,
      this.highWaterMarkBytes,
    );
    if (next !== this.paused) {
      this.paused = next;
      this.onPressureChange?.(next, rss);
    }
    return this.paused;
  }

  /** Begin polling. Idempotent — a second call is a no-op. */
  start(): void {
    if (this.timer) return;
    // Take one sample synchronously so the watchdog reports truthful
    // pressure from t=0 instead of `paused=false` for the first whole
    // `pollIntervalMs`. Without this, a process that boots already over
    // the high-water mark would admit bulk indexing for up to 10s before
    // the first interval tick observed the pressure. Mirrors
    // `startBatteryMonitor`, which likewise primes its state with an
    // immediate read before arming its interval.
    this.poll();
    this.timer = setInterval(() => this.poll(), this.pollIntervalMs);
    // Don't keep the event loop alive on account of the watchdog alone.
    this.timer.unref?.();
  }

  /** Stop polling and release the timer. Idempotent. */
  stop(): void {
    if (this.timer) {
      clearInterval(this.timer);
      this.timer = null;
    }
  }
}

/**
 * Process-wide singleton. Bulk indexing admission points import
 * {@link isIndexingDeferredForMemory}; main wires {@link startMemoryWatchdog}
 * at boot and {@link stopMemoryWatchdog} on will-quit.
 */
let singleton: MemoryWatchdog | null = null;

export function startMemoryWatchdog(
  options: MemoryWatchdogOptions = {},
): MemoryWatchdog {
  if (!singleton) {
    singleton = new MemoryWatchdog(options);
  }
  singleton.start();
  return singleton;
}

export function stopMemoryWatchdog(): void {
  singleton?.stop();
  // Drop the singleton entirely rather than merely stopping its timer.
  // `isIndexingDeferredForMemory()` reads `singleton?.isPaused()`, so a
  // stopped-but-retained watchdog that was paused at stop time would keep
  // reporting `true` forever and silently wedge all bulk indexing — the
  // exact opposite of the documented fail-open contract. Nulling the
  // singleton makes `isIndexingDeferredForMemory()` fall back to `false`
  // (admit) the moment the watchdog is torn down, matching how
  // `stopBatteryMonitor` resets to the fail-open `AC_ALWAYS` snapshot.
  // It also means a later `startMemoryWatchdog(options)` builds a fresh
  // instance that actually honours the new options.
  singleton = null;
}

/**
 * Admission check for bulk indexing. Returns `true` when the watchdog is
 * currently paused under memory pressure. Defaults to `false` (admit)
 * whenever no watchdog is running — the gate must fail *open* so a missing
 * watchdog never silently blocks all indexing.
 */
export function isIndexingDeferredForMemory(): boolean {
  return singleton?.isPaused() ?? false;
}

/** Current snapshot for the Resource Usage dashboard, or `null` if unstarted. */
export function memoryPressureSnapshot(): MemoryPressureSnapshot | null {
  return singleton?.snapshot() ?? null;
}
