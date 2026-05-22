/**
 * IPC handlers for the `automations:*` channels.
 *
 * Same JSON-encode pattern as tasks: the bridge accepts a JSON string
 * because the `trigger_json` / `action_json` fields are opaque blobs
 * the scheduler reinterprets per-trigger / per-action variant.
 */
import { ipcMain } from "electron";
import { getBridge } from "../appState";
import {
  getSchedulerStatus,
  runNow as schedulerRunNow,
} from "../scheduler";
import { assertBoolean, assertId } from "./validate";
import { CreateAutomationSchema } from "./schemas";

export function registerAutomationsHandlers(): void {
  ipcMain.handle("automations:create", async (_event, req: unknown) => {
    const parsed = CreateAutomationSchema.parse(req);
    const bridge = getBridge();
    if (!bridge) throw new Error("Native bridge not available");
    const payload = {
      name: parsed.name,
      trigger_json: JSON.stringify(parsed.trigger),
      action_json: JSON.stringify(parsed.action),
      enabled: parsed.enabled ?? true,
    };
    return bridge.bridgeCreateAutomation(JSON.stringify(payload));
  });

  ipcMain.handle("automations:list", async () => {
    const bridge = getBridge();
    if (!bridge) throw new Error("Native bridge not available");
    return bridge.bridgeListAutomations();
  });

  ipcMain.handle(
    "automations:get",
    async (_event, automationId: unknown) => {
      const validated = assertId(automationId, "automationId");
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      return bridge.bridgeGetAutomation(validated);
    },
  );

  ipcMain.handle(
    "automations:setEnabled",
    async (_event, automationId: unknown, enabled: unknown) => {
      const id = assertId(automationId, "automationId");
      const flag = assertBoolean(enabled, "enabled");
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      bridge.bridgeSetAutomationEnabled(id, flag);
    },
  );

  ipcMain.handle(
    "automations:delete",
    async (_event, automationId: unknown) => {
      const validated = assertId(automationId, "automationId");
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      return bridge.bridgeDeleteAutomation(validated);
    },
  );

  // Scheduler control surface used by the AutomationsPage UI: status
  // (running? in-flight? last error?) + manual "tick now" trigger so
  // the user can verify a freshly-saved schedule without waiting up
  // to `DEFAULT_TICK_MS`.
  ipcMain.handle("automations:schedulerStatus", async () => {
    return getSchedulerStatus();
  });

  // `runNow` always results in a fresh tick observable to the caller:
  // if a tick is already in flight, it waits for it and then runs a
  // new one (see scheduler.ts for the full semantics). This means a
  // user clicking "Run Now" never gets the previous tick's stale
  // status returned to them — the promise only resolves after their
  // requested tick has completed.
  ipcMain.handle("automations:runNow", async () => {
    await schedulerRunNow();
    return getSchedulerStatus();
  });
}
