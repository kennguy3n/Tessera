import { useCallback, useEffect, useState } from "react";
import {
  DEFAULT_BACKUP_INTERVAL_HOURS,
  DEFAULT_BACKUP_RETENTION_COUNT,
  DEFAULT_MODEL_IDLE_TIMEOUT_SECS,
} from "../../../shared/types";
import {
  MAX_PINNED_ARTIFACTS,
  MAX_RECENT_ARTIFACTS,
  type SettingsData,
} from "../types/ipc";

const DEFAULT_SETTINGS: SettingsData = {
  theme: "light",
  // accent placeholder mirrors the main-process `DEFAULT_CONFIG`
  // (`"violet"`, the historic brand colour) so the first paint and
  // the Settings picker bind to the brand swatch during the brief
  // window before `refresh()` resolves the persisted choice.
  accentColor: "violet",
  defaultExportFormat: "markdown",
  ignorePatterns: [".git", "node_modules", ".DS_Store"],
  watchPatterns: ["**/*.md", "**/*.txt", "**/*.csv", "**/*.json"],
  // default to `true` for the in-memory placeholder
  // so a slow IPC response never causes a flash of the onboarding
  // wizard on a previously-onboarded user. The real value is loaded
  // by `refresh()` on mount and overwrites this within a tick.
  onboardingCompleted: true,
  // Empty arrays as the placeholder so the
  // command palette and the sidebar Pinned section render an
  // empty (rather than undefined-guarded) state during the brief
  // window before `refresh()` resolves. Avoids one class of
  // "Cannot read properties of undefined" footguns for downstream
  // hooks that iterate the lists with `.map`/`.includes`.
  pinnedArtifactIds: [],
  recentArtifactIds: [],
  // default placeholder for the local-sidecar
  // idle window. The real value is loaded by `refresh()` on mount;
  // we surface 60 s here so the SettingsPage <select> binds to a
  // sensible bucket even during the brief window before the IPC
  // response lands (matches `DEFAULT_MODEL_IDLE_TIMEOUT_SECS` so a
  // future change to the default propagates without a renderer
  // edit).
  modelIdleTimeoutSecs: DEFAULT_MODEL_IDLE_TIMEOUT_SECS,
  // telemetry defaults OFF (opt-in).
  // The renderer placeholder mirrors the main-process default in
  // `electron/config.ts:DEFAULT_CONFIG` so a slow IPC response
  // never causes a flash of "telemetry on" in the Privacy settings
  // panel for a previously-opted-out user.
  telemetryEnabled: false,
  // app-lock defaults to "off" so the
  // lock overlay never blocks first-run users; user opts in from
  // Settings → Security.
  appLockMode: "off",
  // auto-updater signature enforcement
  // defaults to ON; the Settings UI surfaces a checkbox that
  // toggles this so power users on dev builds can disable it.
  enforceUpdateSignature: true,
  // per-app keychain ACL enforcement defaults to ON; the Settings UI
  // surfaces a checkbox that toggles this so Linux users without a
  // secret-store daemon can flip it off after weighing the trade-off.
  enforceKeychainAcl: true,
  // UX-disclosure placeholders mirror the main-process
  // `DEFAULT_CONFIG`: simplified sidebar on, model auto-download on,
  // and the guided Create wizard as the default mode. The real
  // values load via `refresh()` on mount and overwrite these within
  // a tick; surfacing the same defaults here avoids a flash of the
  // power-user layout for a fresh install before the IPC resolves.
  simplifiedNav: true,
  autoDownloadModel: true,
  createPageMode: "wizard",
  // resource-management profile placeholder mirrors the main-process
  // `DEFAULT_CONFIG` (`"lightweight"`) so the Settings → Performance
  // toggle binds to the correct mode during the brief window before
  // the IPC response lands. The real value loads via `refresh()`.
  resourceMode: "lightweight",
  // close-to-tray defaults OFF (mirrors `DEFAULT_CONFIG`) so the
  // placeholder matches a fresh install's quit-on-close behaviour
  // before the real value loads via `refresh()`.
  closeToTray: false,
  // Backup-scheduler placeholders mirror the main-process
  // `DEFAULT_CONFIG`: protection on, the `<userData>/backups` default
  // dir (empty-string sentinel), a 24h cadence and 7-backup retention.
  // The real values load via `refresh()` on mount; the Settings →
  // Backup panel reads the authoritative resolved state from
  // `backup:status` rather than these placeholders.
  autoBackup: true,
  backupDir: "",
  backupIntervalHours: DEFAULT_BACKUP_INTERVAL_HOURS,
  backupRetentionCount: DEFAULT_BACKUP_RETENTION_COUNT,
};

// Touch the cap consts so the import isn't tree-shaken — they're
// re-exported elsewhere but referenced here too so a future caller
// that uses `useSettings()` can rely on having them in scope via
// the same module graph.
void MAX_PINNED_ARTIFACTS;
void MAX_RECENT_ARTIFACTS;

interface SettingsStoreState {
  settings: SettingsData;
  loading: boolean;
  error: string | null;
}

type Listener = (state: SettingsStoreState) => void;

/**
 * Module-level shared store for the renderer's settings snapshot.
 *
 * PR #87 + architectural root
 * fix. The previous implementation gave every `useSettings()`
 * caller its own `useState`+`useEffect` pair. That had two
 * compounding bugs:
 *
 *   1. **Stale state across siblings.** When the palette wrote
 *      pinned/recent IDs via `useUpdateSetting`, only its own
 *      `useSettings()` instance refreshed. The sidebar's separate
 *      instance kept its pre-write snapshot until a remount, so
 *      pin/unpin in the palette wouldn't reflect in the sidebar.
 *
 *   2. **Track-view race.** Each fresh `useSettings()` started at
 *      `{ pinnedArtifactIds: [], recentArtifactIds: [], loading:
 *      true }`. `useTrackArtifactView` fired its `trackView(id)`
 *      effect before the initial `settings:get` IPC resolved,
 *      capturing the EMPTY recent list as "the current list" and
 *      writing back `[id]` — silently erasing the user's view
 *      history on every editor mount.
 *
 * Sharing the snapshot via a module-level store with N
 * `useSyncExternalStore`-style subscribers fixes both. A single
 * `settings:get` IPC at first mount populates `state.settings`
 * for every consumer; subsequent `refresh()` calls notify every
 * subscriber; and the `loading` flag is a per-store property that
 * any consumer can observe to gate effects (see
 * `useTrackArtifactView`).
 *
 * The store uses a single-flight `pendingRefresh` so concurrent
 * mounts during the first tick collapse to one IPC call.
 */
const settingsStore = (() => {
  let state: SettingsStoreState = {
    settings: DEFAULT_SETTINGS,
    loading: true,
    error: null,
  };
  // True once the initial `settings:get` IPC has resolved (or
  // failed). Used to gate the boot-time `loading: true` window
  // from re-entering on every subsequent mount: callers like the
  // sidebar Pinned section, the palette, and the Home recent
  // grid all `useSettings()` separately and would otherwise each
  // flip `loading: true` on mount and unmount sibling components
  // mid-render. After bootstrap, `ensureBootstrapped()` is a no-op
  // and explicit `refresh()` calls drive new fetches without
  // toggling the loading flag.
  let bootstrapped = false;
  const listeners = new Set<Listener>();
  let pendingRefresh: Promise<void> | null = null;

  function setState(patch: Partial<SettingsStoreState>) {
    state = { ...state, ...patch };
    for (const l of listeners) l(state);
  }

  async function doRefresh(toggleLoading: boolean) {
    if (toggleLoading) setState({ loading: true, error: null });
    else setState({ error: null });
    try {
      const api = window.tessera;
      if (api) {
        const data = await api.settings.get();
        setState({ settings: data });
      }
    } catch (err) {
      setState({ error: err instanceof Error ? err.message : String(err) });
    } finally {
      if (toggleLoading) setState({ loading: false });
      bootstrapped = true;
    }
  }

  return {
    getState: (): SettingsStoreState => state,
    subscribe(listener: Listener): () => void {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /**
     * Trigger a `settings:get` IPC and broadcast the result to all
     * subscribers. Single-flighted so two mounts in the same tick
     * collapse to one IPC call; sequential calls after the first
     * resolves run normally.
     *
     * After the first bootstrap completes, subsequent `refresh()`
     * calls do NOT toggle `loading: true` — the renderer already
     * has a usable snapshot and the brief flicker would unmount
     * `if (loading) return <Loading />` regions every time a new
     * `useSettings()` consumer mounts (see the
     * `bootstrapped` comment above).
     */
    refresh(): Promise<void> {
      if (pendingRefresh) return pendingRefresh;
      pendingRefresh = doRefresh(!bootstrapped).finally(() => {
        pendingRefresh = null;
      });
      return pendingRefresh;
    },
    /**
     * Push a fully-resolved settings snapshot into the store and
     * broadcast it to every subscriber. Called by
     * `useUpdateSetting` after a successful `settings:update` IPC
     * so all consumers reflect the write immediately — without
     * waiting for a separate `refresh()` round-trip.
     */
    setSettings(next: SettingsData) {
      setState({ settings: next });
    },
    // Test-only: reset the store between vitest cases so a test
    // can simulate a fresh app boot without each prior test's
    // settings leaking into it.
    __resetForTests(initial: SettingsStoreState = {
      settings: DEFAULT_SETTINGS,
      loading: true,
      error: null,
    }) {
      state = initial;
      pendingRefresh = null;
      bootstrapped = false;
      listeners.clear();
    },
  };
})();

export function __resetSettingsStoreForTests(initial?: SettingsStoreState) {
  settingsStore.__resetForTests(initial);
}

export function useSettings() {
  const [state, setState] = useState<SettingsStoreState>(() =>
    settingsStore.getState(),
  );

  useEffect(() => {
    // Sync to the current store state on subscribe in case it
    // changed between the initial `useState` factory and the
    // subscription registration (rare, but possible under React 18
    // concurrent rendering).
    setState(settingsStore.getState());
    const unsubscribe = settingsStore.subscribe(setState);
    // Kick off the initial IPC fetch on first mount — single-flighted
    // so a second `useSettings()` mounting in the same tick reuses the
    // pending promise instead of double-fetching.
    void settingsStore.refresh();
    return unsubscribe;
  }, []);

  const refresh = useCallback(() => settingsStore.refresh(), []);

  return {
    settings: state.settings,
    loading: state.loading,
    error: state.error,
    refresh,
  };
}

export function useUpdateSetting() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const update = useCallback(async (partial: Partial<SettingsData>) => {
    setLoading(true);
    setError(null);
    try {
      const api = window.tessera;
      if (!api) throw new Error("Tessera API not available");
      const result = await api.settings.update(partial);
      // Broadcast the fresh snapshot to every `useSettings()`
      // subscriber so sibling components (sidebar Pinned, palette
      // recent rows, breadcrumb crumb labels) reflect the write
      // immediately without a follow-up `refresh()` IPC.
      settingsStore.setSettings(result);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return { update, loading, error };
}
