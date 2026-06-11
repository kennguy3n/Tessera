import { useEffect, useMemo, useState } from "react";
import type { SubstrateMemoryInfo } from "../types/ipc";

/**
 * Renderer-side derivations + hooks over the additive knowledge
 * substrate (`window.tessera.substrate.*`, registered by
 * `electron/ipc/substrate.ts`). The substrate is purely additive, so
 * every read here is best-effort: a missing bridge (cold-start window
 * before the preload script wires `window.tessera`, or the test
 * harness), a substrate-level rejection, or an empty graph all resolve
 * to a clean empty surface rather than surfacing a hard error. The
 * caller distinguishes "bridge unavailable" (render nothing / hint)
 * from "bridge present but empty" (render the empty state) via
 * `bridgeAvailable`.
 *
 * The pure helpers (`isActiveMemoryState`, `parseConceptNodes`,
 * `deriveKnowledgeInsights`) are React-free so they can be unit-tested
 * in isolation and memoized at the call site.
 */

function getApi() {
  return typeof window !== "undefined" ? window.tessera : undefined;
}

/**
 * Memory decay states (`tessera_substrate::MemoryState`) that are still
 * part of the live working set. `superseded`, `archived`, and `deleted`
 * are excluded — they represent memories the substrate has retired and
 * should not be counted as "active" or surfaced as reinforced.
 */
const ACTIVE_MEMORY_STATES: ReadonlySet<string> = new Set([
  "candidate",
  "reinforced",
  "consolidated",
  "canonical",
]);

/** True when a memory is still part of the live working set. */
export function isActiveMemoryState(state: string): boolean {
  return ACTIVE_MEMORY_STATES.has(state.toLowerCase());
}

/**
 * Human-readable label for a substrate observation type
 * (`tessera_substrate::ObservationType`). Falls back to a
 * capitalized form of the raw tag so a future Rust-side variant still
 * renders something sensible instead of an empty string.
 */
const OBSERVATION_TYPE_LABELS: Readonly<Record<string, string>> = {
  entity: "Entity",
  fact: "Fact",
  task: "Task",
  decision: "Decision",
  claim: "Claim",
  question: "Question",
};

export function observationTypeLabel(type: string): string {
  const lowered = type.toLowerCase();
  const known = OBSERVATION_TYPE_LABELS[lowered];
  if (known) return known;
  if (!lowered) return "Observation";
  // Unknown tag: normalize to Title Case from the lowercased form so an
  // all-caps (`HYPOTHESIS`) or snake/kebab-cased (`open_question`) variant
  // still renders cleanly (`Hypothesis`, `Open Question`).
  return lowered
    .split(/[_\s-]+/)
    .filter(Boolean)
    .map((word) => word[0].toUpperCase() + word.slice(1))
    .join(" ");
}

/**
 * A concept-graph node, projected from the substrate's JSON
 * `GraphView` to the minimal shape the UI renders. Mirrors the verified
 * wire shape produced by `bridge_get_concept_graph`
 * (`concept_graph::GraphView`), whose nodes are
 * `{ id, label, state, scope_id, connections_count, position_hint }`.
 */
export interface ConceptNode {
  id: string;
  label: string;
  /** Lifecycle state, normalized to lowercase. */
  state: string;
  /** Visible incident-edge count — the graph's "connectedness" signal. */
  connectionsCount: number;
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null
    ? (value as Record<string, unknown>)
    : null;
}

function asString(value: unknown, fallback = ""): string {
  return typeof value === "string" ? value : fallback;
}

function asFiniteNumber(value: unknown, fallback = 0): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Defensively parse the substrate's concept-graph JSON string into the
 * typed {@link ConceptNode} list the UI renders. The bridge returns a
 * JSON-serialized `GraphView`; anything that is not a parseable object
 * with a `nodes` array (an empty `"{}"`, a non-graph object, malformed
 * JSON) collapses to an empty list rather than throwing, so a single
 * bad payload can never crash the page. Nodes missing an `id` are
 * dropped (the id is the React key + identity); other fields fall back
 * to neutral defaults.
 */
export function parseConceptNodes(json: string): ConceptNode[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch {
    return [];
  }
  const root = asRecord(parsed);
  const rawNodes = root?.nodes;
  if (!Array.isArray(rawNodes)) return [];
  const nodes: ConceptNode[] = [];
  for (const raw of rawNodes) {
    const node = asRecord(raw);
    if (!node) continue;
    const id = asString(node.id);
    if (!id) continue;
    nodes.push({
      id,
      label: asString(node.label),
      state: asString(node.state).toLowerCase(),
      connectionsCount: asFiniteNumber(node.connections_count),
    });
  }
  return nodes;
}

/**
 * Headline knowledge summary surfaced on the HomePage. Derived purely
 * from the memory plane + concept graph so the same shape is reused by
 * the unit test and the component.
 */
export interface KnowledgeInsights {
  /** Total memory objects, across every decay state. */
  totalMemories: number;
  /** Memories still in the live working set (see {@link isActiveMemoryState}). */
  activeMemories: number;
  /** Distinct concepts currently in the graph. */
  conceptCount: number;
  /** Top active memories by retention, strongest first. */
  topReinforced: SubstrateMemoryInfo[];
  /** Most-connected concepts in the graph, strongest first. */
  topConcepts: ConceptNode[];
}

/**
 * Rank an active memory for the "top reinforced" list. Retention score
 * is the primary signal (it already folds in recency + reinforcement);
 * corroboration and pins break ties so a heavily-cited or user-pinned
 * memory wins over an equally-decayed peer. `content` is the final,
 * deterministic tiebreak so the order is stable across renders.
 */
function compareReinforced(
  a: SubstrateMemoryInfo,
  b: SubstrateMemoryInfo,
): number {
  if (b.retentionScore !== a.retentionScore) {
    return b.retentionScore - a.retentionScore;
  }
  const aSignal = a.corroborationCount * 2 + a.pinCount * 2 + a.retrievalCount;
  const bSignal = b.corroborationCount * 2 + b.pinCount * 2 + b.retrievalCount;
  if (bSignal !== aSignal) return bSignal - aSignal;
  return a.content.localeCompare(b.content);
}

/**
 * Derive the HomePage knowledge summary. Pure given its inputs.
 */
export function deriveKnowledgeInsights(
  memories: SubstrateMemoryInfo[],
  conceptNodes: ConceptNode[],
  topN = 5,
): KnowledgeInsights {
  const active = memories.filter((m) => isActiveMemoryState(m.state));
  const topReinforced = [...active].sort(compareReinforced).slice(0, topN);
  const topConcepts = [...conceptNodes]
    .sort((a, b) => {
      if (b.connectionsCount !== a.connectionsCount) {
        return b.connectionsCount - a.connectionsCount;
      }
      return a.label.localeCompare(b.label);
    })
    .slice(0, topN);
  return {
    totalMemories: memories.length,
    activeMemories: active.length,
    conceptCount: conceptNodes.length,
    topReinforced,
    topConcepts,
  };
}

export interface UseKnowledgeInsightsResult {
  insights: KnowledgeInsights;
  loading: boolean;
  error: string | null;
  /** False when the native bridge is unavailable (cold start / tests). */
  bridgeAvailable: boolean;
}

/**
 * Load the memory plane + concept graph for the default scope and
 * derive the HomePage knowledge summary. `enabled` (default `true`)
 * gates the round-trip so a caller that will never render the result
 * (e.g. the fresh-install empty state) pays no IPC cost.
 *
 * Both reads are issued in parallel. Any failure resolves to the empty
 * summary with `error` set, keeping the rest of the page functional.
 */
export function useKnowledgeInsights(
  topN = 5,
  enabled = true,
): UseKnowledgeInsightsResult {
  const [memories, setMemories] = useState<SubstrateMemoryInfo[]>([]);
  const [conceptNodes, setConceptNodes] = useState<ConceptNode[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  const [bridgeAvailable, setBridgeAvailable] = useState(true);

  // Synchronize `loading` with `enabled` during render (React's
  // derived-state pattern) so a false→true transition flips `loading`
  // back to `true` in the same commit the effect is scheduled. Without
  // this, `loading` would stay `false` (its initial value) until the
  // post-paint effect runs, flashing the misleading "No knowledge
  // extracted yet" empty state for one frame once the gate opens.
  const [prevEnabled, setPrevEnabled] = useState(enabled);
  if (enabled !== prevEnabled) {
    setPrevEnabled(enabled);
    setLoading(enabled);
  }

  // `topN` is intentionally absent from the effect deps: it only feeds
  // the derived `useMemo` below, never the fetch, so re-fetching when it
  // changes would be wasted IPC.
  useEffect(() => {
    let cancelled = false;
    if (!enabled) {
      setMemories([]);
      setConceptNodes([]);
      setError(null);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    const api = getApi();
    if (!api?.substrate) {
      setBridgeAvailable(false);
      setMemories([]);
      setConceptNodes([]);
      setError(null);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setBridgeAvailable(true);
    setLoading(true);
    setError(null);
    Promise.all([
      api.substrate.getMemories(null),
      // Bound the graph read: the HomePage only renders the top
      // handful of concepts, so there's no reason to serialize the
      // whole graph across the IPC boundary.
      api.substrate.getConceptGraph(null, 64),
    ])
      .then(([memoryList, graphJson]) => {
        if (cancelled) return;
        setMemories(memoryList);
        setConceptNodes(parseConceptNodes(graphJson));
      })
      .catch((err) => {
        if (cancelled) return;
        setMemories([]);
        setConceptNodes([]);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [enabled]);

  const insights = useMemo(
    () => deriveKnowledgeInsights(memories, conceptNodes, topN),
    [memories, conceptNodes, topN],
  );

  return { insights, loading, error, bridgeAvailable };
}

export interface UseSourceMemoriesResult {
  memories: SubstrateMemoryInfo[];
  loading: boolean;
  error: string | null;
  /** False when the native bridge is unavailable (cold start / tests). */
  bridgeAvailable: boolean;
}

/**
 * Load the substrate memories tied to a single source. The substrate's
 * `getMemories` is scope-scoped (there is no per-source query), so we
 * read the default scope once and filter by `sourceId` client-side —
 * cheap for the per-source counts the substrate produces, and it keeps
 * this renderer-only change off the IPC schema. Memories are returned
 * sorted strongest-retention-first. A missing `sourceId` (route still
 * resolving) settles to a clean empty state without an IPC round-trip.
 *
 * Unlike the HomePage summary (which filters to the active working set
 * via {@link isActiveMemoryState}), this deliberately surfaces every
 * state `getMemories` returns: the source detail page is the place to
 * see the full provenance of what was extracted from a source, so a
 * superseded/archived observation is still meaningful history here.
 */
export function useSourceMemories(
  sourceId: string | undefined,
): UseSourceMemoriesResult {
  const [memories, setMemories] = useState<SubstrateMemoryInfo[]>([]);
  const [loading, setLoading] = useState(Boolean(sourceId));
  const [error, setError] = useState<string | null>(null);
  const [bridgeAvailable, setBridgeAvailable] = useState(true);

  // See `useKnowledgeInsights`: keep `loading` in sync with `sourceId`
  // during render so navigating between sources never flashes the
  // "No observations extracted" empty state before the fetch starts.
  const [prevSourceId, setPrevSourceId] = useState(sourceId);
  if (sourceId !== prevSourceId) {
    setPrevSourceId(sourceId);
    setLoading(Boolean(sourceId));
  }

  useEffect(() => {
    let cancelled = false;
    if (!sourceId) {
      setMemories([]);
      setError(null);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    const api = getApi();
    if (!api?.substrate) {
      setBridgeAvailable(false);
      setMemories([]);
      setError(null);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    setBridgeAvailable(true);
    setLoading(true);
    setError(null);
    api.substrate
      .getMemories(null)
      .then((list) => {
        if (cancelled) return;
        const forSource = list
          .filter((m) => m.sourceId === sourceId)
          .sort(compareReinforced);
        setMemories(forSource);
      })
      .catch((err) => {
        if (cancelled) return;
        setMemories([]);
        setError(err instanceof Error ? err.message : String(err));
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [sourceId]);

  return { memories, loading, error, bridgeAvailable };
}
