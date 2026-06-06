/**
 * KChat presence widget rendered at the bottom of the sidebar.
 *
 * Renders nothing when KChat is unavailable or disconnected.
 * When connected: shows the user, default team, and channel count.
 *
 * The unread badge is driven primarily by WebSocket push events
 * surfaced over the `kchat:event` IPC channel. On every
 * `file_added` event for a channel in the rendered list whose
 * `create_at` post-dates the user's last-seen marker, the badge
 * increments by 1 — no IPC poll required. The renderer subscribes via
 * `window.tessera.kchat.onEvent(cb)` on mount and unsubscribes
 * on unmount; the main-process forwarder owns the per-window
 * ring buffer + drop-oldest backpressure.
 *
 * A 30 s `listChannelFiles` reconciliation poll is preserved as
 * a fallback safety net for the rare case where the renderer
 * subscribes mid-disconnect (so it misses events that arrived
 * before its listener attached), or where the main-process
 * forwarder had to drop events on a saturated buffer. The
 * reconciliation poll computes the unread count from REST so
 * even if every push event were dropped the badge would
 * converge to the correct value within one poll cycle. Status
 * transitions (`connecting` → `connected` / `error`) are
 * delivered via `kchat:status` push, falling back to a 30 s
 * status invoke poll if the push listener is racing the
 * status emitter at mount.
 */
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  getStoredDefaultTeamId,
  isExtensionDetected,
} from "./kchatSettingsHelpers";
import type {
  KchatChannelView,
  KchatConnectionStateView,
  KchatDesktopBridgeStatusView,
  KchatWebSocketEventPayload,
} from "../../../shared/types";

/**
 * Cap the number of KChat channels rendered as individual rows
 * (each with an "Open in KChat Desktop" affordance) so the
 * sidebar doesn't grow without bound. Channels beyond this cap
 * are still represented by the count line. Ten matches the
 * `MAX_POLL_CHANNELS` cap below so the rendered set and the
 * polled set converge.
 */
const MAX_SIDEBAR_CHANNELS = 10;

/**
 * Cadence at which the sidebar's bridge-health dot rechecks.
 *
 * Intentionally distinct from `BRIDGE_STATUS_POLL_MS` in
 * `kchatSettingsHelpers.ts` (10 s): the Settings card is the
 * primary configuration surface and polls more aggressively
 * so the Connect/Disconnect affordance reacts quickly to bridge
 * state changes the user just induced. The sidebar dot is a
 * passive status indicator on an always-mounted surface — the
 * relaxed 15 s cadence reduces background HTTP-call volume by
 * a third without measurably degrading perceived freshness for
 * what amounts to a single coloured dot. This constant lives
 * locally (renamed from the colliding `BRIDGE_STATUS_POLL_MS`)
 * specifically so a future maintainer reading
 * `kchatSettingsHelpers.ts`'s export does not assume the
 * sidebar shares that cadence.
 */
const SIDEBAR_BRIDGE_DOT_POLL_MS = 15_000;

/**
 * Reconciliation poll cadence in milliseconds.
 *
 * Block A used 10 s for both the unread-files poll and the
 * status probe (it was the only delivery mechanism — the
 * sidebar received no push events at all). Block B Task 1
 * added a main-process WebSocket forwarder that pushes
 * `kchat:event` and `kchat:status` over IPC, so the poll
 * stopped being the primary delivery path and became a
 * reconciliation fallback for the narrow case where the push
 * listener missed a transition (renderer subscribed mid-
 * reconnect; a `kchat:event` was dropped by the main-process
 * ring buffer under burst load; the OS suspended the renderer
 * during a transition). 30 s is the convergence target: a
 * missed event surfaces within ~30 s in the worst case, while
 * the steady-state cost (REST round-trip every 30 s × number
 * of channels in `CHANNELS_PER_TICK`, currently 10) stays well
 * below the global KChat REST limiter's 5 req/s × burst 20
 * budget. Third-pass Devin Review on PR #43
 * (`ANALYSIS_pr-review-job-...0005`) flagged that the cadence
 * change from 10 s → 30 s was not documented in the source;
 * this comment is that documentation.
 */
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
  // Active-sync indicator (Session 8 Task 5): true while a
  // reconciliation poll (`pollUnread`) is walking channel files.
  // Surfaced next to the presence dot so the user can tell Tessera
  // is actively pulling from KChat versus idle-connected.
  const [syncing, setSyncing] = useState(false);
  // passive snapshot of Tessera's localhost API server +
  // last extension heartbeat. Used to render the bridge-health
  // dot and to decide whether to show per-channel "Open in
  // Desktop" buttons. `null` until the first probe lands.
  const [bridgeStatus, setBridgeStatus] =
    useState<KchatDesktopBridgeStatusView | null>(null);
  // Wall clock ticked on every bridge poll so the freshness
  // calculation rerenders without a separate clock useEffect.
  const [nowMs, setNowMs] = useState<number>(() => Date.now());

  // Status probe + push subscription. Block B Task 1 moves
  // status transitions to a push channel (`kchat:status`); the
  // renderer subscribes once on mount and the main-process
  // forwarder pushes the new state on every connect /
  // disconnect / health-check transition. The initial state is
  // still fetched via the `kchat:status` invoke so a fresh
  // mount catches up with whatever happened before the
  // subscription installed.
  //
  // Polling teardown when the feature is unavailable: when
  // `kchat:isAvailable` returns false (enterprise licence not
  // active, future opt-out flag, etc.), the component renders
  // `null` and the subscription teardown below releases the
  // IPC listener. Without this early return the listener
  // would still be cheap (`subscribeIpc` is a single
  // `ipcRenderer.on` call) but the per-window ring buffer in
  // the main-process forwarder would accumulate events that
  // the renderer can never consume — the eleventh-pass Devin
  // Review finding generalises here too, so we
  // keep the gate.
  //
  // Reconciliation-only re-fetch: the initial-state read can
  // race the first push event in theory, so we additionally
  // re-fetch state on a slow 30 s timer as a safety net. The
  // old 10 s aggressive poll is gone — push delivery makes it
  // redundant for the common case, and the 30 s reconciliation
  // timer matches the unread-badge file-poll cadence to amortise
  // wakeups.
  useEffect(() => {
    if (!kchat) {
      setAvailable(false);
      return;
    }
    if (available === false) {
      return;
    }
    let cancelled = false;
    // Install the status push subscription synchronously, in the
    // effect body itself, BEFORE any `await` in `probe()`. The
    // listener's lifetime is now deterministically paired with
    // the cleanup closure below: both `unsubscribeStatus` (the
    // sync return value of `onStatusChange`) and the
    // `cancelled = true` write happen on the same React-effect
    // tick, so React's tear-down ordering cannot interleave them.
    //
    // The previous shape created the subscription inside the
    // async `probe()` body, after `await kchat.isAvailable()`
    // resolved. That worked correctly under React 18/19 because
    // `setAvailable(true)` was batched into the microtask queue,
    // so `probe()` continued synchronously to the subscription
    // line BEFORE the re-render (and cleanup) ran. But the
    // correctness was an emergent property of React's batching
    // semantics — a future refactor that moved cleanup ahead of
    // pending async continuations (e.g. concurrent rendering
    // changes, or a hypothetical `useEffectEvent`-style rewrite)
    // would orphan the listener. Devin Review on PR #43
    // (`ANALYSIS_pr-review-job-...0001`) flagged the coupling;
    // moving the subscribe out of the async body decouples
    // correctness from React's internal scheduling.
    //
    // Subscribe BEFORE `probe()` runs so a transition that races
    // the initial `kchat.status()` fetch is captured by the
    // listener (the listener overwrites the fetched initial
    // state with whatever arrived). The reverse order would have
    // a window where an event between fetch and subscribe is
    // lost.
    //
    // The subscription is cheap (the preload bridge just adds to
    // an in-process Set on the renderer side; the main process
    // already has the WS connection open regardless of subscribers)
    // and safe regardless of `available` — the listener captures
    // `cancelled` and short-circuits the `setState(s)` write if
    // the effect has been torn down between push and dispatch.
    const unsubscribeStatus = kchat.onStatusChange((s) => {
      if (!cancelled) setState(s);
    });
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
    // 30 s reconciliation re-fetch. Push delivery handles the
    // common case; this timer exists only to converge after a
    // missed transition (e.g. the renderer subscribed mid-
    // reconnect and the main process emitted a transition
    // before the listener was installed).
    const id = window.setInterval(probe, POLL_INTERVAL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(id);
      unsubscribeStatus();
    };
  }, [kchat, available]);

  // Fetch the channel list whenever we transition into `connected`.
  //
  // Gated on `available === true` (not just `state.state ===
  // "connected"`) so the channel-fetch IPC and rate-limit token
  // consumption only fire AFTER the renderer has confirmed the
  // KChat feature is available. The status push subscription
  // installed on mount can deliver a `"connected"` transition
  // during the `kchat.isAvailable()` round-trip while `available
  // === null`; without the explicit `available === true` gate,
  // this effect would fire before the gate resolves, burning
  // rate-limit tokens on a feature that may turn out to be
  // disabled. Twelfth-pass Devin Review on PR #43
  // (`ANALYSIS_pr-review-job-...0002`).
  useEffect(() => {
    if (!kchat || available !== true || state.state !== "connected") {
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
  }, [kchat, available, state.state]);

  // `channelsRef` holds the live channel list so `pollUnread` can
  // read the latest set without taking `channels` as a useCallback
  // dependency. Capturing `channels` directly would change
  // `pollUnread`'s identity every time `setChannels(list)` is called
  // — even when the resulting array is content-identical — because
  // React compares array references, not contents. The poll-
  // scheduling effect below depends on `pollUnread`, so each
  // identity flip would tear down the recursive `setTimeout` chain
  // and re-arm it, wasting work today and risking a foot-gun in
  // future refactors that refetch channels more aggressively. The
  // ref pattern keeps `pollUnread`'s identity stable for the
  // lifetime of the connection while still letting each cycle
  // observe the latest channel set.
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
  // against an unmounted component. The cancellation is a getter (not a snapshot
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
      setSyncing(true);
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
      } finally {
        if (!isCancelled?.()) setSyncing(false);
      }
    },
    [kchat, state.state],
  );

  // Live WS event subscription. Block B Task 1 push pipeline:
  // the main-process forwarder pushes parsed
  // `KchatWebSocketEventPayload`s over `kchat:event`; we
  // increment the unread badge by 1 on every `file_added` event
  // whose originating channel appears in the rendered channel
  // list AND whose `data.create_at` post-dates the user's
  // last-seen marker. Events for channels we're not displaying
  // (other teams, DMs the user isn't a member of) are ignored;
  // events older than `lastSeen` are ignored (an already-seen
  // file replayed after a reconnect).
  //
  // The subscription is independent of `pollUnread` — the poll
  // exists as a reconciliation fallback. If the forwarder
  // drops events on a saturated buffer, or if a renderer
  // reconnects mid-stream, the 30 s poll re-derives the unread
  // count from REST and overwrites whatever delta the WS path
  // accumulated. Both paths converge on the same `unread`
  // state.
  //
  // CAVEAT, first pass on PR #43):
  // because the WS path is incremental (`n + 1`) and the poll is
  // an absolute overwrite, the badge can briefly tick higher
  // from WS events than the next poll cycle settles at — for
  // example if the WS adds three `file_added` deltas and the
  // next 30 s poll only counts two (page-size caps in REST or a
  // file replaced before the poll observes it). The poll is the
  // REST-authoritative count and intentionally wins; the badge
  // may therefore briefly be non-monotonic across a poll
  // boundary. This is documented as expected behavior — the
  // alternative ("WS wins for X seconds after the increment")
  // would either drift forever or introduce a separate
  // dedupe-by-file_id store keyed by `lastSeen`, neither of
  // which is worth the complexity for a UI badge that converges
  // within 30 s anyway.
  //
  // SECONDARY CAVEAT the `?? 0` fallback for
  // `event.data.create_at` combined with the `getLastSeen() || 0`
  // default produces an "ignore on missing timestamp" branch — a
  // `file_added` event whose `data.create_at` is missing or
  // non-numeric never increments the badge (`0 <= 0` is true).
  // This is the lower-cost failure mode: false negatives converge
  // within 30 s via the REST poll (which gets valid timestamps
  // from the server's REST path independent of the WS path),
  // whereas false positives would visibly tick the badge for a
  // file the user has already viewed and would not recover until
  // the next interaction. The alternative — treat missing
  // timestamps as `Infinity` so they always count as new — would
  // make the very first malformed event after a fresh user opens
  // KChat tick the badge from 0 to 1 with no provenance, which is
  // the most visible failure mode for new users.
  //
  // Gated on `available === true` for the same reason the channel-
  // fetch effect above is — a `"connected"` push that arrives
  // during the initial `isAvailable()` round-trip must not install
  // the IPC listener for a feature that may turn out to be gated
  // off
  useEffect(() => {
    if (!kchat || available !== true || state.state !== "connected") return;
    const unsubscribe = kchat.onEvent((event: KchatWebSocketEventPayload) => {
      if (event.event !== "file_added") return;
      const live = channelsRef.current;
      // The forwarder flattens `broadcast.channel_id` to the
      // top-level `channelId` so we don't have to reach into a
      // nested envelope. A missing channel id (server bug)
      // disqualifies the event from incrementing the badge:
      // there's no way to verify it belongs to a channel we're
      // rendering.
      if (!event.channelId) return;
      if (!live.some((c) => c.id === event.channelId)) return;
      const createAt =
        typeof event.data.create_at === "number" ? event.data.create_at : 0;
      if (createAt <= getLastSeen()) return;
      setUnread((n) => n + 1);
    });
    return () => {
      unsubscribe();
    };
  }, [kchat, available, state.state]);

  // Recursive `setTimeout` instead of `setInterval`. `setInterval` would fire every
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
  // moment the effect tears down
  // — both to save rate-limit tokens on a cycle whose
  // `setUnread` would be discarded, and to avoid the post-unmount
  // state update entirely.
  //
  // Gated on `available === true` so the recursive poll does not
  // arm while `available === null` (the initial-mount race window
  // described on the channel-fetch effect above); twelfth-pass
  useEffect(() => {
    if (
      available !== true ||
      state.state !== "connected" ||
      channels.length === 0
    ) {
      return;
    }
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
  }, [pollUnread, available, state.state, channels.length]);

  // poll the bridge-status snapshot so the per-channel
  // "Open in KChat Desktop" affordance picks up a desktop-app
  // launch / extension install without a remount. The poll is
  // gated on `available && connected` so a disabled-by-feature
  // session or a disconnected session never fires the IPC.
  useEffect(() => {
    if (!kchat || available !== true || state.state !== "connected") {
      setBridgeStatus(null);
      return;
    }
    let cancelled = false;
    const pull = async () => {
      try {
        const next = await kchat.desktopBridgeStatus();
        if (!cancelled) {
          setBridgeStatus(next);
          setNowMs(Date.now());
        }
      } catch {
        if (!cancelled) {
          setBridgeStatus(null);
          setNowMs(Date.now());
        }
      }
    };
    void pull();
    const handle = window.setInterval(pull, SIDEBAR_BRIDGE_DOT_POLL_MS);
    return () => {
      cancelled = true;
      window.clearInterval(handle);
    };
  }, [kchat, available, state.state]);

  const handleMarkSeen = useCallback(() => {
    setLastSeen(Date.now());
    setUnread(0);
  }, []);

  const handleOpenChannelInDesktop = useCallback(
    async (channelId: string) => {
      if (!kchat) return;
      try {
        await kchat.openInDesktop(channelId);
      } catch (err) {
        // The handler is best-effort: a failed `shell.openExternal`
        // means KChat Desktop isn't installed (the OS rejects the
        // `kchat://` scheme) — surface a soft console warning
        // rather than a toast because the sidebar widget has no
        // toast context wired in. The user already sees the dot
        // is grey when the integration isn't reachable.
        console.warn(
          "[Tessera] Failed to open channel in KChat Desktop:",
          err,
        );
      }
    },
    [kchat],
  );

  const userLabel = useMemo(() => {
    if (state.state !== "connected" || !state.user) return null;
    return `@${state.user.username}`;
  }, [state]);

  if (available !== true) return null;
  if (state.state !== "connected") return null;

  // KChat Desktop integration health dot. Green when
  // the Tessera .kcz extension installed in KChat Desktop has
  // checked in recently (i.e. the user has both apps running and
  // the extension is wired up); grey otherwise. Detection is
  // passive: Tessera's localhost API records a heartbeat on
  // every authenticated extension call and `desktopBridgeStatus`
  // reads the most recent timestamp.
  const extensionHealthy = isExtensionDetected(bridgeStatus, nowMs);
  const extensionDotColor = extensionHealthy
    ? "var(--color-success, #2da44e)"
    : "var(--color-text-tertiary, #999)";
  const extensionDotLabel = extensionHealthy
    ? "KChat Desktop detected — channel actions enabled"
    : "KChat Desktop not detected — install the Tessera extension and launch KChat Desktop to enable channel actions";

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
        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--spacing-xs)",
          }}
        >
          <span
            data-testid="kchat-extension-dot"
            data-extension-state={extensionHealthy ? "healthy" : "stale"}
            title={extensionDotLabel}
            aria-label={extensionDotLabel}
            role="img"
            style={{
              display: "inline-block",
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              backgroundColor: extensionDotColor,
            }}
          />
          <strong style={{ color: "var(--color-text-headline)" }}>
            KChat
          </strong>
          <span
            data-testid="kchat-presence-dot"
            data-presence-state="online"
            title="Connected to KChat — you are online"
            aria-label="Connected to KChat — you are online"
            role="img"
            style={{
              display: "inline-block",
              width: "8px",
              height: "8px",
              borderRadius: "50%",
              backgroundColor: "var(--color-success, #2da44e)",
            }}
          />
          <span
            data-testid="kchat-sync-status"
            data-sync-state={syncing ? "syncing" : "idle"}
            title={
              syncing
                ? "Syncing KChat channels…"
                : "KChat is up to date"
            }
            aria-label={
              syncing
                ? "Syncing KChat channels"
                : "KChat is up to date"
            }
            style={{
              fontSize: "var(--font-size-xs)",
              color: syncing
                ? "var(--color-primary, #0969da)"
                : "var(--color-text-tertiary, #999)",
            }}
          >
            {syncing ? "syncing…" : "synced"}
          </span>
        </div>
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
            aria-label={`${unread} unread file${
              unread === 1 ? "" : "s"
            } in KChat — click to mark as seen`}
          >
            {unread}
          </button>
        )}
      </div>
      <div data-testid="kchat-sidebar-user">{userLabel}</div>
      <div data-testid="kchat-sidebar-channels">
        {channels.length} channel{channels.length === 1 ? "" : "s"}
      </div>
      {channels.length > 0 && (
        <ul
          data-testid="kchat-sidebar-channel-list"
          style={{
            listStyle: "none",
            padding: 0,
            margin: "var(--spacing-xs) 0 0",
            display: "flex",
            flexDirection: "column",
            gap: "2px",
          }}
        >
          {channels.slice(0, MAX_SIDEBAR_CHANNELS).map((c) => (
            <li
              key={c.id}
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                gap: "var(--spacing-xs)",
                fontSize: "var(--font-size-xs)",
              }}
            >
              <span
                title={c.display_name || c.name}
                style={{
                  flex: "1 1 auto",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                  color: "var(--color-text-secondary)",
                }}
              >
                #{c.name || c.display_name}
              </span>
              <button
                type="button"
                onClick={() => {
                  void handleOpenChannelInDesktop(c.id);
                }}
                disabled={!extensionHealthy}
                aria-label={
                  extensionHealthy
                    ? `Open #${c.name || c.display_name} in KChat Desktop`
                    : `KChat Desktop not detected (open is disabled)`
                }
                title={
                  extensionHealthy
                    ? "Open in KChat Desktop"
                    : "KChat Desktop not detected"
                }
                data-testid={`kchat-open-channel-${c.id}`}
                style={{
                  background: "transparent",
                  border: "none",
                  cursor: extensionHealthy ? "pointer" : "not-allowed",
                  padding: "2px 4px",
                  color: extensionHealthy
                    ? "var(--color-text-link, #06f)"
                    : "var(--color-text-tertiary, #999)",
                  fontSize: "var(--font-size-xs)",
                  lineHeight: 1,
                }}
              >
                {/* External-link unicode glyph (↗) — chosen over a
                    raster icon so the sidebar stays icon-font-free
                    and the affordance scales with the user's
                    chosen UI scale.  */}
                <span aria-hidden="true">↗</span>
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}
