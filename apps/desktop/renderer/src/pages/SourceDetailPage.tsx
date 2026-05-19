import { useParams, useNavigate } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import Button from "../components/Button";
import Card from "../components/Card";
import StatusBadge from "../components/StatusBadge";
import { useSourceDetail, useReindexSource } from "../hooks/useSources";

export default function SourceDetailPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const { detail, loading, error, refresh } = useSourceDetail(id);
  const { reindex, loading: reindexing } = useReindexSource();

  const handleReindex = async () => {
    if (!id) return;
    try {
      await reindex(id);
      refresh();
    } catch {
      // error handled by hook
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
