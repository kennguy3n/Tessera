/**
 * Non-blocking model-setup banner (Part 3a/3b).
 *
 * Renders a slim strip at the top of `app-main` that reflects the
 * state of the recommended text-model download. It serves two roles:
 *
 *   1. Auto-setup trigger. On a fresh install (`onboardingCompleted
 *      === false`) with auto-download enabled and no text model on
 *      disk, it kicks off `runtime.downloadModel(recommended)` in the
 *      background — the renderer-side equivalent of "zero-friction
 *      setup". `runtime:downloadModel` already enforces single-model
 *      installs, SHA256 verification, `.partial` cleanup and progress
 *      broadcasts, so the banner only has to start it and observe.
 *
 *   2. Progress surface. It subscribes to `runtime.onDownloadProgress`
 *      (filtered to the text slot) so it ALSO reflects a download
 *      started elsewhere (e.g. the Settings model panel) — not just
 *      the one it triggered.
 *
 * States: downloading (with %) → ready (auto-dismisses after 3s) →
 * or failed (with a Retry button). A Skip control dismisses the
 * banner so the user can work in extraction-only mode immediately.
 *
 * The banner is intentionally additive and never blocks: it renders
 * `null` whenever there is nothing to say (idle, dismissed, or a
 * model is already installed).
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { X, Loader2, CheckCircle2, AlertTriangle } from "lucide-react";
import { useSettings } from "../hooks/useSettings";
import { useCspNonce } from "../utils/cspNonce";

type BannerStatus = "idle" | "downloading" | "ready" | "failed";

const READY_AUTODISMISS_MS = 3000;

export default function ModelDownloadBanner() {
  const cspNonce = useCspNonce();
  const { settings, loading } = useSettings();
  const [status, setStatus] = useState<BannerStatus>("idle");
  const [percent, setPercent] = useState(0);
  const [dismissed, setDismissed] = useState(false);
  // Guards so the auto-start effect fires exactly once per mount even
  // as `settings` re-renders the component on every store update.
  const startedRef = useRef(false);
  // Tracks mount state so the async `start()` promise (which is not
  // cancelable through the IPC bridge) never calls a state setter
  // after the user navigates away and the banner unmounts. Re-set on
  // every mount so React 18 StrictMode's mount→unmount→remount cycle
  // leaves it `true`.
  const mountedRef = useRef(true);
  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
    };
  }, []);

  // Kick off (or re-run on Retry) the recommended-model download.
  // Owns the download promise so it can resolve to ready/failed even
  // when no further progress events arrive (e.g. an instant cache
  // hit or an immediate rejection).
  const start = useCallback(async () => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api?.runtime) return;
    try {
      const recommended = await api.runtime.recommendModel("text");
      if (!mountedRef.current) return;
      if (!recommended) {
        // Nothing to install on this device/tier — stay quiet.
        setStatus("idle");
        return;
      }
      setStatus("downloading");
      setPercent(0);
      await api.runtime.downloadModel(recommended.id);
      if (!mountedRef.current) return;
      setStatus("ready");
      setPercent(100);
    } catch {
      if (!mountedRef.current) return;
      setStatus("failed");
    }
  }, []);

  // Reflect ANY in-flight text-slot download (this banner's own, or
  // one started from the Settings panel) by subscribing to progress.
  useEffect(() => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api?.runtime) return;
    return api.runtime.onDownloadProgress((p) => {
      if (p.capability !== "text") return;
      setPercent(p.percent);
      setStatus((s) => (s === "ready" ? s : "downloading"));
    });
  }, []);

  // Fresh-install auto-download trigger. Waits for the real settings
  // to load (so we don't act on the optimistic `onboardingCompleted:
  // true` placeholder), then checks the three preconditions from the
  // spec: auto-download enabled, onboarding not yet completed, and no
  // text model installed — plus a best-effort online check.
  useEffect(() => {
    if (loading || startedRef.current) return;
    if (!settings.autoDownloadModel) return;
    if (settings.onboardingCompleted) return;
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api?.runtime) return;
    const online =
      typeof navigator === "undefined" || navigator.onLine !== false;
    if (!online) return;
    startedRef.current = true;
    void api.runtime.getCurrentModel("text").then((record) => {
      if (!mountedRef.current) return;
      if (record !== null) return;
      void start();
    });
  }, [loading, settings.autoDownloadModel, settings.onboardingCompleted, start]);

  // Auto-dismiss the success state after a short delay so the banner
  // doesn't linger once the model is ready.
  useEffect(() => {
    if (status !== "ready") return;
    const t = setTimeout(() => setDismissed(true), READY_AUTODISMISS_MS);
    return () => clearTimeout(t);
  }, [status]);

  const onRetry = useCallback(() => {
    setDismissed(false);
    void start();
  }, [start]);

  if (dismissed || status === "idle") return null;

  const rounded = Math.round(percent);

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
          `Setting up AI capabilities… ${rounded}%`}
        {status === "ready" && "AI model ready"}
        {status === "failed" &&
          "AI model download failed. You can keep working from your sources."}
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
        {status === "downloading" && (
          <button
            type="button"
            className="model-download-banner-btn"
            onClick={() => setDismissed(true)}
            data-testid="model-download-banner-skip"
          >
            Skip
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
