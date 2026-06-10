import { type ReactNode } from "react";
import { useCspNonce } from "../utils/cspNonce";
import { useBridgeReady } from "../hooks/useBridgeReady";

/**
 * LW-8 (cold-start budget): gate the real app shell behind the native
 * bridge's readiness.
 *
 * The boot sequence now creates the window BEFORE `initAppState()` runs
 * (see `electron/main.ts`), so the renderer mounts while the SQLCipher
 * store is still opening. This gate paints a lightweight "Loading
 * workspace…" skeleton — which issues no bridge-backed IPC — until the
 * main process signals the bridge is up, then hands off to `children`
 * (the full `<App/>`). On a bridge-init failure it shows a terminal
 * error state instead of leaving the user staring at a spinner forever.
 *
 * Why gate here (above `<App/>`) rather than inside each page: every
 * page hook (`useSources`, `useSettings`, …) issues bridge IPC on mount.
 * Mounting them against a not-yet-open store would surface a flash of
 * per-page error toasts on every cold start. Gating once at the root
 * keeps that complexity out of the pages — they can keep assuming the
 * bridge is up by the time they mount.
 */
export default function BridgeGate({ children }: { children: ReactNode }) {
  const { state, error } = useBridgeReady();

  if (state === "ready") return <>{children}</>;

  return state === "error" ? (
    <BridgeFailed error={error} />
  ) : (
    <WorkspaceSkeleton />
  );
}

/**
 * The cold-start skeleton. Deliberately dependency-free (no IPC, no
 * data hooks) so it can paint on the very first frame — it is what the
 * cold-start gate measures to `window-show`. Mirrors the eventual app
 * chrome (sidebar rail + content area) so the hydration into the real
 * shell is not a jarring layout jump.
 */
function WorkspaceSkeleton() {
  const cspNonce = useCspNonce();
  return (
    <div className="bridge-skeleton" role="status" aria-live="polite">
      <div className="bridge-skeleton-rail" aria-hidden="true">
        <div className="bridge-skeleton-logo" />
        <div className="bridge-skeleton-navlist">
          <span className="bridge-skeleton-navitem" />
          <span className="bridge-skeleton-navitem" />
          <span className="bridge-skeleton-navitem" />
          <span className="bridge-skeleton-navitem" />
        </div>
      </div>
      <div className="bridge-skeleton-main">
        <div className="bridge-skeleton-spinner" aria-hidden="true" />
        <p className="bridge-skeleton-label">Loading workspace…</p>
      </div>
      <style nonce={cspNonce}>{`
        .bridge-skeleton {
          display: flex;
          height: 100vh;
          width: 100vw;
          background: var(--color-bg, #0f0f10);
        }
        .bridge-skeleton-rail {
          width: 72px;
          flex-shrink: 0;
          display: flex;
          flex-direction: column;
          align-items: center;
          gap: var(--spacing-lg, 20px);
          padding: var(--spacing-lg, 20px) 0;
          background: var(--color-bg-elevated, #18181b);
          border-right: 1px solid var(--color-border, #27272a);
        }
        .bridge-skeleton-logo {
          width: 32px;
          height: 32px;
          border-radius: 8px;
          background: var(--color-bg-subtle, #27272a);
        }
        .bridge-skeleton-navlist {
          display: flex;
          flex-direction: column;
          gap: var(--spacing-md, 12px);
          width: 100%;
          align-items: center;
        }
        .bridge-skeleton-navitem {
          width: 40px;
          height: 40px;
          border-radius: 10px;
          background: var(--color-bg-subtle, #27272a);
          opacity: 0.6;
        }
        .bridge-skeleton-main {
          flex: 1;
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          gap: var(--spacing-md, 12px);
        }
        .bridge-skeleton-spinner {
          width: 28px;
          height: 28px;
          border-radius: 50%;
          border: 3px solid var(--color-bg-subtle, #27272a);
          border-top-color: var(--color-primary, #6366f1);
          animation: bridge-skeleton-spin 0.8s linear infinite;
        }
        .bridge-skeleton-label {
          color: var(--color-text-secondary, #a1a1aa);
          font-size: var(--font-size-sm, 0.875rem);
        }
        @keyframes bridge-skeleton-spin {
          to { transform: rotate(360deg); }
        }
        @media (prefers-reduced-motion: reduce) {
          .bridge-skeleton-spinner { animation: none; }
        }
      `}</style>
    </div>
  );
}

/**
 * Terminal state shown when bridge init threw. The store could not be
 * opened, so there is no recovery the renderer can drive on its own —
 * we surface the reason and point the user at a relaunch. Kept minimal
 * and IPC-free for the same reason as the skeleton.
 */
function BridgeFailed({ error }: { error: string | null }) {
  const cspNonce = useCspNonce();
  return (
    <div className="bridge-failed" role="alert">
      <h1 className="bridge-failed-title">Couldn’t open your workspace</h1>
      <p className="bridge-failed-message">
        Tessera could not initialise its local store. Your data is safe on
        disk — please relaunch the app. If this keeps happening, check that
        another copy of Tessera isn’t already running.
      </p>
      {error && <pre className="bridge-failed-detail">{error}</pre>}
      <style nonce={cspNonce}>{`
        .bridge-failed {
          display: flex;
          flex-direction: column;
          align-items: center;
          justify-content: center;
          height: 100vh;
          width: 100vw;
          gap: var(--spacing-md, 12px);
          padding: var(--spacing-2xl, 48px);
          text-align: center;
          background: var(--color-bg, #0f0f10);
        }
        .bridge-failed-title {
          color: var(--color-text-headline, #fafafa);
        }
        .bridge-failed-message {
          color: var(--color-text-secondary, #a1a1aa);
          font-size: var(--font-size-sm, 0.875rem);
          max-width: 460px;
        }
        .bridge-failed-detail {
          max-width: 460px;
          max-height: 160px;
          overflow: auto;
          padding: var(--spacing-sm, 8px);
          border-radius: 6px;
          background: var(--color-bg-elevated, #18181b);
          color: var(--color-text-tertiary, #71717a);
          font-size: var(--font-size-xs, 0.75rem);
          white-space: pre-wrap;
          word-break: break-word;
        }
      `}</style>
    </div>
  );
}
