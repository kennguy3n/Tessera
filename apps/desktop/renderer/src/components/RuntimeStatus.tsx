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

  // Platform info (RAM, CPU/GPU backends, preferred format) is derived
  // from hardware and does not change at runtime. The first
  // `detectPlatform()` call blocks the main process for ~3-9 seconds while
  // it inspects `nvidia-smi` / `vulkaninfo` / `/opt/rocm`, so we MUST NOT
  // include it in the 5-second poll — doing so used to pin a worker
  // thread for the lifetime of the page. We fetch it exactly once on
  // mount and then poll only the cheap `status` + `getCurrentModel`
  // values.
  // POLLING DESIGN : we deliberately
  // poll `getCurrentModel` (one fsp.readFile of <1 KB JSON, cached in
  // the OS page cache between polls) rather than wiring an event-driven
  // `runtime:modelChanged` broadcast. The per-call cost is sub-ms on
  // SSD, the model-installed state changes at most a handful of times
  // per session, and the alternative would mean defining a new IPC
  // event payload, threading emits through `downloadModel` /
  // `deleteCurrentModel` / `downloadModelLocked`, and replacing the
  // renderer's polling state machine with a subscribe/cleanup pattern.
  // If `active-model.json` reads ever become hot (multiple windows,
  // sub-second polling), revisit by adding the event channel.
  const pollStatus = useCallback(async () => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api) return;
    try {
      // Scope `getCurrentModel` to the text slot explicitly. The
      // sidebar's runtime pill ONLY represents the text sidecar — it
      // reads from `model.status()` which returns text-sidecar state,
      // and the displayed model name / format pertain to the text
      // slot. The IPC overload without an argument currently defaults
      // to `"text"` for backward-compat (see
      // `apps/desktop/shared/types.ts:1045-1061`), so behaviour is
      // unchanged today — but threading `"text"` here matches the
      // same scoping discipline `ModelRuntimeCard` ships in this
      // PR (every IPC call from the text-slot UI carries the
      // explicit capability) and removes the silent-break gap if the
      // server-side default ever changes. Devin Review pass-N
      // flagged the asymmetry between this call site and the rest
      // of the text-slot UI.
      const [status, current] = await Promise.all([
        api.model.status(),
        api.runtime
          ? api.runtime.getCurrentModel("text")
          : Promise.resolve(null),
      ]);
      setSnap((prev) => ({ ...prev, status, current }));
    } catch {
      setSnap((prev) => ({
        ...prev,
        status: { available: false, modelName: null, status: "error" },
      }));
    }
  }, []);

  useEffect(() => {
    let cancelled = false;
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (api?.runtime) {
      api.runtime
        .detectPlatform()
        .then((platform) => {
          if (!cancelled) setSnap((prev) => ({ ...prev, platform }));
        })
        .catch(() => {
          // Platform detection is informational — a failure shouldn't
          // break the status pill, so leave `platform` null and let the
          // status poll surface any runtime error.
        });
    }
    pollStatus();
    const interval = setInterval(pollStatus, 5000);
    return () => {
      cancelled = true;
      clearInterval(interval);
    };
  }, [pollStatus]);

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
