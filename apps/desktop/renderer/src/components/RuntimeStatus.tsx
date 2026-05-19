import { useState, useEffect, useCallback } from "react";
import { Link } from "react-router-dom";
import type {
  InstalledModelRecord,
  ModelStatus,
  PlatformInfo,
} from "../types/ipc";

interface RuntimeStatusProps {
  compact?: boolean;
}

interface Snapshot {
  status: ModelStatus;
  current: InstalledModelRecord | null;
  platform: PlatformInfo | null;
}

const INITIAL_SNAPSHOT: Snapshot = {
  status: { available: false, modelName: null, status: "stopped" },
  current: null,
  platform: null,
};

function formatLabel(format: string | null): string {
  if (format === "mlx") return "MLX";
  if (format === "gguf") return "GGUF";
  return "";
}

function backendLabel(platform: PlatformInfo | null): string {
  if (!platform) return "";
  const gpus = platform.computeBackends.filter((b) => b !== "cpu");
  if (platform.preferredFormat === "mlx") return "Metal";
  if (gpus.includes("cuda")) return "CUDA";
  if (gpus.includes("rocm")) return "ROCm";
  if (gpus.includes("vulkan")) return "Vulkan";
  return "CPU (AVX2)";
}

export default function RuntimeStatus({ compact = true }: RuntimeStatusProps) {
  const [snap, setSnap] = useState<Snapshot>(INITIAL_SNAPSHOT);
  const [expanded, setExpanded] = useState(false);

  const poll = useCallback(async () => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api) return;
    try {
      const [status, current, platform] = await Promise.all([
        api.model.status(),
        api.runtime ? api.runtime.getCurrentModel() : Promise.resolve(null),
        api.runtime ? api.runtime.detectPlatform() : Promise.resolve(null),
      ]);
      setSnap({ status, current, platform });
    } catch {
      setSnap((prev) => ({
        ...prev,
        status: { available: false, modelName: null, status: "error" },
      }));
    }
  }, []);

  useEffect(() => {
    poll();
    const interval = setInterval(poll, 5000);
    return () => clearInterval(interval);
  }, [poll]);

  const { status, current, platform } = snap;
  const statusColor = getStatusColor(status.status);

  // Compute a display label. Prefer the actual installed model + format; fall
  // back to the legacy `modelName` from `model:status` (which the sidecar
  // hard-codes for now), then to a "No model" state.
  let compactLabel = "No model";
  if (current) {
    const fmt = formatLabel(current.format);
    compactLabel = fmt
      ? `${shortModelName(current.modelId)} (${fmt})`
      : shortModelName(current.modelId);
  } else if (status.modelName) {
    compactLabel = status.modelName;
  }

  if (compact && !expanded) {
    return (
      <button
        type="button"
        className="runtime-status-compact"
        onClick={() => setExpanded(true)}
        title={`Model: ${compactLabel} \u2014 ${status.status}`}
      >
        <span
          className="runtime-status-dot"
          style={{ backgroundColor: statusColor }}
        />
        <span className="runtime-status-label">{compactLabel}</span>
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
          <span className="runtime-detail-value">
            {current ? shortModelName(current.modelId) : status.modelName ?? "\u2014"}
          </span>
        </div>
        <div className="runtime-detail-row">
          <span className="runtime-detail-label">Format</span>
          <span className="runtime-detail-value">
            {current ? formatLabel(current.format) || "\u2014" : "\u2014"}
          </span>
        </div>
        <div className="runtime-detail-row">
          <span className="runtime-detail-label">Backend</span>
          <span className="runtime-detail-value">
            {backendLabel(platform) || "\u2014"}
          </span>
        </div>
        {!current && (
          <div className="runtime-detail-row" style={{ marginTop: "var(--spacing-sm)" }}>
            <Link to="/settings">{"No model downloaded \u2014 open Settings"}</Link>
          </div>
        )}
      </div>
    </div>
  );
}

function shortModelName(modelId: string): string {
  return modelId.replace(/^ternary-bonsai-/, "Bonsai-").replace(/-(gguf|mlx)$/, "");
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
