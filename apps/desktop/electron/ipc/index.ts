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
import { registerAutomationsHandlers } from "./automations";
import { registerArtifactsHandlers } from "./artifacts";
import { registerAuditHandlers } from "./audit";
import { registerCitationsHandlers } from "./citations";
import { registerConnectorsLegacyHandlers } from "./connectorsLegacy";
import { registerDialogHandlers } from "./dialog";
import { registerImagegenHandlers } from "./imagegen";
import { registerKchatHandlers } from "./kchat";
import { registerModelHandlers } from "./model";
import { registerRuntimeHandlers } from "./runtime";
import { registerSettingsHandlers } from "./settings";
import { registerSourcesHandlers } from "./sources";
import { registerTasksHandlers } from "./tasks";
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
}
