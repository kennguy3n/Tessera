/**
 * Pre-built deck templates for the Slide editor.
 *
 * A template is a reusable "starter deck" — a named collection of
 * slides with pre-populated titles, content placeholders, layout
 * assignments, and speaker-notes scaffolds. Think of it as the
 * equivalent of Google Slides' "Pitch", "Report", "Lookbook" etc.
 * templates, but tailored for local-first SME use.
 *
 * Templates are metadata only: they describe the deck shape and
 * placeholder content but contain no React, no IPC, no images.
 * The editor materialises a template into real `Slide[]` via
 * `buildDeckFromTemplate()` which calls `buildSlideFromLayout` +
 * fills in the placeholder content.
 *
 * Mirrors `slideThemes.ts` / `slideLayouts.ts` pattern: pure metadata
 * module with no side effects.
 */
import type { SlideLayout } from "./slideEditorTypes";

/** A slide blueprint within a template. */
export interface TemplateSlide {
  /** Layout to use for this slide. */
  layout: SlideLayout;
  /** Pre-filled title. Empty string for layouts that don't need one. */
  title: string;
  /** Pre-filled blocks (type + content + slot). */
  blocks: ReadonlyArray<{
    type: "text" | "bullets" | "image";
    content: string;
    slot?: string;
  }>;
  /** Optional speaker-notes scaffold. */
  notes?: string;
}

export interface SlideTemplate {
  /** Stable id — persisted nowhere (templates are stateless starters). */
  id: string;
  /** Human label for the template picker. */
  label: string;
  /** One-line description. */
  description: string;
  /** Icon glyph for the picker card. */
  icon: string;
  /** Suggested theme id (from slideThemes.ts). */
  suggestedTheme?: string;
  /** Ordered slide blueprints. */
  slides: readonly TemplateSlide[];
}

/**
 * Insert-card presets — single-slide patterns the user can quick-add
 * from the toolbar. Smaller than a full template: one slide with
 * pre-populated layout + content placeholders.
 */
export interface InsertCardPreset {
  id: string;
  label: string;
  description: string;
  icon: string;
  layout: SlideLayout;
  title: string;
  blocks: ReadonlyArray<{
    type: "text" | "bullets" | "image";
    content: string;
    slot?: string;
  }>;
}

// ---------------------------------------------------------------------------
// Template catalogue
// ---------------------------------------------------------------------------

export const SLIDE_TEMPLATES: readonly SlideTemplate[] = [
  {
    id: "pitch",
    label: "Pitch Deck",
    description: "Classic startup / product pitch — problem → solution → traction → ask.",
    icon: "🚀",
    suggestedTheme: "aurora",
    slides: [
      {
        layout: "title",
        title: "Company Name",
        blocks: [],
        notes: "Introduce yourself and the company in one sentence.",
      },
      {
        layout: "titleContent",
        title: "The Problem",
        blocks: [
          {
            type: "bullets",
            content: "Pain point #1\nPain point #2\nPain point #3",
            slot: "body",
          },
        ],
        notes: "Describe the core problem your audience faces.",
      },
      {
        layout: "titleContent",
        title: "Our Solution",
        blocks: [
          {
            type: "text",
            content: "A clear, one-line value proposition.",
            slot: "body",
          },
        ],
        notes: "Explain how your product solves the problem.",
      },
      {
        layout: "twoColumn",
        title: "How It Works",
        blocks: [
          { type: "text", content: "Step 1: …", slot: "left" },
          { type: "text", content: "Step 2: …", slot: "right" },
        ],
      },
      {
        layout: "bigNumber",
        title: "",
        blocks: [
          { type: "text", content: "10x", slot: "number" },
          { type: "text", content: "improvement in key metric", slot: "caption" },
        ],
        notes: "Share your most impressive traction metric.",
      },
      {
        layout: "titleContent",
        title: "The Ask",
        blocks: [
          {
            type: "text",
            content: "What you need from the audience.",
            slot: "body",
          },
        ],
        notes: "State your funding ask or call to action.",
      },
      {
        layout: "sectionHeader",
        title: "Thank You",
        blocks: [
          { type: "text", content: "your@email.com", slot: "subtitle" },
        ],
      },
    ],
  },
  {
    id: "status-report",
    label: "Status Report",
    description: "Weekly / monthly progress update — highlights, metrics, blockers, next steps.",
    icon: "📊",
    suggestedTheme: "slate",
    slides: [
      {
        layout: "title",
        title: "Status Report",
        blocks: [],
        notes: "Set the date range and project name.",
      },
      {
        layout: "titleContent",
        title: "Highlights",
        blocks: [
          {
            type: "bullets",
            content: "Completed feature X\nShipped release v2.1\nOnboarded 3 new clients",
            slot: "body",
          },
        ],
      },
      {
        layout: "twoColumn",
        title: "Key Metrics",
        blocks: [
          { type: "text", content: "Revenue: $X\nGrowth: Y%", slot: "left" },
          { type: "text", content: "Users: N\nChurn: Z%", slot: "right" },
        ],
      },
      {
        layout: "titleContent",
        title: "Blockers & Risks",
        blocks: [
          {
            type: "bullets",
            content: "Dependency on team X\nBudget constraint\nTimeline risk",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Next Steps",
        blocks: [
          {
            type: "bullets",
            content: "Action item 1\nAction item 2\nAction item 3",
            slot: "body",
          },
        ],
      },
    ],
  },
  {
    id: "workshop",
    label: "Workshop",
    description: "Interactive session — agenda, activities, discussion, takeaways.",
    icon: "🎓",
    suggestedTheme: "mint",
    slides: [
      {
        layout: "title",
        title: "Workshop Title",
        blocks: [],
        notes: "Welcome participants. State learning objectives.",
      },
      {
        layout: "titleContent",
        title: "Agenda",
        blocks: [
          {
            type: "bullets",
            content: "Introduction (10 min)\nActivity 1 (20 min)\nDiscussion (15 min)\nWrap-up (5 min)",
            slot: "body",
          },
        ],
      },
      {
        layout: "sectionHeader",
        title: "Activity 1",
        blocks: [
          { type: "text", content: "Instructions for the first exercise", slot: "subtitle" },
        ],
      },
      {
        layout: "twoColumn",
        title: "Discussion",
        blocks: [
          { type: "text", content: "Question 1: …", slot: "left" },
          { type: "text", content: "Question 2: …", slot: "right" },
        ],
      },
      {
        layout: "titleContent",
        title: "Key Takeaways",
        blocks: [
          {
            type: "bullets",
            content: "Takeaway 1\nTakeaway 2\nTakeaway 3",
            slot: "body",
          },
        ],
      },
      {
        layout: "sectionHeader",
        title: "Questions?",
        blocks: [
          { type: "text", content: "", slot: "subtitle" },
        ],
      },
    ],
  },
  {
    id: "project-proposal",
    label: "Project Proposal",
    description: "Structured proposal — objective, scope, timeline, budget, team.",
    icon: "📋",
    suggestedTheme: "editorial",
    slides: [
      {
        layout: "title",
        title: "Project Proposal",
        blocks: [],
      },
      {
        layout: "titleContent",
        title: "Objective",
        blocks: [
          {
            type: "text",
            content: "Clearly state the project goal and expected outcomes.",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Scope & Deliverables",
        blocks: [
          {
            type: "bullets",
            content: "Deliverable 1\nDeliverable 2\nDeliverable 3\nOut of scope: …",
            slot: "body",
          },
        ],
      },
      {
        layout: "twoColumn",
        title: "Timeline & Budget",
        blocks: [
          { type: "text", content: "Phase 1: Q1\nPhase 2: Q2\nPhase 3: Q3", slot: "left" },
          { type: "text", content: "Total: $X\nHeadcount: N\nTools: $Y", slot: "right" },
        ],
      },
      {
        layout: "titleContent",
        title: "Team & Resources",
        blocks: [
          {
            type: "bullets",
            content: "Lead: Name\nDesign: Name\nEngineering: Name",
            slot: "body",
          },
        ],
      },
      {
        layout: "sectionHeader",
        title: "Next Steps",
        blocks: [
          { type: "text", content: "Approval → Kickoff → First milestone", slot: "subtitle" },
        ],
      },
    ],
  },
  {
    id: "retrospective",
    label: "Retrospective",
    description: "Sprint / project retro — what went well, what didn't, action items.",
    icon: "🔄",
    suggestedTheme: "ocean",
    slides: [
      {
        layout: "title",
        title: "Retrospective",
        blocks: [],
        notes: "Set context: sprint/project name, dates.",
      },
      {
        layout: "titleContent",
        title: "What Went Well",
        blocks: [
          {
            type: "bullets",
            content: "Positive outcome 1\nPositive outcome 2\nPositive outcome 3",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "What Didn't Go Well",
        blocks: [
          {
            type: "bullets",
            content: "Challenge 1\nChallenge 2\nChallenge 3",
            slot: "body",
          },
        ],
      },
      {
        layout: "twoColumn",
        title: "Root Causes",
        blocks: [
          { type: "text", content: "Process gaps", slot: "left" },
          { type: "text", content: "Technical debt", slot: "right" },
        ],
      },
      {
        layout: "titleContent",
        title: "Action Items",
        blocks: [
          {
            type: "bullets",
            content: "Action 1 — Owner: …\nAction 2 — Owner: …\nAction 3 — Owner: …",
            slot: "body",
          },
        ],
      },
    ],
  },
  {
    id: "case-study",
    label: "Case Study",
    description: "Client success story — challenge, approach, results, testimonial.",
    icon: "💼",
    suggestedTheme: "rosewood",
    slides: [
      {
        layout: "title",
        title: "Case Study: Client Name",
        blocks: [],
      },
      {
        layout: "titleContent",
        title: "The Challenge",
        blocks: [
          {
            type: "text",
            content: "Describe the client's situation and pain points.",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Our Approach",
        blocks: [
          {
            type: "bullets",
            content: "Step 1: Discovery\nStep 2: Implementation\nStep 3: Optimisation",
            slot: "body",
          },
        ],
      },
      {
        layout: "bigNumber",
        title: "",
        blocks: [
          { type: "text", content: "300%", slot: "number" },
          { type: "text", content: "improvement in key outcome", slot: "caption" },
        ],
      },
      {
        layout: "quote",
        title: "",
        blocks: [
          { type: "text", content: "This solution transformed how we work.", slot: "quote" },
          { type: "text", content: "— Client Name, Title", slot: "attribution" },
        ],
      },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Insert-card presets
// ---------------------------------------------------------------------------

export const INSERT_CARD_PRESETS: readonly InsertCardPreset[] = [
  {
    id: "stat-card",
    label: "Stat Card",
    description: "Hero number with caption",
    icon: "#",
    layout: "bigNumber",
    title: "",
    blocks: [
      { type: "text", content: "42%", slot: "number" },
      { type: "text", content: "Key metric description", slot: "caption" },
    ],
  },
  {
    id: "comparison",
    label: "Comparison",
    description: "Side-by-side two columns",
    icon: "⇔",
    layout: "twoColumn",
    title: "Comparison",
    blocks: [
      { type: "text", content: "Option A", slot: "left" },
      { type: "text", content: "Option B", slot: "right" },
    ],
  },
  {
    id: "quote-card",
    label: "Quote",
    description: "Centred quotation with attribution",
    icon: "❝",
    layout: "quote",
    title: "",
    blocks: [
      { type: "text", content: "Your quote here.", slot: "quote" },
      { type: "text", content: "— Author", slot: "attribution" },
    ],
  },
  {
    id: "section-break",
    label: "Section Break",
    description: "Bold section divider",
    icon: "◆",
    layout: "sectionHeader",
    title: "New Section",
    blocks: [
      { type: "text", content: "", slot: "subtitle" },
    ],
  },
  {
    id: "image-text",
    label: "Image + Text",
    description: "Image left with text body",
    icon: "▣",
    layout: "imageLeft",
    title: "Visual Point",
    blocks: [
      { type: "image", content: "", slot: "image" },
      { type: "text", content: "Describe the visual.", slot: "body" },
    ],
  },
  {
    id: "bullet-list",
    label: "Bullet List",
    description: "Title with key points",
    icon: "•",
    layout: "titleContent",
    title: "Key Points",
    blocks: [
      {
        type: "bullets",
        content: "Point 1\nPoint 2\nPoint 3",
        slot: "body",
      },
    ],
  },
  {
    id: "blank-card",
    label: "Blank Slide",
    description: "Empty canvas",
    icon: "□",
    layout: "blank",
    title: "",
    blocks: [
      { type: "text", content: "", slot: "body" },
    ],
  },
] as const;

// ---------------------------------------------------------------------------
// Template lookup
// ---------------------------------------------------------------------------

const TEMPLATE_BY_ID: ReadonlyMap<string, SlideTemplate> = new Map(
  SLIDE_TEMPLATES.map((t) => [t.id, t]),
);

const PRESET_BY_ID: ReadonlyMap<string, InsertCardPreset> = new Map(
  INSERT_CARD_PRESETS.map((p) => [p.id, p]),
);

export function getSlideTemplate(
  id: string | undefined | null,
): SlideTemplate | undefined {
  return id != null ? TEMPLATE_BY_ID.get(id) : undefined;
}

export function getInsertCardPreset(
  id: string | undefined | null,
): InsertCardPreset | undefined {
  return id != null ? PRESET_BY_ID.get(id) : undefined;
}
