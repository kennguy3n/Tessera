/**
 * User-authored document templates — pure data model, defensive
 * `localStorage` store, and a portable template-file format.
 *
 * A built-in {@link DocumentTemplate} (see `documentTemplates.ts`) is a
 * stateless metadata starter. A *user* template, by contrast, captures a
 * snapshot of a real document the user authored:
 * `{ id, label, description?, category?, content: string }`. The embedded
 * `content` is HTML — the exact shape `editor.getHTML()` persists — so
 * applying a user template reproduces that document (headings, lists,
 * tables, marks) rather than a blueprint skeleton.
 *
 * This module is the document-editor analogue of
 * `customSlideTemplates.ts`, and is mirrored deliberately so the
 * validation, capping, defensive-parse, and version-guard behaviour stay
 * consistent across the app:
 *
 *   - Store envelope `{ version, templates }` keyed at
 *     {@link CUSTOM_DOCUMENT_TEMPLATES_STORAGE_KEY}; parse NEVER throws
 *     and drops bad / duplicate / foreign-id entries, capped at
 *     {@link MAX_CUSTOM_DOCUMENT_TEMPLATES}.
 *   - Portable envelope `{ format, version, template }` —
 *     {@link DOCUMENT_TEMPLATE_FORMAT}/{@link DOCUMENT_TEMPLATE_VERSION},
 *     DISTINCT from the store envelope and versioned independently.
 *     Import ALWAYS drops the id (a fresh one is minted on save) so an
 *     import is non-destructive and can never overwrite an existing
 *     template.
 *
 * The embedded content is normalised through {@link parseDocumentContent}
 * — the same defensive parser the editor's content-sync path uses — on
 * every path (capture, load, import). The editor itself then re-parses
 * the HTML through TipTap's schema on insert, which strips any node or
 * attribute the schema doesn't allow, so a hand-edited or corrupt blob
 * can never inject markup the editor wouldn't itself emit.
 */

import { parseDocumentContent } from "./documentEditorHelpers";
import {
  DOCUMENT_TEMPLATE_CATEGORIES,
  type DocumentTemplateCategory,
} from "./documentTemplates";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

/** `localStorage` key for the persisted user-template store. */
export const CUSTOM_DOCUMENT_TEMPLATES_STORAGE_KEY =
  "tessera.doctemplates.custom";

/**
 * Store schema version. Independent of {@link DOCUMENT_TEMPLATE_VERSION}
 * (the portable-file version) — the on-disk store and the shareable file
 * evolve separately. Do NOT bump without a migration story.
 */
const SCHEMA_VERSION = 1;

/**
 * Id prefix marking a template as user-authored. Lets the store reject
 * foreign / tampered ids (mirrors `customSlideTemplates` `tpl-` and
 * `customSkills` `custom-`) and keeps custom ids from ever colliding with
 * a built-in {@link DocumentTemplate} id (`doc-…`).
 */
export const CUSTOM_DOCUMENT_TEMPLATE_ID_PREFIX = "doctpl-";

/** Cap on stored user templates; the oldest is dropped on overflow. */
export const MAX_CUSTOM_DOCUMENT_TEMPLATES = 50;

/** Length bound for a template label (collapsed + trimmed). */
export const MAX_DOCUMENT_TEMPLATE_LABEL = 80;

/** Length bound for a template description (collapsed + trimmed). */
export const MAX_DOCUMENT_TEMPLATE_DESCRIPTION = 240;

/** Portable-file envelope discriminator. */
export const DOCUMENT_TEMPLATE_FORMAT = "tessera.doctemplate";

/**
 * Portable-file schema version. Independent of the store
 * {@link SCHEMA_VERSION}. Bump only when the on-file envelope shape
 * changes; the import guard rejects files from a newer version.
 */
export const DOCUMENT_TEMPLATE_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

/**
 * A user-authored document template: a saved document plus the gallery
 * metadata used to find + preview it. `content` is normalised HTML. The
 * shape is intentionally flat + JSON-serialisable so a future bundle can
 * embed a `templates?: CustomDocumentTemplate[]` array without coupling
 * to this module.
 */
export interface CustomDocumentTemplate {
  /** Custom-namespaced id ({@link CUSTOM_DOCUMENT_TEMPLATE_ID_PREFIX}). */
  id: string;
  /** Display name shown on the gallery card. Always non-empty. */
  label: string;
  /** Optional one-line description; omitted when blank. */
  description?: string;
  /** Optional gallery category; an unknown value degrades to "All". */
  category?: DocumentTemplateCategory;
  /** The captured document HTML, inserted when the template applies. */
  content: string;
}

/**
 * Mutable form backing the save / edit / import modal. `category` is a
 * plain string ("" = uncategorised → shows under "All"); an unknown id is
 * coerced away by {@link buildCustomDocumentTemplate}. A present,
 * custom-namespaced `id` edits in place; its absence (or a foreign id)
 * mints a fresh id — which is what makes import non-destructive.
 */
export interface CustomDocumentTemplateDraft {
  id?: string;
  label: string;
  description: string;
  category: string;
  content: string;
}

/** Result of building a template from a draft (validation gate). */
export type CustomDocumentTemplateBuildResult =
  | { ok: true; template: CustomDocumentTemplate }
  | { ok: false; errors: string[] };

/** Result of parsing a portable template file. */
export type DocumentTemplateImportResult =
  | { ok: true; draft: CustomDocumentTemplateDraft }
  | { ok: false; error: string };

// ─────────────────────────────────────────────────────────────────────
// Small total helpers (mirror customSlideTemplates / customSkills)
// ─────────────────────────────────────────────────────────────────────

const CATEGORY_SET: ReadonlySet<string> = new Set<string>(
  DOCUMENT_TEMPLATE_CATEGORIES,
);

/** Narrow an arbitrary value to a known {@link DocumentTemplateCategory}. */
export function isDocumentTemplateCategory(
  value: unknown,
): value is DocumentTemplateCategory {
  return typeof value === "string" && CATEGORY_SET.has(value);
}

/** Whether `id` belongs to a user-authored document template. */
export function isCustomDocumentTemplateId(
  id: string | undefined | null,
): boolean {
  return (
    typeof id === "string" && id.startsWith(CUSTOM_DOCUMENT_TEMPLATE_ID_PREFIX)
  );
}

/**
 * Generate a locally-unique template id. Prefers `crypto.randomUUID`
 * (present in the Electron renderer + jsdom), falling back to a
 * time+random token so it never throws in an exotic host. Mirrors
 * `newCustomSlideTemplateId`.
 */
export function newCustomDocumentTemplateId(): string {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") {
    return `${CUSTOM_DOCUMENT_TEMPLATE_ID_PREFIX}${c.randomUUID()}`;
  }
  return `${CUSTOM_DOCUMENT_TEMPLATE_ID_PREFIX}${Date.now().toString(36)}-${Math.random()
    .toString(36)
    .slice(2, 10)}`;
}

/** Collapse internal whitespace + trim, then length-bound. */
function collapse(raw: string, max: number): string {
  const s = (raw ?? "").replace(/\s+/g, " ").trim();
  return s.length > max ? s.slice(0, max).trimEnd() : s;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

// ─────────────────────────────────────────────────────────────────────
// Content normalisation (single source of validation, reused everywhere)
// ─────────────────────────────────────────────────────────────────────

/**
 * Coerce an arbitrary value into normalised document HTML by routing it
 * through {@link parseDocumentContent} — the same defensive parser the
 * editor's content-sync path uses. A non-string value (a number, `null`,
 * an object, …) is treated as "no content" and yields the parser's empty
 * default (`<p></p>`) rather than stuffing a raw blob into the document,
 * so a corrupt import degrades to a clean empty document instead of
 * leaking JSON into the editor.
 *
 * The returned HTML is still re-parsed by TipTap's schema on insert,
 * which is what ultimately strips any disallowed node/attribute; this
 * step guarantees the stored value is always a well-formed HTML string.
 */
export function normalizeDocumentTemplateContent(content: unknown): string {
  return parseDocumentContent(typeof content === "string" ? content : "");
}

// ─────────────────────────────────────────────────────────────────────
// Build / draft helpers (single source of validation, reused on load)
// ─────────────────────────────────────────────────────────────────────

/** A fresh, empty draft seeded with the document being saved. */
export function emptyDocumentTemplateDraft(
  content: string,
): CustomDocumentTemplateDraft {
  return { label: "", description: "", category: "", content };
}

/** Hydrate an editable draft from an existing template (edit in place). */
export function customDocumentTemplateToDraft(
  template: CustomDocumentTemplate,
): CustomDocumentTemplateDraft {
  return {
    id: template.id,
    label: template.label,
    description: template.description ?? "",
    category: template.category ?? "",
    content: template.content,
  };
}

/**
 * Build a draft for duplicating a template: keep the content + metadata
 * but drop the id (so a fresh one is minted) and suffix the label with
 * " (copy)" so the duplicate is distinguishable in the gallery.
 */
export function duplicateDocumentTemplateDraft(
  template: CustomDocumentTemplate,
): CustomDocumentTemplateDraft {
  return {
    label: collapse(`${template.label} (copy)`, MAX_DOCUMENT_TEMPLATE_LABEL),
    description: template.description ?? "",
    category: template.category ?? "",
    content: template.content,
  };
}

/**
 * Validate + normalise a draft into a {@link CustomDocumentTemplate}, or
 * return the validation errors. The single gate every persisted /
 * imported template passes through, so the store can never diverge from
 * the editor's own rules. A draft carrying a custom-namespaced id edits
 * that template in place; otherwise `idGen` mints a new one.
 */
export function buildCustomDocumentTemplate(
  draft: CustomDocumentTemplateDraft,
  idGen: () => string = newCustomDocumentTemplateId,
): CustomDocumentTemplateBuildResult {
  const errors: string[] = [];

  const label = collapse(draft.label, MAX_DOCUMENT_TEMPLATE_LABEL);
  if (!label) errors.push("Give the template a name.");

  if (errors.length > 0) return { ok: false, errors };

  const template: CustomDocumentTemplate = {
    id: isCustomDocumentTemplateId(draft.id) ? (draft.id as string) : idGen(),
    label,
    content: normalizeDocumentTemplateContent(draft.content),
  };

  const description = collapse(
    draft.description,
    MAX_DOCUMENT_TEMPLATE_DESCRIPTION,
  );
  if (description) template.description = description;
  if (isDocumentTemplateCategory(draft.category)) {
    template.category = draft.category;
  }

  return { ok: true, template };
}

// ─────────────────────────────────────────────────────────────────────
// List ops (insert/replace, remove, find) — mirror customSlideTemplates
// ─────────────────────────────────────────────────────────────────────

/**
 * Insert `template` or replace the existing one with the same id,
 * preserving order (a replacement keeps its slot; a new template
 * appends). Enforces {@link MAX_CUSTOM_DOCUMENT_TEMPLATES} by dropping the
 * oldest when a *new* template would overflow — a replacement never trips
 * the cap.
 */
export function upsertCustomDocumentTemplate(
  list: ReadonlyArray<CustomDocumentTemplate>,
  template: CustomDocumentTemplate,
): CustomDocumentTemplate[] {
  const idx = list.findIndex((t) => t.id === template.id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = template;
    return next;
  }
  const next = [...list, template];
  return next.length > MAX_CUSTOM_DOCUMENT_TEMPLATES
    ? next.slice(next.length - MAX_CUSTOM_DOCUMENT_TEMPLATES)
    : next;
}

/** Remove a template by id (no-op when absent). */
export function removeCustomDocumentTemplate(
  list: ReadonlyArray<CustomDocumentTemplate>,
  id: string,
): CustomDocumentTemplate[] {
  return list.filter((t) => t.id !== id);
}

/** Find a template by id, or `null`. Total — safe with an absent id. */
export function findCustomDocumentTemplate(
  list: ReadonlyArray<CustomDocumentTemplate>,
  id: string | undefined | null,
): CustomDocumentTemplate | null {
  if (id == null) return null;
  return list.find((t) => t.id === id) ?? null;
}

// ─────────────────────────────────────────────────────────────────────
// Defensive parse / serialize / load / save (mirrors customSlideTemplates)
// ─────────────────────────────────────────────────────────────────────

/**
 * Coerce one raw stored object into a valid
 * {@link CustomDocumentTemplate}, or `null` when unusable. Routes through
 * {@link buildCustomDocumentTemplate} so a persisted template reuses the
 * exact same normalisation as the save UI. A stored id that is not
 * custom-namespaced is rejected so a tampered blob cannot shadow a
 * built-in or a foreign entry.
 */
export function parseStoredDocumentTemplate(
  value: unknown,
): CustomDocumentTemplate | null {
  const rec = asRecord(value);
  if (!rec) return null;
  if (typeof rec.id !== "string" || !isCustomDocumentTemplateId(rec.id)) {
    return null;
  }
  if (typeof rec.label !== "string") return null;

  const draft: CustomDocumentTemplateDraft = {
    id: rec.id,
    label: rec.label,
    description: typeof rec.description === "string" ? rec.description : "",
    category: isDocumentTemplateCategory(rec.category) ? rec.category : "",
    content: normalizeDocumentTemplateContent(rec.content),
  };
  const result = buildCustomDocumentTemplate(draft, () => rec.id as string);
  return result.ok ? result.template : null;
}

/**
 * Defensively parse a raw `localStorage` string into a validated list, or
 * `null` when absent/unusable. Never throws: bad JSON, a wrong schema
 * version, or a non-array `templates` all degrade to `null`;
 * individually-bad or duplicate-id templates are dropped, capped at
 * {@link MAX_CUSTOM_DOCUMENT_TEMPLATES}.
 */
export function parseCustomDocumentTemplateStore(
  raw: string | null,
): CustomDocumentTemplate[] | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const rec = asRecord(parsed);
  if (!rec) return null;
  if (rec.version !== SCHEMA_VERSION) return null;
  if (!Array.isArray(rec.templates)) return null;

  const out: CustomDocumentTemplate[] = [];
  const seen = new Set<string>();
  for (const item of rec.templates) {
    const template = parseStoredDocumentTemplate(item);
    if (template && !seen.has(template.id)) {
      seen.add(template.id);
      out.push(template);
      if (out.length >= MAX_CUSTOM_DOCUMENT_TEMPLATES) break;
    }
  }
  return out;
}

/** Serialize a template list to the persisted JSON string (with version). */
export function serializeCustomDocumentTemplateStore(
  list: ReadonlyArray<CustomDocumentTemplate>,
): string {
  return JSON.stringify({ version: SCHEMA_VERSION, templates: list });
}

/**
 * Load + validate the persisted templates. Returns `[]` (never null) when
 * there is nothing usable, so callers use the result directly. Never
 * throws.
 */
export function loadCustomDocumentTemplates(): CustomDocumentTemplate[] {
  try {
    return (
      parseCustomDocumentTemplateStore(
        window.localStorage.getItem(CUSTOM_DOCUMENT_TEMPLATES_STORAGE_KEY),
      ) ?? []
    );
  } catch {
    return [];
  }
}

/**
 * Persist `list`. Best-effort: silently no-ops if `localStorage` is
 * unavailable or the write is rejected (quota/locked).
 */
export function saveCustomDocumentTemplates(
  list: ReadonlyArray<CustomDocumentTemplate>,
): void {
  try {
    window.localStorage.setItem(
      CUSTOM_DOCUMENT_TEMPLATES_STORAGE_KEY,
      serializeCustomDocumentTemplateStore(list),
    );
  } catch {
    /* localStorage disabled / full — drop the write; UI is unaffected. */
  }
}

// ─────────────────────────────────────────────────────────────────────
// Portable template file (export / import) — mirrors customSlideTemplates
// ─────────────────────────────────────────────────────────────────────

/**
 * A URL/file-safe slug derived from a label, used to name the export
 * file. Non-alphanumerics collapse to single hyphens; the result is
 * length-bounded and never empty.
 */
function slugify(label: string): string {
  const slug = label
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/g, "");
  return slug || "template";
}

/** Filename for an exported template: `tessera-doc-template-<slug>.json`. */
export function documentTemplateFilename(
  template: CustomDocumentTemplate,
): string {
  return `tessera-doc-template-${slugify(template.label)}.json`;
}

/**
 * Serialize a template to the portable JSON file body. Wraps it in the
 * `{ format, version, template }` envelope (DISTINCT from the store
 * envelope) and pretty-prints for a human-diffable file. Does NOT mutate
 * the source — `JSON.stringify` only reads.
 */
export function serializeDocumentTemplate(
  template: CustomDocumentTemplate,
): string {
  return JSON.stringify(
    {
      format: DOCUMENT_TEMPLATE_FORMAT,
      version: DOCUMENT_TEMPLATE_VERSION,
      template,
    },
    null,
    2,
  );
}

/**
 * Parse a portable template file into an import draft, or an error. The
 * version guard is hardened exactly like the skill-import / slide-import
 * ones: reject a non-numeric / non-integer / `< 1` version FIRST (so `0`,
 * `-1`, `0.5`, `NaN`, `Infinity` all read as "not valid"), THEN reject a
 * version newer than this build understands.
 *
 * The id is ALWAYS dropped: the returned draft has no `id`, so saving it
 * mints a fresh custom id and an import can never overwrite an existing
 * template. The embedded content is validated through
 * {@link normalizeDocumentTemplateContent} so a corrupt blob degrades
 * safely.
 */
export function parseDocumentTemplate(
  raw: string,
): DocumentTemplateImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "This file isn’t valid JSON." };
  }

  const rec = asRecord(parsed);
  if (!rec || rec.format !== DOCUMENT_TEMPLATE_FORMAT) {
    return { ok: false, error: "This isn’t a Tessera document template file." };
  }
  if (
    typeof rec.version !== "number" ||
    !Number.isInteger(rec.version) ||
    rec.version < 1
  ) {
    return {
      ok: false,
      error: "This isn’t a valid Tessera document template file.",
    };
  }
  if (rec.version > DOCUMENT_TEMPLATE_VERSION) {
    return {
      ok: false,
      error:
        "This document template was exported by a newer version of Tessera.",
    };
  }

  const templateRec = asRecord(rec.template);
  if (!templateRec || typeof templateRec.label !== "string") {
    return {
      ok: false,
      error: "This file doesn’t contain a document template.",
    };
  }

  const draft: CustomDocumentTemplateDraft = {
    // No `id` — a fresh custom id is minted on save (non-destructive).
    label: templateRec.label,
    description:
      typeof templateRec.description === "string"
        ? templateRec.description
        : "",
    category: isDocumentTemplateCategory(templateRec.category)
      ? templateRec.category
      : "",
    content: normalizeDocumentTemplateContent(templateRec.content),
  };

  const built = buildCustomDocumentTemplate(draft);
  if (!built.ok) {
    return {
      ok: false,
      error: built.errors[0] ?? "This document template couldn’t be imported.",
    };
  }
  return { ok: true, draft };
}
