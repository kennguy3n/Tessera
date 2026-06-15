/**
 * User-authored slide templates — pure data model, defensive
 * `localStorage` store, and a portable template-file format.
 *
 * A built-in {@link SlideTemplate} (see `slideTemplates.ts`) is a
 * stateless metadata starter. A *user* template, by contrast, captures
 * a whole saved deck: `{ id, label, description?, category?, content:
 * SlideContent }`. The embedded `content` is the exact `SlideContent`
 * the editor persists, so applying a user template reproduces the deck
 * (slides, layouts, backgrounds, theme, aspect ratio, brand kit) — not
 * just a blueprint skeleton.
 *
 * This module is the renderer-only, local-first analogue of
 * `slideBrandKit.ts` (the persisted store) crossed with
 * `skills/customSkills.ts` (the portable export/import file). It mirrors
 * both deliberately so the validation, capping, defensive-parse, and
 * version-guard behaviour stay consistent across the app:
 *
 *   - Store envelope `{ version, templates }` keyed at
 *     {@link CUSTOM_SLIDE_TEMPLATES_STORAGE_KEY}; parse NEVER throws and
 *     drops bad / duplicate / foreign-id entries, capped at
 *     {@link MAX_CUSTOM_SLIDE_TEMPLATES}.
 *   - Portable envelope `{ format, version, template }` —
 *     {@link SLIDE_TEMPLATE_FORMAT}/{@link SLIDE_TEMPLATE_VERSION},
 *     DISTINCT from the store envelope and versioned independently.
 *     Import ALWAYS drops the id (a fresh one is minted on save) so an
 *     import is non-destructive and can never overwrite an existing
 *     template.
 *
 * The embedded deck is validated through {@link parseSlideContent} on
 * every path (capture, load, import) so an unknown layout / theme /
 * brand-kit id degrades exactly as it does everywhere else, and a
 * hand-edited or corrupt blob can never reach the canvas.
 */

import { parseSlideContent } from "./slideEditorHelpers";
import type { MarpModeState, SlideContent } from "./slideEditorTypes";
import { TEMPLATE_CATEGORIES, type TemplateCategory } from "./slideTemplates";

// ─────────────────────────────────────────────────────────────────────
// Constants
// ─────────────────────────────────────────────────────────────────────

/** `localStorage` key for the persisted user-template store. */
export const CUSTOM_SLIDE_TEMPLATES_STORAGE_KEY =
  "tessera.slidetemplates.custom";

/**
 * Store schema version. Independent of {@link SLIDE_TEMPLATE_VERSION}
 * (the portable-file version) — the on-disk store and the shareable
 * file evolve separately. Do NOT bump without a migration story.
 */
const SCHEMA_VERSION = 1;

/**
 * Id prefix marking a template as user-authored. Lets the store reject
 * foreign / tampered ids (mirrors `customSkills` `custom-` and
 * `slideBrandKit` `brand-`) and keeps custom ids from ever colliding
 * with a built-in {@link SlideTemplate} id.
 */
export const CUSTOM_SLIDE_TEMPLATE_ID_PREFIX = "tpl-";

/** Cap on stored user templates; the oldest is dropped on overflow. */
export const MAX_CUSTOM_SLIDE_TEMPLATES = 50;

/** Length bound for a template label (collapsed + trimmed). */
export const MAX_TEMPLATE_LABEL = 80;

/** Length bound for a template description (collapsed + trimmed). */
export const MAX_TEMPLATE_DESCRIPTION = 240;

/** Portable-file envelope discriminator. */
export const SLIDE_TEMPLATE_FORMAT = "tessera.slidetemplate";

/**
 * Portable-file schema version. Independent of the store
 * {@link SCHEMA_VERSION}. Bump only when the on-file envelope shape
 * changes; the import guard rejects files from a newer version.
 */
export const SLIDE_TEMPLATE_VERSION = 1;

// ─────────────────────────────────────────────────────────────────────
// Types
// ─────────────────────────────────────────────────────────────────────

/**
 * A user-authored slide template: a saved deck plus the gallery
 * metadata used to find + preview it. `content` is a fully-validated
 * {@link SlideContent}. The shape is intentionally flat + JSON-
 * serialisable so a future Brand Pack bundle (a sibling initiative) can
 * embed a `templates?: CustomSlideTemplate[]` array without coupling to
 * this module.
 */
export interface CustomSlideTemplate {
  /** Custom-namespaced id ({@link CUSTOM_SLIDE_TEMPLATE_ID_PREFIX}). */
  id: string;
  /** Display name shown on the gallery card. Always non-empty. */
  label: string;
  /** Optional one-line description; omitted when blank. */
  description?: string;
  /** Optional gallery category; an unknown value degrades to "All". */
  category?: TemplateCategory;
  /** The captured deck, reproduced verbatim when the template applies. */
  content: SlideContent;
}

/**
 * Mutable form backing the save / edit / import modal. `category` is a
 * plain string ("" = uncategorised → shows under "All"); an unknown id
 * is coerced away by {@link buildCustomSlideTemplate}. A present,
 * custom-namespaced `id` edits in place; its absence (or a foreign id)
 * mints a fresh id — which is what makes import non-destructive.
 */
export interface CustomSlideTemplateDraft {
  id?: string;
  label: string;
  description: string;
  category: string;
  content: SlideContent;
}

/** Result of building a template from a draft (validation gate). */
export type CustomSlideTemplateBuildResult =
  | { ok: true; template: CustomSlideTemplate }
  | { ok: false; errors: string[] };

/** Result of parsing a portable template file. */
export type SlideTemplateImportResult =
  | { ok: true; draft: CustomSlideTemplateDraft }
  | { ok: false; error: string };

// ─────────────────────────────────────────────────────────────────────
// Small total helpers (mirror slideBrandKit / customSkills)
// ─────────────────────────────────────────────────────────────────────

const CATEGORY_SET: ReadonlySet<string> = new Set<string>(TEMPLATE_CATEGORIES);

/** Narrow an arbitrary value to a known {@link TemplateCategory}. */
export function isTemplateCategory(value: unknown): value is TemplateCategory {
  return typeof value === "string" && CATEGORY_SET.has(value);
}

/** Whether `id` belongs to a user-authored slide template. */
export function isCustomSlideTemplateId(
  id: string | undefined | null,
): boolean {
  return (
    typeof id === "string" && id.startsWith(CUSTOM_SLIDE_TEMPLATE_ID_PREFIX)
  );
}

/**
 * Generate a locally-unique template id. Prefers `crypto.randomUUID`
 * (present in the Electron renderer + jsdom), falling back to a
 * time+random token so it never throws in an exotic host. Mirrors
 * `slideBrandKit.newBrandKitId`.
 */
export function newCustomSlideTemplateId(): string {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") {
    return `${CUSTOM_SLIDE_TEMPLATE_ID_PREFIX}${c.randomUUID()}`;
  }
  return `${CUSTOM_SLIDE_TEMPLATE_ID_PREFIX}${Date.now().toString(36)}-${Math.random()
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
// Deck normalisation (single source of validation, reused on every path)
// ─────────────────────────────────────────────────────────────────────

/**
 * Coerce an arbitrary value into a fully-validated {@link SlideContent}
 * by round-tripping it through {@link parseSlideContent} — the same
 * defensive parser the editor's content-sync path uses. The result is
 * reassembled into a minimal canonical object (only the deck-level
 * fields that are actually set), so two equal decks serialise
 * identically regardless of how the input was shaped.
 *
 * A non-deck value (missing `slides` array, a number, `null`, …) is
 * treated as "no deck" and yields the parser's empty default rather than
 * stuffing the raw blob into a text slide — so a corrupt import degrades
 * to a clean single-slide deck instead of leaking JSON into the canvas.
 */
export function normalizeSlideContent(content: unknown): SlideContent {
  const rec = asRecord(content);
  let json = "";
  if (typeof content === "string") {
    json = content;
  } else if (rec !== null && Array.isArray(rec.slides)) {
    try {
      json = JSON.stringify(content);
    } catch {
      json = "";
    }
  }

  const parsed = parseSlideContent(json);
  const normalized: SlideContent = { slides: parsed.slides };

  // Carry the marp block whenever any part of it is meaningful — Marp on,
  // a non-empty source, OR a chosen theme. The editor's own save path
  // (`debouncedSave`) always persists `theme`, so dropping a dormant theme
  // here (Marp off + empty source but a non-default theme picked earlier)
  // would lose a setting the deck otherwise round-trips, breaking faithful
  // reproduction the first time the user re-enables Marp.
  if (parsed.marpMode || parsed.marpSource.length > 0 || parsed.marpTheme) {
    const marp: MarpModeState = {
      enabled: parsed.marpMode,
      source: parsed.marpSource,
    };
    if (parsed.marpTheme) marp.theme = parsed.marpTheme;
    normalized.marp = marp;
  }
  normalized.themeId = parsed.themeId;
  normalized.aspectRatio = parsed.aspectRatio;
  if (parsed.brandKitId) normalized.brandKitId = parsed.brandKitId;

  return normalized;
}

// ─────────────────────────────────────────────────────────────────────
// Build / draft helpers (single source of validation, reused on load)
// ─────────────────────────────────────────────────────────────────────

/** A fresh, empty draft seeded with the deck being saved. */
export function emptySlideTemplateDraft(
  content: SlideContent,
): CustomSlideTemplateDraft {
  return { label: "", description: "", category: "", content };
}

/** Hydrate an editable draft from an existing template (edit in place). */
export function customSlideTemplateToDraft(
  template: CustomSlideTemplate,
): CustomSlideTemplateDraft {
  return {
    id: template.id,
    label: template.label,
    description: template.description ?? "",
    category: template.category ?? "",
    content: template.content,
  };
}

/**
 * Build a draft for duplicating a template: keep the deck + metadata but
 * drop the id (so a fresh one is minted) and suffix the label with
 * " (copy)" so the duplicate is distinguishable in the gallery.
 */
export function duplicateSlideTemplateDraft(
  template: CustomSlideTemplate,
): CustomSlideTemplateDraft {
  return {
    label: collapse(`${template.label} (copy)`, MAX_TEMPLATE_LABEL),
    description: template.description ?? "",
    category: template.category ?? "",
    content: template.content,
  };
}

/**
 * Validate + normalise a draft into a {@link CustomSlideTemplate}, or
 * return the validation errors. The single gate every persisted /
 * imported template passes through, so the store can never diverge from
 * the editor's own rules. A draft carrying a custom-namespaced id edits
 * that template in place; otherwise `idGen` mints a new one.
 */
export function buildCustomSlideTemplate(
  draft: CustomSlideTemplateDraft,
  idGen: () => string = newCustomSlideTemplateId,
): CustomSlideTemplateBuildResult {
  const errors: string[] = [];

  const label = collapse(draft.label, MAX_TEMPLATE_LABEL);
  if (!label) errors.push("Give the template a name.");

  if (errors.length > 0) return { ok: false, errors };

  const template: CustomSlideTemplate = {
    id: isCustomSlideTemplateId(draft.id) ? (draft.id as string) : idGen(),
    label,
    content: normalizeSlideContent(draft.content),
  };

  const description = collapse(draft.description, MAX_TEMPLATE_DESCRIPTION);
  if (description) template.description = description;
  if (isTemplateCategory(draft.category)) template.category = draft.category;

  return { ok: true, template };
}

// ─────────────────────────────────────────────────────────────────────
// List ops (insert/replace, remove, find) — mirror slideBrandKit
// ─────────────────────────────────────────────────────────────────────

/**
 * Insert `template` or replace the existing one with the same id,
 * preserving order (a replacement keeps its slot; a new template
 * appends). Enforces {@link MAX_CUSTOM_SLIDE_TEMPLATES} by dropping the
 * oldest when a *new* template would overflow — a replacement never
 * trips the cap.
 */
export function upsertCustomSlideTemplate(
  list: ReadonlyArray<CustomSlideTemplate>,
  template: CustomSlideTemplate,
): CustomSlideTemplate[] {
  const idx = list.findIndex((t) => t.id === template.id);
  if (idx >= 0) {
    const next = list.slice();
    next[idx] = template;
    return next;
  }
  const next = [...list, template];
  return next.length > MAX_CUSTOM_SLIDE_TEMPLATES
    ? next.slice(next.length - MAX_CUSTOM_SLIDE_TEMPLATES)
    : next;
}

/** Remove a template by id (no-op when absent). */
export function removeCustomSlideTemplate(
  list: ReadonlyArray<CustomSlideTemplate>,
  id: string,
): CustomSlideTemplate[] {
  return list.filter((t) => t.id !== id);
}

/** Find a template by id, or `null`. Total — safe with an absent id. */
export function findCustomSlideTemplate(
  list: ReadonlyArray<CustomSlideTemplate>,
  id: string | undefined | null,
): CustomSlideTemplate | null {
  if (id == null) return null;
  return list.find((t) => t.id === id) ?? null;
}

// ─────────────────────────────────────────────────────────────────────
// Defensive parse / serialize / load / save (mirrors slideBrandKit)
// ─────────────────────────────────────────────────────────────────────

/**
 * Coerce one raw stored object into a valid {@link CustomSlideTemplate},
 * or `null` when unusable. Routes through {@link buildCustomSlideTemplate}
 * so a persisted template reuses the exact same normalisation as the
 * save UI. A stored id that is not custom-namespaced is rejected so a
 * tampered blob cannot shadow a built-in or a foreign entry.
 */
export function parseStoredSlideTemplate(
  value: unknown,
): CustomSlideTemplate | null {
  const rec = asRecord(value);
  if (!rec) return null;
  if (typeof rec.id !== "string" || !isCustomSlideTemplateId(rec.id)) {
    return null;
  }
  if (typeof rec.label !== "string") return null;

  const draft: CustomSlideTemplateDraft = {
    id: rec.id,
    label: rec.label,
    description: typeof rec.description === "string" ? rec.description : "",
    category: isTemplateCategory(rec.category) ? rec.category : "",
    content: normalizeSlideContent(rec.content),
  };
  const result = buildCustomSlideTemplate(draft, () => rec.id as string);
  return result.ok ? result.template : null;
}

/**
 * Defensively parse a raw `localStorage` string into a validated list,
 * or `null` when absent/unusable. Never throws: bad JSON, a wrong schema
 * version, or a non-array `templates` all degrade to `null`;
 * individually-bad or duplicate-id templates are dropped, capped at
 * {@link MAX_CUSTOM_SLIDE_TEMPLATES}.
 */
export function parseCustomSlideTemplateStore(
  raw: string | null,
): CustomSlideTemplate[] | null {
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

  const out: CustomSlideTemplate[] = [];
  const seen = new Set<string>();
  for (const item of rec.templates) {
    const template = parseStoredSlideTemplate(item);
    if (template && !seen.has(template.id)) {
      seen.add(template.id);
      out.push(template);
      if (out.length >= MAX_CUSTOM_SLIDE_TEMPLATES) break;
    }
  }
  return out;
}

/** Serialize a template list to the persisted JSON string (with version). */
export function serializeCustomSlideTemplateStore(
  list: ReadonlyArray<CustomSlideTemplate>,
): string {
  return JSON.stringify({ version: SCHEMA_VERSION, templates: list });
}

/**
 * Load + validate the persisted templates. Returns `[]` (never null)
 * when there is nothing usable, so callers use the result directly.
 * Never throws.
 */
export function loadCustomSlideTemplates(): CustomSlideTemplate[] {
  try {
    return (
      parseCustomSlideTemplateStore(
        window.localStorage.getItem(CUSTOM_SLIDE_TEMPLATES_STORAGE_KEY),
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
export function saveCustomSlideTemplates(
  list: ReadonlyArray<CustomSlideTemplate>,
): void {
  try {
    window.localStorage.setItem(
      CUSTOM_SLIDE_TEMPLATES_STORAGE_KEY,
      serializeCustomSlideTemplateStore(list),
    );
  } catch {
    /* localStorage disabled / full — drop the write; UI is unaffected. */
  }
}

// ─────────────────────────────────────────────────────────────────────
// Portable template file (export / import) — mirrors customSkills #193
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

/** Filename for an exported template: `tessera-slide-template-<slug>.json`. */
export function slideTemplateFilename(template: CustomSlideTemplate): string {
  return `tessera-slide-template-${slugify(template.label)}.json`;
}

/**
 * Serialize a template to the portable JSON file body. Wraps it in the
 * `{ format, version, template }` envelope (DISTINCT from the store
 * envelope) and pretty-prints for a human-diffable file. Does NOT mutate
 * the source — `JSON.stringify` only reads.
 */
export function serializeSlideTemplate(template: CustomSlideTemplate): string {
  return JSON.stringify(
    {
      format: SLIDE_TEMPLATE_FORMAT,
      version: SLIDE_TEMPLATE_VERSION,
      template,
    },
    null,
    2,
  );
}

/**
 * Parse a portable template file into an import draft, or an error. The
 * version guard is hardened exactly like the skill-import one (#193):
 * reject a non-numeric / non-integer / `< 1` version FIRST (so `0`,
 * `-1`, `0.5`, `NaN`, `Infinity` all read as "not valid"), THEN reject a
 * version newer than this build understands.
 *
 * The id is ALWAYS dropped: the returned draft has no `id`, so saving it
 * mints a fresh custom id and an import can never overwrite an existing
 * template. The embedded deck is validated through
 * {@link normalizeSlideContent} so a corrupt deck degrades safely.
 */
export function parseSlideTemplate(raw: string): SlideTemplateImportResult {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return { ok: false, error: "This file isn’t valid JSON." };
  }

  const rec = asRecord(parsed);
  if (!rec || rec.format !== SLIDE_TEMPLATE_FORMAT) {
    return { ok: false, error: "This isn’t a Tessera slide template file." };
  }
  if (
    typeof rec.version !== "number" ||
    !Number.isInteger(rec.version) ||
    rec.version < 1
  ) {
    return {
      ok: false,
      error: "This isn’t a valid Tessera slide template file.",
    };
  }
  if (rec.version > SLIDE_TEMPLATE_VERSION) {
    return {
      ok: false,
      error: "This slide template was exported by a newer version of Tessera.",
    };
  }

  const templateRec = asRecord(rec.template);
  if (!templateRec || typeof templateRec.label !== "string") {
    return { ok: false, error: "This file doesn’t contain a slide template." };
  }

  const draft: CustomSlideTemplateDraft = {
    // No `id` — a fresh custom id is minted on save (non-destructive).
    label: templateRec.label,
    description:
      typeof templateRec.description === "string"
        ? templateRec.description
        : "",
    category: isTemplateCategory(templateRec.category)
      ? templateRec.category
      : "",
    content: normalizeSlideContent(templateRec.content),
  };

  const built = buildCustomSlideTemplate(draft);
  if (!built.ok) {
    return {
      ok: false,
      error: built.errors[0] ?? "This slide template couldn’t be imported.",
    };
  }
  return { ok: true, draft };
}
