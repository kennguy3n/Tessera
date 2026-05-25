/**
 * KChat presence widget rendered at the bottom of the sidebar.
 *
 * Renders nothing when KChat is unavailable or disconnected.
 * When connected: shows the user, default team, and channel count.
 *
 * The unread badge is driven by `listChannelFiles` polling — every
 * 30s we fetch the file list for the configured default-team's
 * channels and surface the count of files newer than the last
 * "seen" timestamp the user established by opening the artifact
 * editor or the Sources page.
 *
 * This is intentionally polling-based rather than WebSocket-based:
 * WebSocket events fire in the main process; surfacing them to the
 * renderer would require an extra IPC pipe and a backpressure
 * strategy that is overkill for a 30 s freshness window. If a
 * future iteration wants live updates the main process can flip
 * to push-based via an additional IPC channel.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { getStoredDefaultTeamId } from "./KchatSettingsCard";
import type {
  KchatChannelView,
  KchatConnectionStateView,
} from "../../../shared/types";

const POLL_INTERVAL_MS = 30_000;
const SEEN_LS_KEY = "tessera.kchat.lastSeenAt";

/**
 * Cap the per-tick channel-files fetch fan-out. The KChat REST
 * limiter is global (5 req/s burst 20); each polled channel
 * consumes one token, so walking 50 channels would burn the whole
 * burst budget every 30 s and starve user-initiated requests
 * during the poll window. Ten channels gives accurate-enough
 * unread counts for the common case (most users belong to a
 * handful of active channels) while leaving headroom for typing,
 * shares, and source syncs. Channels beyond the cap simply do not
 * contribute to the badge until the user opens them explicitly.
 */
const MAX_POLL_CHANNELS = 10;

function getLastSeen(): number {
  try {
    const raw = window.localStorage.getItem(SEEN_LS_KEY);
    if (!raw) return 0;
    const n = Number.parseInt(raw, 10);
    return Number.isFinite(n) ? n : 0;
  } catch {
    return 0;
  }
}

function setLastSeen(ts: number): void {
  try {
    window.localStorage.setItem(SEEN_LS_KEY, String(ts));
  } catch {
    /* localStorage disabled — fine, badge will re-count on reload */
  }
}

interface KchatSidebarSectionProps {
  /** Override `window.tessera.kchat` (used by tests). */
  api?: typeof window.tessera.kchat;
}

export default function KchatSidebarSection({ api }: KchatSidebarSectionProps = {}) {
  const kchat = api ?? window.tessera?.kchat;
  const [state, setState] = useState<KchatConnectionStateView>({
    state: "disconnected",
  });
  const [channels, setChannels] = useState<KchatChannelView[]>([]);
  const [unread, setUnread] = useState(0);
  const [available, setAvailable] = useState<boolean | null>(null);

  // Status probe + 10s re-probe so a fresh connect/disconnect from
  // Settings is reflected without a page reload. 10s is much
  // shorter than the file-poll interval because the status read is
  // cheap (a single in-memory lookup in main process).
  //
  // Polling teardown when the feature is unavailable: when
  // `kchat:isAvailable` returns false (enterprise licence not
  // active, future opt-out flag, etc.), the component renders
  // `null` — but without this early return the 10s interval would
  // continue burning an IPC call on every tick for the lifetime of
  // the page. The effect depends on `available`, so once the first
  // probe resolves to `false` it re-runs with the new value and
  // bails out before arming the next interval. This was raised in
  // Devin Review fifth-pass as ANALYSIS_0005.
  useEffect(() => {
    if (!kchat) {
      setAvailable(false);
      return;
    }
    if (available === false) {
      return;
    }
    let cancelled = false;
    const probe = async () => {
      try {
        if (available === null) {
          const ok = await kchat.isAvailable();
          if (cancelled) return;
          setAvailable(ok);
          if (!ok) return;
        }
        const s = await kchat.status();
        if (!cancelled) setState(s);
      } catch {
        /* swallow — surface via state */
      }
    };
    probe();
    const id = window.setInterval(probe, 10_000);
    return () => {
      cancelled = true;
      window.clearInterval(id);
    };
  }, [kchat, available]);

  // Fetch the channel list whenever we transition into `connected`.
  useEffect(() => {
    if (!kchat || state.state !== "connected") {
      setChannels([]);
      setUnread(0);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const team = getStoredDefaultTeamId();
        if (!team) {
          const teams = await kchat.listTeams();
          if (cancelled) return;
          if (!teams[0]) return;
          const list = await kchat.listChannels(teams[0].id);
          if (!cancelled) setChannels(list);
          return;
        }
        const list = await kchat.listChannels(team);
        if (!cancelled) setChannels(list);
      } catch {
        /* swallow — surface via state */
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [kchat, state.state]);

  // `channelsRef` holds the live channel list so `pollUnread` can
  // read the latest set without taking `channels` as a useCallback
  // dependency. Capturing `channels` directly would change
  // `pollUnread`'s identity every time `setChannels(list)` is called
  // — even when the resulting array is content-identical — because
  // React compares array references, not contents. The poll-
  // scheduling effect below depends on `pollUnread`, so each
  // identity flip would tear down the recursive `setTimeout` chain
  // and re-arm it, wasting work today and risking a foot-gun in
  // future refactors that refetch channels more aggressively
  // (thirteenth-pass Devin Review ANALYSIS_0002). The ref pattern
  // keeps `pollUnread`'s identity stable for the lifetime of the
  // connection while still letting each cycle observe the latest
  // channel set.
  const channelsRef = useRef(channels);
  useEffect(() => {
    channelsRef.current = channels;
  }, [channels]);

  // `isCancelled` is an optional callback the caller can pass to
  // short-circuit the poll cycle. We check it (a) before issuing
  // each `listChannelFiles` request — so a teardown stops burning
  // rate-limit tokens on a cycle whose result will be discarded —
  // and (b) right before `setUnread`, so an unmount that races with
  // the in-flight Promise's resolution doesn't fire a state update
  // against an unmounted component (twelfth-pass Devin Review
  // ANALYSIS_0006). The cancellation is a getter (not a snapshot
  // boolean) so the effect's `cancelled` mutation is observed
  // immediately by the running cycle rather than at the next
  // `pollUnread` invocation. This is correct long-term: React 18
  // silently no-ops state updates on unmounted components today,
  // but stricter future modes (and the in-development concurrent
  // renderer) may surface warnings — and the rate-limiter savings
  // are real today.
  const pollUnread = useCallback(
    async (isCancelled?: () => boolean) => {
      const live = channelsRef.current;
      if (!kchat || state.state !== "connected" || live.length === 0) {
        return;
      }
      const seen = getLastSeen();
      // Cap fan-out to `MAX_POLL_CHANNELS` to stay well under the
      // global `kchat:request` rate-limit budget. We walk serially
      // (not in parallel) because the limiter is token-bucket:
      // bursts beyond the budget would `await` inside `consume`, so
      // parallelism cannot actually speed the poll up — it would
      // just make each individual request slower while still
      // consuming the same number of tokens.
      const polled = live.slice(0, MAX_POLL_CHANNELS);
      try {
        let total = 0;
        for (const ch of polled) {
          if (isCancelled?.()) return;
          const files = await kchat.listChannelFiles(ch.id, 0, 20);
          for (const f of files) {
            if (f.create_at > seen) total += 1;
          }
        }
        if (isCancelled?.()) return;
        setUnread(total);
      } catch {
        /* swallow — keep last-known count */
      }
    },
    [kchat, state.state],
  );

  // Recursive `setTimeout` instead of `setInterval` (eleventh-pass
  // Devin Review ANALYSIS_0004). `setInterval` would fire every
  // `POLL_INTERVAL_MS` regardless of whether the previous
  // `pollUnread` had finished — if `listChannelFiles` calls run
  // slow (e.g. the network is degraded), two or more poll cycles
  // could overlap and stack rate-limiter token consumption against
  // the global `kchat:request` budget, starving user-initiated
  // requests. By awaiting `pollUnread` before scheduling the next
  // tick we guarantee a single in-flight poll per component
  // instance, the inter-poll gap is always at least
  // `POLL_INTERVAL_MS`, and any `pollUnread` Promise rejection
  // (swallowed inside the function so a future change couldn't
  // accidentally re-throw) cannot leave a dangling interval.
  //
  // The `cancelled` flag is also passed *into* `pollUnread` via the
  // `isCancelled` getter so an in-flight cycle short-circuits the
  // moment the effect tears down (twelfth-pass Devin Review
  // ANALYSIS_0006) — both to save rate-limit tokens on a cycle whose
  // `setUnread` would be discarded, and to avoid the post-unmount
  // state update entirely.
  useEffect(() => {
    if (state.state !== "connected" || channels.length === 0) return;
    let cancelled = false;
    let timeoutId: number | null = null;
    const tick = async () => {
      if (cancelled) return;
      try {
        await pollUnread(() => cancelled);
      } finally {
        if (!cancelled) {
          timeoutId = window.setTimeout(tick, POLL_INTERVAL_MS);
        }
      }
    };
    tick();
    return () => {
      cancelled = true;
      if (timeoutId !== null) window.clearTimeout(timeoutId);
    };
  }, [pollUnread, state.state, channels.length]);

  const handleMarkSeen = useCallback(() => {
    setLastSeen(Date.now());
    setUnread(0);
  }, []);

  const userLabel = useMemo(() => {
    if (state.state !== "connected" || !state.user) return null;
    return `@${state.user.username}`;
  }, [state]);

  if (available !== true) return null;
  if (state.state !== "connected") return null;

  return (
    <div
      className="sidebar-kchat"
      data-testid="kchat-sidebar"
      style={{
        borderTop: "1px solid var(--color-border)",
        margin: "var(--spacing-sm) var(--spacing-sm) 0",
        padding: "var(--spacing-sm) var(--spacing-md)",
        fontSize: "var(--font-size-xs)",
        color: "var(--color-text-secondary)",
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
        }}
      >
        <strong style={{ color: "var(--color-text-headline)" }}>KChat</strong>
        {unread > 0 && (
          <button
            type="button"
            onClick={handleMarkSeen}
            data-testid="kchat-unread-badge"
            style={{
              background: "var(--color-primary)",
              color: "var(--color-text-on-primary)",
              border: "none",
              borderRadius: "999px",
              padding: "2px 8px",
              fontSize: "var(--font-size-xs)",
              cursor: "pointer",
            }}
            title="Mark all as seen"
            aria-label={`${unread} unread file${unread === 1 ? "" : "s"} in KChat — click to mark as seen`}
          >
            {unread}
          </button>
        )}
      </div>
      <div data-testid="kchat-sidebar-user">{userLabel}</div>
      <div data-testid="kchat-sidebar-channels">
        {channels.length} channel{channels.length === 1 ? "" : "s"}
      </div>
    </div>
  );
}
