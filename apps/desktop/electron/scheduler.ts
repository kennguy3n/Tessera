/**
 * Automations scheduler service.
 *
 * Runs in the Electron main process. Every {@link DEFAULT_TICK_MS}
 * milliseconds it asks the Rust bridge for the set of currently-due
 * `Schedule`-triggered automations and dispatches each one's action
 * (`ReindexSource` or `GenerateFromTemplate`) directly against the
 * bridge — i.e. we **do not** route through the renderer IPC. Going
 * through the renderer would couple the scheduler to whether a window
 * is open, which we don't want (Tessera is a long-running desktop app
 * and the user may close all windows but leave the tray icon active).
 *
 * After each dispatch the scheduler calls `bridgeRecordAutomationRun`
 * with a short status string (`"ok"` / `"failed: <reason>"`). That
 * advances `last_run_at` so subsequent ticks won't re-fire the same
 * automation until `interval_seconds` has elapsed, and surfaces a
 * human-readable result to the AutomationsPage UI.
 *
 * `OnGenerate` triggers are *not* polled here — they're invoked
 * synchronously from the `artifacts:generateFromTemplate` IPC handler
 * after a successful generation via {@link dispatchOnGenerate}.
 *
 * Note an intentional asymmetry: a `GenerateFromTemplate` action that
 * fires from this scheduler does **not** in turn re-trigger any
 * `OnGenerate` automations bound to that template. We dispatch the
 * generation directly against the bridge (no IPC round-trip) precisely
 * so the scheduler can't cascade into an infinite loop
 * (Schedule → generate → OnGenerate-that-generates → OnGenerate → …).
 * OnGenerate is reserved for *user-initiated* generations going through
 * `artifacts:generateFromTemplate`.
 */
import {
  getBridge,
  getKchatBackfillImpl,
  type NativeBridge,
  type AutomationInfo,
} from "./appState";
import { isBatteryLow } from "./batteryMonitor";
import { isIndexingDeferredForMemory } from "./memoryWatchdog";
import { isAppSuspended } from "./appSuspension";

/**
 * Thrown by {@link executeLeafAction} when a `GenerateFromTemplate`
 * action is skipped because the device is on a low battery (LW-3).
 * `runAutomation` catches it specifically and records a
 * `"skipped: battery_low"` status rather than a `"failed: …"` one — a
 * deferred synthesis is not a failure, and the automation should fire
 * normally on the next due tick once the device is charged.
 */
class BatteryGatedSkip extends Error {
  constructor() {
    super("battery_low");
    this.name = "BatteryGatedSkip";
  }
}

/**
 * Thrown by {@link executeLeafAction} when a `reindex_source` step is
 * deferred because the LW-7 memory watchdog has paused bulk-index
 * admission (main-process RSS above the high-water mark). Like
 * {@link BatteryGatedSkip}, `runAutomation` catches it specifically and
 * records a `"skipped: memory_pressure"` status rather than a `"failed: …"`
 * one — a deferred reindex is not a failure, and the automation should
 * fire normally on the next due tick once RSS drops back below the
 * low-water mark.
 *
 * This extends the `sources:batchReindex` IPC admission gate (see
 * `ipc/sources.ts`) to the automation-driven reindex path (Schedule,
 * OnGenerate, and OnKchatMessage automations all reach `executeLeafAction`
 * via `runAutomation`), which calls `bridgeReindexSource` directly and
 * would otherwise bypass the watchdog entirely — letting a dense run of
 * due `reindex_source` automations admit full-source reindexes exactly
 * when the watchdog wants to back off.
 */
class MemoryGatedSkip extends Error {
  constructor() {
    super("memory_pressure");
    this.name = "MemoryGatedSkip";
  }
}

const DEFAULT_TICK_MS = 30_000;

interface AutomationTrigger {
  kind: "schedule" | "on_generate" | "on_kchat_message_match";
  interval_seconds?: number;
  template_id?: string;
  channel_id?: string;
  regex?: string;
}

interface AutomationAction {
  kind:
    | "reindex_source"
    | "generate_from_template"
    | "backfill_kchat_channel"
    | "sequence";
  source_id?: string;
  template_id?: string;
  source_ids?: string[];
  channel_id?: string;
  /** Present only for `kind === "sequence"`: the ordered sub-actions. */
  actions?: AutomationAction[];
}

// Module-level state — there's exactly one scheduler per Electron main
// process. A class would force every consumer to thread a singleton
// reference; module state matches the rest of the codebase
// (config.ts, appState.ts).
let tickHandle: ReturnType<typeof setInterval> | null = null;
// Active tick promise. `null` means no tick is currently running.
// The interval driver and `runNow()` both consult this to serialize
// tick execution; see the comment on `runNow()` for the full state
// machine.
let activeTick: Promise<void> | null = null;
// At most one queued follow-up tick. Set when `runNow()` is invoked
// while a tick is already running — the queued tick fires as soon as
// the active tick resolves. Concurrent `runNow()` callers coalesce
// onto this single promise so a barrage of clicks produces exactly
// one extra tick after the active one, not N.
let queuedRunNow: Promise<void> | null = null;
let lastTickAt: Date | null = null;
let lastTickError: string | null = null;

/** Public surface used by `main.ts` on app ready and on quit. */
export function startScheduler(tickMs: number = DEFAULT_TICK_MS): void {
  if (tickHandle) return;
  tickHandle = setInterval(() => {
    void tick();
  }, tickMs);
  // Kick once immediately so a user creating an automation with a
  // short interval doesn't have to wait a full `tickMs` to see the
  // first run.
  void tick();
}

/**
 * Stop the scheduler interval and wait for any in-flight tick (and the
 * queued follow-up, if any) to drain. Returns a promise that resolves
 * once it's safe to tear down the bridge / quit the process.
 *
 * Callers (`main.ts` on `will-quit`) must `await` this. The interval
 * is cleared synchronously so no new tick can start the moment this
 * function is invoked; only the async wait phase covers the active
 * promise.
 */
export async function stopScheduler(): Promise<void> {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
  }
  // Drain in two phases: queued follow-up first (it implicitly awaits
  // the active tick before running), then the active tick itself. If
  // either ever throws, we still want to honor the quit path, so
  // swallow rejections — the tick's own error handling already wrote
  // any failure into `lastTickError`.
  try {
    if (queuedRunNow) await queuedRunNow;
  } catch {
    /* surfaced via lastTickError */
  }
  try {
    if (activeTick) await activeTick;
  } catch {
    /* surfaced via lastTickError */
  }
}

/** Test-friendly status object the IPC handler can surface to the UI. */
export interface SchedulerStatus {
  running: boolean;
  lastTickAt: string | null;
  lastTickError: string | null;
  inFlight: boolean;
}

export function getSchedulerStatus(): SchedulerStatus {
  return {
    running: tickHandle !== null,
    lastTickAt: lastTickAt ? lastTickAt.toISOString() : null,
    lastTickError,
    inFlight: activeTick !== null,
  };
}

/**
 * Resolve currently-due `Schedule` automations and dispatch each one.
 * Exported for the test suite and called by the scheduler interval on
 * a fixed cadence.
 *
 * Interval semantics: if a previous tick is still running (a slow
 * re-index, say), this call short-circuits and returns immediately.
 * We deliberately do **not** queue interval-driven ticks — overlapping
 * scheduled runs would corrupt `last_run_at` semantics (the second
 * tick reads stale state because the first hasn't recorded yet) and a
 * backlog of queued ticks would amplify any pathology.
 *
 * The manual "Run Now" UI action uses {@link runNow} instead, which
 * waits for the active tick and then enqueues a single follow-up so
 * the user's click always results in an observable fresh tick.
 */
export async function tick(
  bridge: NativeBridge | null = getBridge(),
): Promise<void> {
  if (!bridge) return;
  // LW-9 (minimize-to-tray): when the app is suspended in the tray, the
  // scheduler is paused (`suspendForTray` calls `stopScheduler`), but a
  // tick already dispatched by `setInterval` in the tiny window before
  // `clearInterval` ran could still land here. Self-gate so no
  // background synthesis/reindex burns resources while suspended; the
  // automation re-fires on the next tick after `resumeForTray` restarts
  // the interval. `runNow()` is intentionally NOT gated — it is only
  // reachable from an explicit user action, which requires a visible
  // (non-suspended) window.
  if (isAppSuspended()) return;
  if (activeTick) return;
  await runTick(bridge);
}

/**
 * Manual "tick now" entry point used by the AutomationsPage UI. Unlike
 * {@link tick}, this never silently no-ops on the user — if a tick is
 * already running, it waits for it to complete and then runs a fresh
 * one so the click is guaranteed to produce a new observable tick.
 *
 * Concurrent `runNow()` invocations coalesce onto a single queued
 * follow-up: a burst of clicks while one tick is running results in
 * exactly one extra tick afterward, not N. The returned promise
 * resolves once the caller's tick (the follow-up they're queued onto)
 * has completed.
 */
export async function runNow(
  bridge: NativeBridge | null = getBridge(),
): Promise<void> {
  if (!bridge) return;
  if (!activeTick) {
    await runTick(bridge);
    return;
  }
  // A tick is currently running. Either join the existing queued
  // follow-up (coalesce) or create one.
  if (!queuedRunNow) {
    const current = activeTick;
    queuedRunNow = (async () => {
      // Swallow the active tick's outcome — the queued tick fires
      // regardless of whether the active one succeeded; its own
      // errors are captured in `lastTickError`.
      try {
        await current;
      } catch {
        /* surfaced via lastTickError of the active tick */
      }
      await runTick(bridge);
    })().finally(() => {
      queuedRunNow = null;
    });
  }
  await queuedRunNow;
}

/**
 * Internal helper that performs the actual tick work and manages the
 * `activeTick` promise lifecycle. Callers must check `activeTick`
 * themselves before invoking this — it does NOT guard against
 * re-entrancy on its own.
 */
async function runTick(bridge: NativeBridge): Promise<void> {
  const p = (async () => {
    lastTickError = null;
    try {
      const due = bridge.bridgeDueScheduledAutomations();
      for (const a of due) {
        await runAutomation(bridge, a);
      }
    } catch (e) {
      lastTickError = e instanceof Error ? e.message : String(e);
      // Don't rethrow — the interval would otherwise stall on a single
      // transient bridge error. The error is surfaced via
      // `getSchedulerStatus()` and the per-automation `lastRunStatus`.
      console.error("[scheduler] tick failed:", e);
    } finally {
      lastTickAt = new Date();
    }
  })();
  activeTick = p.finally(() => {
    activeTick = null;
  });
  await activeTick;
}

/**
 * Dispatch every `OnGenerate` automation tied to `templateId`. Called
 * from `ipc.ts` immediately after a successful artifact generation so
 * the user doesn't have to wait for the next scheduler tick.
 *
 * Errors are caught per-automation; a single broken action must not
 * surface as a generation failure for the user.
 */
export async function dispatchOnGenerate(
  templateId: string,
  bridge: NativeBridge | null = getBridge(),
): Promise<void> {
  if (!bridge) return;
  let matches: AutomationInfo[];
  try {
    matches = bridge.bridgeMatchingOnGenerateAutomations(templateId);
  } catch (e) {
    console.error(
      `[scheduler] failed to resolve OnGenerate automations for ${templateId}:`,
      e,
    );
    return;
  }
  for (const a of matches) {
    await runAutomation(bridge, a);
  }
}

/**
 * Dispatch every `OnKchatMessageMatch` automation whose channel equals
 * `channelId` and whose regex matches `message`. Called from the KChat
 * event forwarder ({@link ./kchat/kchatEventForwarder}) on every
 * `posted` WebSocket event.
 *
 * Mirrors {@link dispatchOnGenerate}: resolution failures are logged
 * and swallowed (a malformed rule must not break KChat event handling),
 * and each matching automation is run with per-step error isolation via
 * {@link runAutomation}.
 */
export async function dispatchKchatMessage(
  channelId: string,
  message: string,
  bridge: NativeBridge | null = getBridge(),
): Promise<void> {
  if (!bridge) return;
  if (!channelId) return;
  let matches: AutomationInfo[];
  try {
    matches = bridge.bridgeMatchingKchatMessageAutomations(channelId, message);
  } catch (e) {
    console.error(
      `[scheduler] failed to resolve OnKchatMessageMatch automations for channel ${channelId}:`,
      e,
    );
    return;
  }
  for (const a of matches) {
    await runAutomation(bridge, a);
  }
}

/**
 * Flatten an action into the ordered list of leaf (non-`sequence`)
 * actions to execute. Mirrors `AutomationAction::steps` on the Rust
 * side: a `sequence` expands (recursively) into its children, anything
 * else yields just itself. A `sequence` with no `actions` flattens to
 * an empty list (a no-op automation).
 */
function flattenSteps(action: AutomationAction): AutomationAction[] {
  if (action.kind === "sequence") {
    return (action.actions ?? []).flatMap(flattenSteps);
  }
  return [action];
}

/**
 * Execute a single leaf action against the bridge, throwing on failure.
 * Multi-step orchestration and error aggregation lives in
 * {@link runAutomation}; this only knows how to perform one action.
 */
async function executeLeafAction(
  bridge: NativeBridge,
  action: AutomationAction,
): Promise<void> {
  switch (action.kind) {
    case "reindex_source": {
      if (!action.source_id) {
        throw new Error("reindex_source missing source_id");
      }
      // LW-7: defer automation-driven reindexing while the memory
      // watchdog has paused bulk-index admission. `executeLeafAction`
      // runs for every automation path that reaches `runAutomation` —
      // the scheduled `tick()`, `dispatchOnGenerate`, and
      // `dispatchKchatMessage` — so reindex steps from Schedule,
      // OnGenerate, and OnKchatMessage automations are all gated.
      // User-initiated single-source reindex (`sources:reindex`) stays
      // ungated, mirroring the scope of the `sources:batchReindex` IPC
      // gate (only automated/bulk indexing backs off under pressure).
      // Without this, the direct `bridgeReindexSource` call bypasses the
      // watchdog, so a dense run of due `reindex_source` automations
      // could admit full-source reindexes exactly when RSS is already
      // high. The skip is surfaced as a non-failure status by
      // `runAutomation`, and the automation fires normally on the next
      // due tick once RSS drops below the low-water mark.
      // `isIndexingDeferredForMemory()` fails open (a sampler error or
      // absent watchdog singleton admits indexing).
      if (isIndexingDeferredForMemory()) {
        throw new MemoryGatedSkip();
      }
      bridge.bridgeReindexSource(action.source_id);
      break;
    }
    case "generate_from_template": {
      if (!action.template_id) {
        throw new Error("generate_from_template missing template_id");
      }
      // LW-3: defer background/scheduled synthesis on a low battery.
      // This gates ONLY the scheduler's automation-driven generation —
      // user-initiated generation through `artifacts:generateFromTemplate`
      // is never gated here (an explicit click should always run). The
      // skip is surfaced as a non-failure status by `runAutomation`, and
      // the automation fires normally on the next due tick once charged.
      // `isBatteryLow()` fails open on desktops / AC / unknown state.
      if (isBatteryLow()) {
        throw new BatteryGatedSkip();
      }
      const sourceIds = action.source_ids ?? [];
      bridge.bridgeGenerateFromTemplate(action.template_id, sourceIds);
      break;
    }
    case "backfill_kchat_channel": {
      if (!action.channel_id) {
        throw new Error("backfill_kchat_channel missing channel_id");
      }
      const impl = getKchatBackfillImpl();
      if (!impl) {
        throw new Error(
          "backfill_kchat_channel: KChat backfill not available (auth service not initialised)",
        );
      }
      await impl(action.channel_id);
      break;
    }
    case "sequence": {
      // `runAutomation` flattens sequences before calling this, so a
      // bare `sequence` reaching here means it was nested as a leaf —
      // which `flattenSteps` would already have expanded. Treat it as a
      // programmer error rather than silently no-op'ing.
      throw new Error("sequence action must be flattened before execution");
    }
    default: {
      // The Rust bridge's serde deserialization should have rejected
      // any unknown variant at write time, so this branch is mostly
      // defensive. Still — record the failure so a future schema
      // addition that lands on the Rust side without a TS update
      // surfaces visibly in the UI rather than being silently
      // dropped.
      throw new Error(
        `unknown automation action kind: ${(action as { kind?: string }).kind ?? "(missing)"}`,
      );
    }
  }
}

async function runAutomation(
  bridge: NativeBridge,
  a: AutomationInfo,
): Promise<void> {
  let status = "ok";
  try {
    const action = parseAction(a.actionJson);
    if (action.kind !== "sequence") {
      // Single (non-sequence) action: preserve the original
      // `failed: <msg>` status shape so a one-shot automation reads the
      // same as it always has.
      try {
        await executeLeafAction(bridge, action);
      } catch (e) {
        if (e instanceof BatteryGatedSkip) {
          // LW-3: low-battery defer is a non-failure. Record a distinct
          // status so the run advances `last_run_at` (no per-tick churn)
          // and the UI shows "skipped" rather than a red failure badge.
          status = "skipped: battery_low";
        } else if (e instanceof MemoryGatedSkip) {
          // LW-7: memory-pressure defer is a non-failure, same as the
          // battery skip above — record a distinct status so the UI
          // shows "skipped" not a red failure, and the automation re-runs
          // normally on its next due tick once RSS recovers.
          status = "skipped: memory_pressure";
        } else {
          const msg = e instanceof Error ? e.message : String(e);
          status = `failed: ${msg}`;
          console.error(
            `[scheduler] automation ${a.id} (${a.name}) failed:`,
            e,
          );
        }
      }
    } else {
      // A multi-step `sequence` runs each leaf step independently: a
      // failing step is recorded but does NOT abort the remaining steps.
      // This mirrors `run_action_sequence` / `SequenceReport` on the Rust
      // side, including the aggregated status-string format so the UI
      // renders the same shape regardless of which side computed it.
      const steps = flattenSteps(action);
      const failures: string[] = [];
      let batterySkipped = 0;
      let memorySkipped = 0;
      for (let i = 0; i < steps.length; i++) {
        try {
          await executeLeafAction(bridge, steps[i]);
        } catch (e) {
          if (e instanceof BatteryGatedSkip) {
            // LW-3: a low-battery defer of one step is not a failure —
            // count it separately so it never inflates the `failed: N/M`
            // tally, and so a sequence whose only "errors" are battery
            // skips reports as skipped rather than failed.
            batterySkipped++;
            continue;
          }
          if (e instanceof MemoryGatedSkip) {
            // LW-7: a memory-pressure defer of one step is likewise not a
            // failure — counted separately from `failures` for the same
            // reason as the battery skip above.
            memorySkipped++;
            continue;
          }
          const msg = e instanceof Error ? e.message : String(e);
          failures.push(`step ${i + 1}: ${msg}`);
          console.error(
            `[scheduler] automation ${a.id} (${a.name}) step ${i + 1} failed:`,
            e,
          );
        }
      }
      // Resource-defer skips (LW-3 battery, LW-7 memory) are disclosed in
      // two shapes: a parenthetical appended to the `failed: N/M` line
      // when some steps also failed, and a standalone `skipped: …` status
      // when nothing failed. Both are built from the same ordered clause
      // lists (battery first, then memory) so the strings are
      // deterministic and a battery-only sequence reads exactly as it did
      // before LW-7.
      const skipParenParts: string[] = [];
      if (batterySkipped > 0)
        skipParenParts.push(`${batterySkipped} skipped: battery_low`);
      if (memorySkipped > 0)
        skipParenParts.push(`${memorySkipped} skipped: memory_pressure`);
      const skipStatusParts: string[] = [];
      if (batterySkipped > 0)
        skipStatusParts.push(
          `battery_low (${batterySkipped}/${steps.length} steps)`,
        );
      if (memorySkipped > 0)
        skipStatusParts.push(
          `memory_pressure (${memorySkipped}/${steps.length} steps)`,
        );
      if (failures.length > 0 && skipParenParts.length > 0) {
        // A sequence can both fail some steps AND defer others. Report
        // both so the count is honest: surfacing only the failures would
        // imply the deferred steps ran fine, hiding that they were
        // skipped. The parenthetical keeps the leading `failed: N/M` shape
        // (so existing failure parsing / alerting still matches) while
        // disclosing each skip reason.
        status = `failed: ${failures.length}/${steps.length} steps failed (${skipParenParts.join(", ")}): ${failures.join("; ")}`;
      } else if (failures.length > 0) {
        status = `failed: ${failures.length}/${steps.length} steps failed: ${failures.join("; ")}`;
      } else if (skipStatusParts.length > 0) {
        status = `skipped: ${skipStatusParts.join(", ")}`;
      }
    }
  } catch (e) {
    // Reaching here means parsing the action JSON itself failed (the
    // per-step loop above already isolates execution errors).
    const msg = e instanceof Error ? e.message : String(e);
    status = `failed: ${msg}`;
    console.error(`[scheduler] automation ${a.id} (${a.name}) failed:`, e);
  }
  try {
    bridge.bridgeRecordAutomationRun(a.id, status);
  } catch (e) {
    // Recording the run failed — this is rare (the only failure mode
    // is database I/O) but if it happens we'd otherwise re-fire the
    // same automation on the next tick because `last_run_at` is
    // unchanged. Log and continue — better to have a duplicate run
    // than to stall the whole scheduler.
    console.error(`[scheduler] failed to record run for ${a.id}:`, e);
  }
}

function parseAction(json: string): AutomationAction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(
      `action JSON parse failed: ${e instanceof Error ? e.message : e}`,
    );
  }
  if (!parsed || typeof parsed !== "object" || !("kind" in parsed)) {
    throw new Error("action JSON missing `kind` discriminator");
  }
  return parsed as AutomationAction;
}

/** Exposed only to make the trigger discriminator inspectable by the
 *  AutomationsPage UI without needing to repeat the parsing logic. */
export function parseTrigger(json: string): AutomationTrigger {
  return JSON.parse(json) as AutomationTrigger;
}

// Exported for the test suite — never call from production code.
export const __testing__ = {
  reset: () => {
    if (tickHandle) {
      clearInterval(tickHandle);
      tickHandle = null;
    }
    activeTick = null;
    queuedRunNow = null;
    lastTickAt = null;
    lastTickError = null;
  },
};
