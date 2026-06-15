/**
 * User-authored Base templates — pure data model, defensive
 * `localStorage` store, and a portable template-file format.
 *
 * A built-in {@link BaseTemplate} (see `baseTemplates.ts`) is a
 * stateless metadata starter. A *user* template, by contrast, captures
 * a whole saved base: `{ id, label, description?, category?, content:
 * BaseDocument }`. The embedded `content` is a fully-validated
 * {@link BaseDocument}, so applying a user template reproduces the base
 * (every table, field, sample records, and the app-mode config) — not
 * just a skeleton.
 *
 * This is the Base analogue of `customSlideTemplates.ts` and mirrors it
 * (and `skills/customSkills.ts`) deliberately so validation, capping,
 * defensive-parse, and version-guard behaviour stay consistent:
 *
 *   - Store envelope `{ version, templates }` keyed at
 *     {@link CUSTOM_BASE_TEMPLATES_STORAGE_KEY}; parse NEVER throws and
 *     drops bad / duplicate / foreign-id entries, capped at
 *     {@link MAX_CUSTOM_BASE_TEMPLATES}.
 *   - Portable envelope `{ format, version, template }` —
 *     {@link BASE_TEMPLATE_FORMAT}/{@link BASE_TEMPLATE_VERSION},
 *     DISTINCT from the store envelope and versioned independently.
 *     Import ALWAYS drops the id (a fresh one is minted on save) so an
 *     import is non-destructive and can never overwrite an existing
 *     template.
 *
 * The embedded base is validated through {@link parseBaseDocument} on
 * every path (capture, load, import) via {@link coerceBaseDocument}, so
 * a corrupt or hand-edited blob degrades exactly as a corrupt artifact
 * body would and can never reach the editor unvalidated.
 */

import {
  parseBaseDocument,
  serializeBaseDocument,
} from "./baseDocumentHelpers";
import {
  BASE_TEMPLATE_CATEGORIES,
  type BaseTemplateCategory,
} from "./baseTemplates";
import type { BaseDocument } from "./baseEditorTypes";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

/** `localStorage` key for the persisted user-template store. */
export const CUSTOM_BASE_TEMPLATES_STORAGE_KEY = "tessera.basetemplates.custom";

/**
 * Store schema version. Independent of {@link BASE_TEMPLATE_VERSION}
 * (the portable-file version) — the on-disk store and the shareable file
 * evolve separately. Do NOT bump without a migration story.
 */
const SCHEMA_VERSION = 1;

/**
 * Id prefix marking a template as user-authored. Lets the store reject
 * foreign / tampered ids and keeps custom ids from ever colliding with a
 * built-in {@link BaseTemplate} id (which are bare kebab-case).
 */
export const CUSTOM_BASE_TEMPLATE_ID_PREFIX = "basetpl-";

/** Cap on stored user templates; the oldest is dropped on overflow. */
export const MAX_CUSTOM_BASE_TEMPLATES = 50;

/** Length bound for a template label (collapsed + trimmed). */
export const MAX_BASE_TEMPLATE_LABEL = 80;

/** Length bound for a template description (collapsed + trimmed). */
export const MAX_BASE_TEMPLATE_DESCRIPTION = 240;

/** Portable-file envelope discriminator. */
export const BASE_TEMPLATE_FORMAT = "tessera.basetemplate";

/**
 * Portable-file schema version. Independent of the store
 * {@link SCHEMA_VERSION}. Bump only when the on-file envelope shape
 * changes; the import guard rejects files from a newer version.
 */
export const BASE_TEMPLATE_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

/**
 * A user-authored base template: a saved base plus the gallery metadata
 * used to find + preview it. `content` is a fully-validated
 * {@link BaseDocument}.
 */
export interface CustomBaseTemplate {
  /** Custom-namespaced id ({@link CUSTOM_BASE_TEMPLATE_ID_PREFIX}). */
  id: string;
  /** Display name shown on the gallery card. Always non-empty. */
  label: string;
  /** Optional one-line description; omitted when blank. */
  description?: string;
  /** Optional gallery category; an unknown value degrades to "All". */
  category?: BaseTemplateCategory;
  /** The captured base, reproduced when the template applies. */
  content: BaseDocument;
}

/**
 * Mutable form backing the save / import flow. `category` is a plain
 * string ("" = uncategorised → shows under "All"); an unknown id is
 * coerced away by {@link buildCustomBaseTemplate}. A present,
 * custom-namespaced `id` edits in place; its absence (or a foreign id)
 * mints a fresh id — which is what makes import non-destructive.
 */
export interface CustomBaseTemplateDraft {
  id?: string;
  label: string;
  description: string;
  category: string;
  content: BaseDocument;
}

/** Result of building a template from a draft (validation gate). */
export type CustomBaseTemplateBuildResult =
  | { ok: true; template: CustomBaseTemplate }
  | { ok: false; errors: string[] };

/** Result of parsing a portable template file. */
export type BaseTemplateImportResult =
  | { ok: true; draft: CustomBaseTemplateDraft }
  | { ok: false; error: string };

// ─────────────────────────────────────────────────────────────────────
// Small total helpers (mirror customSlideTemplates)
// ─────────────────────────────────────────────────────────────────────

const CATEGORY_SET: ReadonlySet<string> = new Set<string>(
  BASE_TEMPLATE_CATEGORIES,
);

/** Narrow an arbitrary value to a known {@link BaseTemplateCategory}. */
export function isBaseTemplateCategory(
  value: unknown,
): value is BaseTemplateCategory {
  return typeof value === "string" && CATEGORY_SET.has(value);
}

/** Whether `id` belongs to a user-authored base template. */
export function isCustomBaseTemplateId(id: string | undefined | null): boolean {
  return (
    typeof id === "string" && id.startsWith(CUSTOM_BASE_TEMPLATE_ID_PREFIX)
  );
}

/**
 * Generate a locally-unique template id. Prefers `crypto.randomUUID`
 * (present in the Electron renderer + jsdom), falling back to a
 * time+random token so it never throws in an exotic host.
 */
export function newCustomBaseTemplateId(): string {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") {
    return `${CUSTOM_BASE_TEMPLATE_ID_PREFIX}${c.randomUUID()}`;
  }
  return `${CUSTOM_BASE_TEMPLATE_ID_PREFIX}${Date.now().toString(36)}-${Math.random()
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
// Base normalisation (single source of validation, reused on every path)
// ─────────────────────────────────────────────────────────────────────

/**
 * Coerce an arbitrary value into a fully-validated, independent
 * {@link BaseDocument} by round-tripping it through the editor's own
 * artifact codec ({@link serializeBaseDocument} → {@link parseBaseDocument}).
 * This deep-clones the input (so the stored template never shares record
 * / field references with the live editor), re-runs every field + table
 * sanitiser, mints any missing record ids, and reconciles the app config
 * — exactly as loading a saved base would.
 *
 * Input handling:
 *   - a `BaseDocument`-shaped object is serialised then re-parsed;
 *   - a raw artifact-body string is parsed directly;
 *   - anything else degrades to the parser's default seed base, so a
 *     corrupt import yields a clean usable base instead of throwing.
 */
export function coerceBaseDocument(content: unknown): BaseDocument {
  if (typeof content === "string") return parseBaseDocument(content);
  const rec = asRecord(content);
  if (rec) {
    try {
      return parseBaseDocument(serializeBaseDocument(content as BaseDocument));
    } catch {
      return parseBaseDocument("");
    }
  }
  return parseBaseDocument("");
}

/**
 * Produce a fresh, independent {@link BaseDocument} ready to install as
 * the editor's live document — a deep clone with re-validated fields and
 * a reconciled app config. Used by the gallery's "apply" path for both
 * built-in and user templates.
 */
export function instantiateBaseDocument(doc: BaseDocument): BaseDocument {
  return coerceBaseDocument(doc);
}

// ─────────────────────────────────────────────────────────────────────
// Build / draft helpers (single source of validation, reused on load)
// ─────────────────────────────────────────────────────────────────────

/** A fresh, empty draft seeded with the base being saved. */
export function emptyBaseTemplateDraft(
  content: BaseDocument,
): CustomBaseTemplateDraft {
  return { label: "", description: "", category: "", content };
}

/** Hydrate an editable draft from an existing template (edit in place). */
export function customBaseTemplateToDraft(
  template: CustomBaseTemplate,
): CustomBaseTemplateDraft {
  return {
    id: template.id,
    label: template.label,
    description: template.description ?? "",
    category: template.category ?? "",
    content: template.content,
  };
}

/**
 * Build a draft for duplicating a template: keep the base + metadata but
 * drop the id (so a fresh one is minted) and suffix the label with
 * " (copy)" so the duplicate is distinguishable in the gallery.
 */
export function duplicateBaseTemplateDraft(
  template: CustomBaseTemplate,
): CustomBaseTemplateDraft {
  return {
    label: collapse(`${template.label} (copy)`, MAX_BASE_TEMPLATE_LABEL),
    description: template.description ?? "",
    category: template.category ?? "",
    content: template.content,
  };
}

/**
 * Validate + normalise a draft into a {@link CustomBaseTemplate}, or
 * return the validation errors. The single gate every persisted /
 * imported template passes through. A draft carrying a custom-namespaced
 * id edits that template in place; otherwise `idGen` mints a new one.
 */
export function buildCustomBaseTemplate(
  draft: CustomBaseTemplateDraft,
  idGen: () => string = newCustomBaseTemplateId,
): CustomBaseTemplateBuildResult {
  const errors: string[] = [];

  const label = collapse(draft.label, MAX_BASE_TEMPLATE_LABEL);
  if (!label) errors.push("Give the template a name.");

  if (errors.length > 0) return { ok: false, errors };

  const template: CustomBaseTemplate = {
    id: isCustomBaseTemplateId(draft.id) ? (draft.id as string) : idGen(),
    label,
    content: coerceBaseDocument(draft.content),
  };

  const description = collapse(
    draft.description,
    MAX_BASE_TEMPLATE_DESCRIPTION,
  );
  if (description) template.description = description;
  if (isBaseTemplateCategory(draft.category))
    template.category = draft.category;

  return { ok: true, template };
}

// ─────────────────────────────────────────────────────────────────────
// List ops (insert/replace, remove, find) — mirror customSlideTemplates
// ─────────────────────────────────────────────────────────────────────

/**
 * Insert `template` or replace the existing one with the same id,
 * preserving order (a replacement keeps its slot; a new template
 * appends). Enforces {@link MAX_CUSTOM_BASE_TEMPLATES} by dropping the
 * oldest when a *new* template would overflow — a replacement never trips
 * the cap.
 */
export function upsertCustomBaseTemplate(
  list: ReadonlyArray<CustomBaseTemplate>,
  template: CustomBaseTemplate,
): CustomBaseTemplate[] {
  const idx = list.findIndex((t) => t.id === template.id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = template;
    return next;
  }
  const next = [...list, template];
  return next.length > MAX_CUSTOM_BASE_TEMPLATES
    ? next.slice(next.length - MAX_CUSTOM_BASE_TEMPLATES)
    : next;
}

/** Remove a template by id (no-op when absent). */
export function removeCustomBaseTemplate(
  list: ReadonlyArray<CustomBaseTemplate>,
  id: string,
): CustomBaseTemplate[] {
  return list.filter((t) => t.id !== id);
}

/** Find a template by id, or `null`. Total — safe with an absent id. */
export function findCustomBaseTemplate(
  list: ReadonlyArray<CustomBaseTemplate>,
  id: string | undefined | null,
): CustomBaseTemplate | null {
  if (id == null) return null;
  return list.find((t) => t.id === id) ?? null;
}

// ─────────────────────────────────────────────────────────────────────
// Defensive parse / serialize / load / save (mirrors customSlideTemplates)
// ─────────────────────────────────────────────────────────────────────

/**
 * Coerce one raw stored object into a valid {@link CustomBaseTemplate},
 * or `null` when unusable. Routes through {@link buildCustomBaseTemplate}
 * so a persisted template reuses the exact same normalisation as the save
 * UI. A stored id that is not custom-namespaced is rejected so a tampered
 * blob cannot shadow a built-in or a foreign entry.
 */
export function parseStoredBaseTemplate(
  value: unknown,
): CustomBaseTemplate | null {
  const rec = asRecord(value);
  if (!rec) return null;
  if (typeof rec.id !== "string" || !isCustomBaseTemplateId(rec.id)) {
    return null;
  }
  if (typeof rec.label !== "string") return null;

  const draft: CustomBaseTemplateDraft = {
    id: rec.id,
    label: rec.label,
    description: typeof rec.description === "string" ? rec.description : "",
    category: isBaseTemplateCategory(rec.category) ? rec.category : "",
    content: coerceBaseDocument(rec.content),
  };
  const result = buildCustomBaseTemplate(draft, () => rec.id as string);
  return result.ok ? result.template : null;
}

/**
 * Defensively parse a raw `localStorage` string into a validated list, or
 * `null` when absent/unusable. Never throws: bad JSON, a wrong schema
 * version, or a non-array `templates` all degrade to `null`;
 * individually-bad or duplicate-id templates are dropped, capped at
 * {@link MAX_CUSTOM_BASE_TEMPLATES}.
 */
export function parseCustomBaseTemplateStore(
  raw: string | null,
): CustomBaseTemplate[] | null {
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

  const out: CustomBaseTemplate[] = [];
  const seen = new Set<string>();
  for (const item of rec.templates) {
    const template = parseStoredBaseTemplate(item);
    if (template && !seen.has(template.id)) {
      seen.add(template.id);
      out.push(template);
      if (out.length >= MAX_CUSTOM_BASE_TEMPLATES) break;
    }
  }
  return out;
}

/** Serialize a template list to the persisted JSON string (with version). */
export function serializeCustomBaseTemplateStore(
  list: ReadonlyArray<CustomBaseTemplate>,
): string {
  return JSON.stringify({ version: SCHEMA_VERSION, templates: list });
}

/**
 * Load + validate the persisted templates. Returns `[]` (never null) when
 * there is nothing usable, so callers use the result directly. Never
 * throws.
 */
export function loadCustomBaseTemplates(): CustomBaseTemplate[] {
  try {
    return (
      parseCustomBaseTemplateStore(
        window.localStorage.getItem(CUSTOM_BASE_TEMPLATES_STORAGE_KEY),
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
export function saveCustomBaseTemplates(
  list: ReadonlyArray<CustomBaseTemplate>,
): void {
  try {
    window.localStorage.setItem(
      CUSTOM_BASE_TEMPLATES_STORAGE_KEY,
      serializeCustomBaseTemplateStore(list),
    );
  } catch {
    /* localStorage disabled / full — drop the write; UI is unaffected. */
  }
}

// ─────────────────────────────────────────────────────────────────────
// Portable template file (export / import)
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

/** Filename for an exported template: `tessera-base-template-<slug>.json`. */
export function baseTemplateFilename(template: CustomBaseTemplate): string {
  return `tessera-base-template-${slugify(template.label)}.json`;
}

/**
 * Serialize a template to the portable JSON file body. Wraps it in the
 * `{ format, version, template }` envelope (DISTINCT from the store
 * envelope) and pretty-prints for a human-diffable file. Does NOT mutate
 * the source — `JSON.stringify` only reads.
 */
export function serializeBaseTemplate(template: CustomBaseTemplate): string {
  return JSON.stringify(
    {
      format: BASE_TEMPLATE_FORMAT,
      version: BASE_TEMPLATE_VERSION,
      template,
    },
    null,
    2,
  );
}

/**
 * Parse a portable template file into an import draft, or an error. The
 * version guard is hardened exactly like the slide-template / skill-import
 * ones: reject a non-numeric / non-integer / `< 1` version FIRST (so `0`,
 * `-1`, `0.5`, `NaN`, `Infinity` all read as "not valid"), THEN reject a
 * version newer than this build understands.
 *
 * The id is ALWAYS dropped: the returned draft has no `id`, so saving it
 * mints a fresh custom id and an import can never overwrite an existing
 * template. The embedded base is validated through
 * {@link coerceBaseDocument} so a corrupt base degrades safely.
 */
export function parseBaseTemplate(raw: string): BaseTemplateImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "This file isn’t valid JSON." };
  }

  const rec = asRecord(parsed);
  if (!rec || rec.format !== BASE_TEMPLATE_FORMAT) {
    return { ok: false, error: "This isn’t a Tessera base template file." };
  }
  if (
    typeof rec.version !== "number" ||
    !Number.isInteger(rec.version) ||
    rec.version < 1
  ) {
    return {
      ok: false,
      error: "This isn’t a valid Tessera base template file.",
    };
  }
  if (rec.version > BASE_TEMPLATE_VERSION) {
    return {
      ok: false,
      error: "This base template was exported by a newer version of Tessera.",
    };
  }

  const templateRec = asRecord(rec.template);
  if (!templateRec || typeof templateRec.label !== "string") {
    return { ok: false, error: "This file doesn’t contain a base template." };
  }

  const draft: CustomBaseTemplateDraft = {
    // No `id` — a fresh custom id is minted on save (non-destructive).
    label: templateRec.label,
    description:
      typeof templateRec.description === "string"
        ? templateRec.description
        : "",
    category: isBaseTemplateCategory(templateRec.category)
      ? templateRec.category
      : "",
    content: coerceBaseDocument(templateRec.content),
  };

  const built = buildCustomBaseTemplate(draft);
  if (!built.ok) {
    return {
      ok: false,
      error: built.errors[0] ?? "This base template couldn’t be imported.",
    };
  }
  return { ok: true, draft };
}
