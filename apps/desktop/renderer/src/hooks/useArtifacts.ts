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
 * PR #87 Devin Review ANALYSIS_0005: previously a delete on a
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

export function useArtifactList() {
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
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
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  // Re-fetch whenever any handler (anywhere in the renderer)
  // dispatches `tessera:artifacts-changed`. Mounted globally on
  // `window` so the event reaches every live consumer regardless
  // of where the mutation came from. PR #87 Devin Review
  // ANALYSIS_0005.
  useEffect(() => {
    if (typeof window === "undefined") return;
    const handler = () => {
      void refresh();
    };
    window.addEventListener(ARTIFACTS_CHANGED_EVENT, handler);
    return () => {
      window.removeEventListener(ARTIFACTS_CHANGED_EVENT, handler);
    };
  }, [refresh]);

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
