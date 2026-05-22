/**
 * Public IPC entry-point.
 *
 * Wires every per-domain handler registrar in `./ipc/` plus the
 * auto-updater handlers (`./autoUpdater.ts`). The actual handler
 * bodies live in `./ipc/*.ts`; this file exists so callers (notably
 * `./main.ts`) can keep importing one symbol — `registerIpcHandlers`
 * — without knowing about the per-domain split.
 *
 * The split followed the section markers in the pre-split monolith:
 *
 *   - `ipc/sources.ts`           `sources:*`
 *   - `ipc/artifacts.ts`         `artifacts:*` (CRUD + exports + versions + generation)
 *   - `ipc/templates.ts`         `templates:*`
 *   - `ipc/citations.ts`         `citations:*`
 *   - `ipc/settings.ts`          `settings:*` and `externalProvider:*`
 *   - `ipc/model.ts`             `model:*` (live sidecar)
 *   - `ipc/runtime.ts`           `runtime:*` (registry / download / install)
 *   - `ipc/connectorsLegacy.ts`  `connectors:*` (unified) + `connectors:gdrive:*` picker
 *   - `ipc/tasks.ts`             `tasks:*`
 *   - `ipc/automations.ts`       `automations:*`
 *   - `ipc/dialog.ts`            `dialog:*`
 *
 * Cross-domain helpers live in `ipc/shared.ts` (connector context, OS
 * keychain access, safe-export-root allowlist) and `ipc/schemas.ts`
 * (zod schemas for the object-shaped IPC inputs).
 */
import { registerAllIpcHandlers } from "./ipc/index";
import { registerAutoUpdaterIpc } from "./autoUpdater";

export function registerIpcHandlers(): void {
  registerAllIpcHandlers();
  registerAutoUpdaterIpc();
}
