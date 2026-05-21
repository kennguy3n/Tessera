import { useEffect, useState } from "react";
import type { IndexingProgressInfo } from "../types/ipc";

/**
 * Polls `sources:getIndexingProgress` for the given source id every
 * `intervalMs` milliseconds while `active` is true. Stops the
 * interval when the snapshot reports a terminal status (`done` or
 * `failed`) so we don't keep the bridge IPC running forever.
 *
 * The hook returns the most recent snapshot or `null` until the
 * first response. Callers can use this to drive a progress UI:
 *
 *   const progress = useIndexingProgress(id, reindexing);
 *
 * while a reindex is in flight.
 */
export function useIndexingProgress(
  sourceId: string | undefined,
  active: boolean,
  intervalMs = 500,
): IndexingProgressInfo | null {
  const [snap, setSnap] = useState<IndexingProgressInfo | null>(null);

  useEffect(() => {
    if (!sourceId || !active) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        const next = await window.tessera.sources.getIndexingProgress(sourceId);
        if (cancelled) return;
        setSnap(next);
        if (next.status === "done" || next.status === "failed") {
          return; // stop polling
        }
      } catch {
        // Swallow errors and keep polling — the bridge may not yet
        // be initialized when the source detail page mounts.
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
  }, [sourceId, active, intervalMs]);

  return snap;
}
