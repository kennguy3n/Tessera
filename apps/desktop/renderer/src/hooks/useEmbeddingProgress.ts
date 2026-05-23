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
 * **Stale-terminal-state guard (polling-termination only)**: when a
 * new poll cycle starts, the very first response can race with the
 * bridge's worker thread — the renderer may poll before the worker
 * has called `tracker.start()`, observing the *previous* run's
 * `done`/`failed` status. Without a guard, the effect would treat
 * that stale terminal status as "this run is already over" and stop
 * polling immediately, never showing the new run's progress.
 *
 * The Rust bridge fixes this at the source by calling
 * `mark_starting()` synchronously on the JS main thread before
 * returning the `AsyncTask` (see `napi_exports.rs::bridge_backfill_embeddings`).
 * As a belt-and-suspenders defence, this hook *also* refuses to
 * treat `done`/`failed` as a stop signal until it has observed at
 * least one `running` response for the current generation. So even
 * if a future change to the Rust side regresses the pre-flight
 * reset, the hook keeps polling until it has witnessed a real
 * running→terminal transition.
 *
 * The guard intentionally affects **polling termination only**, not
 * rendering — every response (including a stale terminal) is
 * surfaced to the caller via `setSnap`, so renderers can always
 * show *something* to the user. With Rust's `mark_starting` in
 * place, the first observed status is `running` with zeroed
 * counters and there is no visible stale-state flicker in
 * production; the guard is purely a regression backstop.
 *
 * Polling stops automatically when the tracker reports `done` or
 * `failed` *after* having seen `running`. The hook returns the most
 * recent snapshot, or `null` until the first response arrives —
 * callers render an "idle" placeholder until then.
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

    // Per-generation flag: did we ever see the tracker in `running`
    // for this cycle? Until we do, `done`/`failed` responses must
    // be from a previous run that the bridge hasn't reset yet —
    // keep polling rather than giving up. See the stale-terminal-
    // state guard discussion in the module docstring.
    let observedRunning = false;

    const tick = async () => {
      if (cancelled) return;
      try {
        const next = await window.tessera.sources.getEmbeddingProgress();
        if (cancelled) return;
        if (next.status === "running") {
          observedRunning = true;
        }
        // Always surface the snapshot — rendering is decoupled from
        // termination so the caller can show *something* on every
        // poll. With Rust's `mark_starting` pre-flight reset, the
        // first observed status is `running` with zeroed counters,
        // so there is no user-visible stale-state flicker in
        // production. The defence-in-depth `observedRunning` guard
        // below only governs whether to stop polling.
        setSnap(next);
        if (
          (next.status === "done" || next.status === "failed") &&
          observedRunning
        ) {
          return; // terminal state for this generation; stop polling
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
