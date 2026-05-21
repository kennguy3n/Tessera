import { Component, type ErrorInfo, type ReactNode } from "react";

interface Props {
  children: ReactNode;
  /**
   * Optional override for the fallback UI. When omitted we render
   * the default Tessera error screen with Reload / Report controls.
   */
  fallback?: (error: Error, reset: () => void) => ReactNode;
}

interface State {
  error: Error | null;
}

/**
 * Top-level React error boundary (Task 24).
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
    // The Electron main process owns the disk-backed log file; the
    // renderer just logs to its own console for now. Including the
    // component stack here is essential for diagnosing crashes from
    // user bug reports.
    // eslint-disable-next-line no-console
    console.error("Tessera renderer error:", error, info.componentStack);
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
          Tessera ran into an unexpected error. Your last saved
          artifact has not been lost — Tessera autosaves and keeps
          a local crash log.
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
