import { useCallback, useEffect, useMemo, useState } from "react";
import { useSearchParams, useNavigate } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import Card from "../components/Card";
import Button from "../components/Button";
import IntentPicker from "../components/IntentPicker";
import {
  useSourceList,
  useRelatedSourceSuggestions,
} from "../hooks/useSources";
import { useSettings, useUpdateSetting } from "../hooks/useSettings";
import type { CreatePageMode } from "../../../shared/types";
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
  /**
   * Industry domains this template is tailored for. Empty / missing
   * means the template is industry-agnostic ("General"). The
   * CreatePage industry-filter dropdown reads this field. Mirrors
   * the YAML `industry:` field defined in `schemas/template.schema.json`.
   */
  industry?: string[];
  /**
   * Non-English locales for which a translated YAML variant ships in
   * `templates/<category>/locales/<locale>/<slug>.yaml` with id
   * `<base-id>-<locale>` (e.g. `prd-v1-es`). When the user selects a
   * non-English locale from the locale-filter dropdown, the card
   * navigates to the localized id instead of the base id. Listed
   * locales must be present on disk — see
   * `crates/tessera_templates/tests/bundled_templates.rs` for the
   * registry mirror that enforces this.
   */
  availableLocales?: string[];
}

/** Industry filter options surfaced in the CreatePage dropdown. */
const INDUSTRY_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All industries" },
  { value: "general", label: "General" },
  { value: "healthcare", label: "Healthcare" },
  { value: "legal", label: "Legal" },
  { value: "education", label: "Education" },
  { value: "government", label: "Government" },
  { value: "finance", label: "Finance" },
  { value: "manufacturing", label: "Manufacturing" },
  { value: "retail", label: "Retail" },
  { value: "nonprofit", label: "Nonprofit" },
  { value: "creative", label: "Creative / Marketing" },
  { value: "real-estate", label: "Real Estate" },
  { value: "construction", label: "Construction" },
];

/**
 * Locale filter options. Keep in sync with the localized template
 * directories under `templates/*\/locales/<locale>/` and the
 * `availableLocales` entries on the top-10 localized templates.
 */
const LOCALE_OPTIONS: { value: string; label: string }[] = [
  { value: "all", label: "All languages" },
  { value: "en", label: "English" },
  { value: "es", label: "Spanish" },
  { value: "fr", label: "French" },
  { value: "de", label: "German" },
  { value: "ja", label: "Japanese" },
  { value: "zh", label: "Chinese" },
  { value: "pt", label: "Portuguese" },
  { value: "ko", label: "Korean" },
  { value: "ar", label: "Arabic" },
  { value: "hi", label: "Hindi" },
];

/**
 * The set of non-English locales for which the top-10 "core"
 * templates ship a translated variant. Sourced from
 * `templates/<category>/locales/<locale>/<slug>.yaml`. If you add a
 * new locale you must (1) drop the YAML files for all 10 core
 * templates under the new `<locale>/` directory, (2) extend
 * `LOCALE_OPTIONS` above, and (3) extend the `bundled_templates.rs`
 * registry test.
 */
const CORE_LOCALES = ["es", "fr", "de", "ja", "zh", "pt", "ko", "ar", "hi"];

/**
 * Resolve the template id to navigate to when the user clicks a card.
 * Honors the locale-filter selection: for a non-English locale where
 * a localized variant exists on disk, returns `<id>-<locale>`;
 * otherwise returns the base id so the runner falls back to English.
 */
function resolveTemplateId(item: CategoryItem, locale: string): string {
  if (locale === "all" || locale === "en") return item.id;
  if (item.availableLocales?.includes(locale)) {
    return `${item.id}-${locale}`;
  }
  return item.id;
}

/**
 * Does this CategoryItem match the user's industry filter? A template
 * with no `industry` array is treated as "General" so it shows under
 * the General filter AND under "All industries". A template tagged
 * with `["healthcare", "legal"]` shows under either Healthcare or
 * Legal filters.
 */
function matchesIndustry(item: CategoryItem, sel: string): boolean {
  if (sel === "all") return true;
  // Workflow shortcuts are universal entry points (e.g. "Generate
  // report") that produce artifacts regardless of the active industry
  // filter. Hiding them when the user picks a specific industry would
  // leave the tab confusingly empty even when relevant work is
  // available — the underlying template card resolves the artifact
  // for the right industry on its own. Keep workflows visible under
  // every industry, including "General".
  if (item.badge === "workflow") return true;
  const tags = item.industry ?? [];
  if (sel === "general") return tags.length === 0;
  return tags.includes(sel);
}

/**
 * Does this CategoryItem match the user's locale filter? English is
 * the universal default — every template renders in English — so an
 * "en" filter returns true for everything. A non-English filter only
 * matches templates that ship a localized variant for that locale.
 */
function matchesLocale(item: CategoryItem, sel: string): boolean {
  if (sel === "all" || sel === "en") return true;
  // Workflow shortcuts launch the underlying template, which itself
  // resolves to the localized variant via `resolveTemplateId`. Hiding
  // the workflow card on a non-English locale would force the user
  // to find the underlying template card manually, which defeats the
  // shortcut. Keep workflows visible under every locale.
  if (item.badge === "workflow") return true;
  return item.availableLocales?.includes(sel) ?? false;
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
    // Documents — General / Corporate
    {
      id: "prd-v1",
      name: "PRD",
      description: "Product Requirements Document",
      availableLocales: CORE_LOCALES,
    },
    {
      id: "proposal-v1",
      name: "Proposal",
      description: "Business proposal",
      availableLocales: CORE_LOCALES,
    },
    { id: "brief-v1", name: "Brief", description: "One-pager brief" },
    { id: "memo-v1", name: "Memo", description: "Internal memo" },
    {
      id: "sop-v1",
      name: "SOP",
      description: "Standard Operating Procedure",
      availableLocales: CORE_LOCALES,
    },
    {
      id: "form-v1",
      name: "Form",
      description: "Fillable form with fields, validation, and submission notes",
      availableLocales: CORE_LOCALES,
    },
    // Documents — Healthcare
    {
      id: "clinical-protocol-v1",
      name: "Clinical Protocol",
      description:
        "Evidence-based protocol with eligibility, intervention, monitoring, safety stops",
      industry: ["healthcare"],
    },
    {
      id: "patient-care-plan-v1",
      name: "Patient Care Plan",
      description: "Nursing care plan (ADPIE) with assessment, diagnoses, goals",
      industry: ["healthcare"],
    },
    {
      id: "discharge-summary-v1",
      name: "Discharge Summary",
      description: "Hospital discharge summary with course, meds, follow-up",
      industry: ["healthcare"],
    },
    // Documents — Legal
    {
      id: "legal-brief-v1",
      name: "Legal Brief (IRAC)",
      description: "IRAC-format brief with standard of review and authorities",
      industry: ["legal"],
    },
    {
      id: "case-intake-v1",
      name: "Case Intake",
      description: "Client intake with matter, conflicts, fee structure",
      industry: ["legal"],
    },
    // Documents — Education
    {
      id: "lesson-plan-v1",
      name: "Lesson Plan",
      description: "Standards-aligned lesson plan with objectives and assessment",
      industry: ["education"],
    },
    {
      id: "course-syllabus-v1",
      name: "Course Syllabus",
      description: "Course syllabus with outcomes, schedule, grading, policies",
      industry: ["education"],
    },
    // Documents — Government
    {
      id: "policy-brief-v1",
      name: "Policy Brief",
      description: "Policy brief with options, recommendation, equity impact",
      industry: ["government", "nonprofit"],
    },
    {
      id: "grant-proposal-v1",
      name: "Grant Proposal",
      description: "Grant application with need, methods, budget, evaluation",
      industry: ["government", "nonprofit", "education"],
    },
    // Documents — Nonprofit
    {
      id: "donor-report-v1",
      name: "Donor Report",
      description: "Donor impact report with outcomes, stories, stewardship",
      industry: ["nonprofit"],
    },
    {
      id: "volunteer-handbook-v1",
      name: "Volunteer Handbook",
      description: "Volunteer onboarding with roles, policies, contacts",
      industry: ["nonprofit"],
    },
    // Documents — Creative / Marketing
    {
      id: "brand-guidelines-v1",
      name: "Brand Guidelines",
      description: "Brand identity guide with voice, visual identity, usage",
      industry: ["creative"],
    },
    {
      id: "content-calendar-v1",
      name: "Content Calendar",
      description: "Editorial calendar with channels, topics, owners, deadlines",
      industry: ["creative"],
    },
    {
      id: "campaign-brief-v1",
      name: "Campaign Brief",
      description:
        "Marketing campaign brief with audience, channels, KPIs, timeline",
      industry: ["creative"],
    },
    // Slides — General
    {
      id: "pitch-v1",
      name: "Pitch Deck",
      description: "Investor / sales pitch",
      availableLocales: CORE_LOCALES,
    },
    { id: "training-v1", name: "Training Deck", description: "Slide-based training" },
    {
      id: "onboarding-deck-v1",
      name: "Employee Onboarding Deck",
      description:
        "New-hire onboarding with company, role, 30/60/90 plan",
    },
    {
      id: "sales-enablement-deck-v1",
      name: "Sales Enablement Deck",
      description:
        "Product demo deck with discovery recap, walk-through, mutual action plan",
    },
    {
      id: "workshop-deck-v1",
      name: "Workshop Deck",
      description: "Workshop facilitation deck with exercises and debrief",
    },
    {
      id: "board-update-deck-v1",
      name: "Board Update",
      description:
        "Quarterly board update covering performance, financials, strategy, risks",
    },
    {
      id: "investor-update-deck-v1",
      name: "Investor Update",
      description:
        "Monthly or quarterly investor update with metrics, wins, lowlights, asks",
    },
    // Visuals — existing rich infographic/landing-page YAMLs
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
    // Visuals — new
    {
      id: "infographic-timeline-v1",
      name: "Timeline",
      description: "Historical or project timeline infographic",
    },
    {
      id: "infographic-org-chart-v1",
      name: "Org Chart",
      description:
        "Organization chart with hierarchy, span of control, matrix relationships",
    },
    {
      id: "infographic-kpi-dashboard-v1",
      name: "KPI Dashboard",
      description: "Headline KPIs with trend, target lines, annotations",
    },
    {
      id: "landing-nonprofit-v1",
      name: "Nonprofit Landing",
      description: "Mission landing with stories, impact, donate CTAs",
      industry: ["nonprofit"],
    },
    {
      id: "landing-event-v1",
      name: "Event Landing",
      description: "Conference / event registration with speakers, agenda, tickets",
    },
    {
      id: "landing-portfolio-v1",
      name: "Portfolio Landing",
      description: "Designer / agency portfolio with bio, services, case studies",
      industry: ["creative"],
    },
  ],
  Analyze: [
    // Workflows surface at the top so they're the first thing users
    // see when they open the Analyze tab. They reference the underlying
    // `report-v1` template, which ships localized variants under
    // `templates/documents/locales/<locale>/`. Mirroring `availableLocales`
    // here ensures clicking a workflow under a non-English locale
    // resolves to the localized template id (e.g. `report-v1-es`),
    // matching the behavior of the canonical "Report" card below.
    {
      id: "report-v1",
      name: "Summarize sources",
      description:
        "Pick one or more sources and Tessera will draft a grounded summary report.",
      badge: "workflow",
      availableLocales: CORE_LOCALES,
    },
    {
      id: "report-v1",
      name: "Generate report",
      description:
        "Use the Report template with your selected sources for an analytical write-up.",
      badge: "workflow",
      availableLocales: CORE_LOCALES,
    },
    {
      id: "report-v1",
      name: "Analyze spreadsheet",
      description: "Generate insights from a Sheet artifact.",
      badge: "workflow",
      availableLocales: CORE_LOCALES,
      sourceHint:
        "Pick a Sheet you've already imported as a source — the report will cite its rows.",
    },
    {
      id: "report-v1",
      name: "Report",
      description: "Analytical report",
      availableLocales: CORE_LOCALES,
    },
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
    // Analyze — Finance
    {
      id: "financial-analysis-v1",
      name: "Financial Analysis",
      description: "Ratio analysis, trend analysis, peer comparison, scenarios",
      industry: ["finance"],
    },
    {
      id: "investment-memo-v1",
      name: "Investment Memo",
      description: "Deal thesis with market, traction, valuation, risks",
      industry: ["finance"],
    },
    {
      id: "audit-findings-v1",
      name: "Audit Findings",
      description: "Internal audit findings with root cause and remediation",
      industry: ["finance", "legal"],
    },
    {
      id: "compliance-audit-v1",
      name: "Compliance Audit",
      description: "Compliance audit with findings, evidence, remediation plan",
      industry: ["legal", "finance"],
    },
    // Analyze — Government / Policy
    {
      id: "impact-assessment-v1",
      name: "Impact Assessment",
      description: "Regulatory impact assessment with cost-benefit, equity",
      industry: ["government"],
    },
    {
      id: "public-consultation-report-v1",
      name: "Public Consultation Report",
      description: "Public consultation summary with themes and agency response",
      industry: ["government"],
    },
    // Analyze — Education
    {
      id: "student-progress-report-v1",
      name: "Student Progress Report",
      description: "Student academic, behavioral, and SEL progress",
      industry: ["education"],
    },
    // Analyze — Healthcare / Safety
    {
      id: "hipaa-incident-report-v1",
      name: "HIPAA Incident Report",
      description: "HIPAA breach / incident with timeline, risk assessment",
      industry: ["healthcare", "legal"],
    },
    {
      id: "safety-incident-report-v1",
      name: "Safety Incident Report",
      description: "Workplace safety incident with root cause, OSHA reporting",
      industry: ["manufacturing", "healthcare", "construction"],
    },
    // Analyze — Manufacturing / Real Estate
    {
      id: "quality-control-report-v1",
      name: "QC Report",
      description: "Quality control with sampling, defect Pareto, capability",
      industry: ["manufacturing"],
    },
    {
      id: "property-analysis-v1",
      name: "Property Investment Analysis",
      description: "Property analysis with comps, pro forma, returns, exit",
      industry: ["real-estate"],
    },
  ],
  Plan: [
    { id: "strategy-v1", name: "Strategy Deck", description: "Strategy deck" },
    { id: "roadmap-v1", name: "Roadmap", description: "Project roadmap (Sheet)" },
    {
      id: "roadmap-base-v1",
      name: "Roadmap (Base)",
      description: "Roadmap as a structured Base with initiatives, themes, owners",
    },
    {
      id: "budget-v1",
      name: "Budget",
      description: "Budget tracker",
      availableLocales: CORE_LOCALES,
    },
    {
      id: "tracker-v1",
      name: "Tracker",
      description: "General-purpose item tracker (status, owner, due date)",
    },
    {
      id: "inventory-v1",
      name: "Inventory",
      description: "Inventory sheet with SKU, quantity, reorder level",
    },
    { id: "project-plan-v1", name: "Project Plan", description: "Phased project plan" },
    {
      id: "task-list-v1",
      name: "Task List",
      description: "Task list with owners",
      availableLocales: CORE_LOCALES,
    },
    {
      id: "launch-checklist-v1",
      name: "Launch Checklist",
      description: "Go-live readiness checklist",
    },
    {
      id: "meeting-agenda-v1",
      name: "Meeting Agenda",
      description: "Structured meeting agenda",
      availableLocales: CORE_LOCALES,
    },
    {
      id: "meeting-notes-v1",
      name: "Meeting Notes",
      description: "Decisions + actions from a meeting",
      availableLocales: CORE_LOCALES,
    },
    // Plan — Industry-Specific
    {
      id: "curriculum-map-v1",
      name: "Curriculum Map",
      description: "Standards-aligned curriculum map with scope and sequence",
      industry: ["education"],
    },
    {
      id: "maintenance-schedule-v1",
      name: "Maintenance Schedule",
      description: "PM schedule with FMEA, intervals, parts, KPIs",
      industry: ["manufacturing"],
    },
    {
      id: "sales-forecast-v1",
      name: "Sales Forecast",
      description: "Sales forecast with seasonality, scenarios, actuals tracking",
      industry: ["retail", "finance"],
    },
    {
      id: "product-catalog-v1",
      name: "Product Catalog",
      description: "Retail catalog with SKUs, variants, pricing, inventory",
      industry: ["retail"],
    },
    {
      id: "crm-base-v1",
      name: "CRM (Base)",
      description: "Lightweight CRM with contacts, companies, deals, pipeline",
    },
    {
      id: "employee-directory-base-v1",
      name: "Employee Directory",
      description: "Employee directory with reporting hierarchy and skills",
    },
    {
      id: "incident-tracker-base-v1",
      name: "Incident Tracker",
      description: "Incident tracker with severity, timeline, root cause",
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
    {
      id: "asset-inventory-v1",
      name: "Asset Inventory",
      description: "Asset register Base with serial, owner, location, status",
    },
    // Approve — Industry-specific
    {
      id: "contract-summary-v1",
      name: "Contract Summary",
      description: "Contract review with key terms, obligations, risks",
      industry: ["legal"],
    },
    {
      id: "loan-proposal-v1",
      name: "Loan / Credit Proposal",
      description: "Credit proposal with financials, collateral, covenants",
      industry: ["finance"],
    },
    {
      id: "lease-summary-v1",
      name: "Lease Summary",
      description: "Commercial lease abstract with rent, term, red flags",
      industry: ["real-estate", "legal"],
    },
    {
      id: "compliance-register-base-v1",
      name: "Compliance Register",
      description: "Compliance obligations register with controls and attestation",
      industry: ["finance", "legal", "healthcare"],
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
  // Localized templates use the `<base-id>-<locale>` suffix convention
  // (e.g. `prd-v1-es`), but CATEGORIES only lists base ids — the
  // locale-aware `resolveTemplateId` adds the suffix at link time. To
  // keep the runner's loading state showing a human-friendly name
  // (e.g. "PRD" rather than the raw "prd-v1-es"), fall back to the
  // base id by stripping a trailing `-<locale>` segment whose locale
  // matches one of the known LOCALE_OPTIONS. We only strip when the
  // suffixed id is not directly in CATEGORIES — that way a future
  // locale-variant added to CATEGORIES wins over the stripped lookup.
  const lookupIds = [id];
  const lastDash = id.lastIndexOf("-");
  if (lastDash > 0) {
    const suffix = id.slice(lastDash + 1);
    const knownLocale = LOCALE_OPTIONS.some(
      (opt) => opt.value === suffix && opt.value !== "all" && opt.value !== "en",
    );
    if (knownLocale) {
      lookupIds.push(id.slice(0, lastDash));
    }
  }
  if (preferWorkflow) {
    for (const candidate of lookupIds) {
      for (const list of Object.values(CATEGORIES)) {
        const match = list.find(
          (c) => c.id === candidate && c.name === preferWorkflow,
        );
        if (match) return match;
      }
    }
  }
  for (const candidate of lookupIds) {
    for (const list of Object.values(CATEGORIES)) {
      const match = list.find(
        (c) => c.id === candidate && c.badge !== "workflow",
      );
      if (match) return match;
    }
  }
  for (const candidate of lookupIds) {
    for (const list of Object.values(CATEGORIES)) {
      const match = list.find((c) => c.id === candidate);
      if (match) return match;
    }
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
  const [selectedIndustry, setSelectedIndustry] = useState<string>("all");
  const [selectedLocale, setSelectedLocale] = useState<string>("all");

  const { settings } = useSettings();
  const { update } = useUpdateSetting();
  // Local override wins immediately when the user flips between the
  // guided wizard and the full gallery via the in-page links, while
  // `update()` persists the choice so it survives relaunches and
  // syncs other surfaces. Until the user clicks, the persisted
  // `createPageMode` (default `"wizard"`) drives the view.
  const [modeOverride, setModeOverride] = useState<CreatePageMode | null>(null);
  const mode = modeOverride ?? settings.createPageMode;
  const setMode = useCallback(
    (next: CreatePageMode) => {
      setModeOverride(next);
      void update({ createPageMode: next });
    },
    [update],
  );

  if (templateId) {
    return (
      <TemplateRunner templateId={templateId} workflow={workflow} />
    );
  }

  if (mode === "wizard") {
    return (
      <div>
        <PageHeader
          title="Create"
          description="Tell us what you need and we'll suggest a starting point."
          actions={
            <Button variant="secondary" onClick={() => setMode("gallery")}>
              Show all templates
            </Button>
          }
        />
        <IntentPicker
          onSelectTemplate={(id) => navigate(`/create?template=${id}`)}
          onShowAll={() => setMode("gallery")}
        />
      </div>
    );
  }

  const visibleItems = CATEGORIES[activeTab].filter(
    (item) =>
      matchesIndustry(item, selectedIndustry) &&
      matchesLocale(item, selectedLocale),
  );

  return (
    <div>
      <PageHeader
        title="Create"
        description={TAB_DESCRIPTIONS[activeTab]}
        actions={
          <Button variant="secondary" onClick={() => setMode("wizard")}>
            Guided picker
          </Button>
        }
      />

      <div
        role="tablist"
        aria-label="Template category"
        style={{
          display: "flex",
          gap: "var(--spacing-xs)",
          marginBottom: "var(--spacing-md)",
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
        data-testid="create-template-filters"
        style={{
          display: "flex",
          flexWrap: "wrap",
          gap: "var(--spacing-md)",
          alignItems: "center",
          marginBottom: "var(--spacing-lg)",
        }}
      >
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--spacing-xs)",
            fontSize: "var(--font-size-sm)",
            color: "var(--color-text-secondary)",
          }}
        >
          Industry
          <select
            data-testid="industry-filter"
            value={selectedIndustry}
            onChange={(e) => setSelectedIndustry(e.target.value)}
            style={{
              padding: "0.25rem 0.5rem",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--color-border)",
              background: "var(--color-surface)",
              color: "var(--color-text)",
              fontSize: "var(--font-size-sm)",
            }}
          >
            {INDUSTRY_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <label
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "var(--spacing-xs)",
            fontSize: "var(--font-size-sm)",
            color: "var(--color-text-secondary)",
          }}
        >
          Language
          <select
            data-testid="locale-filter"
            value={selectedLocale}
            onChange={(e) => setSelectedLocale(e.target.value)}
            style={{
              padding: "0.25rem 0.5rem",
              borderRadius: "var(--radius-sm)",
              border: "1px solid var(--color-border)",
              background: "var(--color-surface)",
              color: "var(--color-text)",
              fontSize: "var(--font-size-sm)",
            }}
          >
            {LOCALE_OPTIONS.map((opt) => (
              <option key={opt.value} value={opt.value}>
                {opt.label}
              </option>
            ))}
          </select>
        </label>
        <span
          data-testid="filter-count"
          style={{
            fontSize: "var(--font-size-xs)",
            color: "var(--color-text-secondary)",
            marginLeft: "auto",
          }}
        >
          Showing {visibleItems.length} of {CATEGORIES[activeTab].length}{" "}
          {activeTab.toLowerCase()} templates
        </span>
      </div>

      {visibleItems.length === 0 ? (
        <div
          data-testid="filter-empty-state"
          style={{
            textAlign: "center",
            padding: "var(--spacing-xl)",
            border: "1px dashed var(--color-border)",
            borderRadius: "var(--radius-md)",
            color: "var(--color-text-secondary)",
          }}
        >
          No {activeTab.toLowerCase()} templates match the selected industry +
          language filters. Try widening the filters or switching tabs.
        </div>
      ) : (
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(240px, 1fr))",
            gap: "var(--spacing-md)",
          }}
        >
          {visibleItems.map((item) => {
            // Workflows pass `workflow=<name>` to the runner so it can
            // load the workflow-specific hint copy. Regular template
            // cards just navigate with the template id, resolved
            // against the locale filter so non-English selections
            // route to the localized variant id (e.g. `prd-v1-es`).
            const resolvedId = resolveTemplateId(item, selectedLocale);
            const target =
              item.badge === "workflow"
                ? `/create?template=${resolvedId}&workflow=${encodeURIComponent(item.name)}`
                : `/create?template=${resolvedId}`;
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
                {item.industry && item.industry.length > 0 && (
                  <div
                    data-testid="card-industry-tags"
                    style={{
                      marginTop: "var(--spacing-xs)",
                      display: "flex",
                      flexWrap: "wrap",
                      gap: "0.25rem",
                    }}
                  >
                    {item.industry.map((tag) => (
                      <span
                        key={tag}
                        style={{
                          fontSize: "var(--font-size-xs)",
                          color: "var(--color-text-secondary)",
                          background: "var(--color-surface-soft, #f3f4f6)",
                          padding: "0.0625rem 0.375rem",
                          borderRadius: "999px",
                        }}
                      >
                        {tag}
                      </span>
                    ))}
                  </div>
                )}
              </Card>
            );
          })}
        </div>
      )}
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
  // Tri-state model availability for the text slot: `null` while the
  // `runtime.getCurrentModel` probe is in flight, then `true` once a
  // model is installed (LLM drafting available) or `false` when the
  // slot is empty (extraction-only — artifacts are assembled from
  // raw source material). Drives the "AI-enhanced" vs "Source-based"
  // badge, the Generate button label, and the inline explanation.
  const [modelAvailable, setModelAvailable] = useState<boolean | null>(null);

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

  useEffect(() => {
    let cancelled = false;
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api) {
      // No bridge (e.g. unit test without a runtime mock): treat as
      // extraction-only so the UI sets honest "Source-based"
      // expectations rather than implying AI drafting.
      setModelAvailable(false);
      return () => {
        cancelled = true;
      };
    }
    api.runtime
      .getCurrentModel("text")
      .then((record) => {
        if (cancelled) return;
        setModelAvailable(record !== null);
      })
      .catch(() => {
        if (cancelled) return;
        setModelAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const toggle = useCallback((id: string) => {
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  // Concept-graph smart suggestions: as the user builds their working
  // set, the substrate surfaces other indexed sources that co-occur (by
  // entity) with the selection — replacing the manual "search and hunt"
  // step with a one-click "include these too" affordance.
  // `selected` is a Set whose reference only changes when the working
  // set actually changes, so memoising on it avoids allocating a fresh
  // array on unrelated re-renders. The hook already derives a stable
  // string key internally, so this is purely an allocation nicety.
  const selectedIds = useMemo(() => Array.from(selected), [selected]);
  const { suggestions } = useRelatedSourceSuggestions(selectedIds);
  // Only suggest sources that still exist in the live list and aren't
  // already selected (the substrate already excludes selected ids, but
  // the source list can lag a removal — defend against a stale id).
  const knownSourceIds = new Set(sources.map((s) => s.id));
  const visibleSuggestions = suggestions
    .map((suggestion) => ({
      ...suggestion,
      sourceIds: suggestion.sourceIds.filter(
        (id) => knownSourceIds.has(id) && !selected.has(id),
      ),
    }))
    .filter((suggestion) => suggestion.sourceIds.length > 0);

  const includeSuggestion = useCallback((sourceIds: string[]) => {
    setSelected((prev) => {
      const next = new Set(prev);
      for (const id of sourceIds) next.add(id);
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
      if (!artifact?.id) {
        setGen({
          status: "error",
          message: "Generation did not return an artifact. Please try again.",
        });
        return;
      }
      setGen({ status: "success", message: artifact.id });
      // /artifacts/:id is NOT a registered route (the router only
      // registers /artifacts/:id/edit; the catch-all redirects to "/"),
      // so navigating there silently sends the user to Home instead of
      // the artifact they just generated. Go straight to the editor,
      // matching HomePage's recent-artifact cards and the command palette.
      navigate(`/artifacts/${artifact.id}/edit`);
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
          <div
            style={{
              display: "flex",
              alignItems: "center",
              gap: "var(--spacing-sm)",
            }}
          >
            {modelAvailable !== null && (
              <span
                data-testid="create-model-badge"
                title={
                  modelAvailable
                    ? "A local AI model is installed — generation drafts and summarizes your sources."
                    : "No AI model installed yet — artifacts are assembled directly from your source material."
                }
                style={{
                  fontSize: "var(--font-size-xs)",
                  fontWeight: 600,
                  padding: "0.125rem 0.5rem",
                  borderRadius: "999px",
                  color: modelAvailable
                    ? "var(--color-primary, #7C3AED)"
                    : "var(--color-text-secondary)",
                  background: modelAvailable
                    ? "var(--color-primary-soft, #ede9fe)"
                    : "var(--color-surface-soft, #f3f4f6)",
                }}
              >
                {modelAvailable ? "AI-enhanced" : "Source-based"}
              </span>
            )}
            <Button variant="secondary" onClick={() => navigate("/create")}>
              Back to Templates
            </Button>
          </div>
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

        {visibleSuggestions.length > 0 && (
          <div
            data-testid="create-related-suggestions"
            style={{
              marginTop: "var(--spacing-md)",
              padding: "var(--spacing-sm) var(--spacing-md)",
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
              background: "var(--color-surface-soft)",
            }}
          >
            <h4
              style={{
                margin: 0,
                marginBottom: "var(--spacing-xs)",
                fontSize: "var(--font-size-sm)",
              }}
            >
              Related sources
            </h4>
            <ul style={{ listStyle: "none", padding: 0, margin: 0 }}>
              {visibleSuggestions.map((suggestion) => {
                const count = suggestion.sourceIds.length;
                return (
                  <li
                    key={suggestion.entity}
                    style={{
                      display: "flex",
                      alignItems: "center",
                      justifyContent: "space-between",
                      gap: "var(--spacing-sm)",
                      padding: "var(--spacing-xs) 0",
                    }}
                  >
                    <span style={{ fontSize: "var(--font-size-sm)" }}>
                      You have {count} more source{count === 1 ? "" : "s"}{" "}
                      about <strong>{suggestion.entity}</strong>.
                    </span>
                    <Button
                      variant="secondary"
                      onClick={() => includeSuggestion(suggestion.sourceIds)}
                      aria-label={`Include ${count} source${
                        count === 1 ? "" : "s"
                      } about ${suggestion.entity}`}
                    >
                      Include {count === 1 ? "it" : "them"}
                    </Button>
                  </li>
                );
              })}
            </ul>
          </div>
        )}

        {modelAvailable === false && (
          <p
            data-testid="create-extraction-note"
            style={{
              marginTop: "var(--spacing-md)",
              fontSize: "var(--font-size-sm)",
              color: "var(--color-text-secondary)",
            }}
          >
            AI model is downloading. You can create from your source material
            now, or wait for AI-powered generation.
          </p>
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
            {gen.status === "loading"
              ? modelAvailable === false
                ? "Creating…"
                : "Generating…"
              : modelAvailable === false
                ? "Create from sources"
                : "Generate"}
          </Button>
          {gen.status === "loading" && (
            <span data-testid="create-generating" style={{ fontSize: "var(--font-size-sm)" }}>
              {modelAvailable === false
                ? "Assembling from your sources…"
                : "Generating from the local model…"}
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
