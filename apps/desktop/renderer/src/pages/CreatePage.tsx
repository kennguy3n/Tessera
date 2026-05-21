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
  /** Optional badge — used to highlight quick-start workflows. */
  badge?: "workflow";
  /**
   * Optional hint shown beneath the description when the user is
   * expected to pick a specific source type for this workflow (e.g.
   * the "Analyze spreadsheet" workflow requires a Sheet artifact).
   * Purely informational; the actual selection happens in the
   * TemplateRunner below where the source list lives.
   */
  sourceHint?: string;
}

/**
 * The four PROPOSAL.md categories. Each lists every shipping
 * template — pulled by id from `templates/{documents,slides,sheets,
 * bases,infographics,landing_pages}/` — plus a small set of named
 * quick-start workflows at the top of the relevant category. The
 * workflows are NOT separate template files; they're a UX shortcut
 * onto an existing template with extra hint copy so the user knows
 * what to grab before hitting Generate.
 *
 * If you add a new template under `templates/`, append it to the
 * appropriate category below — and add a row to the
 * `bundled_templates.rs` test in `crates/tessera_templates/tests/`
 * so the registry stays in sync.
 */
const CATEGORIES: Record<string, CategoryItem[]> = {
  Create: [
    // Documents
    { id: "prd-v1", name: "PRD", description: "Product Requirements Document" },
    { id: "proposal-v1", name: "Proposal", description: "Business proposal" },
    { id: "brief-v1", name: "Brief", description: "One-pager brief" },
    { id: "memo-v1", name: "Memo", description: "Internal memo" },
    { id: "sop-v1", name: "SOP", description: "Standard Operating Procedure" },
    // Slides
    { id: "pitch-v1", name: "Pitch Deck", description: "Investor / sales pitch" },
    { id: "training-v1", name: "Training Deck", description: "Slide-based training" },
    // Visuals
    {
      id: "infographic-stats-overview-v1",
      name: "Stats Overview",
      description: "Stat-block infographic",
    },
    {
      id: "infographic-process-flow-v1",
      name: "Process Flow",
      description: "Step-by-step infographic",
    },
    {
      id: "infographic-comparison-v1",
      name: "Comparison",
      description: "Side-by-side infographic",
    },
    {
      id: "landing-saas-product-v1",
      name: "SaaS Landing Page",
      description: "Marketing landing page",
    },
  ],
  Analyze: [
    // Workflows surface at the top so they're the first thing users
    // see when they open the Analyze tab.
    {
      id: "report-v1",
      name: "Summarize sources",
      description:
        "Pick one or more sources and Tessera will draft a grounded summary report.",
      badge: "workflow",
    },
    {
      id: "report-v1",
      name: "Generate report",
      description:
        "Use the Report template with your selected sources for an analytical write-up.",
      badge: "workflow",
    },
    {
      id: "report-v1",
      name: "Analyze spreadsheet",
      description: "Generate insights from a Sheet artifact.",
      badge: "workflow",
      sourceHint:
        "Pick a Sheet you've already imported as a source — the report will cite its rows.",
    },
    { id: "report-v1", name: "Report", description: "Analytical report" },
    { id: "qbr-v1", name: "QBR", description: "Quarterly Business Review" },
    { id: "scorecard-v1", name: "Scorecard", description: "Performance scorecard" },
    { id: "review-v1", name: "Review Deck", description: "Post-mortem / review deck" },
    {
      id: "review-checklist-v1",
      name: "Review Checklist",
      description: "Pre-launch review checklist",
    },
    {
      id: "risk-register-v1",
      name: "Risk Register",
      description: "Risk tracking",
    },
  ],
  Plan: [
    { id: "strategy-v1", name: "Strategy Deck", description: "Strategy deck" },
    { id: "roadmap-v1", name: "Roadmap", description: "Project roadmap" },
    { id: "budget-v1", name: "Budget", description: "Budget tracker" },
    { id: "project-plan-v1", name: "Project Plan", description: "Phased project plan" },
    { id: "task-list-v1", name: "Task List", description: "Task list with owners" },
    {
      id: "launch-checklist-v1",
      name: "Launch Checklist",
      description: "Go-live readiness checklist",
    },
    {
      id: "meeting-agenda-v1",
      name: "Meeting Agenda",
      description: "Structured meeting agenda",
    },
    {
      id: "meeting-notes-v1",
      name: "Meeting Notes",
      description: "Decisions + actions from a meeting",
    },
  ],
  Approve: [
    {
      id: "purchase-approval-v1",
      name: "Purchase Approval",
      description: "Purchase request with risk + approval chain",
    },
    {
      id: "budget-approval-v1",
      name: "Budget Approval",
      description: "Budget request with rationale",
    },
    {
      id: "policy-exception-v1",
      name: "Policy Exception",
      description: "Exception request with conditions",
    },
    {
      id: "vendor-review-v1",
      name: "Vendor Review",
      description: "Vendor due-diligence",
    },
    {
      id: "vendor-register-v1",
      name: "Vendor Register",
      description: "Vendor catalog Base",
    },
    {
      id: "decision-log-v1",
      name: "Decision Log",
      description: "ADR-style decision tracking",
    },
  ],
};

const TABS = Object.keys(CATEGORIES);

/**
 * Resolve the human-readable category entry for a template id. If the
 * same template id appears under more than one category (e.g. the
 * Analyze workflows all run the Report template), we return the first
 * non-workflow entry so the runner title shows the canonical name
 * rather than "Summarize sources".
 */
function localItemForTemplate(
  id: string,
  preferWorkflow?: string,
): CategoryItem | undefined {
  if (preferWorkflow) {
    for (const list of Object.values(CATEGORIES)) {
      const match = list.find((c) => c.id === id && c.name === preferWorkflow);
      if (match) return match;
    }
  }
  for (const list of Object.values(CATEGORIES)) {
    const match = list.find((c) => c.id === id && c.badge !== "workflow");
    if (match) return match;
  }
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

const TAB_DESCRIPTIONS: Record<string, string> = {
  Create: "Generate documents, slides, infographics, and landing pages from scratch.",
  Analyze:
    "Summarize sources, generate reports, and turn structured data into insights.",
  Plan: "Strategy decks, roadmaps, budgets, and project plans.",
  Approve: "Approval workflows: purchases, budgets, exceptions, vendor reviews.",
};

export default function CreatePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const templateId = searchParams.get("template");
  // `workflow` is an optional query-string key used by the Analyze
  // workflow shortcuts so the runner can show the workflow's hint
  // text ("Pick a Sheet you've already imported...") instead of the
  // generic template description.
  const workflow = searchParams.get("workflow") ?? undefined;
  const [activeTab, setActiveTab] = useState(TABS[0]);

  if (templateId) {
    return (
      <TemplateRunner templateId={templateId} workflow={workflow} />
    );
  }

  return (
    <div>
      <PageHeader
        title="Create"
        description={TAB_DESCRIPTIONS[activeTab]}
      />

      <div
        role="tablist"
        aria-label="Template category"
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
            role="tab"
            aria-selected={activeTab === tab}
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
        {CATEGORIES[activeTab].map((item) => {
          // Workflows pass `workflow=<name>` to the runner so it can
          // load the workflow-specific hint copy. Regular template
          // cards just navigate with the template id.
          const target =
            item.badge === "workflow"
              ? `/create?template=${item.id}&workflow=${encodeURIComponent(item.name)}`
              : `/create?template=${item.id}`;
          return (
            <Card
              key={`${item.id}-${item.name}`}
              onClick={() => navigate(target)}
            >
              {item.badge === "workflow" && (
                <span
                  style={{
                    display: "inline-block",
                    fontSize: "var(--font-size-xs)",
                    fontWeight: 600,
                    color: "var(--color-primary, #7C3AED)",
                    background: "var(--color-primary-soft, #ede9fe)",
                    padding: "0.125rem 0.5rem",
                    borderRadius: "999px",
                    marginBottom: "var(--spacing-xs)",
                  }}
                >
                  Workflow
                </span>
              )}
              <div className="card-title">{item.name}</div>
              <div className="card-description">{item.description}</div>
            </Card>
          );
        })}
      </div>
    </div>
  );
}

function TemplateRunner({
  templateId,
  workflow,
}: {
  templateId: string;
  workflow?: string;
}) {
  const navigate = useNavigate();
  const localItem = localItemForTemplate(templateId, workflow);
  const { sources, loading: sourcesLoading } = useSourceList();
  const [template, setTemplate] = useState<TemplateInfo | null>(null);
  const [templateLoaded, setTemplateLoaded] = useState(false);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [gen, setGen] = useState<GenerateState>({ status: "idle", message: null });

  // NOTE: artifacts.generateFromTemplate runs synchronously through the Rust
  // bridge (bridgeGenerateFromTemplate -> inference_router) and does NOT emit
  // `model:token` SSE events the way the sidecar `model:generate` IPC does.
  // We previously subscribed to `model:token` for a streaming preview here,
  // but that was dead code — the channel is silent for template generation.
  // A future PR can thread streaming token events through the artifacts
  // pipeline (inference_router streaming -> N-API event -> renderer); until
  // then we show an honest indeterminate progress indicator instead of a
  // token preview that never updates.

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

  // Workflow shortcuts show the workflow's friendly name (e.g.
  // "Analyze spreadsheet") rather than the underlying template name
  // (e.g. "Report") so the user sees the action they clicked on.
  const displayName =
    localItem?.badge === "workflow"
      ? localItem.name
      : template?.name ?? localItem?.name ?? templateId;
  // Workflow shortcuts whose underlying template carries a generic
  // description (e.g. workflow "Summarize sources" → template "Report"
  // → "Analytical report") must keep their workflow-specific copy even
  // after the template async-resolves. So workflow `localItem.description`
  // wins over `template?.description`. Non-workflow templates keep the
  // existing precedence: prefer the loaded template's description, fall
  // back to the local entry, finally a generic label.
  const displayDescription =
    localItem?.sourceHint ??
    (localItem?.badge === "workflow" ? localItem?.description : null) ??
    template?.description ??
    localItem?.description ??
    "Template details";

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
              Generating from the local model…
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

        {!templateLoaded && (
          <p style={{ fontSize: "var(--font-size-xs)", color: "var(--color-text-secondary)" }}>
            Resolving template…
          </p>
        )}
      </Card>
    </div>
  );
}
