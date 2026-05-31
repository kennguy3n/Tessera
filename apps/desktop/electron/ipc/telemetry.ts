/**
 * Phase 19 PR 10 Task 9 — IPC handlers for the local-only
 * telemetry sink. See `electron/telemetrySink.ts` for the
 * underlying privacy contract (opt-in, never socket, whitelisted
 * keys, append-only JSONL on disk).
 *
 * Channels:
 *   - `telemetry:getEvents`           -> in-memory + on-disk snapshot
 *   - `telemetry:getPersistedEvents`  -> on-disk slice only
 *   - `telemetry:recordCounter`       (key: string, increment?: number)
 *
 * Extracted from `registerSettingsHandlers` so the IPC surface
 * matches the per-domain-module pattern every other IPC area in
 * this codebase uses (`registerAppLockHandlers`,
 * `registerConnectorsLegacyHandlers`, etc.) — keeping the
 * telemetry domain in its own file makes it trivial for an
 * auditor to point at one file and say "this is the entire
 * telemetry surface".
 *
 * Why the toggle stays in `settings.ts`: `telemetryEnabled` is a
 * persisted setting field, not an event-recording channel.
 * Flipping it goes through `settings:update` like every other
 * config knob, and the side-effects (enable/disable the sink,
 * truncate the on-disk file) belong with the rest of the
 * settings-write logic. Only the event-pumping IPCs move here.
 */
import { idempotentHandle } from "./register";
import {
  getEventsSnapshot,
  readPersistedEvents,
  recordCounter,
  type TelemetryEvent,
} from "../telemetrySink";

export function registerTelemetryHandlers(): void {
  // Read-only telemetry inspection. The renderer's "audit my
  // telemetry" panel calls this so the user can see exactly what
  // has been recorded. No write surface here — adding raw-event
  // support would defeat the whitelisted-key privacy guarantee
  // documented in `telemetrySink.ts`.
  idempotentHandle(
    "telemetry:getEvents",
    async (): Promise<TelemetryEvent[]> => {
      return getEventsSnapshot();
    },
  );

  idempotentHandle(
    "telemetry:getPersistedEvents",
    async (): Promise<TelemetryEvent[]> => {
      return readPersistedEvents();
    },
  );

  // Single-write surface for the renderer to record a whitelisted
  // event. `recordCounter` itself validates the key against
  // `TELEMETRY_KEY_WHITELIST` in `telemetrySink.ts` so a
  // compromised renderer / preload that bypasses the schema
  // validation (e.g. by hand-crafting an IPC frame) still cannot
  // smuggle in a non-whitelisted key. Defense in depth: schema at
  // the IPC boundary, key-whitelist at the sink boundary.
  idempotentHandle(
    "telemetry:recordCounter",
    async (
      _event,
      keyRaw: unknown,
      incrementRaw: unknown,
    ): Promise<void> => {
      if (typeof keyRaw !== "string") return;
      const increment =
        typeof incrementRaw === "number" ? incrementRaw : 1;
      recordCounter(keyRaw, increment);
    },
  );
}
