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
import { getBridge, getKchatBackfillImpl, type NativeBridge, type AutomationInfo } from "./appState";

const DEFAULT_TICK_MS = 30_000;

interface AutomationTrigger {
  kind: "schedule" | "on_generate";
  interval_seconds?: number;
  template_id?: string;
}

interface AutomationAction {
  kind: "reindex_source" | "generate_from_template" | "backfill_kchat_channel";
  source_id?: string;
  template_id?: string;
  source_ids?: string[];
  channel_id?: string;
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

async function runAutomation(
  bridge: NativeBridge,
  a: AutomationInfo,
): Promise<void> {
  let status = "ok";
  try {
    const action = parseAction(a.actionJson);
    switch (action.kind) {
      case "reindex_source": {
        if (!action.source_id) {
          throw new Error("reindex_source missing source_id");
        }
        bridge.bridgeReindexSource(action.source_id);
        break;
      }
      case "generate_from_template": {
        if (!action.template_id) {
          throw new Error("generate_from_template missing template_id");
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
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    status = `failed: ${msg}`;
    console.error(
      `[scheduler] automation ${a.id} (${a.name}) failed:`,
      e,
    );
  }
  try {
    bridge.bridgeRecordAutomationRun(a.id, status);
  } catch (e) {
    // Recording the run failed — this is rare (the only failure mode
    // is database I/O) but if it happens we'd otherwise re-fire the
    // same automation on the next tick because `last_run_at` is
    // unchanged. Log and continue — better to have a duplicate run
    // than to stall the whole scheduler.
    console.error(
      `[scheduler] failed to record run for ${a.id}:`,
      e,
    );
  }
}

function parseAction(json: string): AutomationAction {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (e) {
    throw new Error(`action JSON parse failed: ${e instanceof Error ? e.message : e}`);
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
