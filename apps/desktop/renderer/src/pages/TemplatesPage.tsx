import { useNavigate } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import Card from "../components/Card";
import EmptyState from "../components/EmptyState";
import { useTemplateList } from "../hooks/useTemplates";

interface TemplateCardData {
  id: string;
  name: string;
  description: string;
  type: string;
}

const BUILTIN_TEMPLATES: Record<string, TemplateCardData[]> = {
  Documents: [
    { id: "prd-v1", name: "PRD", description: "Product Requirements Document with problem, solution, scope, and success criteria", type: "document" },
    { id: "proposal-v1", name: "Proposal", description: "Business or project proposal with executive summary and budget", type: "document" },
    { id: "sop-v1", name: "SOP", description: "Standard Operating Procedure with step-by-step instructions", type: "document" },
    { id: "report-v1", name: "Report", description: "Analytical report with findings and recommendations", type: "document" },
    { id: "memo-v1", name: "Memo", description: "Internal communication memo with context and action items", type: "document" },
  ],
  Slides: [
    { id: "qbr-v1", name: "QBR", description: "Quarterly Business Review with metrics and next quarter plan", type: "slides" },
    { id: "strategy-v1", name: "Strategy Deck", description: "Strategic planning with vision, market analysis, and roadmap", type: "slides" },
    { id: "review-v1", name: "Review", description: "Project or performance review with status and next steps", type: "slides" },
  ],
  Sheets: [
    { id: "budget-v1", name: "Budget", description: "Budget spreadsheet with categories and variance analysis", type: "sheet" },
    { id: "scorecard-v1", name: "Scorecard", description: "Performance scorecard with KPIs and targets", type: "sheet" },
    { id: "roadmap-v1", name: "Roadmap", description: "Product or project roadmap with phases and milestones", type: "sheet" },
  ],
  Bases: [
    { id: "vendor-register-v1", name: "Vendor Register", description: "Vendor management with contracts and risk ratings", type: "base" },
    { id: "risk-register-v1", name: "Risk Register", description: "Risk management with likelihood, impact, and mitigations", type: "base" },
    { id: "decision-log-v1", name: "Decision Log", description: "Decision tracking with context, options, and outcomes", type: "base" },
  ],
};

const TYPE_ICONS: Record<string, string> = {
  document: "\uD83D\uDCC4",
  slides: "\uD83D\uDCCA",
  sheet: "\uD83D\uDCCA",
  base: "\uD83D\uDDC3\uFE0F",
};

export default function TemplatesPage() {
  const navigate = useNavigate();
  const { templates, loading } = useTemplateList();

  if (loading) {
    return (
      <div>
        <PageHeader
          title="Templates"
          description="Choose a template to create a new artifact"
        />
        <p>Loading...</p>
      </div>
    );
  }

  const hasIpcTemplates = templates.length > 0;

  return (
    <div>
      <PageHeader
        title="Templates"
        description="Choose a template to create a new artifact"
      />

      {!hasIpcTemplates ? (
        Object.entries(BUILTIN_TEMPLATES).map(([category, items]) => (
          <section key={category} style={{ marginBottom: "var(--spacing-xl)" }}>
            <h2 style={{ marginBottom: "var(--spacing-md)" }}>{category}</h2>
            <div
              style={{
                display: "grid",
                gridTemplateColumns: "repeat(auto-fill, minmax(260px, 1fr))",
                gap: "var(--spacing-md)",
              }}
            >
              {items.map((tmpl) => (
                <Card
                  key={tmpl.id}
                  onClick={() => navigate(`/create?template=${tmpl.id}`)}
                >
                  <div
                    style={{
                      display: "flex",
                      alignItems: "center",
                      gap: "var(--spacing-sm)",
                      marginBottom: "var(--spacing-sm)",
                    }}
                  >
                    <span>{TYPE_ICONS[tmpl.type] ?? "\uD83D\uDCC4"}</span>
                    <span className="card-title" style={{ margin: 0 }}>
                      {tmpl.name}
                    </span>
                  </div>
                  <div className="card-description">{tmpl.description}</div>
                </Card>
              ))}
            </div>
          </section>
        ))
      ) : (
        <EmptyState
          icon="\uD83D\uDCCB"
          title="Templates loaded via IPC"
          message={`${templates.length} templates available from the Rust backend.`}
        />
      )}
    </div>
  );
}
