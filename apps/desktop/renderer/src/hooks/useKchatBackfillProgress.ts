import { useEffect, useState } from "react";
import type { KchatBackfillProgressView } from "../types/ipc";

/**
 * Polls `kchat:backfillProgress` for a given channel id at a fixed
 * cadence.
 *
 * The hook is keyed off `channelId`: when the caller passes `null`
 * (e.g. the SourceDetailPage is showing a non-KChat source) the
 * hook holds at `null` and schedules no work. When the caller
 * supplies a 26-char channel id the hook fires an immediate poll
 * and then a recurring `setTimeout` chain at `intervalMs` until the
 * effect cleanup runs.
 *
 * **Why poll instead of subscribing to a push channel.** The
 * `kchat:backfillProgress` IPC handler is a pure read of two
 * substrate states (`bridgeGetKchatBackfillState` and the
 * `inFlightBackfillKchatChannel` map). The watermark itself is
 * persisted by `bridgeIngestKchatBackfillPage` between pages, so
 * there is no incrementally-pushed signal that a push channel
 * could surface — it would be a synthetic re-read of the same
 * state we're already polling. The 2-second cadence below balances
 * "visible progress for the user during a multi-minute walk" with
 * the IPC rate-limit budget (`kchat:backfillProgress` is gated at
 * 2 tokens / 1 s sustained, 4 burst — see
 * `RATE_LIMIT_PROFILES["kchat:backfillProgress"]`). A 2 s tick
 * leaves headroom for a single retry burst without tripping the
 * limiter.
 *
 * **Mounting on every render.** The hook always schedules polling
 * when `channelId` is non-null — there is no `generation`
 * counter and no "start / stop" verb. The SourceDetailPage mounts
 * this hook once per source navigation; navigating away unmounts
 * it which fires the cleanup, cancels the timer, and stops the
 * polling chain. This is intentionally different from
 * `useEmbeddingProgress`, which is driven by an action button
 * (Re-embed) and only polls *during* a backfill: a KChat channel
 * source's backfill state is interesting even when no walk is in
 * flight (so the user sees "Backfill complete" / "Backfill error"
 * badges between sessions), so passive polling is the right shape.
 *
 * **Cancellation guarantee.** The cleanup sets `cancelled = true`
 * BEFORE clearing the pending timer, so any in-flight IPC promise
 * that resolves after unmount will hit the `if (cancelled) return;`
 * guard and never call `setSnap` on an unmounted component. The
 * timer-clear is belt-and-suspenders against the case where the
 * IPC promise rejected — the catch arm would otherwise schedule a
 * new tick that fires after the cleanup ran.
 *
 * **Transport-error surfacing.** The `kchat:backfillProgress`
 * handler itself catches every substrate-level failure and
 * surfaces it through the `status: "error"` discriminator with an
 * `error: string` field, so a *handler-level* failure is already
 * a successful IPC. A *transport-level* failure (preload bridge
 * missing, IPC channel torn down, etc.) is harder — for a single
 * transient blip we want to keep polling and self-heal without
 * flickering the UI from a valid snapshot into a synthetic error.
 *
 * Devin Review pass 3 on d7290e0 (ANALYSIS_0004): pre-fix we
 * swallowed every transport error indefinitely, which meant a
 * permanently-broken preload bridge would pin the UI in a
 * "Loading backfill state…" placeholder forever — indistinguishable
 * from "the IPC is just slow" without devtools. The fix surfaces a
 * synthetic `status: "error"` view AFTER
 * `TRANSPORT_FAILURE_THRESHOLD` consecutive transport failures, so:
 *
 *   - 1–2 consecutive failures → keep the last known good snapshot
 *     (or `null` if none yet) and silently retry.
 *   - ≥ 3 consecutive failures → render the error card with a
 *     "renderer transport failure" message so the user has a hint
 *     to surface in a bug report, even though the polling loop
 *     itself keeps running and will self-heal once the next tick
 *     succeeds.
 *
 * The counter resets on EVERY successful IPC round-trip
 * (regardless of the substrate-level `status`), so a permanent
 * substrate error doesn't accidentally re-trip the transport-error
 * branch, and an intermittent transport failure between two good
 * polls is invisible to the user.
 */

/**
 * Number of consecutive transport-level IPC failures before the
 * hook surfaces a synthetic `status: "error"` view to the caller.
 * Three failures at the default 2s interval = ~6s of broken IPC
 * before the UI changes — long enough to ride out a transient
 * channel-teardown / preload-reload blip, short enough that a
 * permanently broken bridge isn't invisible to the user.
 */
const TRANSPORT_FAILURE_THRESHOLD = 3;

export function useKchatBackfillProgress(
  channelId: string | null,
  intervalMs = 2000,
): KchatBackfillProgressView | null {
  const [snap, setSnap] = useState<KchatBackfillProgressView | null>(null);

  useEffect(() => {
    // No channel selected (e.g. the source detail page is showing
    // a `local_folder` source) — drop any previous snapshot and
    // schedule no polling work. The snapshot reset is structural:
    // navigating from one KChat source to another resets the UI
    // to a known-null state before the first poll for the new
    // channel id resolves, so we never briefly render the
    // previous channel's `oldestFetched` / `postsIngested`
    // counters while the new channel's poll is in flight.
    if (!channelId) {
      setSnap(null);
      return;
    }

    // Defence-in-depth: clear the snapshot on every new
    // `channelId` so the brief render between the effect firing
    // and the first poll completing shows the loading state, not
    // a stale snapshot from the previous channel. The renderer's
    // "Loading backfill state…" placeholder maps to `snap === null`.
    setSnap(null);

    let cancelled = false;
    let timer: ReturnType<typeof setTimeout> | null = null;
    // Devin Review pass 3 on d7290e0 (ANALYSIS_0004): per-effect
    // counter of consecutive transport-level failures. Lives in the
    // effect closure (NOT a ref) because a `channelId` change tears
    // down the effect and starts a fresh counter — we don't want a
    // previous channel's failures to contaminate the new channel's
    // threshold.
    let consecutiveTransportFailures = 0;

    const tick = async () => {
      if (cancelled) return;
      try {
        const next = await window.tessera.kchat.backfillProgress(channelId);
        if (cancelled) return;
        // Successful IPC: reset the transport-failure counter
        // BEFORE setting state so a future failure starts from a
        // clean baseline. We reset on any successful round-trip
        // regardless of substrate-level `status` — a permanent
        // substrate `error` is the handler's responsibility to
        // signal, not the transport layer's.
        consecutiveTransportFailures = 0;
        setSnap(next);
      } catch {
        // Transport-level failure — the renderer-to-main IPC
        // itself failed (bridge missing, channel torn down, etc.).
        // We keep ticking so the next interval can re-attempt and
        // the loop self-heals, but after
        // `TRANSPORT_FAILURE_THRESHOLD` consecutive failures we
        // surface a synthetic error view so the UI isn't pinned
        // in a "Loading…" placeholder for a permanently broken
        // bridge. The handler captures `cancelled` AFTER the
        // increment so a threshold-crossing tick that races
        // cleanup never sets state on an unmounted component.
        consecutiveTransportFailures += 1;
        if (
          !cancelled &&
          consecutiveTransportFailures >= TRANSPORT_FAILURE_THRESHOLD
        ) {
          setSnap({
            channelId,
            oldestFetched: null,
            totalPosts: null,
            postsIngested: 0,
            status: "error",
            error:
              "Renderer transport failure (kchat:backfillProgress). The polling loop will keep retrying; if the card stays in this state, restart the app.",
          });
        }
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
  }, [channelId, intervalMs]);

  return snap;
}
