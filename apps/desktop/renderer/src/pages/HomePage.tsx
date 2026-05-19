import { useNavigate } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import Card from "../components/Card";
import Button from "../components/Button";
import EmptyState from "../components/EmptyState";
import { useRecentArtifacts } from "../hooks/useArtifacts";
import { useSourceList } from "../hooks/useSources";

export default function HomePage() {
  const navigate = useNavigate();
  const { recent, loading: artifactsLoading } = useRecentArtifacts();
  const { sources, loading: sourcesLoading } = useSourceList();

  const hasSources = sources.length > 0;
  const hasArtifacts = recent.length > 0;
  const isLoading = artifactsLoading || sourcesLoading;

  if (isLoading) {
    return (
      <div>
        <PageHeader title="Home" description="Your productivity workspace" />
        <p>Loading...</p>
      </div>
    );
  }

  if (!hasSources && !hasArtifacts) {
    return (
      <div>
        <PageHeader title="Home" description="Your productivity workspace" />
        <EmptyState
          icon="\uD83D\uDE80"
          title="Welcome to Tessera"
          message="Get started by adding your first source — a local folder or file — then create artifacts from your data."
          action={
            <div style={{ display: "flex", gap: "0.5rem" }}>
              <Button onClick={() => navigate("/sources")}>Add Source</Button>
              <Button variant="secondary" onClick={() => navigate("/create")}>
                Explore Templates
              </Button>
            </div>
          }
        />
      </div>
    );
  }

  return (
    <div>
      <PageHeader
        title="Home"
        description="Your productivity workspace"
        actions={
          <div style={{ display: "flex", gap: "0.5rem" }}>
            <Button onClick={() => navigate("/create")}>New Document</Button>
            <Button variant="secondary" onClick={() => navigate("/sources")}>
              Add Source
            </Button>
          </div>
        }
      />

      <section style={{ marginBottom: "var(--spacing-xl)" }}>
        <h2 style={{ marginBottom: "var(--spacing-md)" }}>Sources</h2>
        <div style={{ display: "flex", gap: "var(--spacing-md)", flexWrap: "wrap" }}>
          <Card>
            <div className="card-title">{sources.length}</div>
            <div className="card-description">Connected sources</div>
          </Card>
          <Card>
            <div className="card-title">
              {sources.reduce((sum, s) => sum + s.fileCount, 0)}
            </div>
            <div className="card-description">Indexed files</div>
          </Card>
        </div>
      </section>

      {hasArtifacts && (
        <section>
          <h2 style={{ marginBottom: "var(--spacing-md)" }}>Recent Artifacts</h2>
          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(auto-fill, minmax(280px, 1fr))",
              gap: "var(--spacing-md)",
            }}
          >
            {recent.map((artifact) => (
              <Card key={artifact.id}>
                <div className="card-title">{artifact.title}</div>
                <div className="card-description">
                  {artifact.artifactType} &middot; v{artifact.version} &middot;{" "}
                  {new Date(artifact.updatedAt).toLocaleDateString()}
                </div>
              </Card>
            ))}
          </div>
        </section>
      )}
    </div>
  );
}
