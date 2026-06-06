/**
 * Barrel that wires every per-domain IPC registrar from this directory.
 *
 * The legacy public entry-point is still `registerIpcHandlers` (in
 * `../ipc.ts`) — that function now delegates here so the per-domain
 * modules are reachable through one import without rewriting every
 * caller. Domain order matches the section order in the pre-split
 * `ipc.ts` so a stack trace from a hot-reload double-registration
 * crash points at the same module the contributor was just editing.
 */
import { registerAppLockHandlers } from "./appLock";
import { registerAutomationsHandlers } from "./automations";
import { registerArtifactsHandlers } from "./artifacts";
import { registerAuditHandlers } from "./audit";
import { registerCitationsHandlers } from "./citations";
import { registerConnectorsLegacyHandlers } from "./connectorsLegacy";
import { registerDiagnosticsHandlers } from "./diagnostics";
import { registerDialogHandlers } from "./dialog";
import { registerImagegenHandlers } from "./imagegen";
import { registerKchatHandlers } from "./kchat";
import { registerModelHandlers } from "./model";
import { registerRuntimeHandlers } from "./runtime";
import { registerSettingsHandlers } from "./settings";
import { registerSourcesHandlers } from "./sources";
import { registerTasksHandlers } from "./tasks";
import { registerTelemetryHandlers } from "./telemetry";
import { registerTemplatesHandlers } from "./templates";
import { registerVisionHandlers } from "./vision";

export function registerAllIpcHandlers(): void {
  registerSourcesHandlers();
  registerArtifactsHandlers();
  registerTemplatesHandlers();
  registerCitationsHandlers();
  registerSettingsHandlers();
  registerModelHandlers();
  registerRuntimeHandlers();
  registerVisionHandlers();
  registerImagegenHandlers();
  registerConnectorsLegacyHandlers();
  registerTasksHandlers();
  registerAutomationsHandlers();
  registerDialogHandlers();
  registerKchatHandlers();
  registerAuditHandlers();
  // local-only telemetry event-pumping
  // IPCs. The `telemetryEnabled` toggle itself lives in
  // `settings:update`; this only registers the event-recording
  // and event-inspection channels so the audit panel and the
  // record-counter callsites have somewhere to dispatch to.
  registerTelemetryHandlers();
  // PIN / biometric app-lock IPC. Wired
  // last so the lock surface is available after all stateful
  // handlers; ordering is only cosmetic since registration is
  // idempotent.
  registerAppLockHandlers();
  // Renderer crash / error-boundary reporting. Ordering is cosmetic
  // (registration is idempotent); kept at the end alongside the other
  // cross-cutting diagnostic surfaces.
  registerDiagnosticsHandlers();
}
