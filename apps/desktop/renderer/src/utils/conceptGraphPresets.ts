/**
 * Saved concept-graph filter *presets*, persisted per scope.
 *
 * A preset is a named snapshot of the graph's filter combination —
 * disabled relation types, disabled node kinds, the scope sub-filter,
 * local-graph mode + hop distance, the "show all labels" toggle, and
 * whether the decay overlay is on. Users can save the combination they
 * keep re-deriving, switch between saved views with one click, and mark
 * one as the default that loads automatically for that scope.
 *
 * The pure logic (sanitize / build / upsert / remove / match) lives here
 * with unit tests; the component is a thin shell that calls these and
 * persists the result. Persistence is intentionally a *separate*
 * `localStorage` key from the live view state so the high-frequency
 * pan/zoom writes never churn the (rarely-changed) preset list, and so a
 * corrupt preset blob can't take down view-state restore (and vice
 * versa).
 *
 * Privacy (multi-tenant, ~5000 SMEs): a preset stores only the same
 * non-sensitive UI enums/booleans/integers as the view state, plus the
 * **user-authored preset name** — the one free-text field, which the user
 * deliberately types as a label for their own filter combo (never derived
 * from document/concept content). Names are trimmed and length-bounded;
 * everything else is validated through the `conceptGraph` type guards so
 * a tampered blob can't inject bogus enum values.
 */

import {
  isConceptNodeState,
  isConceptRelation,
  type ConceptNodeState,
  type ConceptRelation,
} from "./conceptGraph";

/** Namespace prefix; the scope id is appended to form the full key. */
const KEY_PREFIX = "tessera.conceptGraph.presets.";

/** Schema version for the persisted preset store. */
const SCHEMA_VERSION = 1;

/** Upper bound on `localHops`, mirrored from the panel's hop control. */
const MAX_HOPS = 3;

/** Max characters kept for a preset name (trimmed + collapsed first). */
export const MAX_PRESET_NAME = 60;

/** Hard cap on saved presets per scope (defensive against unbounded growth). */
export const MAX_PRESETS = 50;

/** Fallback name when the user-supplied name is empty after sanitizing. */
export const FALLBACK_PRESET_NAME = "Untitled view";

/**
 * The filter subset a preset captures — exactly the view controls that
 * define "what subset of the graph am I looking at", excluding transient
 * per-session state (selection, pan/zoom, scrubber position).
 */
export interface PresetFilter {
  disabledRelations: ConceptRelation[];
  disabledStates: ConceptNodeState[];
  scopeFilter: string;
  localMode: boolean;
  localHops: number;
  labelsAll: boolean;
  decayMode: boolean;
}

/** A named, identified preset = a {@link PresetFilter} + id + name. */
export interface ConceptGraphPreset extends PresetFilter {
  /** Opaque, locally-unique id (never shown to the user). */
  id: string;
  /** User-authored display name (sanitized, length-bounded). */
  name: string;
}

/** The persisted per-scope preset store. */
export interface ConceptGraphPresetStore {
  presets: ConceptGraphPreset[];
  /** Id of the preset applied automatically on load, or null. */
  defaultPresetId: string | null;
}

/** Empty store (fresh scope / parse fallback). */
export function defaultPresetStore(): ConceptGraphPresetStore {
  return { presets: [], defaultPresetId: null };
}

/** Full `localStorage` key for a scope's preset store. */
export function presetStorageKey(scopeId: string): string {
  return `${KEY_PREFIX}${scopeId}`;
}

/**
 * Trim, collapse internal whitespace, and length-bound a user-entered
 * preset name. Returns {@link FALLBACK_PRESET_NAME} when nothing usable
 * remains so a preset always has a visible label.
 */
export function sanitizePresetName(raw: string): string {
  const collapsed = raw.replace(/\s+/g, " ").trim();
  if (!collapsed) return FALLBACK_PRESET_NAME;
  return collapsed.length > MAX_PRESET_NAME
    ? collapsed.slice(0, MAX_PRESET_NAME).trimEnd()
    : collapsed;
}

/** Clamp/normalize a hop count into 1..MAX_HOPS. */
function normalizeHops(hops: number): number {
  if (!Number.isFinite(hops)) return 1;
  return Math.min(MAX_HOPS, Math.max(1, Math.trunc(hops)));
}

/**
 * Normalize a raw filter (e.g. straight from the component's live state)
 * into a clean {@link PresetFilter}: dedupe + validate enum arrays and
 * clamp hops, so what we persist is always well-formed regardless of how
 * the caller assembled it.
 */
export function normalizeFilter(filter: PresetFilter): PresetFilter {
  return {
    disabledRelations: dedupe(filter.disabledRelations.filter(isConceptRelation)),
    disabledStates: dedupe(filter.disabledStates.filter(isConceptNodeState)),
    scopeFilter: typeof filter.scopeFilter === "string" ? filter.scopeFilter : "all",
    localMode: !!filter.localMode,
    localHops: normalizeHops(filter.localHops),
    labelsAll: !!filter.labelsAll,
    decayMode: !!filter.decayMode,
  };
}

/**
 * Build a preset from a name + filter + id. The name is sanitized and the
 * filter normalized. `idGen` defaults to {@link newPresetId} but is
 * injectable so tests get deterministic ids.
 */
export function makePreset(
  name: string,
  filter: PresetFilter,
  idGen: () => string = newPresetId,
): ConceptGraphPreset {
  return {
    id: idGen(),
    name: sanitizePresetName(name),
    ...normalizeFilter(filter),
  };
}

/**
 * Insert `preset` or replace the existing one with the same id, preserving
 * order (replacement keeps its slot; a new preset appends). Enforces
 * {@link MAX_PRESETS} by dropping the oldest when a *new* preset would
 * overflow — a replacement never trips the cap.
 */
export function upsertPreset(
  presets: ReadonlyArray<ConceptGraphPreset>,
  preset: ConceptGraphPreset,
): ConceptGraphPreset[] {
  const idx = presets.findIndex((p) => p.id === preset.id);
  if (idx >= 0) {
    const next = presets.slice();
    next[idx] = preset;
    return next;
  }
  const next = [...presets, preset];
  return next.length > MAX_PRESETS ? next.slice(next.length - MAX_PRESETS) : next;
}

/**
 * Save `filter` under the user-entered `rawName`, *updating in place* when a
 * preset with the same sanitized name already exists (preserving its id and
 * slot) rather than appending a duplicate. This makes "Save view" idempotent
 * for a given name — re-saving "Hubs only" overwrites the existing "Hubs only"
 * instead of stacking copies. A brand-new name appends (subject to
 * {@link MAX_PRESETS}). `idGen` is injectable for deterministic tests.
 */
export function upsertPresetByName(
  presets: ReadonlyArray<ConceptGraphPreset>,
  rawName: string,
  filter: PresetFilter,
  idGen: () => string = newPresetId,
): ConceptGraphPreset[] {
  const name = sanitizePresetName(rawName);
  const existing = presets.find((p) => p.name === name);
  const preset: ConceptGraphPreset = existing
    ? { ...existing, name, ...normalizeFilter(filter) }
    : makePreset(rawName, filter, idGen);
  return upsertPreset(presets, preset);
}

/** Remove a preset by id (no-op when absent). */
export function removePreset(
  presets: ReadonlyArray<ConceptGraphPreset>,
  id: string,
): ConceptGraphPreset[] {
  return presets.filter((p) => p.id !== id);
}

/** Find a preset by id, or null. */
export function findPreset(
  presets: ReadonlyArray<ConceptGraphPreset>,
  id: string | null,
): ConceptGraphPreset | null {
  if (id === null) return null;
  return presets.find((p) => p.id === id) ?? null;
}

/**
 * Whether a live filter exactly matches a preset's captured filter (used
 * to highlight the active preset and to decide if "save" would be a
 * no-op). Compares the normalized forms so ordering/dupes don't matter.
 */
export function filterMatchesPreset(
  filter: PresetFilter,
  preset: ConceptGraphPreset,
): boolean {
  const a = normalizeFilter(filter);
  return (
    sameSet(a.disabledRelations, preset.disabledRelations) &&
    sameSet(a.disabledStates, preset.disabledStates) &&
    a.scopeFilter === preset.scopeFilter &&
    a.localMode === preset.localMode &&
    a.localHops === preset.localHops &&
    a.labelsAll === preset.labelsAll &&
    a.decayMode === preset.decayMode
  );
}

/**
 * Id of the preset whose filter matches `filter`, or null when none does
 * (i.e. the user has diverged from every saved view). First match wins.
 */
export function activePresetId(
  presets: ReadonlyArray<ConceptGraphPreset>,
  filter: PresetFilter,
): string | null {
  for (const p of presets) if (filterMatchesPreset(filter, p)) return p.id;
  return null;
}

/**
 * Generate a locally-unique preset id. Prefers `crypto.randomUUID` (always
 * present in the Electron renderer + jsdom 22+); falls back to a
 * time+random token so the function never throws in an exotic host.
 */
export function newPresetId(): string {
  const c = typeof globalThis !== "undefined" ? globalThis.crypto : undefined;
  if (c && typeof c.randomUUID === "function") return c.randomUUID();
  return `p-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

// ---------------------------------------------------------------------------
// Defensive parse / serialize / load / save (mirrors conceptGraphViewState).
// ---------------------------------------------------------------------------

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

/** Validate one raw preset object, or null when unusable. */
function parsePreset(value: unknown): ConceptGraphPreset | null {
  const rec = asRecord(value);
  if (!rec) return null;
  if (typeof rec.id !== "string" || !rec.id) return null;
  if (typeof rec.name !== "string") return null;
  const disabledRelations = Array.isArray(rec.disabledRelations)
    ? dedupe(rec.disabledRelations.filter(isConceptRelation))
    : [];
  const disabledStates = Array.isArray(rec.disabledStates)
    ? dedupe(rec.disabledStates.filter(isConceptNodeState))
    : [];
  const hops =
    typeof rec.localHops === "number" && Number.isFinite(rec.localHops)
      ? normalizeHops(rec.localHops)
      : 1;
  return {
    id: rec.id,
    name: sanitizePresetName(rec.name),
    disabledRelations,
    disabledStates,
    scopeFilter: typeof rec.scopeFilter === "string" ? rec.scopeFilter : "all",
    localMode: typeof rec.localMode === "boolean" ? rec.localMode : false,
    localHops: hops,
    labelsAll: typeof rec.labelsAll === "boolean" ? rec.labelsAll : false,
    decayMode: typeof rec.decayMode === "boolean" ? rec.decayMode : false,
  };
}

/**
 * Defensively parse a raw `localStorage` string into a validated
 * {@link ConceptGraphPresetStore}, or `null` when absent/unusable. Never
 * throws: bad JSON, a wrong schema version, or a non-array `presets` all
 * degrade to `null`; individually-bad presets are dropped. A
 * `defaultPresetId` that doesn't resolve to a surviving preset is cleared
 * so the store can never point at a ghost default.
 */
export function parsePresetStore(raw: string | null): ConceptGraphPresetStore | null {
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
  if (!Array.isArray(rec.presets)) return null;

  const presets: ConceptGraphPreset[] = [];
  const seen = new Set<string>();
  for (const raw of rec.presets) {
    const p = parsePreset(raw);
    // Drop duplicates by id so a tampered blob can't seed an ambiguous list.
    if (p && !seen.has(p.id)) {
      seen.add(p.id);
      presets.push(p);
      if (presets.length >= MAX_PRESETS) break;
    }
  }

  const rawDefault =
    typeof rec.defaultPresetId === "string" ? rec.defaultPresetId : null;
  const defaultPresetId = rawDefault && seen.has(rawDefault) ? rawDefault : null;

  return { presets, defaultPresetId };
}

/** Serialize a preset store to the persisted JSON string (with version). */
export function serializePresetStore(store: ConceptGraphPresetStore): string {
  return JSON.stringify({
    version: SCHEMA_VERSION,
    presets: store.presets,
    defaultPresetId: store.defaultPresetId,
  });
}

/**
 * Load + validate the persisted preset store for `scopeId`. Returns an
 * empty store (never null) when there's nothing usable, so callers can use
 * the result directly. Never throws.
 */
export function loadPresetStore(scopeId: string): ConceptGraphPresetStore {
  try {
    return (
      parsePresetStore(window.localStorage.getItem(presetStorageKey(scopeId))) ??
      defaultPresetStore()
    );
  } catch {
    return defaultPresetStore();
  }
}

/**
 * Persist `store` for `scopeId`. Best-effort: silently no-ops if
 * `localStorage` is unavailable or the write is rejected (quota/locked).
 */
export function savePresetStore(
  scopeId: string,
  store: ConceptGraphPresetStore,
): void {
  try {
    window.localStorage.setItem(
      presetStorageKey(scopeId),
      serializePresetStore(store),
    );
  } catch {
    /* localStorage disabled / full — drop the write; UI is unaffected. */
  }
}

function dedupe<T>(values: ReadonlyArray<T>): T[] {
  return Array.from(new Set(values));
}

/**
 * Order-independent set equality for small enum arrays. Builds a set from each
 * side so the result is correct regardless of duplicate elements (it does not
 * assume the inputs are pre-deduped, even though in practice they always are).
 */
function sameSet<T>(a: ReadonlyArray<T>, b: ReadonlyArray<T>): boolean {
  const setA = new Set(a);
  const setB = new Set(b);
  if (setA.size !== setB.size) return false;
  for (const v of setA) if (!setB.has(v)) return false;
  return true;
}
