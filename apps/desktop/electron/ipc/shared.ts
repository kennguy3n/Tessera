/**
 * Cross-domain helpers shared by the per-domain IPC modules in this
 * directory. Each helper used to be a private file-scope function or
 * module-level constant inside `apps/desktop/electron/ipc.ts`. As part
 * of the per-domain split (one file per IPC domain), they were hoisted here
 * so every domain module can import them by name rather than
 * reimplementing the same logic.
 *
 * The `IpcContext` returned by `getConnectorContext()` is captured
 * lazily on first use so `app.getPath('userData')` is only invoked
 * after Electron's `ready` event has fired — the same lazy-capture
 * the inline version relied on.
 */
import { app } from "electron";
import * as os from "os";
import * as path from "path";
import { getLogger } from "../logger";
import { createDefaultContext } from "./context";
import { defaultRateLimiter } from "./rateLimiter";
import {
  getValidAccessTokenForProvider,
} from "./connectors/handlers";
import type { ProviderId } from "./connectors/providerOAuth";

let sharedConnectorContext: ReturnType<typeof createDefaultContext> | null =
  null;

/**
 * Resolve the shared `IpcContext` used by both the unified
 * `connectors:*` dispatcher (`registerConnectorHandlers`) and the
 * legacy `connectors:gdrive:*` picker handlers. Sharing one context
 * guarantees both code paths read/write the same `tokenVault`, log to
 * the same logger, and rate-limit against the same in-memory bucket.
 */
export function getConnectorContext(): ReturnType<typeof createDefaultContext> {
  if (!sharedConnectorContext) {
    sharedConnectorContext = createDefaultContext(
      getLogger(),
      defaultRateLimiter,
    );
  }
  return sharedConnectorContext;
}

/**
 * Resolve a fresh access token for an OAuth provider, refreshing via
 * the stored refresh token if needed. Delegates to the unified
 * `getValidAccessTokenForProvider` helper in
 * `ipc/connectors/handlers.ts` so the legacy `connectors:gdrive:*`
 * channels and the new `connectors:authenticate / sync / disconnect`
 * channels share a single source of truth for token refresh + the
 * non-expiring-token short-circuit.
 */
export async function getValidAccessToken(
  provider: ProviderId,
): Promise<string> {
  return getValidAccessTokenForProvider(getConnectorContext(), provider);
}

/**
 * Build the allowlist of safe export roots that the IPC handlers will
 * accept absolute paths inside. Computed lazily (per call) rather than
 * captured in a module-level constant because Electron's `app.getPath()`
 * APIs are only safe to call after the `ready` event has fired — and
 * the IPC handlers register against `ipcMain` synchronously at startup
 * but the handlers themselves only execute later, well after `ready`.
 *
 * Roots include `downloads`, `documents`, `desktop`, the user's home
 * directory, the Electron app's `userData` directory, and the OS temp
 * directory.
 */
export function getSafeExportRoots(): string[] {
  const roots: string[] = [];
  for (const key of ["downloads", "documents", "desktop", "home", "userData"]) {
    try {
      const p = app.getPath(key as Parameters<typeof app.getPath>[0]);
      if (p) roots.push(p);
    } catch {
      // skip unknown path keys (e.g. `desktop` on headless Linux)
    }
  }
  try {
    roots.push(os.tmpdir());
  } catch {
    // skip
  }
  return roots;
}

/**
 * Directories that are NEVER valid export targets, even when they
 * fall inside a safe root. A compromised renderer must not be able to
 * overwrite the KChat channel cache (which lives under HOME) via an
 * export IPC and thereby inject attacker-controlled content that the
 * KChat connector would later ingest.
 *
 * The list uses the same `~/.tessera/kchat-channels` canonical prefix
 * from `kchatPaths.ts`.
 *
 * Defensive symmetry with `getSafeExportRoots`: wrap path resolution in
 * try/catch so a misconfigured environment (theoretical `os.homedir()`
 * failure on a severely broken system) does not throw out of the IPC
 * handler. A failed deny-root lookup is the safe direction — the
 * allow-list will still gate writes; we just lose one defence layer.
 */
export function getDenyExportRoots(): string[] {
  const roots: string[] = [];
  try {
    roots.push(path.join(os.homedir(), ".tessera", "kchat-channels"));
  } catch {
    // skip if homedir is unavailable; allow-list still gates writes
  }
  return roots;
}
