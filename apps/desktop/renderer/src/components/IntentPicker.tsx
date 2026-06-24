import { useState } from "react";
import { FileText, Presentation, Table, Database } from "lucide-react";
import type { LucideIcon } from "lucide-react";
import Card from "./Card";
import Button from "./Button";

/**
 * A curated template surfaced in the intent picker's second step.
 * `id` must be a real template id present in the bundled registry so
 * the Create runner can resolve it; `name`/`description` are display
 * copy kept short for the card grid (they need not match the YAML
 * front-matter verbatim).
 */
export interface IntentTemplate {
  id: string;
  name: string;
  description: string;
}

/**
 * One top-level "What do you need?" choice. Maps a plain-language
 * intent ("Write a document") to a small, hand-picked set of
 * industry-agnostic templates — a deliberately tiny slice of the full
 * 170+ gallery so a first-time, non-technical user is not overwhelmed.
 */
export interface IntentCategory {
  id: string;
  /** Plain-language action shown on the step-1 card. */
  title: string;
  /** One-line elaboration shown beneath the title. */
  description: string;
  Icon: LucideIcon;
  templates: IntentTemplate[];
}

/**
 * The four intent buckets. Template ids are verified against
 * `CreatePage`'s `CATEGORIES` / the bundled registry; each list is
 * intentionally short (3-5) so step 2 stays scannable. The full
 * gallery remains one click away via the "Show all templates" link.
 */
const INTENT_CATEGORIES: IntentCategory[] = [
  {
    id: "document",
    title: "Write a document",
    description: "Drafts, plans, and write-ups grounded in your sources",
    Icon: FileText,
    templates: [
      {
        id: "prd-v1",
        name: "PRD",
        description: "Product Requirements Document",
      },
      { id: "proposal-v1", name: "Proposal", description: "Business proposal" },
      {
        id: "sop-v1",
        name: "SOP",
        description: "Standard Operating Procedure",
      },
      {
        id: "report-v1",
        name: "Report",
        description: "Grounded summary report from your sources",
      },
      {
        id: "meeting-notes-v1",
        name: "Meeting Notes",
        description: "Decisions + actions from a meeting",
      },
    ],
  },
  {
    id: "slides",
    title: "Make a presentation",
    description: "Slide decks for reviews, strategy, and pitches",
    Icon: Presentation,
    templates: [
      { id: "qbr-v1", name: "QBR", description: "Quarterly Business Review" },
      {
        id: "strategy-v1",
        name: "Strategy Deck",
        description: "Strategy deck",
      },
      {
        id: "pitch-v1",
        name: "Pitch Deck",
        description: "Investor / sales pitch",
      },
      {
        id: "training-v1",
        name: "Training Deck",
        description: "Slide-based training",
      },
    ],
  },
  {
    id: "sheet",
    title: "Track data in a spreadsheet",
    description: "Budgets, trackers, and scorecards",
    Icon: Table,
    templates: [
      { id: "budget-v1", name: "Budget", description: "Budget tracker" },
      {
        id: "tracker-v1",
        name: "Tracker",
        description: "General-purpose item tracker",
      },
      {
        id: "scorecard-v1",
        name: "Scorecard",
        description: "Performance scorecard",
      },
    ],
  },
  {
    id: "base",
    title: "Build a database",
    description: "Structured records: CRM, registers, inventories",
    Icon: Database,
    templates: [
      {
        id: "crm-base-v1",
        name: "CRM",
        description: "Contacts, companies, deals, pipeline",
      },
      {
        id: "risk-register-v1",
        name: "Risk Register",
        description: "Risk tracking register",
      },
      {
        id: "asset-inventory-v1",
        name: "Asset Inventory",
        description: "Asset register with serial, owner, location",
      },
    ],
  },
];

interface IntentPickerProps {
  /**
   * Invoked with the chosen template id when the user picks a curated
   * template in step 2. The host decides what to do (navigate to the
   * Create runner, advance an onboarding step, etc.).
   */
  onSelectTemplate: (templateId: string) => void;
  /**
   * Optional escape hatch rendered as a "Show all templates" link
   * beneath step 2. When omitted the link is hidden (e.g. inside the
   * onboarding wizard, which has no full gallery to reveal).
   */
  onShowAll?: () => void;
}

/**
 * Two-step progressive-disclosure picker used by both the Create page
 * and the onboarding wizard:
 *
 *   Step 1 — "What do you need?" (four large intent cards)
 *   Step 2 — "What's it for?" (a handful of curated templates)
 *
 * Step state is internal; the host only learns about the final
 * template selection via `onSelectTemplate`. Keeping the two steps
 * here (rather than in each host) is what lets the onboarding wizard
 * feel like a natural entry into the same Create flow.
 */
export default function IntentPicker({
  onSelectTemplate,
  onShowAll,
}: IntentPickerProps) {
  const [intentId, setIntentId] = useState<string | null>(null);
  const intent = INTENT_CATEGORIES.find((c) => c.id === intentId) ?? null;

  if (!intent) {
    return (
      <div data-testid="intent-picker-step1">
        {/* Step heading sits directly under the page `<h1>` (Create) or
            the wizard dialog title, so it is an `<h2>` — h1 → h2 with no
            skipped level. */}
        <h2
          className="section-title"
          style={{ marginBottom: "var(--spacing-md)" }}
        >
          What do you need?
        </h2>
        <div
          style={{
            display: "grid",
            gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
            gap: "var(--spacing-md)",
          }}
        >
          {INTENT_CATEGORIES.map((c) => (
            <Card key={c.id} onClick={() => setIntentId(c.id)}>
              <div
                style={{
                  display: "flex",
                  alignItems: "center",
                  gap: "var(--spacing-sm)",
                  marginBottom: "var(--spacing-xs)",
                }}
              >
                <span aria-hidden="true" style={{ display: "inline-flex" }}>
                  <c.Icon size={22} strokeWidth={1.75} />
                </span>
                <span className="card-title">{c.title}</span>
              </div>
              <div className="card-description">{c.description}</div>
            </Card>
          ))}
        </div>
      </div>
    );
  }

  return (
    <div data-testid="intent-picker-step2">
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "var(--spacing-md)",
          marginBottom: "var(--spacing-md)",
        }}
      >
        <Button variant="secondary" onClick={() => setIntentId(null)}>
          Back
        </Button>
        <h2 className="section-title" style={{ margin: 0 }}>
          What's it for?
        </h2>
      </div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: "var(--spacing-md)",
        }}
      >
        {intent.templates.map((t) => (
          <Card key={t.id} onClick={() => onSelectTemplate(t.id)}>
            <div className="card-title">{t.name}</div>
            <div className="card-description">{t.description}</div>
          </Card>
        ))}
      </div>
      {onShowAll && (
        <p style={{ marginTop: "var(--spacing-lg)" }}>
          <a
            href="#"
            data-testid="intent-show-all"
            onClick={(e) => {
              e.preventDefault();
              onShowAll();
            }}
          >
            Show all templates
          </a>
        </p>
      )}
    </div>
  );
}
