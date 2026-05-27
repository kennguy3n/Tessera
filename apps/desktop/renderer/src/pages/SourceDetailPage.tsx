import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import Button from "../components/Button";
import Card from "../components/Card";
import StatusBadge from "../components/StatusBadge";
import { useSourceDetail, useReindexSource } from "../hooks/useSources";
import { useIndexingProgress } from "../hooks/useIndexingProgress";
import { useEmbeddingProgress } from "../hooks/useEmbeddingProgress";
import { useKchatBackfillProgress } from "../hooks/useKchatBackfillProgress";
import type { ExtractedItem, SourceInfo } from "../types/ipc";

/**
 * Extract the KChat channel id from a `SourceType::Kchat` source's
 * `path`. The Node-side `kchatChannelCacheDir(channelId)` always
 * produces `<home>/.tessera/kchat-channels/<channelId>`, so the
 * last path segment is the canonical channel id.
 *
 * Returns `null` for non-KChat sources OR when the basename is
 * empty (defensive guard against a malformed `source.path`). The
 * renderer treats `null` as "don't poll backfill state" — the
 * `useKchatBackfillProgress` hook is quiescent for `null`.
 *
 * Splits on BOTH `/` and `\` so the helper works on Windows where
 * `path.join(...)` in the main process produces backslash-separated
 * paths like `C:\Users\user\.tessera\kchat-channels\<id>` (Devin
 * Review on 869295e, BUG_0001). A POSIX-only split would yield a
 * single segment containing the full Windows path string, which
 * then fails the IPC's `assertKchatId` regex and the renderer would
 * silently never render a progress card on Windows.
 *
 * We intentionally do NOT re-validate the 26-char object-id shape
 * here. The IPC handler at `kchat:backfillProgress` re-validates
 * via `assertKchatId(channelId, "channelId")` so any malformed
 * input rejects at the boundary with a clear error message. The
 * renderer-side strict regex would just produce a silent UI no-op,
 * which is harder to debug than an IPC-level rejection that the
 * polling hook surfaces back as a transport error.
 */
export function extractKchatChannelIdFromSource(
  source: SourceInfo,
): string | null {
  if (source.sourceType !== "kchat") return null;
  const segments = source.path.split(/[\\/]/).filter((s) => s.length > 0);
  const id = segments[segments.length - 1];
  return id && id.length > 0 ? id : null;
}

/**
 * Render a human-readable label for a `SourceInfo.sourceType` so
 * the Source Information card (and any other surface that displays
 * the type) shows something coherent for every known kind.
 *
 * Phase 13 Task 10 fix (Devin Review on 869295e, ANALYSIS_0003): the
 * pre-Task-10 page only rendered local sources, so the card used a
 * binary `local_folder ? "Local Folder" : "Local File"` ternary.
 * Task 10 lit up the page for KChat sources too, which made the
 * fallthrough "Local File" label misleading. The helper centralises
 * the mapping so any future source kind only has to be added in
 * one place. Unknown / future kinds fall through to a humanised
 * version of the raw `sourceType` string so the UI degrades
 * gracefully instead of mis-attributing the kind.
 */
export function formatSourceTypeLabel(sourceType: string): string {
  switch (sourceType) {
    case "local_folder":
      return "Local Folder";
    case "local_file":
      return "Local File";
    case "kchat":
      return "KChat Channel";
    default:
      // Humanise an unknown discriminator (`some_new_kind` →
      // `Some New Kind`) so a future variant looks reasonable
      // in the UI even before we land an explicit case here.
      return sourceType
        .split("_")
        .filter((s) => s.length > 0)
        .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
        .join(" ");
  }
}

export default function SourceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { detail, loading, error, refresh } = useSourceDetail(id);
  const { reindex, loading: reindexing } = useReindexSource();
  const progress = useIndexingProgress(id, reindexing);
  const [extracted, setExtracted] = useState<ExtractedItem[] | null>(null);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);
  const [reembedding, setReembedding] = useState(false);
  const [reembedError, setReembedError] = useState<string | null>(null);
  // Monotonic counter that bumps on each Re-embed click so the
  // polling effect inside `useEmbeddingProgress` re-fires even when
  // the previous pass already reached terminal status. A boolean
  // "active" flag would fail to retrigger on the second click
  // because React batches the inline state updates inside
  // `handleReembed` and the effect dep `[active]` may stay `true`
  // across the click boundary. See `useEmbeddingProgress` for the
  // full rationale.
  const [reembedGeneration, setReembedGeneration] = useState(0);
  // The embedding backfill tracker is workspace-global, so the
  // poller doesn't take a source id. Rate-limiting the
  // `sources:backfillEmbeddings` IPC means a click-mashing user
  // won't trigger multiple overlapping passes; the button is also
  // disabled while `reembedding === true`.
  const embeddingProgress = useEmbeddingProgress(reembedGeneration);
  // Phase 13 Task 10: when this source is a KChat channel,
  // subscribe to the substrate-side backfill watermark. The
  // helper returns `null` for non-KChat sources so the hook stays
  // quiescent — there's no per-page polling cost for the common
  // local_folder / local_file case. Computing the channel id is
  // safe before the `detail` guard below because `detail` is
  // null-checked at the top of the render branch; we still want
  // the hook reference stable across renders so we always call
  // it. When `detail` is null we pass `null` explicitly so the
  // hook drops to its quiescent path.
  const kchatChannelId = detail
    ? extractKchatChannelIdFromSource(detail.source)
    : null;
  const kchatBackfill = useKchatBackfillProgress(kchatChannelId);
  // The "Backfill posts" button is a manual trigger that calls
  // `sources:backfillKchatChannel`. We track the in-flight state
  // separately from `kchatBackfill.status === "active"` because
  // the IPC handler may not have observed our trigger yet (the
  // poll runs at 2 s cadence; the click should disable the button
  // immediately). On the IPC promise settling we drop the local
  // flag — by then the poll has either picked up the active state
  // OR the walk finished synchronously (e.g. already-completed
  // short-circuit).
  const [kchatBackfilling, setKchatBackfilling] = useState(false);
  const [kchatBackfillError, setKchatBackfillError] = useState<string | null>(
    null,
  );

  const handleBackfillKchat = async () => {
    if (!kchatChannelId) return;
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api) {
      setKchatBackfillError("Tessera bridge not available");
      return;
    }
    setKchatBackfillError(null);
    setKchatBackfilling(true);
    try {
      await api.kchat.backfillChannel(kchatChannelId);
    } catch (err) {
      // Surface the IPC-layer failure (rate-limit, validation,
      // bridge error) in the same card the poll renders into.
      // The substrate-level outcomes (`access_revoked`, etc.)
      // come back through `kchatBackfill` rather than as a
      // rejection.
      setKchatBackfillError(
        err instanceof Error ? err.message : String(err),
      );
    } finally {
      setKchatBackfilling(false);
    }
  };

  const handleReindex = async () => {
    if (!id) return;
    try {
      await reindex(id);
      refresh();
    } catch {
      // error handled by hook
    }
  };

  const handleReembed = async () => {
    // Re-embed re-encodes every chunk in the workspace that doesn't
    // have an embedding for the active model. The bridge is
    // idempotent and rate-limited (1 every 10s) so a stale click
    // is harmless, but we still gate the button with `reembedding`
    // so the UI is unambiguous about "you already triggered this,
    // wait for it to finish".
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api) {
      setReembedError("Tessera bridge not available");
      return;
    }
    setReembedError(null);
    setReembedding(true);
    // Bump the generation so the polling effect re-fires even if
    // the previous backfill already finished. The counter is
    // monotonic; old values are never reused so each Re-embed
    // click maps to a unique `useEffect` cycle inside the hook.
    setReembedGeneration((g) => g + 1);
    try {
      await api.sources.backfillEmbeddings();
    } catch (err) {
      setReembedError(err instanceof Error ? err.message : String(err));
      // Roll the generation back to the quiescent sentinel (`0`).
      // The IPC failed BEFORE reaching the Rust bridge (e.g. the
      // `sources:backfillEmbeddings` IPC handler in `ipc/sources.ts`
      // rejects synchronously via `defaultRateLimiter.consume(...)`
      // when the user mashes Re-embed faster than the configured
      // budget), which means the bridge's pre-flight
      // `embedding_progress.mark_starting()` never fired. Without
      // this rollback, `useEmbeddingProgress` would be left in an
      // unobservable state — its `observedRunning` guard requires a
      // `running` status to ever surface, but the tracker is stuck
      // in whatever prior state the worker left it in (`idle` on
      // first launch, or `done`/`failed` from a previous successful
      // pass). The polling loop would then tick every 500 ms
      // forever, never reaching a state that satisfies the
      // terminal check, until the user clicks Re-embed again or the
      // component unmounts.
      //
      // Resetting to 0 trips the `if (generation <= 0) return;`
      // guard at the top of the hook's effect, which causes the
      // cleanup of the previous effect run to fire — cancelling the
      // pending timer — and the new effect to early-return without
      // scheduling another tick. The next successful Re-embed click
      // re-bumps to 1, which is a fresh generation as far as the
      // hook is concerned.
      setReembedGeneration(0);
    } finally {
      setReembedding(false);
      // The poller stops itself once it observes `status=done` or
      // `status=failed`. The final snapshot stays in the hook's
      // state and continues rendering as the "summary" line until
      // the user navigates away or clicks Re-embed again.
    }
  };

  const handleExtract = async () => {
    if (!id) return;
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api) {
      setExtractError("Tessera bridge not available");
      return;
    }
    // Clear BOTH previous error and previous results when starting a new
    // extraction. Without clearing `extracted`, a successful first
    // extraction followed by a failed second extraction would render the
    // new error alongside the stale results from the first run (the
    // section's guard is `extractError || extracted`). Showing stale
    // task/decision items next to an error is misleading because the
    // user can't tell that those items are NOT the result of the call
    // they just made.
    setExtractError(null);
    setExtracted(null);
    setExtracting(true);
    try {
      const result = await api.artifacts.extractTasksDecisions(id);
      setExtracted(result);
    } catch (err) {
      setExtractError(err instanceof Error ? err.message : String(err));
    } finally {
      setExtracting(false);
    }
  };

  if (loading) {
    return (
      <div>
        <PageHeader title="Source Detail" description="Loading source info..." />
        <p>Loading...</p>
      </div>
    );
  }

  if (error || !detail) {
    return (
      <div>
        <PageHeader title="Source Detail" description="" />
        <Card>
          <p style={{ color: "var(--color-danger)" }}>
            {error || "Source not found"}
          </p>
          <Button variant="secondary" onClick={() => navigate("/sources")}>
            Back to Sources
          </Button>
        </Card>
      </div>
    );
  }

  const { source, files } = detail;

  return (
    <div>
      <PageHeader
        title={source.path.split("/").pop() || source.path}
        description={source.path}
        actions={
          <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
            <Button
              variant="secondary"
              onClick={handleExtract}
              disabled={extracting}
              data-testid="extract-tasks-decisions"
            >
              {extracting ? "Extracting…" : "Extract Tasks & Decisions"}
            </Button>
            <Button
              variant="secondary"
              onClick={handleReindex}
              disabled={reindexing}
            >
              {reindexing ? "Reindexing..." : "Reindex"}
            </Button>
            <Button
              variant="secondary"
              onClick={handleReembed}
              disabled={reembedding}
              aria-label={
                reembedding
                  ? "Embedding backfill in progress"
                  : "Re-embed all chunks against the active embedding model"
              }
              data-testid="reembed-button"
            >
              {reembedding ? "Re-embedding…" : "Re-embed"}
            </Button>
            {kchatChannelId && (
              // Phase 13 Task 10: manual trigger for the KChat
              // post-history backfill walk. The substrate-side
              // orchestrator is idempotent on `cacheDir` (an
              // already-completed walk short-circuits at the state
              // read with `outcome: "skipped"`), so a re-click is
              // safe; we still disable the button while a walk is
              // in flight or while the poller observes the
              // `active` state to give the user clear feedback
              // that their click was registered.
              <Button
                variant="secondary"
                onClick={handleBackfillKchat}
                disabled={
                  kchatBackfilling || kchatBackfill?.status === "active"
                }
                aria-label={
                  kchatBackfilling || kchatBackfill?.status === "active"
                    ? "KChat post backfill in progress"
                    : "Backfill KChat post history for this channel"
                }
                data-testid="kchat-backfill-button"
              >
                {kchatBackfilling || kchatBackfill?.status === "active"
                  ? "Backfilling…"
                  : "Backfill posts"}
              </Button>
            )}
            <Button variant="secondary" onClick={() => navigate("/sources")}>
              Back
            </Button>
          </div>
        }
      />

      <div style={{ display: "grid", gap: "var(--spacing-md)" }}>
        {reindexing && progress && progress.status === "running" && (
          <Card>
            <h3 className="card-title">Indexing</h3>
            <p
              role="status"
              aria-live="polite"
              style={{ color: "var(--color-text-secondary)" }}
            >
              Scanned {progress.scanned} · Indexed {progress.indexed} ·
              Unchanged {progress.unchanged} · Skipped {progress.skipped}
              {progress.errors > 0 && (
                <span style={{ color: "var(--color-error)" }}>
                  {" "}
                  · Errors {progress.errors}
                </span>
              )}
            </p>
            {progress.currentPath && (
              <p
                style={{
                  fontSize: "var(--font-size-xs)",
                  color: "var(--color-text-secondary)",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                  whiteSpace: "nowrap",
                }}
              >
                {progress.currentPath}
              </p>
            )}
          </Card>
        )}
        {progress && progress.status === "failed" && (
          <Card>
            <p role="alert" style={{ color: "var(--color-error)" }}>
              Indexing failed: {progress.lastError ?? "unknown error"}
            </p>
          </Card>
        )}
        {!reembedError &&
          embeddingProgress &&
          (embeddingProgress.status === "running" ||
            embeddingProgress.status === "done") &&
          embeddingProgress.totalChunks > 0 && (
            // Guard on `!reembedError` so a synchronous IPC
            // rejection (e.g. rate-limit thrown from the IPC layer
            // BEFORE the backfill bridge is even called) doesn't
            // leave a stale "Re-embed complete: 10/10 chunks"
            // success card visible alongside the new error banner.
            // The progress card only makes sense when the most
            // recent click actually reached the bridge.
            <Card data-testid="embedding-progress-card">
              <h3 className="card-title">
                {embeddingProgress.status === "done"
                  ? "Re-embed complete"
                  : "Re-embedding…"}
              </h3>
              <p
                role="status"
                aria-live="polite"
                style={{ color: "var(--color-text-secondary)" }}
              >
                {embeddingProgress.embedded} / {embeddingProgress.totalChunks}{" "}
                chunks embedded
                {embeddingProgress.failed > 0 && (
                  <span style={{ color: "var(--color-error)" }}>
                    {" "}
                    · {embeddingProgress.failed} failed
                  </span>
                )}
                {embeddingProgress.modelId && (
                  <span
                    style={{
                      fontSize: "var(--font-size-xs)",
                      marginLeft: "var(--spacing-sm)",
                    }}
                  >
                    (model: {embeddingProgress.modelId})
                  </span>
                )}
              </p>
              {/*
                Plain HTML5 progress element so screen readers
                announce the value/max pair without us having to
                roll our own aria-valuemin/max plumbing. CSS in
                index.css adjusts the bar to the Tessera palette.
              */}
              <progress
                aria-label="Embedding backfill progress"
                value={embeddingProgress.embedded}
                max={Math.max(embeddingProgress.totalChunks, 1)}
                style={{ width: "100%", marginTop: "var(--spacing-xs)" }}
              />
            </Card>
          )}
        {!reembedError &&
          embeddingProgress &&
          embeddingProgress.status === "failed" && (
            // Same `!reembedError` guard as the success card: if
            // the most recent click was rejected by the IPC layer,
            // suppress the tracker's stale `failed` snapshot from
            // a prior backfill so the new error banner is the
            // single source of truth for the failure.
            <Card>
              <p role="alert" style={{ color: "var(--color-error)" }}>
                Re-embed failed:{" "}
                {embeddingProgress.lastError ?? "unknown error"}
              </p>
            </Card>
          )}
        {reembedError && (
          <Card>
            <p
              role="alert"
              style={{ color: "var(--color-error)" }}
              data-testid="reembed-error"
            >
              {reembedError}
            </p>
          </Card>
        )}
        {/*
          Phase 13 Task 10 — KChat backfill progress card.

          Rendered ONLY for KChat-channel sources. The card has four
          discriminated states the poll surfaces via
          `kchatBackfill.status`:

            - `"idle"`     → no walk has run yet; the card explains
                              the action and points to the
                              "Backfill posts" button in the header.
            - `"active"`   → walk in flight; shows an indeterminate
                              progress indicator and the running
                              `postsIngested` counter. The substrate
                              does NOT always surface `totalPosts`,
                              so the HTML5 `<progress>` element
                              renders without `max=` when the total
                              is unknown — the browser shows an
                              indeterminate spinner in that case.
            - `"complete"` → walk reached the head of the channel.
                              Shows a "Backfill complete" pill plus
                              the most-recent `oldestFetched`
                              timestamp if available.
            - `"error"`    → substrate-level failure; shows the
                              error message and lets the user
                              re-trigger via the header button.

          We deliberately hide the card while `kchatBackfill === null`
          (the very first poll hasn't returned yet) to avoid a flash
          of "idle" before the substrate-state read completes.
        */}
        {kchatChannelId && kchatBackfillError && (
          <Card>
            <p
              role="alert"
              style={{ color: "var(--color-error)" }}
              data-testid="kchat-backfill-error"
            >
              KChat backfill failed: {kchatBackfillError}
            </p>
          </Card>
        )}
        {kchatChannelId && kchatBackfill && (
          <Card data-testid="kchat-backfill-card">
            <h3 className="card-title">
              {kchatBackfill.status === "complete"
                ? "KChat backfill complete"
                : kchatBackfill.status === "active"
                  ? "KChat backfill in progress"
                  : kchatBackfill.status === "error"
                    ? "KChat backfill error"
                    : "KChat post backfill"}
            </h3>
            <p
              role="status"
              aria-live="polite"
              style={{ color: "var(--color-text-secondary)" }}
              data-testid="kchat-backfill-status"
              data-status={kchatBackfill.status}
            >
              {kchatBackfill.status === "idle" &&
                'No walk has run yet. Click "Backfill posts" to fetch the channel\u2019s post history.'}
              {kchatBackfill.status === "active" &&
                `${kchatBackfill.postsIngested} posts ingested\u2026`}
              {kchatBackfill.status === "complete" &&
                (kchatBackfill.oldestFetched !== null
                  ? `History fetched back to ${new Date(
                      kchatBackfill.oldestFetched,
                    ).toLocaleString()}.`
                  : "Channel history fully fetched.")}
              {kchatBackfill.status === "error" &&
                (kchatBackfill.error ??
                  "Last walk failed; click Backfill posts to retry.")}
            </p>
            {kchatBackfill.status === "active" && (
              <progress
                aria-label="KChat backfill progress"
                /*
                  The substrate does not always surface `totalPosts`
                  (the KChat REST API exposes a per-page count but no
                  channel-level total in the same call). When
                  `totalPosts === null` we omit `value` AND `max` so
                  the HTML5 `<progress>` element renders in its
                  indeterminate mode, which is the correct UX cue for
                  "work is happening but the end is unknown". When a
                  `totalPosts` value IS available we render a
                  determinate bar capped at 1 so an over-shoot from a
                  stale total doesn't clip negatively.
                */
                {...(kchatBackfill.totalPosts !== null
                  ? {
                      value: kchatBackfill.postsIngested,
                      max: Math.max(kchatBackfill.totalPosts, 1),
                    }
                  : {})}
                style={{ width: "100%", marginTop: "var(--spacing-xs)" }}
              />
            )}
          </Card>
        )}
        {(extractError || extracted) && (
          <Card>
            <h3 className="card-title">Extracted Tasks &amp; Decisions</h3>
            {extractError && (
              <p style={{ color: "var(--color-danger, #ef4444)" }} data-testid="extract-error">
                {extractError}
              </p>
            )}
            {extracted && extracted.length === 0 && (
              <p style={{ color: "var(--color-text-secondary)" }}>
                No tasks or decisions detected.
              </p>
            )}
            {extracted && extracted.length > 0 && (
              <ul data-testid="extracted-list" style={{ paddingLeft: "var(--spacing-md)" }}>
                {extracted.map((item, idx) => (
                  <li key={idx} style={{ marginBottom: "var(--spacing-xs)" }}>
                    <strong>{item.itemType === "task" ? "Task" : "Decision"}:</strong>{" "}
                    {item.text}{" "}
                    <span style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>
                      ({item.sourceCitation}, confidence {(item.confidence * 100).toFixed(0)}%)
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </Card>
        )}
        <Card>
          <h3 className="card-title">Source Information</h3>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "auto 1fr",
              gap: "var(--spacing-xs) var(--spacing-lg)",
              fontSize: "var(--font-size-sm)",
            }}
          >
            <span style={{ fontWeight: 600 }}>Type</span>
            <span>{formatSourceTypeLabel(source.sourceType)}</span>

            <span style={{ fontWeight: 600 }}>Status</span>
            <span>
              <StatusBadge status={source.status} />
            </span>

            <span style={{ fontWeight: 600 }}>Full Path</span>
            <span style={{ wordBreak: "break-all" }}>{source.path}</span>

            <span style={{ fontWeight: 600 }}>Created</span>
            <span>{new Date(source.createdAt).toLocaleString()}</span>

            <span style={{ fontWeight: 600 }}>Last Indexed</span>
            <span>
              {source.lastIndexed
                ? new Date(source.lastIndexed).toLocaleString()
                : "Never"}
            </span>

            <span style={{ fontWeight: 600 }}>Total Files</span>
            <span>{source.fileCount}</span>
          </div>
        </Card>

        <Card>
          <h3 className="card-title">
            Indexed Files ({files.length})
          </h3>
          {files.length === 0 ? (
            <p className="card-description">
              No files indexed yet. Click Reindex to start.
            </p>
          ) : (
            <div style={{ overflowX: "auto" }}>
              <table
                style={{
                  width: "100%",
                  borderCollapse: "collapse",
                  fontSize: "var(--font-size-sm)",
                }}
              >
                <thead>
                  <tr
                    style={{
                      borderBottom: "1px solid var(--color-border)",
                      textAlign: "left",
                    }}
                  >
                    <th style={{ padding: "var(--spacing-xs) var(--spacing-sm)" }}>
                      File Path
                    </th>
                    <th style={{ padding: "var(--spacing-xs) var(--spacing-sm)" }}>
                      Hash
                    </th>
                    <th style={{ padding: "var(--spacing-xs) var(--spacing-sm)" }}>
                      Last Modified
                    </th>
                    <th style={{ padding: "var(--spacing-xs) var(--spacing-sm)" }}>
                      Chunks
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {files.map((file, idx) => (
                    <tr
                      key={idx}
                      style={{
                        borderBottom: "1px solid var(--color-border)",
                      }}
                    >
                      <td
                        style={{
                          padding: "var(--spacing-xs) var(--spacing-sm)",
                          wordBreak: "break-all",
                          maxWidth: "400px",
                        }}
                      >
                        {file.path}
                      </td>
                      <td
                        style={{
                          padding: "var(--spacing-xs) var(--spacing-sm)",
                          fontFamily: "monospace",
                          fontSize: "0.75rem",
                        }}
                      >
                        {file.hash.slice(0, 12)}...
                      </td>
                      <td style={{ padding: "var(--spacing-xs) var(--spacing-sm)" }}>
                        {new Date(file.lastModified).toLocaleString()}
                      </td>
                      <td style={{ padding: "var(--spacing-xs) var(--spacing-sm)" }}>
                        {file.chunkCount}
                      </td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </Card>
      </div>
    </div>
  );
}
