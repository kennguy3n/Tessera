import { useCallback, useEffect, useState } from "react";
import type { ArtifactInfo } from "../types/ipc";

/**
 * Custom DOM event dispatched after any artifact mutation (create,
 * update, delete, duplicate). Consumers of `useArtifactList()`
 * listen for this event and re-fetch automatically so a mutation
 * triggered in one part of the UI (e.g. context-menu delete on the
 * Home page) is reflected in every other consumer (sidebar,
 * command palette, recents card) without each one needing its own
 * refresh hook or a manual prop drill.
 *
 * PR #87: previously a delete on a
 * `RecentArtifactCard` would call `api.artifacts.remove()` but
 * leave the deleted card visible on the home page until the user
 * navigated away and back. Now the delete handler dispatches this
 * event and `useArtifactList()` picks it up automatically.
 */
export const ARTIFACTS_CHANGED_EVENT = "tessera:artifacts-changed";

/**
 * Dispatch the artifact-mutation event from any handler that has
 * just called `api.artifacts.{create,update,remove}` /
 * `api.artifacts.bulkDelete` so every live `useArtifactList`
 * subscriber re-fetches.
 *
 * Safe to call when there is no window (SSR / test setup that
 * never mounts the renderer) — it short-circuits gracefully.
 */
export function notifyArtifactsChanged(): void {
  if (typeof window === "undefined") return;
  window.dispatchEvent(new CustomEvent(ARTIFACTS_CHANGED_EVENT));
}

/**
 * Options for `useArtifactList`.
 *
 * `enabled` defaults to `true` — when `false`, the hook short-
 * circuits the `artifacts:list` IPC and the artifact-changed
 * listener, returning an empty list. Used by callers that only
 * conditionally need the list (e.g. the Sidebar's pinned-artifact
 * section, which has nothing to render when the user has zero
 * pins). Flipping `enabled` from `false` to `true` triggers a
 * fresh fetch on the next render — the hook re-runs its mount
 * effect when the dep changes.
 *
 * PR #87 round 3: previously the
 * Sidebar called `useArtifactList()` unconditionally on every
 * launch, firing an `artifacts:list` IPC that returns the full
 * artifact list (including `content: string`) even when the user
 * had zero pins. With this option the Sidebar can declare
 * `useArtifactList({ enabled: pinnedIds.length > 0 })` and skip
 * the IPC entirely until the first pin is added.
 */
export interface UseArtifactListOptions {
  enabled?: boolean;
}

export function useArtifactList(options: UseArtifactListOptions = {}) {
  const enabled = options.enabled ?? true;
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([]);
  // When disabled, we have nothing to load — surface `loading:
  // false` immediately so callers can render their empty state
  // without showing a spinner. Mount-time `enabled: true` still
  // starts at `loading: true` until the first fetch resolves
  // (preserves the existing contract).
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!enabled) {
      setArtifacts([]);
      setLoading(false);
      setError(null);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const api = window.tessera;
      if (api) {
        const list = await api.artifacts.list();
        setArtifacts(list);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [enabled]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Re-fetch whenever any handler (anywhere in the renderer)
  // dispatches `tessera:artifacts-changed`. Mounted globally on
  // `window` so the event reaches every live consumer regardless
  // of where the mutation came from. Disabled callers skip the
  // listener entirely — they don't care about mutations because
  // they aren't rendering the list. PR #87 Devin Review
  useEffect(() => {
    if (typeof window === "undefined") return;
    if (!enabled) return;
    const handler = () => {
      void refresh();
    };
    window.addEventListener(ARTIFACTS_CHANGED_EVENT, handler);
    return () => {
      window.removeEventListener(ARTIFACTS_CHANGED_EVENT, handler);
    };
  }, [enabled, refresh]);

  return { artifacts, loading, error, refresh };
}

export function useRecentArtifacts(limit: number = 5) {
  const { artifacts, loading, error, refresh } = useArtifactList();

  const recent = [...artifacts]
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )
    .slice(0, limit);

  return { recent, loading, error, refresh };
}
