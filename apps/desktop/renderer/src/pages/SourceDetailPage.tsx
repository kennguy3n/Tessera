import { useState } from "react";
import { useParams, useNavigate } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import Button from "../components/Button";
import Card from "../components/Card";
import StatusBadge from "../components/StatusBadge";
import { useSourceDetail, useReindexSource } from "../hooks/useSources";
import type { ExtractedItem } from "../types/ipc";

export default function SourceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { detail, loading, error, refresh } = useSourceDetail(id);
  const { reindex, loading: reindexing } = useReindexSource();
  const [extracted, setExtracted] = useState<ExtractedItem[] | null>(null);
  const [extractError, setExtractError] = useState<string | null>(null);
  const [extracting, setExtracting] = useState(false);

  const handleReindex = async () => {
    if (!id) return;
    try {
      await reindex(id);
      refresh();
    } catch {
      // error handled by hook
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
    // they just made. See Devin Review finding 3270586359.
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
            <Button variant="secondary" onClick={() => navigate("/sources")}>
              Back
            </Button>
          </div>
        }
      />

      <div style={{ display: "grid", gap: "var(--spacing-md)" }}>
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
            <span>
              {source.sourceType === "local_folder" ? "Local Folder" : "Local File"}
            </span>

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
