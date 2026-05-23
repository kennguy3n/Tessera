import { useEffect, useState } from "react";
import type { EmbeddingProgressInfo } from "../types/ipc";

/**
 * Polls `sources:getEmbeddingProgress` for the duration of a single
 * Re-embed pass.
 *
 * The hook is driven by a monotonically-increasing `generation`
 * counter rather than a boolean `active` flag. Every time the caller
 * wants to start a new poll cycle (e.g. on each click of the Re-embed
 * button) it bumps the counter; the effect's dep array picks up the
 * change and a fresh polling loop is scheduled.
 *
 * A boolean `active` was the original design, but it had a subtle
 * bug: when the previous backfill reached terminal status, the effect
 * stopped scheduling new timers. If the caller then clicked Re-embed
 * a second time, React's batched state updates could leave `active`
 * at `true` across the click handler (it goes `true → true` instead
 * of `false → true`) so the effect dep `[active]` never changed and
 * polling never restarted. The generation counter sidesteps that
 * entirely: even if the boolean shape of "is something running" never
 * flips, the counter is a different value every click, so the effect
 * re-fires deterministically.
 *
 * Polling stops automatically when the tracker reports `done` or
 * `failed`. The hook returns the most recent snapshot, or `null`
 * until the first response arrives — callers render an "idle"
 * placeholder until then.
 *
 * Pass `generation = 0` (or any value where the caller hasn't yet
 * decided to start polling) to keep the hook quiescent.
 */
export function useEmbeddingProgress(
  generation: number,
  intervalMs = 500,
): EmbeddingProgressInfo | null {
  const [snap, setSnap] = useState<EmbeddingProgressInfo | null>(null);

  useEffect(() => {
    // Quiescent until the caller bumps the generation. We treat
    // `0` (and any value `<= 0`) as "never started" so the
    // default-initialised counter doesn't trigger a poll.
    if (generation <= 0) return;
    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;

    const tick = async () => {
      if (cancelled) return;
      try {
        const next = await window.tessera.sources.getEmbeddingProgress();
        if (cancelled) return;
        setSnap(next);
        if (next.status === "done" || next.status === "failed") {
          return; // terminal state; stop polling for this generation
        }
      } catch {
        // Swallow — the bridge may not yet be initialised when the
        // page first mounts, or the user may have quit between
        // polls. Keep ticking until the next generation bump or
        // until the component unmounts.
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
  }, [generation, intervalMs]);

  return snap;
}
