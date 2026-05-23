import { useEffect, useState } from "react";
import type { EmbeddingProgressInfo } from "../types/ipc";

/**
 * Polls `sources:getEmbeddingProgress` while `active` is true.
 *
 * Unlike `useIndexingProgress`, the embedding backfill tracker is
 * workspace-global (not per-source) because every source shares one
 * `ProgressTracker` on the Rust side. The hook still takes `active`
 * so the polling loop can be torn down once the caller's UI dismisses
 * the progress banner (e.g. after the Re-embed button is released).
 *
 * Polling stops automatically when the tracker reports `done` or
 * `failed`. The hook returns the most recent snapshot, or an
 * empty idle snapshot until the first response arrives — the
 * default lets the UI render a "ready" state without flicker.
 */
export function useEmbeddingProgress(
  active: boolean,
  intervalMs = 500,
): EmbeddingProgressInfo | null {
  const [snap, setSnap] = useState<EmbeddingProgressInfo | null>(null);

  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        const next = await window.tessera.sources.getEmbeddingProgress();
        if (cancelled) return;
        setSnap(next);
        if (next.status === "done" || next.status === "failed") {
          return; // terminal state; stop polling
        }
      } catch {
        // Swallow — the bridge may not yet be initialised when the
        // page first mounts, or the user may have quit between
        // polls. Keep ticking until `active` flips to false.
      }
      if (!cancelled) {
        timer = setTimeout(tick, intervalMs);
      }
    };

    tick();
    return () => {
      cancelled = true;
      if (timer !== null) clearTimeout(timer);
    };
  }, [active, intervalMs]);

  return snap;
}
