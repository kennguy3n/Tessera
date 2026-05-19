import { useState, useEffect, useCallback } from "react";
import type { ModelStatus } from "../types/ipc";

interface RuntimeStatusProps {
  compact?: boolean;
}

export default function RuntimeStatus({ compact = true }: RuntimeStatusProps) {
  const [status, setStatus] = useState<ModelStatus>({
    available: false,
    modelName: null,
    status: "stopped",
  });
  const [expanded, setExpanded] = useState(false);

  const pollStatus = useCallback(async () => {
    try {
      const api = window.tessera;
      if (!api) return;
      const result = await api.model.status();
      setStatus(result);
    } catch {
      setStatus({ available: false, modelName: null, status: "error" });
    }
  }, []);

  useEffect(() => {
    pollStatus();
    const interval = setInterval(pollStatus, 5000);
    return () => clearInterval(interval);
  }, [pollStatus]);

  const statusColor = getStatusColor(status.status);

  if (compact && !expanded) {
    return (
      <button
        type="button"
        className="runtime-status-compact"
        onClick={() => setExpanded(true)}
        title={`Model: ${status.modelName || "None"} — ${status.status}`}
      >
        <span
          className="runtime-status-dot"
          style={{ backgroundColor: statusColor }}
        />
        <span className="runtime-status-label">
          {status.modelName || "No model"}
        </span>
      </button>
    );
  }

  return (
    <div className="runtime-status-expanded">
      <div className="runtime-status-header">
        <div style={{ display: "flex", alignItems: "center", gap: "var(--spacing-xs)" }}>
          <span
            className="runtime-status-dot"
            style={{ backgroundColor: statusColor }}
          />
          <span className="runtime-status-title">Model Runtime</span>
        </div>
        {compact && (
          <button
            type="button"
            className="runtime-status-close"
            onClick={() => setExpanded(false)}
          >
            x
          </button>
        )}
      </div>

      <div className="runtime-status-details">
        <div className="runtime-detail-row">
          <span className="runtime-detail-label">Status</span>
          <span className="runtime-detail-value">{status.status}</span>
        </div>
        <div className="runtime-detail-row">
          <span className="runtime-detail-label">Model</span>
          <span className="runtime-detail-value">{status.modelName || "—"}</span>
        </div>
        <div className="runtime-detail-row">
          <span className="runtime-detail-label">Available</span>
          <span className="runtime-detail-value">
            {status.available ? "Yes" : "No"}
          </span>
        </div>
      </div>
    </div>
  );
}

function getStatusColor(status: string): string {
  switch (status) {
    case "running":
      return "var(--color-success, #22c55e)";
    case "loading":
    case "starting":
      return "var(--color-warning, #eab308)";
    case "error":
      return "var(--color-danger, #ef4444)";
    case "stopped":
    default:
      return "var(--color-muted, #6b7280)";
  }
}
