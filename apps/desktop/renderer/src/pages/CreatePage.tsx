import { useCallback, useEffect, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import Card from "../components/Card";
import Button from "../components/Button";
import { useSourceList } from "../hooks/useSources";
import type { TemplateInfo } from "../types/ipc";

interface CategoryItem {
  id: string;
  name: string;
  description: string;
}

const CATEGORIES: Record<string, CategoryItem[]> = {
  Create: [
    { id: "prd-v1", name: "PRD", description: "Product Requirements Document" },
    { id: "proposal-v1", name: "Proposal", description: "Business proposal" },
    { id: "sop-v1", name: "SOP", description: "Standard Operating Procedure" },
    { id: "report-v1", name: "Report", description: "Analytical report" },
    { id: "memo-v1", name: "Memo", description: "Internal memo" },
  ],
  Analyze: [
    { id: "qbr-v1", name: "QBR", description: "Quarterly Business Review" },
    { id: "scorecard-v1", name: "Scorecard", description: "Performance scorecard" },
  ],
  Plan: [
    { id: "strategy-v1", name: "Strategy", description: "Strategy deck" },
    { id: "roadmap-v1", name: "Roadmap", description: "Project roadmap" },
    { id: "budget-v1", name: "Budget", description: "Budget tracker" },
  ],
  Approve: [
    { id: "vendor-register-v1", name: "Vendor Register", description: "Vendor management" },
    { id: "risk-register-v1", name: "Risk Register", description: "Risk tracking" },
    { id: "decision-log-v1", name: "Decision Log", description: "Decision tracking" },
  ],
};

const TABS = Object.keys(CATEGORIES);

function localItemForTemplate(id: string): CategoryItem | undefined {
  for (const list of Object.values(CATEGORIES)) {
    const match = list.find((c) => c.id === id);
    if (match) return match;
  }
  return undefined;
}

interface GenerateState {
  status: "idle" | "loading" | "success" | "error";
  message: string | null;
}

export default function CreatePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const templateId = searchParams.get("template");
  const [activeTab, setActiveTab] = useState(TABS[0]);

  if (templateId) {
    return <TemplateRunner templateId={templateId} />;
  }

  return (
    <div>
      <PageHeader
        title="Create"
        description="Choose what you want to create"
      />

      <div
        style={{
          display: "flex",
          gap: "var(--spacing-xs)",
          marginBottom: "var(--spacing-xl)",
          borderBottom: "1px solid var(--color-border)",
          paddingBottom: "var(--spacing-sm)",
        }}
      >
        {TABS.map((tab) => (
          <button
            key={tab}
            className={`btn ${activeTab === tab ? "btn-primary" : "btn-secondary"}`}
            onClick={() => setActiveTab(tab)}
            style={{ fontSize: "var(--font-size-sm)" }}
          >
            {tab}
          </button>
        ))}
      </div>

      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
          gap: "var(--spacing-md)",
        }}
      >
        {CATEGORIES[activeTab].map((item) => (
          <Card
            key={item.id}
            onClick={() => navigate(`/create?template=${item.id}`)}
          >
            <div className="card-title">{item.name}</div>
            <div className="card-description">{item.description}</div>
          </Card>
        ))}
      </div>
    </div>
  );
}

function TemplateRunner({ templateId }: { templateId: string }) {
  const navigate = useNavigate();
  const localItem = localItemForTemplate(templateId);
  const { sources, loading: sourcesLoading } = useSourceList();
  const [template, setTemplate] = useState<TemplateInfo | null>(null);
  const [templateLoaded, setTemplateLoaded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [gen, setGen] = useState<GenerateState>({ status: "idle", message: null });

  // Streaming token preview for the generation in flight. We still navigate
  // to the artifact editor on success; this just gives feedback in-page.
  const [tokens, setTokens] = useState<string>("");

  useEffect(() => {
    let cancelled = false;
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api) {
      setTemplateLoaded(true);
      return () => {
        cancelled = true;
      };
    }
    api.templates
      .get(templateId)
      .then((result) => {
        if (cancelled) return;
        setTemplate(result);
        setTemplateLoaded(true);
      })
      .catch(() => {
        if (cancelled) return;
        setTemplateLoaded(true);
      });
    return () => {
      cancelled = true;
    };
  }, [templateId]);

  useEffect(() => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api) return;
    return api.model.onToken((chunk) => {
      if (chunk.error) {
        setGen({ status: "error", message: chunk.error });
        return;
      }
      if (chunk.token) {
        setTokens((prev) => prev + chunk.token);
      }
    });
  }, []);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const handleGenerate = useCallback(async () => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api) {
      setGen({ status: "error", message: "Tessera bridge not available" });
      return;
    }
    if (selected.size === 0) {
      setGen({
        status: "error",
        message: "Select at least one source to ground the artifact.",
      });
      return;
    }
    setGen({ status: "loading", message: null });
    setTokens("");
    try {
      const artifact = await api.artifacts.generateFromTemplate(
        templateId,
        Array.from(selected),
      );
      setGen({ status: "success", message: artifact.id });
      navigate(`/artifacts/${artifact.id}`);
    } catch (err) {
      setGen({
        status: "error",
        message: err instanceof Error ? err.message : String(err),
      });
    }
  }, [navigate, selected, templateId]);

  const displayName = template?.name ?? localItem?.name ?? templateId;
  const displayDescription =
    template?.description ?? localItem?.description ?? "Template details";

  return (
    <div>
      <PageHeader
        title={`Create: ${displayName}`}
        description={displayDescription}
        actions={
          <Button variant="secondary" onClick={() => navigate("/create")}>
            Back to Templates
          </Button>
        }
      />

      <Card>
        <h3 style={{ marginBottom: "var(--spacing-sm)" }}>
          Select sources to ground this {displayName}
        </h3>
        <p
          style={{
            fontSize: "var(--font-size-sm)",
            color: "var(--color-text-secondary)",
            marginBottom: "var(--spacing-md)",
          }}
        >
          Tessera will only cite content from the sources you select below.
        </p>

        {sourcesLoading && <p>Loading sources…</p>}
        {!sourcesLoading && sources.length === 0 && (
          <p style={{ color: "var(--color-text-secondary)" }}>
            No sources connected.{" "}
            <a href="#" onClick={(e) => {
              e.preventDefault();
              navigate("/sources");
            }}>
              Connect one in Sources
            </a>{" "}
            first.
          </p>
        )}
        {!sourcesLoading && sources.length > 0 && (
          <ul
            data-testid="create-source-list"
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              maxHeight: 300,
              overflowY: "auto",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
            }}
          >
            {sources.map((source) => {
              const checked = selected.has(source.id);
              return (
                <li
                  key={source.id}
                  style={{
                    padding: "var(--spacing-sm) var(--spacing-md)",
                    borderBottom: "1px solid var(--color-border)",
                  }}
                >
                  <label
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--spacing-sm)",
                      cursor: "pointer",
                    }}
                  >
                    <input
                      type="checkbox"
                      checked={checked}
                      onChange={() => toggle(source.id)}
                    />
                    <span>
                      <strong>{source.path}</strong>
                      <span
                        style={{
                          marginLeft: "var(--spacing-sm)",
                          fontSize: "var(--font-size-xs)",
                          color: "var(--color-text-secondary)",
                        }}
                      >
                        {source.sourceType} · {source.fileCount} files
                      </span>
                    </span>
                  </label>
                </li>
              );
            })}
          </ul>
        )}

        <div
          style={{
            display: "flex",
            alignItems: "center",
            gap: "var(--spacing-md)",
            marginTop: "var(--spacing-md)",
          }}
        >
          <Button
            onClick={handleGenerate}
            disabled={gen.status === "loading" || selected.size === 0}
          >
            {gen.status === "loading" ? "Generating…" : "Generate"}
          </Button>
          {gen.status === "loading" && (
            <span data-testid="create-generating" style={{ fontSize: "var(--font-size-sm)" }}>
              Streaming tokens from the local model…
            </span>
          )}
          {gen.status === "error" && (
            <span
              data-testid="create-error"
              style={{ color: "var(--color-danger, #ef4444)", fontSize: "var(--font-size-sm)" }}
            >
              {gen.message}
            </span>
          )}
        </div>

        {gen.status === "loading" && tokens.length > 0 && (
          <div
            data-testid="create-token-stream"
            style={{
              marginTop: "var(--spacing-md)",
              padding: "var(--spacing-md)",
              backgroundColor: "var(--color-surface-muted, #f9fafb)",
              borderRadius: "var(--radius-sm)",
              fontFamily: "var(--font-family-mono, monospace)",
              fontSize: "var(--font-size-xs)",
              maxHeight: 200,
              overflowY: "auto",
              whiteSpace: "pre-wrap",
            }}
          >
            {tokens}
          </div>
        )}

        {!templateLoaded && (
          <p style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>
            Resolving template…
          </p>
        )}
      </Card>
    </div>
  );
}
