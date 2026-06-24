import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /**
   * Name of the subtree this boundary guards (e.g. "HomePage",
   * "DocumentEditor"). Included verbatim in the crash report so a
   * `crash-report.json` entry points at the exact page/editor that
   * threw. Defaults to "renderer" for the top-level boundary.
   */
  name?: string;
  /**
   * Values that, when any of them changes, clear a caught error so the
   * boundary re-renders its children. Use this to auto-recover on a
   * context change the crashed subtree depends on — e.g. the route
   * pathname or the edited artifact's id — so the user isn't left
   * staring at a stale crash screen for resource A after navigating to
   * resource B. Compared element-wise with `Object.is`.
   */
  resetKeys?: readonly unknown[];
  /**
   * Optional override for the fallback UI. When omitted we render
   * the default Tessera error screen with Reload / Report controls.
   */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

function resetKeysChanged(
  prev: readonly unknown[] = [],
  next: readonly unknown[] = [],
): boolean {
  return (
    prev.length !== next.length ||
    prev.some((value, i) => !Object.is(value, next[i]))
  );
}

/**
 * Top-level React error boundary.
 *
 * Catches render-time errors in any descendant component and shows
 * a friendly screen with:
 *   - the error message
 *   - a "Reload" button that re-mounts the app (`window.location.reload`)
 *   - a "Report" button that opens the GitHub issues URL with the
 *     error message pre-filled so users can file a bug quickly
 *
 * Crash recovery (persisting unsaved artifact state) is handled in
 * the renderer's per-artifact draft layer, not here — the error
 * boundary's job is to keep the app shell responsive after a crash.
 */
export default class ErrorBoundary extends Component<Props, State> {
  state: State = { error: null };

  static getDerivedStateFromError(error: Error): State {
    return { error };
  }

  componentDidCatch(error: Error, info: ErrorInfo): void {
    const component = this.props.name ?? "renderer";
    // Including the component stack is essential for diagnosing crashes
    // from user bug reports.
    console.error(
      `Tessera renderer error [${component}]:`,
      error,
      info.componentStack,
    );

    // Forward to the main process, which owns the disk-backed log
    // directory and persists `crash-report.json` (the renderer is the
    // untrusted web context and cannot write files itself). Best-effort:
    // the `tessera` bridge is absent in unit tests and a rejected
    // promise here would be noise while the fallback UI is already up.
    try {
      // `reportCrash` returns a promise (or `undefined` when the bridge
      // is absent). Route it through `Promise.resolve(...).catch` so an
      // async rejection — should a future handler ever reject — is
      // swallowed rather than surfacing as an unhandled rejection. The
      // synchronous `try/catch` only covers a throw while *invoking* the
      // call (e.g. the bridge getter throwing), not the returned promise.
      void Promise.resolve(
        window.tessera?.diagnostics?.reportCrash({
          component,
          error: error.message,
          // Prefer the JS stack; fall back to React's component stack so
          // the report is never empty.
          stack: error.stack ?? info.componentStack ?? "",
          timestamp: new Date().toISOString(),
        }),
      ).catch(() => {
        // Swallow — reporting a crash must never cause another crash.
      });
    } catch {
      // Swallow — reporting a crash must never cause another crash.
    }
  }

  componentDidUpdate(prevProps: Props): void {
    // Auto-recover once the boundary is guarding a different context
    // (e.g. a new route or artifact id). Without this, a static-keyed
    // boundary keeps showing the crash UI from the previous resource
    // after the user navigates to a new one.
    if (
      this.state.error !== null &&
      resetKeysChanged(prevProps.resetKeys, this.props.resetKeys)
    ) {
      this.reset();
    }
  }

  reset = (): void => {
    this.setState({ error: null });
  };

  render(): ReactNode {
    const { error } = this.state;
    if (!error) return this.props.children;

    if (this.props.fallback) {
      return this.props.fallback(error, this.reset);
    }

    const reportUrl = `https://github.com/kennguy3n/Tessera/issues/new?title=${encodeURIComponent(
      `Renderer crash: ${error.message}`,
    )}&body=${encodeURIComponent(
      `**Error**\n\n\`\`\`\n${error.stack ?? error.message}\n\`\`\``,
    )}`;

    return (
      <div
        role="alert"
        style={{
          padding: "var(--spacing-xl)",
          maxWidth: "640px",
          margin: "10vh auto",
          background: "var(--color-bg-surface)",
          borderRadius: "var(--radius-card)",
          boxShadow: "var(--shadow-card)",
        }}
      >
        <h1
          style={{
            color: "var(--color-text-headline)",
            marginBottom: "var(--spacing-md)",
          }}
        >
          Something went wrong.
        </h1>
        <p
          style={{
            color: "var(--color-text-body)",
            marginBottom: "var(--spacing-md)",
          }}
        >
          Tessera ran into an unexpected error. Your last saved artifact has not
          been lost — Tessera autosaves and keeps a local crash log.
        </p>
        <pre
          style={{
            background: "var(--color-bg-secondary)",
            padding: "var(--spacing-sm)",
            borderRadius: "var(--radius-input)",
            fontSize: "var(--font-size-xs)",
            color: "var(--color-text-secondary)",
            overflow: "auto",
            maxHeight: "12rem",
          }}
        >
          {error.message}
          {"\n"}
          {error.stack ?? ""}
        </pre>
        <div
          style={{
            display: "flex",
            gap: "var(--spacing-sm)",
            marginTop: "var(--spacing-md)",
          }}
        >
          <button
            type="button"
            className="btn btn-primary"
            onClick={() => window.location.reload()}
          >
            Reload
          </button>
          <a
            href={reportUrl}
            target="_blank"
            rel="noopener noreferrer"
            className="btn btn-secondary"
          >
            Report
          </a>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={this.reset}
          >
            Dismiss
          </button>
        </div>
      </div>
    );
  }
}
