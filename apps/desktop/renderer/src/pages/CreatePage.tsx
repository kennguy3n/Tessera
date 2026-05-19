import { useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import Card from "../components/Card";

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

export default function CreatePage() {
  const [searchParams] = useSearchParams();
  const navigate = useNavigate();
  const templateId = searchParams.get("template");
  const [activeTab, setActiveTab] = useState(TABS[0]);

  if (templateId) {
    return (
      <div>
        <PageHeader
          title="Create Artifact"
          description={`Template: ${templateId}`}
        />
        <Card>
          <p style={{ color: "var(--color-text-secondary)" }}>
            Artifact creation with the <strong>{templateId}</strong> template
            will be available in Phase 3. The template structure and sections
            are defined in <code>templates/</code>.
          </p>
          <button
            className="btn btn-secondary"
            style={{ marginTop: "var(--spacing-md)" }}
            onClick={() => navigate("/create")}
          >
            Back to Templates
          </button>
        </Card>
      </div>
    );
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
