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
 * **Why we swallow IPC errors.** The `kchat:backfillProgress`
 * handler itself catches every substrate-level failure and
 * surfaces it through the `status: "error"` discriminator with an
 * `error: string` field, so a *handler-level* failure is already
 * a successful IPC. A *transport-level* failure (preload bridge
 * missing, the user quit mid-poll, the IPC channel was torn down
 * for some other reason) is unrecoverable from the renderer's
 * perspective; we keep ticking so the next interval can re-attempt
 * but we deliberately do NOT surface the transport error to the
 * caller. That avoids a flicker between "valid backfill state"
 * and "renderer-level IPC error" during a transient transport
 * blip, and the polling loop self-heals.
 */
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

    const tick = async () => {
      if (cancelled) return;
      try {
        const next = await window.tessera.kchat.backfillProgress(channelId);
        if (cancelled) return;
        setSnap(next);
      } catch {
        // Transport-level failure — keep ticking; the next
        // interval can re-attempt. The IPC handler surfaces
        // substrate-level failures through the `status: "error"`
        // discriminator, so reaching this catch means the
        // renderer-to-main IPC itself failed (bridge missing,
        // channel torn down, etc.) which is unrecoverable from
        // here.
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
