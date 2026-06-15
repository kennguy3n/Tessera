/**
 * Pre-built document templates for the Document (TipTap) editor.
 *
 * A built-in template is a reusable, professional **starter document** —
 * a named block of rich content (headings, lists, task lists, tables,
 * callout-style quotes) the user can drop into the editor to skeleton a
 * meeting note, PRD, status report, and so on. It is the document-domain
 * analogue of the built-in {@link SlideTemplate} catalogue in
 * `slideTemplates.ts`.
 *
 * Unlike a slide template (structured `SlideContent`), a document is an
 * **HTML string** — the exact shape `editor.getHTML()` produces and
 * `editor.commands.setContent` / `insertContent` consume. So a template's
 * `content` is authored as TipTap-insertable HTML using only the node
 * types the Document editor's schema understands (headings, paragraphs,
 * bullet / ordered / task lists, blockquotes, tables, horizontal rules).
 * Inserting it routes through TipTap's schema-based HTML parser, which
 * silently drops any node or attribute the schema doesn't allow — the
 * same mechanism that protects every other content path in the editor —
 * so a template can never inject markup the editor wouldn't itself emit.
 *
 * This module is pure, side-effect-free metadata (mirrors
 * `slideTemplates.ts`): no React, no IPC, no `localStorage`. User-authored
 * templates and their persisted store live in `customDocumentTemplates.ts`.
 */

/**
 * Template taxonomy — a closed, curated union (not free-form strings) so
 * the filter chips, tests, and per-template tags stay honest: a typo is a
 * compile error, not a silently-empty filter. Mirrors
 * `slideTemplates.ts`' `TemplateCategory`, but tuned to document
 * use-cases rather than deck use-cases.
 */
export type DocumentTemplateCategory =
  | "Engineering"
  | "Meetings"
  | "Planning"
  | "Process"
  | "Product"
  | "Reporting"
  | "Strategy";

/**
 * Display-ordered category list for the gallery filter row. Drives the
 * filter chips so adding a category in one place updates the UI.
 */
export const DOCUMENT_TEMPLATE_CATEGORIES: readonly DocumentTemplateCategory[] =
  [
    "Engineering",
    "Meetings",
    "Planning",
    "Process",
    "Product",
    "Reporting",
    "Strategy",
  ] as const;

/** Sentinel for the implicit "show everything" filter chip. */
export const ALL_DOCUMENT_TEMPLATES_CATEGORY = "All" as const;

/** A gallery filter value: a real category or the "All" sentinel. */
export type DocumentTemplateCategoryFilter =
  | DocumentTemplateCategory
  | typeof ALL_DOCUMENT_TEMPLATES_CATEGORY;

/** A built-in document template — stateless metadata + insertable HTML. */
export interface DocumentTemplate {
  /** Stable id — persisted nowhere (built-ins are stateless starters). */
  id: string;
  /** Human label shown on the gallery card. */
  label: string;
  /** One-line description. */
  description: string;
  /** Emoji / text glyph for the picker card. */
  icon: string;
  /**
   * Use-case category for the gallery taxonomy / filter. Optional and
   * additive — an un-tagged template still appears under "All".
   */
  category?: DocumentTemplateCategory;
  /**
   * The starter content as TipTap-insertable HTML. Authored using only
   * schema-supported nodes so it parses losslessly on insert.
   */
  content: string;
}

// ─────────────────────────────────────────────────────────────────────
// Built-in catalogue
//
// Each `content` is a single HTML string in the shape `getHTML()` emits.
// Task lists use the canonical `ul[data-type="taskList"]` /
// `li[data-type="taskItem"]` shape TipTap's TaskItem parses; table cells
// wrap their text in a paragraph so cell content satisfies the `block+`
// schema. Kept deliberately conservative (no callouts / mermaid / images)
// so every node round-trips through the editor's parser unchanged.
// ─────────────────────────────────────────────────────────────────────

export const DOCUMENT_TEMPLATES: readonly DocumentTemplate[] = [
  {
    id: "doc-meeting-notes",
    label: "Meeting notes",
    description:
      "Agenda, discussion, decisions, and tracked action items for any meeting.",
    icon: "📝",
    category: "Meetings",
    content: `<h1>Meeting notes</h1>
<p><strong>Date:</strong> <br><strong>Attendees:</strong> <br><strong>Facilitator:</strong> </p>
<h2>Agenda</h2>
<ol><li><p>Topic one</p></li><li><p>Topic two</p></li><li><p>Topic three</p></li></ol>
<h2>Discussion</h2>
<p>Capture the key points raised for each agenda item.</p>
<h2>Decisions</h2>
<ul><li><p>Decision made and the rationale behind it.</p></li></ul>
<h2>Action items</h2>
<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Owner — action — due date</p></li><li data-type="taskItem" data-checked="false"><p>Owner — action — due date</p></li></ul>`,
  },
  {
    id: "doc-one-on-one",
    label: "1:1 notes",
    description:
      "Running agenda for a recurring one-on-one: wins, blockers, growth, follow-ups.",
    icon: "🤝",
    category: "Meetings",
    content: `<h1>1:1 — <em>Name</em></h1>
<p><strong>Date:</strong> </p>
<h2>Wins since last time</h2>
<ul><li><p>What went well</p></li></ul>
<h2>Challenges &amp; blockers</h2>
<ul><li><p>What's in the way</p></li></ul>
<h2>Growth &amp; feedback</h2>
<p>Career goals, skills to develop, feedback in both directions.</p>
<h2>Action items</h2>
<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Follow-up</p></li></ul>`,
  },
  {
    id: "doc-retro",
    label: "Sprint retrospective",
    description:
      "Structured retro: what went well, what didn't, and concrete improvements.",
    icon: "🔁",
    category: "Meetings",
    content: `<h1>Sprint retrospective</h1>
<p><strong>Sprint:</strong> <br><strong>Date:</strong> <br><strong>Participants:</strong> </p>
<h2>What went well</h2>
<ul><li><p>Keep doing this</p></li></ul>
<h2>What didn't go well</h2>
<ul><li><p>Pain point to address</p></li></ul>
<h2>What we'll try next</h2>
<ul><li><p>Experiment for the next sprint</p></li></ul>
<h2>Action items</h2>
<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Owner — improvement — by when</p></li></ul>`,
  },
  {
    id: "doc-prd",
    label: "Product requirements (PRD)",
    description:
      "Problem, goals, user stories, scope, and success metrics for a product spec.",
    icon: "📦",
    category: "Product",
    content: `<h1>PRD: <em>Feature name</em></h1>
<p><strong>Author:</strong> <br><strong>Status:</strong> Draft <br><strong>Last updated:</strong> </p>
<h2>Summary</h2>
<p>One paragraph: what we're building and why it matters now.</p>
<h2>Problem</h2>
<p>The user problem, with evidence. Who is affected and how often.</p>
<h2>Goals</h2>
<ul><li><p>Goal — the outcome we want</p></li></ul>
<h2>Non-goals</h2>
<ul><li><p>Explicitly out of scope for this release</p></li></ul>
<h2>User stories</h2>
<ul><li><p>As a <em>role</em>, I want <em>capability</em>, so that <em>benefit</em>.</p></li></ul>
<h2>Requirements</h2>
<table><tbody><tr><th><p>Requirement</p></th><th><p>Priority</p></th><th><p>Notes</p></th></tr><tr><td><p>Requirement one</p></td><td><p>P0</p></td><td><p></p></td></tr><tr><td><p>Requirement two</p></td><td><p>P1</p></td><td><p></p></td></tr></tbody></table>
<h2>Success metrics</h2>
<ul><li><p>Metric — target — how it's measured</p></li></ul>
<h2>Open questions</h2>
<ul><li><p>Question to resolve before build</p></li></ul>`,
  },
  {
    id: "doc-design-doc",
    label: "Technical design doc",
    description:
      "Context, proposed design, alternatives, and rollout for an engineering change.",
    icon: "🛠️",
    category: "Engineering",
    content: `<h1>Design: <em>Title</em></h1>
<p><strong>Author:</strong> <br><strong>Reviewers:</strong> <br><strong>Status:</strong> Draft </p>
<h2>Context &amp; problem</h2>
<p>What exists today and why it needs to change.</p>
<h2>Goals &amp; non-goals</h2>
<ul><li><p>Goal</p></li><li><p>Non-goal</p></li></ul>
<h2>Proposed design</h2>
<p>The approach, key components, and how data flows through them.</p>
<h2>Alternatives considered</h2>
<ul><li><p>Alternative — why it was not chosen</p></li></ul>
<h2>Risks &amp; mitigations</h2>
<blockquote><p>Call out the riskiest assumption and how you'll de-risk it.</p></blockquote>
<h2>Rollout &amp; testing</h2>
<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Migration / backfill plan</p></li><li data-type="taskItem" data-checked="false"><p>Test &amp; observability plan</p></li></ul>`,
  },
  {
    id: "doc-incident-postmortem",
    label: "Incident postmortem",
    description:
      "Blameless postmortem: impact, timeline, root cause, and follow-up actions.",
    icon: "🚨",
    category: "Engineering",
    content: `<h1>Postmortem: <em>Incident</em></h1>
<p><strong>Date:</strong> <br><strong>Severity:</strong> <br><strong>Authors:</strong> <br><strong>Status:</strong> Draft </p>
<h2>Summary</h2>
<p>What happened, in two or three sentences.</p>
<h2>Impact</h2>
<ul><li><p>Who / what was affected, for how long, and the measurable cost.</p></li></ul>
<h2>Timeline</h2>
<table><tbody><tr><th><p>Time</p></th><th><p>Event</p></th></tr><tr><td><p></p></td><td><p>Detection</p></td></tr><tr><td><p></p></td><td><p>Mitigation</p></td></tr><tr><td><p></p></td><td><p>Resolution</p></td></tr></tbody></table>
<h2>Root cause</h2>
<p>The underlying cause — blameless, focused on systems not people.</p>
<h2>What went well / what went poorly</h2>
<ul><li><p>Went well</p></li><li><p>Went poorly</p></li></ul>
<h2>Action items</h2>
<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Owner — preventive action — due date</p></li></ul>`,
  },
  {
    id: "doc-status-report",
    label: "Status report",
    description:
      "Weekly status: highlights, progress, risks, and next steps at a glance.",
    icon: "📊",
    category: "Reporting",
    content: `<h1>Status report</h1>
<p><strong>Period:</strong> <br><strong>Owner:</strong> <br><strong>Overall status:</strong> 🟢 On track </p>
<h2>Highlights</h2>
<ul><li><p>The most important thing a reader should know this week.</p></li></ul>
<h2>Progress</h2>
<table><tbody><tr><th><p>Workstream</p></th><th><p>Status</p></th><th><p>Notes</p></th></tr><tr><td><p>Workstream A</p></td><td><p>🟢</p></td><td><p></p></td></tr><tr><td><p>Workstream B</p></td><td><p>🟡</p></td><td><p></p></td></tr></tbody></table>
<h2>Risks &amp; blockers</h2>
<ul><li><p>Risk — impact — mitigation / ask</p></li></ul>
<h2>Next steps</h2>
<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Planned for next period</p></li></ul>`,
  },
  {
    id: "doc-sop",
    label: "Standard operating procedure",
    description:
      "Repeatable process: purpose, scope, roles, and numbered step-by-step.",
    icon: "📋",
    category: "Process",
    content: `<h1>SOP: <em>Procedure name</em></h1>
<p><strong>Owner:</strong> <br><strong>Version:</strong> 1.0 <br><strong>Last reviewed:</strong> </p>
<h2>Purpose</h2>
<p>What this procedure achieves and when to use it.</p>
<h2>Scope</h2>
<p>What is and isn't covered, and who it applies to.</p>
<h2>Roles &amp; responsibilities</h2>
<ul><li><p><strong>Role</strong> — responsibility</p></li></ul>
<h2>Procedure</h2>
<ol><li><p>First step — be specific and actionable.</p></li><li><p>Second step.</p></li><li><p>Third step.</p></li></ol>
<h2>Prerequisites &amp; checklist</h2>
<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Required access / tool / approval</p></li></ul>
<h2>References</h2>
<ul><li><p>Related document or policy</p></li></ul>`,
  },
  {
    id: "doc-decision-log",
    label: "Decision record",
    description:
      "Lightweight ADR: context, the decision, and its consequences and status.",
    icon: "⚖️",
    category: "Process",
    content: `<h1>Decision: <em>Title</em></h1>
<p><strong>Status:</strong> Proposed <br><strong>Date:</strong> <br><strong>Deciders:</strong> </p>
<h2>Context</h2>
<p>The forces at play — technical, product, and organisational — that make a decision necessary.</p>
<h2>Decision</h2>
<p>We will <em>…</em>. State it in one clear sentence.</p>
<h2>Alternatives considered</h2>
<ul><li><p>Option — why it was rejected</p></li></ul>
<h2>Consequences</h2>
<ul><li><p>Positive — what this unlocks</p></li><li><p>Negative — the cost or trade-off we accept</p></li></ul>`,
  },
  {
    id: "doc-project-plan",
    label: "Project plan",
    description:
      "Objective, milestones, timeline table, owners, and risks for a project.",
    icon: "🗺️",
    category: "Planning",
    content: `<h1>Project plan: <em>Project name</em></h1>
<p><strong>Owner:</strong> <br><strong>Start:</strong> <br><strong>Target:</strong> </p>
<h2>Objective</h2>
<p>The outcome this project delivers and why it matters.</p>
<h2>Scope</h2>
<ul><li><p><strong>In scope</strong> — included</p></li><li><p><strong>Out of scope</strong> — excluded</p></li></ul>
<h2>Milestones</h2>
<table><tbody><tr><th><p>Milestone</p></th><th><p>Owner</p></th><th><p>Target date</p></th><th><p>Status</p></th></tr><tr><td><p>Milestone one</p></td><td><p></p></td><td><p></p></td><td><p>Not started</p></td></tr><tr><td><p>Milestone two</p></td><td><p></p></td><td><p></p></td><td><p>Not started</p></td></tr></tbody></table>
<h2>Risks</h2>
<ul><li><p>Risk — likelihood / impact — mitigation</p></li></ul>
<h2>Next actions</h2>
<ul data-type="taskList"><li data-type="taskItem" data-checked="false"><p>Owner — action — due date</p></li></ul>`,
  },
  {
    id: "doc-one-pager",
    label: "One-pager brief",
    description:
      "Crisp single-page proposal: problem, proposal, impact, and the ask.",
    icon: "📄",
    category: "Strategy",
    content: `<h1><em>Proposal title</em></h1>
<p><strong>Author:</strong> <br><strong>Date:</strong> </p>
<blockquote><p>One-sentence summary of what you're proposing and the outcome it drives.</p></blockquote>
<h2>Problem</h2>
<p>The problem or opportunity, with just enough evidence to make it real.</p>
<h2>Proposal</h2>
<p>What you propose to do about it.</p>
<h2>Expected impact</h2>
<ul><li><p>The measurable benefit and who it helps</p></li></ul>
<h2>The ask</h2>
<p>Exactly what you need — decision, budget, people, or time.</p>`,
  },
] as const;

// ─────────────────────────────────────────────────────────────────────
// Safe preview text
// ─────────────────────────────────────────────────────────────────────

const HTML_ENTITY_REPLACEMENTS: ReadonlyArray<readonly [RegExp, string]> = [
  [/&nbsp;/gi, " "],
  [/&lt;/gi, "<"],
  [/&gt;/gi, ">"],
  [/&quot;/gi, '"'],
  [/&#39;|&apos;/gi, "'"],
  [/&amp;/gi, "&"],
];

/**
 * Derive a short, plain-text excerpt from a template's HTML for the
 * gallery card's live preview.
 *
 * Deliberately returns *text*, never markup: the value is rendered as a
 * React text node (which React escapes), so a tampered or hand-edited
 * custom template can never inject markup into the gallery — there is no
 * `dangerouslySetInnerHTML` anywhere in this feature. Tags are stripped
 * with a non-evaluating regex (the string is never parsed as HTML or
 * assigned to `innerHTML`), entities are decoded for the common cases,
 * whitespace is collapsed, and the result is bounded with an ellipsis.
 * `&amp;` is decoded last so an encoded entity like `&amp;lt;` becomes
 * the literal text `&lt;` rather than `<`.
 */
export function documentTemplatePreviewText(
  content: string,
  maxChars = 180,
): string {
  let text = content.replace(/<[^>]*>/g, " ");
  for (const [pattern, replacement] of HTML_ENTITY_REPLACEMENTS) {
    text = text.replace(pattern, replacement);
  }
  text = text.replace(/\s+/g, " ").trim();
  return text.length > maxChars
    ? `${text.slice(0, maxChars).trimEnd()}…`
    : text;
}

// ─────────────────────────────────────────────────────────────────────
// Gallery filtering (mirrors slideTemplates.filterSlideTemplates)
// ─────────────────────────────────────────────────────────────────────

/**
 * The minimal gallery-facing shape {@link filterDocumentTemplates} needs.
 * Both the built-in {@link DocumentTemplate} and the user-authored
 * `CustomDocumentTemplate` (see `customDocumentTemplates.ts`) satisfy it,
 * so the filter is generic over either — or a merged list — without this
 * module depending on the custom-template module. A built-in always
 * carries a string `description`; a custom one may omit it, hence the
 * optional field.
 */
export interface FilterableDocumentTemplate {
  label: string;
  description?: string;
  category?: DocumentTemplateCategory;
}

/**
 * Pure filter used by the template gallery. Narrows by `category` (the
 * "All" sentinel matches everything) and then by a free-text `query`
 * matched case-insensitively against the label, description, and
 * category. Input order is preserved and the source array is never
 * mutated, so callers can memoise on the result safely.
 *
 * Generic over {@link FilterableDocumentTemplate} so it filters built-in
 * or user templates (or a merged list) and returns the same concrete
 * element type it was given.
 */
export function filterDocumentTemplates<T extends FilterableDocumentTemplate>(
  templates: readonly T[],
  category: DocumentTemplateCategoryFilter,
  query: string,
): T[] {
  const normalisedQuery = query.trim().toLowerCase();
  return templates.filter((template) => {
    if (
      category !== ALL_DOCUMENT_TEMPLATES_CATEGORY &&
      template.category !== category
    ) {
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
