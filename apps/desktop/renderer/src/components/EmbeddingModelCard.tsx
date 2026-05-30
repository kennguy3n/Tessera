import { useCallback, useEffect, useId, useRef, useState } from "react";
import Card from "./Card";
import Button from "./Button";
import type {
  EmbeddingDownloadProgressInfo,
  EmbeddingModelInfo,
  EmbeddingModelStatusInfo,
} from "../types/ipc";

/**
 * Phase 19 Task 1: settings card that lets the user pick the
 * embedding provider used for semantic search.
 *
 * Three tiers, rendered as radio buttons:
 *
 *   1. **Fast (HashTrick — offline, no download)** — the bundled
 *      lexical-ish embedder. Zero download, zero model file, near
 *      instantaneous. Always available.
 *   2. **Semantic — English (MiniLM, ~22 MB)** — Xenova's
 *      quantised ONNX export of `all-MiniLM-L6-v2`. Best recall
 *      for English content.
 *   3. **Semantic — Multilingual (XLM-R, ~120 MB)** — Xenova's
 *      quantised ONNX export of
 *      `paraphrase-multilingual-MiniLM-L12-v2`. Covers 50+
 *      languages; recommended default when non-English content
 *      is detected.
 *
 * Behaviour:
 *
 *   * The card polls `settings:getEmbeddingModelStatus` on a 1 s
 *     timer so it stays in sync with downloads / switches
 *     triggered from elsewhere.
 *   * Selecting a not-yet-downloaded ONNX model first triggers a
 *     download, then a switch — both routed through the same
 *     IPC channels.
 *   * During a download, a progress bar reads from
 *     `settings:getEmbeddingDownloadProgress` (polled at 500 ms).
 *   * When the bridge reports that more than 10 % of indexed
 *     chunks contain non-ASCII text AND the corpus has more
 *     than 50 chunks, a hint banner suggests switching to the
 *     multilingual model.
 *
 * The card never blocks the UI: every IPC is async and the
 * polling timers continue running while a mutation is in flight.
 * If a mutation fails (e.g. checksum mismatch on download), the
 * error message lands in `mutationError` until the user changes
 * selection or 10 s elapses, whichever comes first.
 */

interface SelectableModel {
  /** Canonical slug used by IPC; `"hash-trick"` for the bundled provider. */
  slug: string;
  /** Display label in the picker. */
  label: string;
  /** One-line description shown under the label. */
  description: string;
  /** Approximate download size in bytes (0 for HashTrick). */
  sizeBytes: number;
  /** Whether this option requires a download / file install. */
  needsDownload: boolean;
}

/**
 * Display-ordered list of selectable embedders. The two ONNX
 * entries are intentionally hard-coded here (instead of being
 * fanned out from `status.models`) so the picker renders the
 * full three-way choice on first render — before the bridge
 * has had a chance to reply with the catalogue. Once the
 * catalogue lands, the per-row "Installed (~X MB)" badge picks
 * up the real size + install state from `status.models`.
 *
 * The slugs MUST match the schema enum in
 * `electron/ipc/schemas.ts` AND the SHIPPED_MODELS in
 * `crates/tessera_sources/src/model_registry.rs` AND the
 * HASH_TRICK_SLUG constant in `crates/tessera_bridge/src/sources.rs`.
 * A drift between any of these surfaces produces a "rejected at
 * the IPC boundary" error and fails closed.
 */
const SELECTABLE_MODELS: SelectableModel[] = [
  {
    slug: "hash-trick",
    label: "Fast (HashTrick — offline, no download)",
    description:
      "Bundled lexical embedder. Zero download. Best for offline-first / privacy-sensitive setups; weakest recall on paraphrased queries.",
    sizeBytes: 0,
    needsDownload: false,
  },
  {
    slug: "all-MiniLM-L6-v2",
    label: "Semantic — English (MiniLM, ~22 MB)",
    description:
      "Quantised all-MiniLM-L6-v2. Strong English recall. Smallest semantic option. Outputs 384-dim vectors compatible with the existing ANN index.",
    sizeBytes: 22 * 1024 * 1024,
    needsDownload: true,
  },
  {
    slug: "paraphrase-multilingual-MiniLM-L12-v2",
    label: "Semantic — Multilingual (XLM-R, ~120 MB)",
    description:
      "Quantised paraphrase-multilingual-MiniLM-L12-v2. 50+ languages including CJK, Arabic, Devanagari, Hangul. Recommended when your corpus is not pure English.",
    sizeBytes: 120 * 1024 * 1024,
    needsDownload: true,
  },
];

/**
 * Threshold above which the auto-detect banner appears. Spec
 * value (>10%). Combined with a minimum chunk-count gate
 * (`MIN_CHUNKS_FOR_HINT`) so a brand-new install with a single
 * smart-quote-in-an-essay chunk doesn't trigger the hint.
 */
const NON_ASCII_HINT_RATIO = 0.1;
const MIN_CHUNKS_FOR_HINT = 50;

const STATUS_POLL_MS = 1_000;
const DOWNLOAD_POLL_MS = 500;
/** How long a transient mutation error sticks before auto-clearing. */
const MUTATION_ERROR_TTL_MS = 10_000;

function formatBytes(bytes: number): string {
  if (bytes <= 0) return "0 B";
  const KB = 1024;
  const MB = KB * 1024;
  if (bytes < MB) {
    return `${(bytes / KB).toFixed(0)} KB`;
  }
  return `${(bytes / MB).toFixed(1)} MB`;
}

function modelInfoFor(
  slug: string,
  status: EmbeddingModelStatusInfo | null,
): EmbeddingModelInfo | undefined {
  return status?.models.find((m) => m.slug === slug);
}

/**
 * Decide which slug is currently active. The bridge's
 * `currentModelId` is the canonical truth — but `model_id` is a
 * formatted string ("onnx:all-MiniLM-L6-v2:384d", or
 * "hash-trick-v1-256d-char3-5"), not a slug. Translate by
 * substring-match against the slugs in the catalogue + the
 * HashTrick sentinel.
 *
 * Returns the matching slug, or `null` if the catalogue hasn't
 * loaded yet / the bridge hasn't attached an embedder.
 */
function activeSlugFromStatus(
  status: EmbeddingModelStatusInfo | null,
): string | null {
  if (!status?.currentModelId) return null;
  const id = status.currentModelId;
  // ONNX model ids embed the slug verbatim — see
  // `OnnxEmbeddingProvider::model_id` in onnx_embedder.rs.
  for (const m of SELECTABLE_MODELS) {
    if (m.slug !== "hash-trick" && id.includes(m.slug)) {
      return m.slug;
    }
  }
  // The HashTrick provider's id starts with "hash-trick-v" — see
  // `HashTrickEmbedding::model_id` in embedding.rs.
  if (id.startsWith("hash-trick")) {
    return "hash-trick";
  }
  return null;
}

interface ProgressBarProps {
  download: EmbeddingDownloadProgressInfo;
}

function ProgressBar({ download }: ProgressBarProps) {
  if (download.status !== "downloading") return null;
  const pct =
    download.bytesTotal && download.bytesTotal > 0
      ? Math.min(100, (download.bytesDownloaded / download.bytesTotal) * 100)
      : null;
  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={pct ?? undefined}
      aria-label="Downloading embedding model"
      data-testid="embedding-download-progress"
      style={{
        marginTop: "var(--spacing-sm)",
        padding: "var(--spacing-sm)",
        backgroundColor: "var(--color-bg-secondary)",
        borderRadius: "var(--radius-sm)",
      }}
    >
      <div
        style={{
          display: "flex",
          justifyContent: "space-between",
          fontSize: "var(--font-size-xs)",
          color: "var(--color-text-secondary)",
          marginBottom: "var(--spacing-xs)",
        }}
      >
        <span>Downloading {download.slug ?? "model"}…</span>
        <span>
          {formatBytes(download.bytesDownloaded)}
          {download.bytesTotal != null
            ? ` / ${formatBytes(download.bytesTotal)}`
            : ""}
        </span>
      </div>
      <div
        style={{
          height: 6,
          backgroundColor: "var(--color-border)",
          borderRadius: 3,
          overflow: "hidden",
        }}
      >
        <div
          style={{
            width: pct != null ? `${pct}%` : "20%",
            height: "100%",
            backgroundColor: "var(--color-primary)",
            transition: "width 200ms linear",
          }}
        />
      </div>
    </div>
  );
}

export default function EmbeddingModelCard() {
  const [status, setStatus] = useState<EmbeddingModelStatusInfo | null>(null);
  const [download, setDownload] =
    useState<EmbeddingDownloadProgressInfo | null>(null);
  const [pendingSlug, setPendingSlug] = useState<string | null>(null);
  const [mutationError, setMutationError] = useState<string | null>(null);
  // Held as a ref so the unmount cleanup can clear it even after
  // the React state setter has gone out of scope.
  const errorTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const refreshStatus = useCallback(async () => {
    try {
      const s = await window.tessera.settings.getEmbeddingModelStatus();
      setStatus(s);
    } catch (err) {
      // Polling errors are expected during the brief bridge-init
      // window. Don't surface them.
      console.debug("getEmbeddingModelStatus failed:", err);
    }
  }, []);

  const refreshDownload = useCallback(async () => {
    try {
      const d = await window.tessera.settings.getEmbeddingDownloadProgress();
      setDownload(d);
    } catch (err) {
      console.debug("getEmbeddingDownloadProgress failed:", err);
    }
  }, []);

  useEffect(() => {
    void refreshStatus();
    void refreshDownload();
    const sId = setInterval(() => void refreshStatus(), STATUS_POLL_MS);
    const dId = setInterval(() => void refreshDownload(), DOWNLOAD_POLL_MS);
    return () => {
      clearInterval(sId);
      clearInterval(dId);
      if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    };
  }, [refreshStatus, refreshDownload]);

  const flashError = useCallback((msg: string) => {
    setMutationError(msg);
    if (errorTimerRef.current) clearTimeout(errorTimerRef.current);
    errorTimerRef.current = setTimeout(
      () => setMutationError(null),
      MUTATION_ERROR_TTL_MS,
    );
  }, []);

  const handleSelect = useCallback(
    async (slug: string) => {
      if (pendingSlug) return; // single-flight: one mutation at a time
      setPendingSlug(slug);
      setMutationError(null);
      try {
        const target = SELECTABLE_MODELS.find((m) => m.slug === slug);
        if (!target) {
          flashError(`Unknown model: ${slug}`);
          return;
        }
        // For ONNX models that aren't installed yet, download first.
        // The download IPC is idempotent on an already-installed
        // model, but skipping it when we KNOW the file is present
        // (per `status.models[].installed`) avoids the round trip
        // entirely.
        if (target.needsDownload) {
          const info = modelInfoFor(slug, status);
          if (!info?.installed) {
            await window.tessera.settings.downloadEmbeddingModel(slug);
            // Refresh status mid-flow so the post-download switch
            // sees `installed: true` on its next status poll.
            await refreshStatus();
          }
        }
        await window.tessera.settings.switchEmbeddingModel(slug);
        await refreshStatus();
      } catch (err) {
        flashError(err instanceof Error ? err.message : String(err));
      } finally {
        setPendingSlug(null);
      }
    },
    [pendingSlug, status, refreshStatus, flashError],
  );

  const groupId = useId();
  const activeSlug = activeSlugFromStatus(status);
  const downloadView = download ?? {
    status: "idle",
    slug: null,
    bytesTotal: null,
    bytesDownloaded: 0,
    lastError: null,
  };

  const showMultilingualHint = (() => {
    if (!status) return false;
    if (status.totalChunks < MIN_CHUNKS_FOR_HINT) return false;
    const ratio = status.nonAsciiChunks / Math.max(1, status.totalChunks);
    if (ratio < NON_ASCII_HINT_RATIO) return false;
    return activeSlug !== "paraphrase-multilingual-MiniLM-L12-v2";
  })();

  return (
    <Card data-testid="embedding-model-card">
      <h3 style={{ marginBottom: "var(--spacing-md)" }}>Embedding model</h3>
      <p
        style={{
          fontSize: "var(--font-size-sm)",
          color: "var(--color-text-secondary)",
          marginBottom: "var(--spacing-md)",
        }}
      >
        Controls which model converts your indexed content into vectors
        for semantic search. Switching models triggers a background
        re-embed pass so existing chunks pick up the new model's
        vectors; the schema (FTS5 + chunk_embeddings) stays the same.
      </p>

      {showMultilingualHint && (
        <div
          role="status"
          data-testid="embedding-multilingual-hint"
          style={{
            marginBottom: "var(--spacing-md)",
            padding: "var(--spacing-sm)",
            backgroundColor: "var(--color-warning-bg)",
            border: "1px solid var(--color-warning)",
            borderRadius: "var(--radius-sm)",
            fontSize: "var(--font-size-sm)",
          }}
        >
          <strong>Multilingual content detected.</strong>{" "}
          {status?.nonAsciiChunks.toLocaleString()} of{" "}
          {status?.totalChunks.toLocaleString()} indexed chunks contain
          non-ASCII characters (CJK, Cyrillic, Arabic, etc.&mdash; or
          rich English typography like smart quotes and em-dashes).
          If most of these are non-English content, consider switching
          to the Multilingual (XLM-R) model for better recall on
          non-English queries.
        </div>
      )}

      <div
        role="radiogroup"
        aria-labelledby={`${groupId}-label`}
        style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-sm)" }}
      >
        <span id={`${groupId}-label`} className="visually-hidden">
          Choose embedding provider
        </span>
        {SELECTABLE_MODELS.map((m) => {
          const info = modelInfoFor(m.slug, status);
          const isActive = activeSlug === m.slug;
          const isInstalled = m.needsDownload ? (info?.installed ?? false) : true;
          const isPending = pendingSlug === m.slug;
          const inputId = `${groupId}-${m.slug}`;
          const realSize = info ? info.modelSizeBytes : m.sizeBytes;
          return (
            <label
              key={m.slug}
              htmlFor={inputId}
              data-testid={`embedding-model-option-${m.slug}`}
              style={{
                display: "flex",
                alignItems: "flex-start",
                gap: "var(--spacing-sm)",
                padding: "var(--spacing-sm)",
                border: isActive
                  ? "2px solid var(--color-primary)"
                  : "1px solid var(--color-border)",
                borderRadius: "var(--radius-sm)",
                cursor: pendingSlug ? "wait" : "pointer",
                opacity: pendingSlug && !isPending ? 0.6 : 1,
              }}
            >
              <input
                id={inputId}
                type="radio"
                name={groupId}
                value={m.slug}
                checked={isActive}
                disabled={!!pendingSlug}
                onChange={() => void handleSelect(m.slug)}
                style={{ marginTop: 4 }}
              />
              <div style={{ flex: 1 }}>
                <div
                  style={{
                    display: "flex",
                    justifyContent: "space-between",
                    alignItems: "center",
                    gap: "var(--spacing-sm)",
                  }}
                >
                  <span style={{ fontWeight: 600 }}>{m.label}</span>
                  <span
                    style={{
                      fontSize: "var(--font-size-xs)",
                      color: "var(--color-text-secondary)",
                    }}
                  >
                    {m.needsDownload
                      ? isInstalled
                        ? `Installed (${formatBytes(realSize)})`
                        : `${formatBytes(m.sizeBytes)} download`
                      : "Built-in"}
                  </span>
                </div>
                <div
                  style={{
                    fontSize: "var(--font-size-sm)",
                    color: "var(--color-text-secondary)",
                    marginTop: "var(--spacing-xs)",
                  }}
                >
                  {m.description}
                </div>
                {isPending && (
                  <div
                    style={{
                      marginTop: "var(--spacing-xs)",
                      fontSize: "var(--font-size-xs)",
                      color: "var(--color-text-secondary)",
                    }}
                  >
                    {m.needsDownload && !isInstalled
                      ? "Downloading…"
                      : "Switching…"}
                  </div>
                )}
              </div>
            </label>
          );
        })}
      </div>

      <ProgressBar download={downloadView} />

      {downloadView.status === "failed" && downloadView.lastError && (
        <div
          role="alert"
          data-testid="embedding-download-error"
          style={{
            marginTop: "var(--spacing-sm)",
            color: "var(--color-error)",
            fontSize: "var(--font-size-sm)",
          }}
        >
          Download failed: {downloadView.lastError}
        </div>
      )}

      {mutationError && (
        <div
          role="alert"
          data-testid="embedding-mutation-error"
          style={{
            marginTop: "var(--spacing-sm)",
            color: "var(--color-error)",
            fontSize: "var(--font-size-sm)",
          }}
        >
          {mutationError}
        </div>
      )}

      <div style={{ marginTop: "var(--spacing-md)" }}>
        <Button
          variant="secondary"
          onClick={() => void refreshStatus()}
          disabled={!!pendingSlug}
          data-testid="embedding-model-refresh"
        >
          Refresh
        </Button>
      </div>
    </Card>
  );
}
