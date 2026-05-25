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
import { useCallback, useEffect, useMemo, useState } from "react";
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
  useEffect(() => {
    if (!kchat) {
      setAvailable(false);
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

  const pollUnread = useCallback(async () => {
    if (!kchat || state.state !== "connected" || channels.length === 0) {
      return;
    }
    const seen = getLastSeen();
    // Cap fan-out to `MAX_POLL_CHANNELS` to stay well under the
    // global `kchat:request` rate-limit budget. We walk serially
    // (not in parallel) because the limiter is token-bucket: bursts
    // beyond the budget would `await` inside `consume`, so
    // parallelism cannot actually speed the poll up — it would just
    // make each individual request slower while still consuming the
    // same number of tokens.
    const polled = channels.slice(0, MAX_POLL_CHANNELS);
    try {
      let total = 0;
      for (const ch of polled) {
        const files = await kchat.listChannelFiles(ch.id, 0, 20);
        for (const f of files) {
          if (f.create_at > seen) total += 1;
        }
      }
      setUnread(total);
    } catch {
      /* swallow — keep last-known count */
    }
  }, [kchat, state.state, channels]);

  useEffect(() => {
    if (state.state !== "connected" || channels.length === 0) return;
    pollUnread();
    const id = window.setInterval(pollUnread, POLL_INTERVAL_MS);
    return () => window.clearInterval(id);
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
