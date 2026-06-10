/**
 * Non-blocking model-setup banner (Session 5, Step 2).
 *
 * Renders a slim strip at the top of `app-main` that reflects the
 * state of the recommended text-model download. It is a pure OBSERVER:
 * the first-launch auto-download is now initiated authoritatively in
 * the MAIN process (`autoModelDownload.ts`, after `init_bridge`
 * succeeds), so the banner no longer triggers a download on mount —
 * it only reflects one that is (or was) in flight, whether started by
 * the auto-download or from the Settings model panel. Having a single
 * initiator removes the previous double-start race and means the
 * banner can't fire a redundant fetch on every remount.
 *
 * State machine, driven entirely by IPC events:
 *   - `runtime:downloadProgress` (text slot) → downloading (with %),
 *     flipping to ready once a `percent >= 100` event arrives (the
 *     main process emits a synthetic 100% completion event so this is
 *     reliable even if the fetcher's last real tick lands below 100).
 *   - `runtime:downloadError` (text slot) → failed, with a Retry
 *     button that calls `runtime.downloadRecommended("text")`.
 *
 * UX per spec: shows an estimated size before bytes start
 * ("Downloading AI model (~450 MB)…"), auto-dismisses the success
 * state after 5s, and offers a "Skip — work without AI" link that
 * dismisses AND persists `autoDownloadModel: false` so the next launch
 * won't auto-retry.
 *
 * The banner is intentionally additive and never blocks: it renders
 * `null` whenever there is nothing to say (idle, dismissed, or a
 * model is already installed).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { X, Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { useUpdateSetting } from "../hooks/useSettings";
import { useCspNonce } from "../utils/cspNonce";
import { formatModelSize } from "../utils/formatModelSize";

type BannerStatus = "idle" | "downloading" | "ready" | "failed";

const READY_AUTODISMISS_MS = 5000;

export default function ModelDownloadBanner() {
  const cspNonce = useCspNonce();
  const { update } = useUpdateSetting();
  const [status, setStatus] = useState<BannerStatus>("idle");
  const [percent, setPercent] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // Estimated download size, shown before the first progress byte and
  // then reconciled to the real `totalMb` once it's known.
  const [sizeMb, setSizeMb] = useState<number | null>(null);
  // Tracks mount state so async IPC callbacks (not cancelable through
  // the bridge) never call a state setter after unmount. Re-set on
  // every mount so React 18 StrictMode's mount→unmount→remount cycle
  // leaves it `true`.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Probe the recommended model's size up-front so we can show
  // "~450 MB" in the banner before the first progress event lands.
  // Best-effort and read-only — never initiates a download.
  useEffect(() => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api?.runtime) return;
    let cancelled = false;
    void api.runtime
      .recommendModel("text")
      .then((m) => {
        if (cancelled || !mountedRef.current) return;
        if (m) setSizeMb(m.downloadSizeMb);
      })
      .catch(() => {
        // No manifest / bridge not ready — degrade to no estimate.
      });
    return () => {
      cancelled = true;
    };
  }, []);

  // Reflect ANY in-flight text-slot download (the main-process auto-
  // download, or one started from the Settings panel) by observing
  // progress. A `percent >= 100` event is the completion signal.
  useEffect(() => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api?.runtime) return;
    return api.runtime.onDownloadProgress((p) => {
      if (p.capability !== "text") return;
      if (!mountedRef.current) return;
      setPercent(p.percent);
      // Capture the authoritative total once the fetcher reports it.
      if (Number.isFinite(p.totalMb) && p.totalMb > 0) setSizeMb(p.totalMb);
      if (p.percent >= 100) {
        setStatus("ready");
      } else {
        setStatus((s) => (s === "ready" ? s : "downloading"));
      }
    });
  }, []);

  // Reflect a terminal failure of the main-process auto-download
  // (which is fire-and-forget and has no caller to reject to).
  useEffect(() => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api?.runtime?.onDownloadError) return;
    return api.runtime.onDownloadError((e) => {
      if (e.capability !== "text") return;
      if (!mountedRef.current) return;
      setStatus("failed");
    });
  }, []);

  // Auto-dismiss the success state after a short delay so the banner
  // doesn't linger once the model is ready.
  useEffect(() => {
    if (status !== "ready") return;
    const t = setTimeout(() => setDismissed(true), READY_AUTODISMISS_MS);
    return () => clearTimeout(t);
  }, [status]);

  // Retry re-runs the recommended-model install via the dedicated IPC.
  // It owns this promise so it resolves to ready/failed even when no
  // further progress events arrive (instant cache hit or immediate
  // rejection); the progress/error observers above converge on the
  // same states for the auto-download path.
  const onRetry = useCallback(() => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api?.runtime) return;
    setDismissed(false);
    setStatus("downloading");
    setPercent(0);
    void api.runtime
      .downloadRecommended("text")
      .then((record) => {
        if (!mountedRef.current) return;
        // `null` = no candidate for this device/tier — stay quiet.
        setStatus(record === null ? "idle" : "ready");
      })
      .catch(() => {
        if (!mountedRef.current) return;
        setStatus("failed");
      });
  }, []);

  // Skip is a TRUE opt-out: it (1) cancels any in-flight download so we
  // stop consuming network/disk the instant the user opts out, (2)
  // dismisses the banner, and (3) persists the opt-out so the next
  // launch's auto-download trigger stays off. (The plain "X"/Dismiss
  // button only hides the banner and lets a near-complete download
  // finish in the background.) The user can re-enable from Settings →
  // Model Runtime. Cancellation is fire-and-forget and best-effort: if
  // the download already finished there is simply nothing to abort, so
  // a rejection (or an older preload without the channel) is ignored.
  const onSkip = useCallback(() => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    void api?.runtime?.cancelDownload?.("text").catch(() => {
      // Already complete / nothing in flight — opt-out below still applies.
    });
    setDismissed(true);
    void update({ autoDownloadModel: false }).catch(() => {
      // A failed persist still dismisses for this session; the toggle
      // in Settings remains the durable control.
    });
  }, [update]);

  if (dismissed || status === "idle") return null;

  const rounded = Math.round(percent);
  const sizeLabel = formatModelSize(sizeMb);

  return (
    <div
      className={`model-download-banner model-download-banner-${status}`}
      role="status"
      aria-live="polite"
      data-testid="model-download-banner"
    >
      <span className="model-download-banner-icon" aria-hidden="true">
        {status === "downloading" && (
          <Loader2 size={16} className="model-download-banner-spin" />
        )}
        {status === "ready" && <CheckCircle2 size={16} />}
        {status === "failed" && <AlertTriangle size={16} />}
      </span>
      <span className="model-download-banner-text">
        {status === "downloading" &&
          (rounded > 0
            ? `Setting up AI capabilities… ${rounded}%`
            : `Downloading AI model${sizeLabel}…`)}
        {status === "ready" && "AI ready"}
        {status === "failed" &&
          "AI setup failed. You can keep working from your sources."}
      </span>
      <span className="model-download-banner-actions">
        {status === "failed" && (
          <button
            type="button"
            className="model-download-banner-btn"
            onClick={onRetry}
            data-testid="model-download-banner-retry"
          >
            Retry
          </button>
        )}
        {(status === "downloading" || status === "failed") && (
          <button
            type="button"
            className="model-download-banner-link"
            onClick={onSkip}
            data-testid="model-download-banner-skip"
          >
            Skip — work without AI
          </button>
        )}
        <button
          type="button"
          className="model-download-banner-close"
          aria-label="Dismiss"
          onClick={() => setDismissed(true)}
        >
          <X size={14} aria-hidden="true" />
        </button>
      </span>
      <style nonce={cspNonce}>{`
        .model-download-banner {
          display: flex;
          align-items: center;
          gap: var(--spacing-sm);
          padding: var(--spacing-sm) var(--spacing-md);
          border-bottom: 1px solid var(--color-border, #d9d9d9);
          background: var(--color-bg-subtle, #f5f3ff);
          color: var(--color-text-secondary);
          font-size: var(--font-size-sm);
        }
        .model-download-banner-failed {
          background: var(--color-danger-subtle, #fef2f2);
        }
        .model-download-banner-ready {
          background: var(--color-success-subtle, #f0fdf4);
        }
        .model-download-banner-text {
          flex: 1 1 auto;
        }
        .model-download-banner-actions {
          display: flex;
          align-items: center;
          gap: var(--spacing-sm);
        }
        .model-download-banner-icon {
          display: inline-flex;
          color: var(--color-primary, #7c3aed);
        }
        .model-download-banner-btn {
          background: none;
          border: 1px solid var(--color-border, #d9d9d9);
          border-radius: var(--radius-sm, 4px);
          padding: 2px 10px;
          cursor: pointer;
          color: inherit;
          font-size: var(--font-size-sm);
        }
        .model-download-banner-link {
          background: none;
          border: none;
          padding: 2px 4px;
          cursor: pointer;
          color: inherit;
          font-size: var(--font-size-sm);
          text-decoration: underline;
          opacity: 0.85;
        }
        .model-download-banner-link:hover {
          opacity: 1;
        }
        .model-download-banner-close {
          background: none;
          border: none;
          cursor: pointer;
          color: inherit;
          display: inline-flex;
          padding: 2px;
        }
        .model-download-banner-spin {
          animation: model-download-banner-spin 1s linear infinite;
        }
        @keyframes model-download-banner-spin {
          from { transform: rotate(0deg); }
          to { transform: rotate(360deg); }
        }
      `}</style>
    </div>
  );
}
