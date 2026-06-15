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
import type { SlideBlockType, SlideLayout } from "./slideEditorTypes";

/**
 * Template taxonomy — mirrors Gamma's template categories so the
 * gallery can group and filter a broad built-in library by use-case.
 * The list is intentionally fixed and curated rather than free-form
 * strings: a closed union keeps the filter UI, tests, and template
 * tags honest (a typo is a compile error, not a silently-empty
 * filter).
 */
export type TemplateCategory =
  | "Company"
  | "Consulting"
  | "Creative"
  | "Education"
  | "Fundraising"
  | "Marketing"
  | "People"
  | "Project Management"
  | "Reporting"
  | "Sales"
  | "Strategy";

/**
 * Display-ordered category list for the gallery filter row. Drives the
 * filter chips so adding a category in one place updates the UI.
 */
export const TEMPLATE_CATEGORIES: readonly TemplateCategory[] = [
  "Company",
  "Consulting",
  "Creative",
  "Education",
  "Fundraising",
  "Marketing",
  "People",
  "Project Management",
  "Reporting",
  "Sales",
  "Strategy",
] as const;

/** Sentinel for the implicit "show everything" filter chip. */
export const ALL_TEMPLATES_CATEGORY = "All" as const;

/** A gallery filter value: a real category or the "All" sentinel. */
export type TemplateCategoryFilter =
  | TemplateCategory
  | typeof ALL_TEMPLATES_CATEGORY;

/** A slide blueprint within a template. */
export interface TemplateSlide {
  /** Layout to use for this slide. */
  layout: SlideLayout;
  /** Pre-filled title. Empty string for layouts that don't need one. */
  title: string;
  /** Pre-filled blocks (type + content + slot). */
  blocks: ReadonlyArray<{
    type: SlideBlockType;
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
  /**
   * Use-case category for the gallery taxonomy / filter. Optional and
   * additive — an un-tagged template still appears under "All".
   */
  category?: TemplateCategory;
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
  /** Emoji / text glyph fallback, rendered when no icon component resolves. */
  icon: string;
  /**
   * Optional lucide icon name (display-only). When it resolves via the
   * icon resolver the menu renders the vector icon; otherwise it falls
   * back to {@link icon}. Never persisted — purely a picker affordance.
   */
  iconName?: string;
  layout: SlideLayout;
  title: string;
  blocks: ReadonlyArray<{
    type: SlideBlockType;
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
    description:
      "Classic startup / product pitch — problem → solution → traction → ask.",
    icon: "🚀",
    suggestedTheme: "aurora",
    category: "Fundraising",
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
          {
            type: "text",
            content: "improvement in key metric",
            slot: "caption",
          },
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
        blocks: [{ type: "text", content: "your@email.com", slot: "subtitle" }],
      },
    ],
  },
  {
    id: "status-report",
    label: "Status Report",
    description:
      "Weekly / monthly progress update — highlights, metrics, blockers, next steps.",
    icon: "📊",
    suggestedTheme: "slate",
    category: "Reporting",
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
            content:
              "Completed feature X\nShipped release v2.1\nOnboarded 3 new clients",
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
    description:
      "Interactive session — agenda, activities, discussion, takeaways.",
    icon: "🎓",
    suggestedTheme: "mint",
    category: "Education",
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
            content:
              "Introduction (10 min)\nActivity 1 (20 min)\nDiscussion (15 min)\nWrap-up (5 min)",
            slot: "body",
          },
        ],
      },
      {
        layout: "sectionHeader",
        title: "Activity 1",
        blocks: [
          {
            type: "text",
            content: "Instructions for the first exercise",
            slot: "subtitle",
          },
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
        blocks: [{ type: "text", content: "", slot: "subtitle" }],
      },
    ],
  },
  {
    id: "project-proposal",
    label: "Project Proposal",
    description:
      "Structured proposal — objective, scope, timeline, budget, team.",
    icon: "📋",
    suggestedTheme: "editorial",
    category: "Project Management",
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
            content:
              "Deliverable 1\nDeliverable 2\nDeliverable 3\nOut of scope: …",
            slot: "body",
          },
        ],
      },
      {
        layout: "twoColumn",
        title: "Timeline & Budget",
        blocks: [
          {
            type: "text",
            content: "Phase 1: Q1\nPhase 2: Q2\nPhase 3: Q3",
            slot: "left",
          },
          {
            type: "text",
            content: "Total: $X\nHeadcount: N\nTools: $Y",
            slot: "right",
          },
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
          {
            type: "text",
            content: "Approval → Kickoff → First milestone",
            slot: "subtitle",
          },
        ],
      },
    ],
  },
  {
    id: "retrospective",
    label: "Retrospective",
    description:
      "Sprint / project retro — what went well, what didn't, action items.",
    icon: "🔄",
    suggestedTheme: "ocean",
    category: "Project Management",
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
            content:
              "Positive outcome 1\nPositive outcome 2\nPositive outcome 3",
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
            content:
              "Action 1 — Owner: …\nAction 2 — Owner: …\nAction 3 — Owner: …",
            slot: "body",
          },
        ],
      },
    ],
  },
  {
    id: "case-study",
    label: "Case Study",
    description:
      "Client success story — challenge, approach, results, testimonial.",
    icon: "💼",
    suggestedTheme: "rosewood",
    category: "Sales",
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
            content:
              "Step 1: Discovery\nStep 2: Implementation\nStep 3: Optimisation",
            slot: "body",
          },
        ],
      },
      {
        layout: "bigNumber",
        title: "",
        blocks: [
          { type: "text", content: "300%", slot: "number" },
          {
            type: "text",
            content: "improvement in key outcome",
            slot: "caption",
          },
        ],
      },
      {
        layout: "quote",
        title: "",
        blocks: [
          {
            type: "text",
            content: "This solution transformed how we work.",
            slot: "quote",
          },
          {
            type: "text",
            content: "— Client Name, Title",
            slot: "attribution",
          },
        ],
      },
    ],
  },
  {
    id: "company-overview",
    label: "Company Overview",
    description:
      "Introduce your company — mission, what you do, traction, and team.",
    icon: "🏢",
    suggestedTheme: "slate",
    category: "Company",
    slides: [
      {
        layout: "sectionHeader",
        title: "Acme, Inc.",
        blocks: [
          {
            type: "text",
            content: "The operating system for modern operations",
            slot: "subtitle",
          },
        ],
        notes: "Open with the company name and a one-line positioning.",
      },
      {
        layout: "titleContent",
        title: "What We Do",
        blocks: [
          {
            type: "text",
            content:
              "We help operations teams replace spreadsheets and manual handoffs with a single source of truth — faster cycle times, fewer errors, happier teams.",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "The Problem We Solve",
        blocks: [
          {
            type: "bullets",
            content:
              "Critical work still lives in disconnected spreadsheets\nHandoffs stall when context is buried in inboxes\nLeaders lack a real-time view of what's actually shipping",
            slot: "body",
          },
        ],
      },
      {
        layout: "twoColumn",
        title: "What Makes Us Different",
        blocks: [
          {
            type: "text",
            content:
              "Purpose-built\nWorkflows tailored to operations, not a generic project tool.",
            slot: "left",
          },
          {
            type: "text",
            content:
              "Local-first\nYour data stays on your devices and syncs only when you choose.",
            slot: "right",
          },
        ],
      },
      {
        layout: "bigNumber",
        title: "",
        blocks: [
          { type: "text", content: "2,400+", slot: "number" },
          {
            type: "text",
            content: "teams run their week on Acme",
            slot: "caption",
          },
        ],
        notes: "Lead with your single most credible traction metric.",
      },
      {
        layout: "titleContent",
        title: "Our Team",
        blocks: [
          {
            type: "bullets",
            content:
              "Founders — two-time operators from logistics and fintech\nEngineering — distributed and product-minded\nAdvisors — leaders from companies you trust",
            slot: "body",
          },
        ],
      },
      {
        layout: "sectionHeader",
        title: "Let's Talk",
        blocks: [
          {
            type: "text",
            content: "hello@acme.com · acme.com",
            slot: "subtitle",
          },
        ],
      },
    ],
  },
  {
    id: "all-hands",
    label: "All-Hands Update",
    description:
      "Company-wide meeting — wins, metrics, what's next, and shout-outs.",
    icon: "📣",
    suggestedTheme: "ocean",
    category: "Company",
    slides: [
      {
        layout: "title",
        title: "Q3 All-Hands",
        blocks: [],
        notes: "Set the tone: one sentence on the quarter in review.",
      },
      {
        layout: "titleContent",
        title: "Agenda",
        blocks: [
          {
            type: "bullets",
            content:
              "Where we are\nWins this quarter\nMetrics that matter\nWhat's next\nQ&A",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Wins This Quarter",
        blocks: [
          {
            type: "bullets",
            content:
              "Shipped the new onboarding flow — activation up 18%\nClosed our three largest accounts to date\nCut support response time to under two hours",
            slot: "body",
          },
        ],
      },
      {
        layout: "bigNumber",
        title: "",
        blocks: [
          { type: "text", content: "118%", slot: "number" },
          {
            type: "text",
            content: "of the quarterly revenue target",
            slot: "caption",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "What's Next",
        blocks: [
          {
            type: "bullets",
            content:
              "Launch the mobile beta\nGrow the customer success team\nHarden reliability ahead of peak season",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Shout-Outs",
        blocks: [
          {
            type: "text",
            content:
              "A huge thank-you to everyone who stepped up this quarter. Recognition isn't a formality — it's how we remember what good looks like.",
            slot: "body",
          },
        ],
        notes: "Name specific people and what they did.",
      },
      {
        layout: "sectionHeader",
        title: "Questions?",
        blocks: [
          {
            type: "text",
            content: "Open floor — nothing is off the table",
            slot: "subtitle",
          },
        ],
      },
    ],
  },
  {
    id: "consulting-proposal",
    label: "Consulting Engagement",
    description:
      "Scope a client engagement — situation, approach, workstreams, and fees.",
    icon: "🧩",
    suggestedTheme: "editorial",
    category: "Consulting",
    slides: [
      {
        layout: "title",
        title: "Engagement Proposal",
        blocks: [],
        notes: "Client name and date go in the subtitle when you present.",
      },
      {
        layout: "titleContent",
        title: "Situation",
        blocks: [
          {
            type: "text",
            content:
              "Summarise the client's current state in two or three sentences — the business context, the trigger for this engagement, and why now.",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Our Understanding",
        blocks: [
          {
            type: "bullets",
            content:
              "Objective — the outcome the client is accountable for\nConstraints — budget, timeline, internal capacity\nDefinition of success — how we'll both know it worked",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Approach",
        blocks: [
          {
            type: "bullets",
            content:
              "Phase 1 — Diagnose: data review, interviews, baseline\nPhase 2 — Design: options, trade-offs, recommendation\nPhase 3 — Deliver: pilot, measure, scale",
            slot: "body",
          },
        ],
      },
      {
        layout: "twoColumn",
        title: "Workstreams & Owners",
        blocks: [
          {
            type: "text",
            content: "Workstream A — Process\nLead consultant + client SME",
            slot: "left",
          },
          {
            type: "text",
            content: "Workstream B — Enablement\nChange lead + training",
            slot: "right",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Investment & Terms",
        blocks: [
          {
            type: "table",
            content:
              "| Phase | Duration | Fee |\n| --- | --- | --- |\n| Diagnose | 3 weeks | $X |\n| Design | 4 weeks | $Y |\n| Deliver | 6 weeks | $Z |",
            slot: "body",
          },
        ],
      },
      {
        layout: "sectionHeader",
        title: "Next Steps",
        blocks: [
          {
            type: "text",
            content: "Sign-off → kickoff within ten business days",
            slot: "subtitle",
          },
        ],
      },
    ],
  },
  {
    id: "discovery-findings",
    label: "Discovery Findings",
    description:
      "Present diagnostic results — findings, impact, and a phased roadmap.",
    icon: "🔎",
    suggestedTheme: "slate",
    category: "Consulting",
    slides: [
      {
        layout: "title",
        title: "Discovery Findings",
        blocks: [],
      },
      {
        layout: "titleContent",
        title: "Executive Summary",
        blocks: [
          {
            type: "text",
            content:
              "Three sentences a busy executive can act on: what we found, what it means, and what we recommend doing first.",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "What We Did",
        blocks: [
          {
            type: "bullets",
            content:
              "14 stakeholder interviews across four functions\nReview of six months of operational data\nProcess walkthroughs at two sites",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Key Findings",
        blocks: [
          {
            type: "bullets",
            content:
              "The bottleneck is handoffs, not headcount\nThe data exists but isn't trusted\nQuick wins are blocked by approvals, not tooling",
            slot: "body",
          },
        ],
      },
      {
        layout: "twoColumn",
        title: "Impact vs. Effort",
        blocks: [
          {
            type: "text",
            content:
              "Do now\nHigh impact, low effort — fix approval thresholds.",
            slot: "left",
          },
          {
            type: "text",
            content:
              "Plan next\nHigh impact, higher effort — unify the data model.",
            slot: "right",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Recommended Roadmap",
        blocks: [
          {
            type: "table",
            content:
              "| Horizon | Focus | Outcome |\n| --- | --- | --- |\n| 0–30 days | Quick wins | Restore momentum |\n| 30–90 days | Foundations | Trusted data |\n| 90+ days | Scale | Repeatable process |",
            slot: "body",
          },
        ],
      },
      {
        layout: "sectionHeader",
        title: "Discussion",
        blocks: [
          {
            type: "text",
            content: "Which finding should we pressure-test first?",
            slot: "subtitle",
          },
        ],
      },
    ],
  },
  {
    id: "brand-guidelines",
    label: "Brand Guidelines",
    description:
      "Define the brand — logo, colour, type, and voice with do's and don'ts.",
    icon: "🎨",
    suggestedTheme: "noir",
    category: "Creative",
    slides: [
      {
        layout: "sectionHeader",
        title: "Brand Guidelines",
        blocks: [
          {
            type: "text",
            content: "How we look, sound, and show up",
            slot: "subtitle",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Brand Essence",
        blocks: [
          {
            type: "text",
            content:
              "One line that captures who we are. Everything else — the logo, the colour, the words — exists to make this line feel true.",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Logo Usage",
        blocks: [
          {
            type: "bullets",
            content:
              "Keep clear space equal to the logo height\nNever stretch, recolour, or add effects\nUse the monochrome mark on busy backgrounds",
            slot: "body",
          },
        ],
      },
      {
        layout: "twoColumn",
        title: "Colour & Type",
        blocks: [
          {
            type: "text",
            content:
              "Colour\nPrimary, secondary, and one accent. Use the accent sparingly — for emphasis, never decoration.",
            slot: "left",
          },
          {
            type: "text",
            content:
              "Typography\nOne typeface family. Bold for headlines, regular for body, generous line spacing.",
            slot: "right",
          },
        ],
      },
      {
        layout: "quote",
        title: "",
        blocks: [
          {
            type: "text",
            content: "Design is the silent ambassador of your brand.",
            slot: "quote",
          },
          { type: "text", content: "— Paul Rand", slot: "attribution" },
        ],
      },
      {
        layout: "twoColumn",
        title: "Voice — Do & Don't",
        blocks: [
          {
            type: "text",
            content: "Do\nBe direct. Be warm. Use plain words.",
            slot: "left",
          },
          {
            type: "text",
            content: "Don't\nNo jargon. No hype. No exclamation-mark energy.",
            slot: "right",
          },
        ],
      },
      {
        layout: "sectionHeader",
        title: "Stay On-Brand",
        blocks: [
          {
            type: "text",
            content: "Questions? Ask the brand team before you ship.",
            slot: "subtitle",
          },
        ],
      },
    ],
  },
  {
    id: "creative-concept",
    label: "Creative Concept",
    description:
      "Pitch a campaign idea — the big idea, tone, territories, and next steps.",
    icon: "✨",
    suggestedTheme: "rosewood",
    category: "Creative",
    slides: [
      {
        layout: "sectionHeader",
        title: "Creative Concept",
        blocks: [
          {
            type: "text",
            content: "Campaign codename · date",
            slot: "subtitle",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "The Big Idea",
        blocks: [
          {
            type: "text",
            content:
              "State the concept in a single, memorable sentence. If it needs a paragraph to explain, it isn't the idea yet.",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Why It Works",
        blocks: [
          {
            type: "bullets",
            content:
              "It's true to the brand\nIt's relevant to the audience right now\nIt's distinctive enough to remember",
            slot: "body",
          },
        ],
      },
      {
        layout: "twoColumn",
        title: "Tone & Mood",
        blocks: [
          {
            type: "text",
            content: "Tone\nConfident, playful, human.",
            slot: "left",
          },
          {
            type: "text",
            content: "Mood\nWarm light, candid moments, real people.",
            slot: "right",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Executional Territories",
        blocks: [
          {
            type: "bullets",
            content:
              "Hero film — 30s with 6s cutdowns\nSocial — story-first, legible with sound off\nOut-of-home — one line, one image, zero clutter",
            slot: "body",
          },
        ],
      },
      {
        layout: "quote",
        title: "",
        blocks: [
          {
            type: "text",
            content:
              "Make it simple. Make it memorable. Make it inviting to look at.",
            slot: "quote",
          },
          { type: "text", content: "— Leo Burnett", slot: "attribution" },
        ],
      },
      {
        layout: "sectionHeader",
        title: "Let's Build It",
        blocks: [
          {
            type: "text",
            content: "Feedback by Friday — production starts Monday",
            slot: "subtitle",
          },
        ],
      },
    ],
  },
  {
    id: "lesson-plan",
    label: "Lesson Plan",
    description:
      "Structure a class — objectives, agenda, key concept, activity, and check.",
    icon: "🍎",
    suggestedTheme: "mint",
    category: "Education",
    slides: [
      {
        layout: "title",
        title: "Lesson Plan",
        blocks: [],
        notes: "Subject, grade level, and lesson length set the context.",
      },
      {
        layout: "titleContent",
        title: "Learning Objectives",
        blocks: [
          {
            type: "bullets",
            content:
              "Apply the concept to a real example\nExplain it in their own words\nConnect it to what they already know",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Agenda",
        blocks: [
          {
            type: "bullets",
            content:
              "Hook — why this matters (5 min)\nTeach — the core concept (15 min)\nPractice — guided activity (15 min)\nReflect — check for understanding (10 min)",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Key Concept",
        blocks: [
          {
            type: "text",
            content:
              "Introduce the single most important idea of this lesson. Keep it concrete — one clear definition and one vivid example.",
            slot: "body",
          },
        ],
      },
      {
        layout: "twoColumn",
        title: "Activity",
        blocks: [
          {
            type: "text",
            content: "Task\nWhat learners do, in pairs.",
            slot: "left",
          },
          {
            type: "text",
            content: "Materials\nWhat they need to do it.",
            slot: "right",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Check for Understanding",
        blocks: [
          {
            type: "bullets",
            content:
              "Exit ticket — one question, one minute\nThumbs up or down on the objective\nPreview the next lesson",
            slot: "body",
          },
        ],
      },
    ],
  },
  {
    id: "course-syllabus",
    label: "Course Syllabus",
    description:
      "Outline a course — description, outcomes, weekly schedule, and grading.",
    icon: "📚",
    suggestedTheme: "editorial",
    category: "Education",
    slides: [
      {
        layout: "sectionHeader",
        title: "Course Syllabus",
        blocks: [
          {
            type: "text",
            content: "Course title · term · instructor",
            slot: "subtitle",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Course Description",
        blocks: [
          {
            type: "text",
            content:
              "Two or three sentences on what the course covers, who it's for, and what learners will be able to do by the end.",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Learning Outcomes",
        blocks: [
          {
            type: "bullets",
            content:
              "Outcome 1 — foundational knowledge\nOutcome 2 — a practical skill\nOutcome 3 — applied judgement",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Schedule",
        blocks: [
          {
            type: "table",
            content:
              "| Week | Topic | Deliverable |\n| --- | --- | --- |\n| 1 | Foundations | Reading response |\n| 2 | Core methods | Problem set |\n| 3 | Application | Project draft |",
            slot: "body",
          },
        ],
      },
      {
        layout: "twoColumn",
        title: "Grading & Policies",
        blocks: [
          {
            type: "text",
            content: "Grading\nParticipation 20%\nAssignments 40%\nProject 40%",
            slot: "left",
          },
          {
            type: "text",
            content:
              "Policies\nLate work, attendance, and academic-integrity expectations.",
            slot: "right",
          },
        ],
      },
      {
        layout: "sectionHeader",
        title: "Office Hours",
        blocks: [
          {
            type: "text",
            content: "By appointment · email anytime",
            slot: "subtitle",
          },
        ],
      },
    ],
  },
  {
    id: "investor-update",
    label: "Investor Update",
    description:
      "Monthly update to investors — TL;DR, KPIs, highlights, lowlights, asks.",
    icon: "📈",
    suggestedTheme: "aurora",
    category: "Fundraising",
    slides: [
      {
        layout: "title",
        title: "Investor Update",
        blocks: [],
        notes: "Lead with the month and one honest headline.",
      },
      {
        layout: "titleContent",
        title: "TL;DR",
        blocks: [
          {
            type: "bullets",
            content:
              "Revenue grew 22% month over month\nClosed two lighthouse customers\nRunway: 14 months\nAsks: two warm intros (see last slide)",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Key Metrics",
        blocks: [
          {
            type: "chart",
            content:
              "type: line\ntitle: Monthly recurring revenue ($k)\nlabels: Jan, Feb, Mar, Apr, May, Jun\nMRR: 42, 51, 60, 71, 86, 105",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Highlights",
        blocks: [
          {
            type: "bullets",
            content:
              "Shipped the integrations that unblocked enterprise deals\nNet revenue retention reached 118%\nHired a VP of Sales",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Lowlights",
        blocks: [
          {
            type: "bullets",
            content:
              "The sales cycle ran longer than modelled\nA key engineering hire fell through\nInfra costs are rising faster than usage",
            slot: "body",
          },
        ],
        notes: "Candour here builds trust — don't bury the hard parts.",
      },
      {
        layout: "titleContent",
        title: "Asks",
        blocks: [
          {
            type: "bullets",
            content:
              "Intro to a head of operations at a mid-market logistics firm\nReferrals for a senior backend engineer\nFeedback on the new pricing",
            slot: "body",
          },
        ],
      },
      {
        layout: "sectionHeader",
        title: "Thank You",
        blocks: [
          { type: "text", content: "founders@company.com", slot: "subtitle" },
        ],
      },
    ],
  },
  {
    id: "marketing-plan",
    label: "Marketing Plan",
    description:
      "Quarterly marketing plan — goals, audience, channels, funnel, budget.",
    icon: "📢",
    suggestedTheme: "solar",
    category: "Marketing",
    slides: [
      {
        layout: "sectionHeader",
        title: "Marketing Plan",
        blocks: [
          { type: "text", content: "Quarter · owner", slot: "subtitle" },
        ],
      },
      {
        layout: "titleContent",
        title: "Goals",
        blocks: [
          {
            type: "bullets",
            content:
              "Grow qualified pipeline 40% quarter over quarter\nLift activation from 32% to 45%\nReach payback under three months on paid",
            slot: "body",
          },
        ],
      },
      {
        layout: "twoColumn",
        title: "Target Audience",
        blocks: [
          {
            type: "text",
            content: "Who\nOperations leaders at 50–500 person companies.",
            slot: "left",
          },
          {
            type: "text",
            content:
              "Jobs to be done\nReplace brittle spreadsheets with trusted workflows.",
            slot: "right",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Channels",
        blocks: [
          {
            type: "bullets",
            content:
              "Content & SEO — own the category language\nLifecycle email — activate and expand\nPaid — retarget high-intent visitors\nPartnerships — co-market with adjacent tools",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Funnel & Targets",
        blocks: [
          {
            type: "table",
            content:
              "| Stage | Metric | Target |\n| --- | --- | --- |\n| Awareness | Visitors | 80k/mo |\n| Interest | MQLs | 1,200/mo |\n| Decision | SQLs | 240/mo |",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Budget",
        blocks: [
          {
            type: "table",
            content:
              "| Channel | Spend | Target CAC |\n| --- | --- | --- |\n| Paid | $30k | $180 |\n| Content | $15k | $90 |\n| Events | $10k | $260 |",
            slot: "body",
          },
        ],
      },
      {
        layout: "sectionHeader",
        title: "Let's Execute",
        blocks: [
          {
            type: "text",
            content: "Weekly check-in · dashboard linked in the notes",
            slot: "subtitle",
          },
        ],
      },
    ],
  },
  {
    id: "product-launch",
    label: "Go-to-Market Launch",
    description:
      "Plan a launch — goals, positioning, timeline, channels, and metrics.",
    icon: "🛫",
    suggestedTheme: "aurora",
    category: "Marketing",
    slides: [
      {
        layout: "title",
        title: "Go-to-Market: Launch",
        blocks: [],
      },
      {
        layout: "titleContent",
        title: "Launch Goals",
        blocks: [
          {
            type: "bullets",
            content:
              "Reach 5,000 signups in week one\nEarn ten press or creator mentions\nConvert 8% of signups to paid",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Positioning",
        blocks: [
          {
            type: "text",
            content:
              "For [audience] who [need], [product] is the [category] that [key benefit] — unlike [alternative], we [differentiator].",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Timeline",
        blocks: [
          {
            type: "table",
            content:
              "| Phase | When | Focus |\n| --- | --- | --- |\n| Pre-launch | T−4 weeks | Waitlist + teasers |\n| Launch | Day 0 | Announcement + press |\n| Sustain | T+4 weeks | Lifecycle + iteration |",
            slot: "body",
          },
        ],
      },
      {
        layout: "twoColumn",
        title: "Channels & Assets",
        blocks: [
          {
            type: "text",
            content: "Channels\nEmail, social, press, community.",
            slot: "left",
          },
          {
            type: "text",
            content: "Assets\nLanding page, demo video, launch post, FAQ.",
            slot: "right",
          },
        ],
      },
      {
        layout: "bigNumber",
        title: "",
        blocks: [
          { type: "text", content: "Day 0", slot: "number" },
          {
            type: "text",
            content: "everything ships together — page, post, and product",
            slot: "caption",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Success Metrics",
        blocks: [
          {
            type: "bullets",
            content:
              "Signups and activation rate\nPress and social reach\nPaid conversion and CAC",
            slot: "body",
          },
        ],
      },
    ],
  },
  {
    id: "onboarding",
    label: "New Hire Onboarding",
    description:
      "Welcome a new teammate — first week, tools, people, and a 30/60/90.",
    icon: "👋",
    suggestedTheme: "mint",
    category: "People",
    slides: [
      {
        layout: "sectionHeader",
        title: "Welcome to the Team",
        blocks: [
          { type: "text", content: "We're glad you're here", slot: "subtitle" },
        ],
      },
      {
        layout: "titleContent",
        title: "Your First Week",
        blocks: [
          {
            type: "bullets",
            content:
              "Day 1 — accounts, hardware, introductions\nDays 2–3 — shadow your onboarding buddy\nDays 4–5 — ship a first small task end to end",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Tools You'll Use",
        blocks: [
          {
            type: "bullets",
            content:
              "Comms — where we talk\nDocs — where we write things down\nProject tracker — where the work lives",
            slot: "body",
          },
        ],
      },
      {
        layout: "twoColumn",
        title: "Who's Who",
        blocks: [
          {
            type: "text",
            content: "Your manager\nWeekly 1:1s, here to unblock you.",
            slot: "left",
          },
          {
            type: "text",
            content: "Your buddy\nYour go-to for the small questions.",
            slot: "right",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Your 30 / 60 / 90",
        blocks: [
          {
            type: "table",
            content:
              "| By day | You'll be able to |\n| --- | --- |\n| 30 | Ship with guidance |\n| 60 | Own a small area |\n| 90 | Drive a project end to end |",
            slot: "body",
          },
        ],
      },
      {
        layout: "sectionHeader",
        title: "Questions?",
        blocks: [
          {
            type: "text",
            content: "No question is too small — ask early, ask often",
            slot: "subtitle",
          },
        ],
      },
    ],
  },
  {
    id: "performance-review",
    label: "Performance Review",
    description:
      "Run a fair review — summary, achievements, growth areas, and goals.",
    icon: "⭐",
    suggestedTheme: "slate",
    category: "People",
    slides: [
      {
        layout: "title",
        title: "Performance Review",
        blocks: [],
        notes: "Name and review period set the frame; keep it specific.",
      },
      {
        layout: "titleContent",
        title: "Summary",
        blocks: [
          {
            type: "text",
            content:
              "A fair, specific paragraph: overall performance this cycle, the headline strengths, and the one or two areas to focus on next.",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Key Achievements",
        blocks: [
          {
            type: "bullets",
            content:
              "Delivered [project] with measurable impact\nRaised the bar on [skill or behaviour]\nHelped the team by [collaboration example]",
            slot: "body",
          },
        ],
      },
      {
        layout: "twoColumn",
        title: "Strengths & Growth",
        blocks: [
          {
            type: "text",
            content: "Strengths\nWhat to keep doing — be specific.",
            slot: "left",
          },
          {
            type: "text",
            content: "Growth areas\nWhat to develop — framed as opportunity.",
            slot: "right",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Goals for Next Cycle",
        blocks: [
          {
            type: "bullets",
            content:
              "Goal 1 — an outcome and how we'll measure it\nGoal 2 — a stretch worth attempting\nGoal 3 — a development goal",
            slot: "body",
          },
        ],
      },
      {
        layout: "sectionHeader",
        title: "Open Conversation",
        blocks: [
          {
            type: "text",
            content: "Your reflections matter as much as this review",
            slot: "subtitle",
          },
        ],
      },
    ],
  },
  {
    id: "project-kickoff",
    label: "Project Kickoff",
    description: "Align a new project — goals, milestones, team, and risks.",
    icon: "🏁",
    suggestedTheme: "ocean",
    category: "Project Management",
    slides: [
      {
        layout: "title",
        title: "Project Kickoff",
        blocks: [],
      },
      {
        layout: "titleContent",
        title: "Why We're Here",
        blocks: [
          {
            type: "text",
            content:
              "One paragraph on the problem this project solves and what changes for the business when it's done.",
            slot: "body",
          },
        ],
      },
      {
        layout: "twoColumn",
        title: "Goals & Non-Goals",
        blocks: [
          {
            type: "text",
            content: "Goals\nWhat success looks like.",
            slot: "left",
          },
          {
            type: "text",
            content: "Non-goals\nWhat we're deliberately not doing.",
            slot: "right",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Milestones",
        blocks: [
          {
            type: "table",
            content:
              "| Milestone | When | Owner |\n| --- | --- | --- |\n| Kickoff | Week 0 | PM |\n| Alpha | Week 4 | Eng |\n| Beta | Week 8 | Eng |\n| Launch | Week 12 | PM |",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Team & Roles",
        blocks: [
          {
            type: "bullets",
            content:
              "Sponsor — accountable for the outcome\nLead — drives day to day\nContributors — design, engineering, QA",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Risks & Mitigations",
        blocks: [
          {
            type: "bullets",
            content:
              "Scope creep → ruthless prioritisation\nDependency slip → map the critical path early\nUnknowns → a time-boxed spike in week one",
            slot: "body",
          },
        ],
      },
      {
        layout: "sectionHeader",
        title: "Let's Go",
        blocks: [
          {
            type: "text",
            content: "Standups daily · demo every Friday",
            slot: "subtitle",
          },
        ],
      },
    ],
  },
  {
    id: "monthly-business-review",
    label: "Monthly Business Review",
    description:
      "Review the month — exec summary, performance vs. plan, wins, risks.",
    icon: "🗓️",
    suggestedTheme: "slate",
    category: "Reporting",
    slides: [
      {
        layout: "title",
        title: "Monthly Business Review",
        blocks: [],
      },
      {
        layout: "titleContent",
        title: "Executive Summary",
        blocks: [
          {
            type: "text",
            content:
              "What happened, why it matters, and what we'll do about it — in three sentences a leader can repeat.",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Performance vs. Plan",
        blocks: [
          {
            type: "chart",
            content:
              "type: bar\ntitle: Revenue ($k)\nlabels: Jan, Feb, Mar, Apr\nActual: 380, 410, 440, 468\nPlan: 400, 420, 440, 450",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Wins",
        blocks: [
          {
            type: "bullets",
            content:
              "Beat the revenue plan by 4%\nReduced churn to 1.8%\nLaunched the most-requested feature",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Risks & Watch-Items",
        blocks: [
          {
            type: "bullets",
            content:
              "Pipeline coverage below 3x for next quarter\nSupport backlog creeping up\nA key renewal at risk — mitigation underway",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Plan for Next Month",
        blocks: [
          {
            type: "bullets",
            content:
              "Rebuild pipeline coverage to 3.5x\nShip the reliability work\nClose the at-risk renewal",
            slot: "body",
          },
        ],
      },
      {
        layout: "sectionHeader",
        title: "Discussion",
        blocks: [
          {
            type: "text",
            content: "Where do you want to go deeper?",
            slot: "subtitle",
          },
        ],
      },
    ],
  },
  {
    id: "sales-deck",
    label: "Sales Deck",
    description:
      "Sell the outcome — problem, solution, proof, pricing, and next steps.",
    icon: "🤝",
    suggestedTheme: "noir",
    category: "Sales",
    slides: [
      {
        layout: "title",
        title: "Sales Deck",
        blocks: [],
      },
      {
        layout: "titleContent",
        title: "The Problem",
        blocks: [
          {
            type: "text",
            content:
              "Name the pain in your buyer's words. If they don't nod here, nothing else matters.",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "The Cost of Doing Nothing",
        blocks: [
          {
            type: "bullets",
            content:
              "Hours lost to manual work\nDecisions made on stale data\nRisk that compounds quietly",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Our Solution",
        blocks: [
          {
            type: "text",
            content:
              "One clear sentence on what you do and the outcome it creates — not the feature list.",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "How It Works",
        blocks: [
          {
            type: "bullets",
            content:
              "Connect your data in minutes\nAutomate the busywork\nSee the whole picture in one place",
            slot: "body",
          },
        ],
      },
      {
        layout: "bigNumber",
        title: "",
        blocks: [
          { type: "text", content: "6 hrs", slot: "number" },
          {
            type: "text",
            content: "saved per person, every week",
            slot: "caption",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Pricing",
        blocks: [
          {
            type: "table",
            content:
              "| Plan | For | Price |\n| --- | --- | --- |\n| Starter | Small teams | $X/mo |\n| Growth | Scaling teams | $Y/mo |\n| Enterprise | Custom needs | Talk to us |",
            slot: "body",
          },
        ],
      },
      {
        layout: "sectionHeader",
        title: "Next Steps",
        blocks: [
          {
            type: "text",
            content: "Book a tailored demo this week",
            slot: "subtitle",
          },
        ],
      },
    ],
  },
  {
    id: "strategic-plan",
    label: "Strategic Plan",
    description:
      "Set direction — vision, where to play, pillars, roadmap, and metrics.",
    icon: "🧭",
    suggestedTheme: "forest",
    category: "Strategy",
    slides: [
      {
        layout: "sectionHeader",
        title: "Strategic Plan",
        blocks: [
          { type: "text", content: "Three-year horizon", slot: "subtitle" },
        ],
      },
      {
        layout: "titleContent",
        title: "Vision",
        blocks: [
          {
            type: "text",
            content:
              "Where we're going and why it's worth the effort — one sentence the whole company can recite.",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Where We Play",
        blocks: [
          {
            type: "bullets",
            content:
              "Markets we'll win\nSegments we'll prioritise\nThings we'll say no to",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Strategic Pillars",
        blocks: [
          {
            type: "bullets",
            content:
              "Pillar 1 — grow the core\nPillar 2 — expand the platform\nPillar 3 — operational excellence",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Roadmap",
        blocks: [
          {
            type: "table",
            content:
              "| Year | Focus | Outcome |\n| --- | --- | --- |\n| Y1 | Strengthen the core | Profitable growth |\n| Y2 | Expand | New-segment traction |\n| Y3 | Scale | Category leadership |",
            slot: "body",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "How We'll Measure Success",
        blocks: [
          {
            type: "bullets",
            content:
              "A north-star metric and its target\nThe leading indicators we'll watch\nOur review cadence",
            slot: "body",
          },
        ],
      },
      {
        layout: "sectionHeader",
        title: "Aligned & Accountable",
        blocks: [
          {
            type: "text",
            content: "Quarterly strategy reviews keep us honest",
            slot: "subtitle",
          },
        ],
      },
    ],
  },
  {
    id: "okrs",
    label: "Quarterly OKRs",
    description:
      "Set quarterly OKRs — theme, objectives with key results, and a scorecard.",
    icon: "🎯",
    suggestedTheme: "lavender",
    category: "Strategy",
    slides: [
      {
        layout: "title",
        title: "Quarterly OKRs",
        blocks: [],
      },
      {
        layout: "titleContent",
        title: "Theme",
        blocks: [
          {
            type: "text",
            content:
              "The one thing this quarter is about. If a request doesn't serve the theme, it waits.",
            slot: "body",
          },
        ],
      },
      {
        layout: "twoColumn",
        title: "Objective 1",
        blocks: [
          {
            type: "text",
            content: "Objective\nDelight new users from day one.",
            slot: "left",
          },
          {
            type: "text",
            content:
              "Key Results\nKR1: activation 32% → 45%\nKR2: time-to-value < 1 day\nKR3: NPS ≥ 40",
            slot: "right",
          },
        ],
      },
      {
        layout: "twoColumn",
        title: "Objective 2",
        blocks: [
          {
            type: "text",
            content: "Objective\nMake revenue predictable.",
            slot: "left",
          },
          {
            type: "text",
            content:
              "Key Results\nKR1: pipeline coverage ≥ 3.5x\nKR2: win rate 22% → 28%\nKR3: churn < 2%",
            slot: "right",
          },
        ],
      },
      {
        layout: "titleContent",
        title: "Scorecard",
        blocks: [
          {
            type: "table",
            content:
              "| Objective | Confidence | Status |\n| --- | --- | --- |\n| Delight new users | 0.7 | On track |\n| Predictable revenue | 0.5 | At risk |",
            slot: "body",
          },
        ],
      },
      {
        layout: "sectionHeader",
        title: "Focus Wins",
        blocks: [
          {
            type: "text",
            content: "Fewer goals, finished — beats many, half-done",
            slot: "subtitle",
          },
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
    iconName: "Hash",
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
    iconName: "Columns2",
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
    iconName: "Quote",
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
    iconName: "Minus",
    layout: "sectionHeader",
    title: "New Section",
    blocks: [{ type: "text", content: "", slot: "subtitle" }],
  },
  {
    id: "image-text",
    label: "Image + Text",
    description: "Image left with text body",
    icon: "▣",
    iconName: "PanelLeft",
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
    iconName: "List",
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
    iconName: "Square",
    layout: "blank",
    title: "",
    blocks: [{ type: "text", content: "", slot: "body" }],
  },
  // -------------------------------------------------------------------------
  // Smart-layout presets (additive — surface the new CSS-grid layouts as
  // one-click insert cards). Ids are new and never collide with the layout
  // ids of the same theme (preset ids live in their own namespace).
  // -------------------------------------------------------------------------
  {
    id: "timeline-card",
    label: "Timeline",
    description: "Milestones on a connected track",
    icon: "●─●─●",
    iconName: "Milestone",
    layout: "timeline",
    title: "Timeline",
    blocks: [
      { type: "text", content: "Q1 — Kickoff", slot: "event" },
      { type: "text", content: "Q2 — Build", slot: "event" },
      { type: "text", content: "Q3 — Launch", slot: "event" },
    ],
  },
  {
    id: "process-card",
    label: "Process / Steps",
    description: "Numbered left-to-right steps",
    icon: "1·2·3",
    iconName: "ListOrdered",
    layout: "process",
    title: "Process",
    blocks: [
      { type: "text", content: "Plan the work", slot: "step" },
      { type: "text", content: "Do the work", slot: "step" },
      { type: "text", content: "Review results", slot: "step" },
    ],
  },
  {
    id: "comparison-split",
    label: "Comparison Panels",
    description: "Two panels with a central divider",
    icon: "▮│▮",
    iconName: "GitCompare",
    layout: "comparison",
    title: "Comparison",
    blocks: [
      { type: "text", content: "Option A", slot: "left" },
      { type: "text", content: "Option B", slot: "right" },
    ],
  },
  {
    id: "gallery-card",
    label: "Gallery",
    description: "Responsive grid of images",
    icon: "▦",
    iconName: "Images",
    layout: "gallery",
    title: "Gallery",
    blocks: [
      { type: "image", content: "", slot: "image" },
      { type: "image", content: "", slot: "image" },
      { type: "image", content: "", slot: "image" },
    ],
  },
  {
    id: "metric-row",
    label: "Metric Row",
    description: "Row of headline numbers",
    icon: "## ##",
    iconName: "BarChart3",
    layout: "metricRow",
    title: "Key Metrics",
    blocks: [
      { type: "text", content: "99%", slot: "metric" },
      { type: "text", content: "2.4k", slot: "metric" },
      { type: "text", content: "3x", slot: "metric" },
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

// ---------------------------------------------------------------------------
// Gallery filtering
// ---------------------------------------------------------------------------

/**
 * The minimal gallery-facing shape {@link filterSlideTemplates} needs.
 * Both the built-in {@link SlideTemplate} and the user-authored
 * `CustomSlideTemplate` (see `customSlideTemplates.ts`) satisfy it, so
 * the filter is generic over either — or a merged list of both —
 * without this module depending on the custom-template module. A
 * built-in always carries a string `description`; a custom one may
 * omit it, hence the optional field.
 */
export interface FilterableTemplate {
  label: string;
  description?: string;
  category?: TemplateCategory;
}

/**
 * Pure filter used by the template gallery. Narrows by `category`
 * (the "All" sentinel matches everything) and then by a free-text
 * `query` matched case-insensitively against the label, description,
 * and category. Input order is preserved and the source array is
 * never mutated, so callers can memoise on the result safely.
 *
 * Generic over {@link FilterableTemplate} so it filters built-in or
 * user templates (or a merged list) and returns the same concrete
 * element type it was given. The matching behaviour is unchanged for
 * built-ins (whose `description` is always a string).
 */
export function filterSlideTemplates<T extends FilterableTemplate>(
  templates: readonly T[],
  category: TemplateCategoryFilter,
  query: string,
): T[] {
  const normalisedQuery = query.trim().toLowerCase();
  return templates.filter((template) => {
    if (category !== ALL_TEMPLATES_CATEGORY && template.category !== category) {
      return false;
    }
    if (normalisedQuery.length === 0) {
      return true;
    }
    const haystack = `${template.label} ${template.description ?? ""} ${
      template.category ?? ""
    }`.toLowerCase();
    return haystack.includes(normalisedQuery);
  });
}
