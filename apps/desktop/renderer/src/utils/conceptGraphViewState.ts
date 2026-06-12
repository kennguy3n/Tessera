/**
 * Per-scope persistence of the concept-graph *view* controls.
 *
 * The concept-graph panel (`ConceptGraphPanel`) exposes a handful of
 * view controls — which relation types / node kinds are hidden, the
 * "show every label" toggle, local-graph mode + hop distance, the
 * selected node, the scope filter, and the current zoom/pan (viewBox).
 * None of these survived a reload, so the user had to re-derive their
 * working set every time. This module persists just that UI state in
 * `localStorage`, namespaced per scope so panels for different scopes
 * don't clobber each other.
 *
 * Privacy (this is a multi-tenant, ~5000-SME app): the persisted blob
 * contains **only** UI state already present in the renderer — relation/
 * state enums, booleans, small integers, node ids, viewBox numbers, and
 * an integer fingerprint of the visible node-id set. It never contains
 * any source content, evidence text, concept *labels*, or secrets. The
 * blob is intentionally minimal and non-sensitive so a shared/synced or
 * forensically-recovered `localStorage` reveals nothing about the
 * tenant's knowledge.
 *
 * Robustness: parsing mirrors the defensive discipline in
 * `conceptGraph.ts` — a malformed, partial, truncated, or
 * schema-drifted blob never throws; every field is validated
 * independently and falls back to its default. Reads/writes are wrapped
 * so a disabled/quota-exceeded `localStorage` (private browsing, a
 * locked-down WebView) degrades to "no persistence" rather than
 * crashing the renderer.
 */

import {
  isConceptNodeState,
  isConceptRelation,
  type ConceptNodeState,
  type ConceptRelation,
  type FitBox,
} from "./conceptGraph";

/** Namespace prefix; the scope id is appended to form the full key. */
const KEY_PREFIX = "tessera.conceptGraph.viewState.";

/** Schema version, bumped if the persisted shape changes incompatibly. */
const SCHEMA_VERSION = 1;

/** Upper bound on `localHops`, mirrored from the panel's hop control. */
const MAX_HOPS = 3;

/**
 * The persisted, validated view state. Every field is optional on read
 * (a partial/old blob omits some) and the panel merges it over its
 * defaults; the serializer always writes the full object.
 */
export interface ConceptGraphViewState {
  /** Relation types the user has toggled *off* in the legend. */
  disabledRelations: ConceptRelation[];
  /** Node kinds (lifecycle states) the user has toggled *off*. */
  disabledStates: ConceptNodeState[];
  /** "Show every label regardless of zoom/density" toggle. */
  labelsAll: boolean;
  /** Whether the local-graph (neighborhood) mode is active. */
  localMode: boolean;
  /** Local-graph hop distance (1..MAX_HOPS). */
  localHops: number;
  /** Selected concept node id, or null. */
  selectedId: string | null;
  /** Scope sub-filter ("all" or a concrete scope id). */
  scopeFilter: string;
  /** Persisted zoom/pan, or null to fall back to fit-on-load. */
  viewBox: FitBox | null;
  /**
   * Integer fingerprint of the visible node-id set when `viewBox` was
   * saved. On restore the panel only re-applies `viewBox` if the current
   * fingerprint matches; otherwise it re-fits (the persisted pan/zoom is
   * meaningless against a different node set). 0 means "no fingerprint".
   */
  viewSignature: number;
}

/** The defaults a fresh panel starts from (also the parse fallback). */
export function defaultViewState(): ConceptGraphViewState {
  return {
    disabledRelations: [],
    disabledStates: [],
    labelsAll: false,
    localMode: false,
    localHops: 1,
    selectedId: null,
    scopeFilter: "all",
    viewBox: null,
    viewSignature: 0,
  };
}

/** Full `localStorage` key for a scope's view state. */
export function viewStateStorageKey(scopeId: string): string {
  return `${KEY_PREFIX}${scopeId}`;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asFiniteNumber(value: unknown): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/** A finite, positive (or zero) box with non-zero size, else null. */
function parseFitBox(value: unknown): FitBox | null {
  const rec = asRecord(value);
  if (!rec) return null;
  const x = asFiniteNumber(rec.x);
  const y = asFiniteNumber(rec.y);
  const width = asFiniteNumber(rec.width);
  const height = asFiniteNumber(rec.height);
  if (x === null || y === null || width === null || height === null) return null;
  if (width <= 0 || height <= 0) return null;
  return { x, y, width, height };
}

/**
 * Deterministic 32-bit fingerprint of a set of node ids (order-
 * independent). Used to decide whether a persisted viewBox still applies
 * to the currently-visible nodes. Combines a per-id FNV-1a hash with a
 * commutative XOR/sum mix so it doesn't depend on iteration order, plus
 * the count so two different sets that happen to XOR-collide still differ
 * by length. Returns an unsigned 32-bit integer.
 */
export function computeViewSignature(ids: Iterable<string>): number {
  // Keep the XOR and SUM mixes in *separate* accumulators: each is
  // individually commutative, so the result is independent of iteration
  // order. (Interleaving XOR and ADD in one accumulator would not be.)
  let xorAcc = 0;
  let sumAcc = 0;
  let count = 0;
  for (const id of ids) {
    let h = 0x811c9dc5;
    for (let i = 0; i < id.length; i++) {
      h ^= id.charCodeAt(i);
      h = Math.imul(h, 0x01000193);
    }
    xorAcc = (xorAcc ^ (h >>> 0)) >>> 0;
    sumAcc = (sumAcc + Math.imul(h >>> 0, 0x9e3779b1)) >>> 0;
    count++;
  }
  let acc = (xorAcc ^ Math.imul(sumAcc, 0x85ebca6b)) >>> 0;
  // Fold in the count so size differences always change the signature.
  acc = (acc ^ Math.imul(count, 0x27d4eb2f)) >>> 0;
  return acc >>> 0;
}

/**
 * Defensively parse a raw `localStorage` string into a validated
 * {@link ConceptGraphViewState}, or `null` when absent/unusable. Never
 * throws: malformed JSON, a non-object payload, a mismatched schema
 * version, or individually-bad fields all degrade to defaults (or, for
 * the whole blob, `null`). Enum arrays are filtered through the
 * `conceptGraph` type guards so a corrupt blob can't inject bogus
 * relation/state values into the renderer.
 */
export function parseViewState(raw: string | null): ConceptGraphViewState | null {
  if (raw === null) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const rec = asRecord(parsed);
  if (!rec) return null;
  // A present-but-wrong version is treated as "no usable state".
  if (asFiniteNumber(rec.version) !== SCHEMA_VERSION) return null;

  const base = defaultViewState();

  const disabledRelations = Array.isArray(rec.disabledRelations)
    ? rec.disabledRelations.filter(isConceptRelation)
    : base.disabledRelations;
  const disabledStates = Array.isArray(rec.disabledStates)
    ? rec.disabledStates.filter(isConceptNodeState)
    : base.disabledStates;

  const hopsRaw = asFiniteNumber(rec.localHops);
  const localHops =
    hopsRaw === null
      ? base.localHops
      : Math.min(MAX_HOPS, Math.max(1, Math.trunc(hopsRaw)));

  const sigRaw = asFiniteNumber(rec.viewSignature);

  return {
    disabledRelations,
    disabledStates,
    labelsAll: typeof rec.labelsAll === "boolean" ? rec.labelsAll : base.labelsAll,
    localMode: typeof rec.localMode === "boolean" ? rec.localMode : base.localMode,
    localHops,
    selectedId: typeof rec.selectedId === "string" ? rec.selectedId : null,
    scopeFilter:
      typeof rec.scopeFilter === "string" ? rec.scopeFilter : base.scopeFilter,
    viewBox: parseFitBox(rec.viewBox),
    viewSignature: sigRaw === null ? 0 : Math.trunc(sigRaw) >>> 0,
  };
}

/** Serialize a view state to the persisted JSON string (with version). */
export function serializeViewState(state: ConceptGraphViewState): string {
  return JSON.stringify({
    version: SCHEMA_VERSION,
    disabledRelations: state.disabledRelations,
    disabledStates: state.disabledStates,
    labelsAll: state.labelsAll,
    localMode: state.localMode,
    localHops: state.localHops,
    selectedId: state.selectedId,
    scopeFilter: state.scopeFilter,
    viewBox: state.viewBox,
    viewSignature: state.viewSignature,
  });
}

/**
 * Load + validate the persisted view state for `scopeId`. Returns `null`
 * when there's nothing usable (absent, corrupt, or `localStorage`
 * unavailable). Never throws.
 */
export function loadViewState(scopeId: string): ConceptGraphViewState | null {
  try {
    return parseViewState(window.localStorage.getItem(viewStateStorageKey(scopeId)));
  } catch {
    return null;
  }
}

/**
 * Persist `state` for `scopeId`. Silently no-ops if `localStorage` is
 * unavailable or the write is rejected (quota/locked), so persistence is
 * always best-effort and never a failure path for the renderer.
 */
export function saveViewState(scopeId: string, state: ConceptGraphViewState): void {
  try {
    window.localStorage.setItem(
      viewStateStorageKey(scopeId),
      serializeViewState(state),
    );
  } catch {
    /* localStorage disabled / full — drop the write; UI is unaffected. */
  }
}
