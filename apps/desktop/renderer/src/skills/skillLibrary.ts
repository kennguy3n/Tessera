/**
 * Seed library of built-in skills.
 *
 * Each skill is a deliberate, multi-step instruction template designed
 * to make a SMALL on-device model produce output well above its
 * one-shot quality. The shapes are plain data (see `skillTypes.ts`) so
 * they can later be loaded from disk / connectors exactly like the YAML
 * artifact templates under `templates/<kind>/`.
 *
 * Only the Document skill is wired into a UI in this iteration; the
 * others are surface-agnostic and unit-tested so the slide/sheet/base
 * panels can adopt the same engine incrementally.
 */

import type { Skill, SkillSurface } from "./skillTypes";

/**
 * Document — "Deliberate draft": the canonical plan → draft → critique
 * → revise loop. Turns a small model's mediocre one-shot prose into
 * self-reviewed prose without any extra model capability.
 */
export const DOCUMENT_DELIBERATE_DRAFT: Skill = {
  id: "document-deliberate-draft",
  name: "Deliberate draft",
  description:
    "Plan, draft, self-critique, then revise — a four-step loop that lifts " +
    "a small local model's writing quality well above a single pass.",
  surfaces: ["document"],
  inputs: [
    {
      id: "topic",
      label: "What should this say?",
      required: true,
      placeholder: "e.g. A paragraph explaining our refund policy",
      multiline: true,
    },
    {
      id: "context",
      label: "Source material / notes (optional)",
      placeholder: "Paste any facts the draft must stay faithful to",
      multiline: true,
    },
  ],
  steps: [
    {
      id: "plan",
      title: "Plan the structure",
      kind: "plan",
      instruction:
        "Produce a short, ordered outline for the following writing task. " +
        "Capture the key points to cover, in order.\n\nTASK: {{topic}}",
      inputsFrom: ["context"],
      output: "outline",
      outputContract:
        "FORMAT: 3–6 lines, each a single '- ' bullet naming one point to " +
        "cover. No sub-bullets, no prose.",
    },
    {
      id: "draft",
      title: "Write the draft",
      kind: "draft",
      instruction:
        "Write the text for this task, following the outline exactly and " +
        "staying faithful to any supplied material.\n\nTASK: {{topic}}",
      inputsFrom: ["outline", "context"],
      output: "draft_text",
    },
    {
      id: "critique",
      title: "Self-critique",
      kind: "critique",
      instruction:
        "Review the draft below against the task. List concrete problems: " +
        "unsupported claims, vagueness, missing outline points, redundancy, " +
        "or tone issues.\n\nTASK: {{topic}}",
      inputsFrom: ["draft_text"],
      output: "critique",
      outputContract:
        "FORMAT: up to 5 '- ' bullets, each a single specific problem. If " +
        "the draft is already strong, output exactly 'NONE'.",
    },
    {
      id: "revise",
      title: "Apply the critique",
      kind: "revise",
      instruction:
        "Revise the draft to fix every point in the critique. If the " +
        "critique is 'NONE', return the draft unchanged. Preserve meaning " +
        "and any factual details.\n\nTASK: {{topic}}",
      inputsFrom: ["draft_text", "critique"],
      output: "final_text",
    },
  ],
};

/**
 * Slides — "Plan → write → tighten": outline a deck (count-pinned),
 * expand each section, then compress to short, presentable bullets.
 * Designed to feed the existing `parseDeckOutline` contract.
 */
export const SLIDE_PLAN_WRITE_TIGHTEN: Skill = {
  id: "slide-plan-write-tighten",
  name: "Plan, write & tighten a deck",
  description:
    "Outline a deck, expand each slide, then compress every bullet to a " +
    "tight, presentable line — three deliberate passes instead of one.",
  surfaces: ["slide"],
  inputs: [
    {
      id: "topic",
      label: "Deck topic",
      required: true,
      placeholder: "e.g. Q3 go-to-market plan",
      multiline: true,
    },
    {
      id: "slide_count",
      label: "Approximate slide count",
      placeholder: "e.g. 6",
    },
  ],
  steps: [
    {
      id: "outline",
      title: "Outline the deck",
      kind: "plan",
      instruction:
        "Outline a slide deck for this topic. Aim for about {{slide_count}} " +
        "slides (default to 6 if unspecified).\n\nTOPIC: {{topic}}",
      output: "deck_outline",
      outputContract:
        "FORMAT: one '## ' heading per slide, each followed by 2–4 '- ' " +
        "bullets. No prose outside this structure.",
    },
    {
      id: "expand",
      title: "Expand each slide",
      kind: "draft",
      instruction:
        "Expand the outline so every slide's bullets are concrete and " +
        "specific to the topic. Keep the same '## heading' + '- bullet' " +
        "structure and the same slide order.\n\nTOPIC: {{topic}}",
      inputsFrom: ["deck_outline"],
      output: "deck_expanded",
    },
    {
      id: "tighten",
      title: "Tighten the bullets",
      kind: "format",
      instruction:
        "Rewrite every bullet below to be at most 12 words, punchy, and " +
        "presentation-ready. Keep the heading/bullet structure and order " +
        "unchanged.",
      inputsFrom: ["deck_expanded"],
      output: "deck_final",
      outputContract:
        "FORMAT: preserve '## heading' lines and '- bullet' lines exactly; " +
        "only shorten the bullet wording.",
    },
  ],
};

/**
 * Sheets — "Intent → formula → self-check → repair": propose a formula,
 * have the model verify its own syntax, then repair if needed. (A
 * follow-up can replace the model self-check with the real
 * `parseFormula` engine as a deterministic tool step.)
 */
export const SHEET_INTENT_FORMULA_SELFCHECK: Skill = {
  id: "sheet-intent-formula-selfcheck",
  name: "Formula with self-check",
  description:
    "Translate intent into a spreadsheet formula, verify its syntax, then " +
    "repair it — so a small model is far less likely to emit a broken cell.",
  surfaces: ["sheet"],
  inputs: [
    {
      id: "intent",
      label: "What should the formula do?",
      required: true,
      placeholder: "e.g. Sum column B where column A equals 'Paid'",
      multiline: true,
    },
    {
      id: "columns",
      label: "Columns / headers (optional)",
      placeholder: "e.g. A=Status, B=Amount",
    },
  ],
  steps: [
    {
      id: "propose",
      title: "Propose a formula",
      kind: "draft",
      instruction:
        "Write a single spreadsheet formula that accomplishes this intent, " +
        "using the given columns where relevant.\n\nINTENT: {{intent}}",
      inputsFrom: ["columns"],
      output: "formula",
      outputContract:
        "FORMAT: output ONLY the formula on one line, starting with '='. No " +
        "explanation.",
    },
    {
      id: "check",
      title: "Self-check the syntax",
      kind: "critique",
      instruction:
        "Check whether the formula below is valid spreadsheet syntax and " +
        "actually satisfies the intent. Note any problem with parentheses, " +
        "function names, or argument counts.\n\nINTENT: {{intent}}",
      inputsFrom: ["formula"],
      output: "formula_check",
      outputContract:
        "FORMAT: if correct, output exactly 'OK'. Otherwise output one line " +
        "describing the single most important problem.",
    },
    {
      id: "repair",
      title: "Repair if needed",
      kind: "revise",
      instruction:
        "If the check is 'OK', return the formula unchanged. Otherwise " +
        "return a corrected single formula that fixes the noted problem and " +
        "satisfies the intent.\n\nINTENT: {{intent}}",
      inputsFrom: ["formula", "formula_check"],
      output: "formula_final",
      outputContract:
        "FORMAT: output ONLY the final formula on one line, starting with " +
        "'='. No explanation.",
    },
  ],
};

/**
 * Base — "Schema design": propose a relational schema, critique it for
 * normalization / relations, then emit the finalized tables and fields.
 */
export const BASE_SCHEMA_DESIGN: Skill = {
  id: "base-schema-design",
  name: "Design a base schema",
  description:
    "Propose tables and fields for a use case, critique the design for " +
    "normalization and relationships, then emit a clean final schema.",
  surfaces: ["base"],
  inputs: [
    {
      id: "use_case",
      label: "What is the base for?",
      required: true,
      placeholder: "e.g. Track sales pipeline: companies, contacts, deals",
      multiline: true,
    },
  ],
  steps: [
    {
      id: "propose",
      title: "Propose tables & fields",
      kind: "draft",
      instruction:
        "Propose a set of tables and their fields for this use case. " +
        "Include field types and any links between tables.\n\nUSE CASE: " +
        "{{use_case}}",
      output: "schema_draft",
      outputContract:
        "FORMAT: one '## TableName' heading per table, each followed by " +
        "'- field_name: type' lines. Use 'link → OtherTable' as the type " +
        "for relationships.",
    },
    {
      id: "critique",
      title: "Critique the design",
      kind: "critique",
      instruction:
        "Review the schema for normalization problems, missing links, " +
        "redundant fields, and missing primary identifiers.\n\nUSE CASE: " +
        "{{use_case}}",
      inputsFrom: ["schema_draft"],
      output: "schema_critique",
      outputContract:
        "FORMAT: up to 5 '- ' bullets, each one concrete issue. If the " +
        "design is sound, output exactly 'NONE'.",
    },
    {
      id: "finalize",
      title: "Emit final schema",
      kind: "revise",
      instruction:
        "Apply the critique and emit the final schema. If the critique is " +
        "'NONE', return the draft unchanged.\n\nUSE CASE: {{use_case}}",
      inputsFrom: ["schema_draft", "schema_critique"],
      output: "schema_final",
      outputContract:
        "FORMAT: same structure as the draft — '## TableName' headings with " +
        "'- field_name: type' lines.",
    },
  ],
};

/** Every built-in skill, in display order. */
export const BUILTIN_SKILLS: Skill[] = [
  DOCUMENT_DELIBERATE_DRAFT,
  SLIDE_PLAN_WRITE_TIGHTEN,
  SHEET_INTENT_FORMULA_SELFCHECK,
  BASE_SCHEMA_DESIGN,
];

/** Look up a skill by id. */
export function getSkillById(id: string): Skill | undefined {
  return BUILTIN_SKILLS.find((skill) => skill.id === id);
}

/** All built-in skills offered on a given surface, in display order. */
export function getSkillsForSurface(surface: SkillSurface): Skill[] {
  return BUILTIN_SKILLS.filter((skill) => skill.surfaces.includes(surface));
}
