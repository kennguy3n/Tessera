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
 */
import { getBridge, type NativeBridge, type AutomationInfo } from "./appState";

const DEFAULT_TICK_MS = 30_000;

interface AutomationTrigger {
  kind: "schedule" | "on_generate";
  interval_seconds?: number;
  template_id?: string;
}

interface AutomationAction {
  kind: "reindex_source" | "generate_from_template";
  source_id?: string;
  template_id?: string;
  source_ids?: string[];
}

// Module-level state — there's exactly one scheduler per Electron main
// process. A class would force every consumer to thread a singleton
// reference; module state matches the rest of the codebase
// (config.ts, appState.ts).
let tickHandle: ReturnType<typeof setInterval> | null = null;
let inFlight = false;
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

export function stopScheduler(): void {
  if (tickHandle) {
    clearInterval(tickHandle);
    tickHandle = null;
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
    inFlight,
  };
}

/**
 * Resolve currently-due `Schedule` automations and dispatch each one.
 * Exported for the test suite and for the manual "run now" UI action;
 * the scheduler interval calls it on a fixed cadence.
 */
export async function tick(
  bridge: NativeBridge | null = getBridge(),
): Promise<void> {
  if (!bridge) return;
  // Re-entrancy guard. A slow tick (e.g. a large re-index) must not
  // produce overlapping invocations — we'd otherwise double-fire on
  // every interval boundary and corrupt the `last_run_at` semantics
  // (a second tick reads the still-stale `last_run_at` because the
  // first hasn't recorded yet).
  if (inFlight) return;
  inFlight = true;
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
    inFlight = false;
    lastTickAt = new Date();
  }
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
    inFlight = false;
    lastTickAt = null;
    lastTickError = null;
  },
};
