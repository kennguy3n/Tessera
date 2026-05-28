/**
 * Pure helpers + persistence accessors for `KchatSettingsCard`.
 *
 * Extracted out of the component module so React Fast Refresh can
 * preserve component state across HMR edits. The constants below
 * are intentionally module-scoped: the localStorage key MUST stay
 * fixed across all consumers (Settings card, sidebar section,
 * share modal, channel-source picker) so a single source of truth
 * exists for the user's chosen team. Multiple components import
 * `getStoredDefaultTeamId` / `setStoredDefaultTeamId`, so this is
 * not card-internal state.
 */
import type { KchatDesktopBridgeStatusView } from "../../../shared/types";

const TEAM_LS_KEY = "tessera.kchat.defaultTeamId";

/**
 * A heartbeat older than this is treated as "extension no longer
 * connected" — the .kcz extension is expected to make at least
 * one status call per minute when it's loaded inside a running
 * KChat Desktop.
 */
export const EXTENSION_HEARTBEAT_STALE_MS = 90_000;

/**
 * Cadence at which the Settings card re-reads the bridge status.
 *
 * Note: the sidebar bridge-health dot uses a different cadence
 * (`SIDEBAR_BRIDGE_DOT_POLL_MS = 15_000` in `KchatSidebarSection.tsx`).
 * The Settings card polls more aggressively because it is the
 * primary configuration surface — a user editing the Connect/
 * Disconnect affordance expects bridge state to reflect their
 * action within a fresh-looking interval. The sidebar dot is a
 * passive always-mounted indicator and accepts a slower cadence
 * to keep background HTTP-call volume low. Naming the two
 * constants distinctly (rather than re-using `BRIDGE_STATUS_POLL_MS`
 * in both modules with different values) protects future
 * maintainers from accidentally assuming the cadences are linked.
 */
export const BRIDGE_STATUS_POLL_MS = 10_000;

export function getStoredDefaultTeamId(): string | null {
  try {
    return window.localStorage.getItem(TEAM_LS_KEY);
  } catch {
    return null;
  }
}

export function setStoredDefaultTeamId(id: string | null): void {
  try {
    if (id === null) {
      window.localStorage.removeItem(TEAM_LS_KEY);
    } else {
      window.localStorage.setItem(TEAM_LS_KEY, id);
    }
  } catch {
    /* localStorage disabled — silently no-op; the renderer can
     * still operate, the next session just loses the default. */
  }
}

/**
 * Treat the bridge status as "extension-detected" only when the
 * local API server is up AND the extension has been heard from
 * recently. Local API server up alone isn't sufficient: a
 * running Tessera with no .kcz installed in KChat Desktop also
 * exposes the server but the heartbeat never arrives.
 */
export function isExtensionDetected(
  status: KchatDesktopBridgeStatusView | null,
  nowMs: number,
): boolean {
  if (status === null) return false;
  if (!status.apiServerRunning) return false;
  if (status.lastExtensionContactAt === null) return false;
  const heartbeatMs = Date.parse(status.lastExtensionContactAt);
  if (Number.isNaN(heartbeatMs)) return false;
  return nowMs - heartbeatMs < EXTENSION_HEARTBEAT_STALE_MS;
}
