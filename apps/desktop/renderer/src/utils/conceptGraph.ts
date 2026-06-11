/**
 * Parsing + layout helpers for the knowledge-substrate concept graph.
 *
 * The substrate exposes the concept graph as a JSON *string* (see
 * `bridge_get_concept_graph` → `tessera_substrate::SubstrateManager::
 * concept_graph_json`, which serializes a `concept_graph::GraphView`).
 * Keeping the parse + layout math here — free of React and of the
 * `window.tessera` bridge — means the renderer component
 * (`ConceptGraphPanel`) stays a thin presentational layer and the
 * non-trivial logic (defensive parsing of an untrusted JSON string and
 * the deterministic layout used for the lightweight SVG renderer) is
 * unit- and snapshot-testable in isolation.
 *
 * The wire shape (verified against the Rust serializer) is:
 *
 * ```json
 * {
 *   "nodes": [{ "id": "<uuid>", "label": "Atlas", "state": "Canonical",
 *               "scope_id": "<uuid>", "connections_count": 3,
 *               "position_hint": { "x": 1.0, "y": 2.0 } }],
 *   "edges": [{ "id": "<uuid>", "from": "<uuid>", "to": "<uuid>",
 *               "relation_type": "is_a", "scope_id": "<uuid>" }],
 *   "scope_filter": ["<uuid>"],
 *   "depth": 2,
 *   "truncation": "complete"
 * }
 * ```
 *
 * Note the casing asymmetry baked into the Rust enums: `state` is
 * PascalCase (`NodeState` has no `rename_all`) while `relation_type`
 * and `truncation` are snake_case. We normalize `state` to lowercase
 * on the way in so the renderer only ever reasons about one casing.
 */

/** Lifecycle state of a concept node, normalized to lowercase. */
export type ConceptNodeState =
  | "candidate"
  | "canonical"
  | "superseded"
  | "contradicted"
  | "deleted"
  | "unknown";

/**
 * Typed concept-graph relation. Mirrors
 * `concept_graph::RelationType` (snake_case serde tags). `unknown`
 * is a forward-compat catch-all so a future Rust-side variant renders
 * as a neutral edge instead of being dropped.
 */
export type ConceptRelation =
  | "is_a"
  | "part_of"
  | "decided_by"
  | "supersedes"
  | "contradicts"
  | "derived_from"
  | "assigned_to"
  | "unknown";

/** Why the substrate stopped the graph traversal. */
export type GraphTruncation =
  | "complete"
  | "node_limit_reached"
  | "depth_limit_reached"
  | "unknown";

export interface ConceptGraphNode {
  id: string;
  label: string;
  state: ConceptNodeState;
  scopeId: string;
  /** Visible incident-edge count, used to size the node. */
  connectionsCount: number;
  /** Optional persisted layout hint in logical canvas units. */
  positionHint?: { x: number; y: number };
}

export interface ConceptGraphEdge {
  id: string;
  from: string;
  to: string;
  relationType: ConceptRelation;
  scopeId: string;
}

export interface ConceptGraphView {
  nodes: ConceptGraphNode[];
  edges: ConceptGraphEdge[];
  scopeFilter: string[];
  depth: number;
  truncation: GraphTruncation;
}

const KNOWN_STATES: ReadonlySet<string> = new Set([
  "candidate",
  "canonical",
  "superseded",
  "contradicted",
  "deleted",
]);

const KNOWN_RELATIONS: ReadonlySet<string> = new Set([
  "is_a",
  "part_of",
  "decided_by",
  "supersedes",
  "contradicts",
  "derived_from",
  "assigned_to",
]);

const KNOWN_TRUNCATIONS: ReadonlySet<string> = new Set([
  "complete",
  "node_limit_reached",
  "depth_limit_reached",
]);

/** Human-readable label for a relation type, for legends/tooltips. */
export const RELATION_LABELS: Record<ConceptRelation, string> = {
  is_a: "is a",
  part_of: "part of",
  decided_by: "decided by",
  supersedes: "supersedes",
  contradicts: "contradicts",
  derived_from: "derived from",
  assigned_to: "assigned to",
  unknown: "related to",
};

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

function normalizeState(value: unknown): ConceptNodeState {
  const lowered = asString(value).toLowerCase();
  return (KNOWN_STATES.has(lowered) ? lowered : "unknown") as ConceptNodeState;
}

function normalizeRelation(value: unknown): ConceptRelation {
  const lowered = asString(value).toLowerCase();
  return (
    KNOWN_RELATIONS.has(lowered) ? lowered : "unknown"
  ) as ConceptRelation;
}

function normalizeTruncation(value: unknown): GraphTruncation {
  // An *absent* truncation field means the payload was not a truncated graph
  // (or not a graph at all), so it collapses to the canonical empty view's
  // "complete" — keeping every empty/non-graph input (unparseable, non-object,
  // or a non-graph object like `[]`) consistent with EMPTY_VIEW. A *present*
  // but unrecognized value is a forward-compat signal from a newer substrate
  // and stays "unknown".
  if (value === undefined || value === null) return "complete";
  const lowered = asString(value).toLowerCase();
  return (
    KNOWN_TRUNCATIONS.has(lowered) ? lowered : "unknown"
  ) as GraphTruncation;
}

/**
 * Recursively freeze a parsed view so the immutability invariant is
 * enforced at runtime, not just by convention. Consumers treat the view
 * as read-only and several share a single reference (e.g. the empty view
 * and `useSubstrate`'s `EMPTY_CONCEPT_GRAPH`); freezing means an errant
 * `graph.nodes.push(...)` throws in strict mode instead of silently
 * corrupting every other consumer holding the same reference. All reads
 * (filter / find / map / `[...nodes].sort`) already copy before
 * mutating, so freezing is safe. (Devin Review PR #120.)
 */
function freezeView(view: ConceptGraphView): ConceptGraphView {
  for (const n of view.nodes) {
    if (n.positionHint) Object.freeze(n.positionHint);
    Object.freeze(n);
  }
  Object.freeze(view.nodes);
  for (const e of view.edges) Object.freeze(e);
  Object.freeze(view.edges);
  Object.freeze(view.scopeFilter);
  return Object.freeze(view);
}

const EMPTY_VIEW: ConceptGraphView = freezeView({
  nodes: [],
  edges: [],
  scopeFilter: [],
  depth: 0,
  truncation: "complete",
});

/**
 * Parse the JSON string returned by `substrate.getConceptGraph` into a
 * typed, renderer-friendly {@link ConceptGraphView}.
 *
 * Defensive by construction: a malformed string, a non-object payload,
 * or a missing/!array `nodes`/`edges` field yields an empty view rather
 * than throwing, and individual rows with a missing `id` are dropped.
 * Edges that reference a node not present in the (possibly truncated)
 * node set are also dropped so the renderer never draws a dangling
 * line — mirroring the substrate's own "edges to truncated nodes are
 * dropped" invariant defensively on the client.
 */
export function parseConceptGraph(json: string): ConceptGraphView {
  let raw: unknown;
  try {
    raw = JSON.parse(json);
  } catch {
    return EMPTY_VIEW;
  }
  const root = asRecord(raw);
  if (!root) return EMPTY_VIEW;

  const rawNodes = Array.isArray(root.nodes) ? root.nodes : [];
  const nodes: ConceptGraphNode[] = [];
  for (const entry of rawNodes) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const id = asString(rec.id);
    if (!id) continue;
    const hintRec = asRecord(rec.position_hint);
    const positionHint = hintRec
      ? {
          x: asFiniteNumber(hintRec.x),
          y: asFiniteNumber(hintRec.y),
        }
      : undefined;
    nodes.push({
      id,
      label: asString(rec.label, id),
      state: normalizeState(rec.state),
      scopeId: asString(rec.scope_id),
      connectionsCount: Math.max(
        0,
        Math.trunc(asFiniteNumber(rec.connections_count)),
      ),
      ...(positionHint ? { positionHint } : {}),
    });
  }

  const nodeIds = new Set(nodes.map((n) => n.id));
  const rawEdges = Array.isArray(root.edges) ? root.edges : [];
  const edges: ConceptGraphEdge[] = [];
  for (const entry of rawEdges) {
    const rec = asRecord(entry);
    if (!rec) continue;
    const id = asString(rec.id);
    const from = asString(rec.from);
    const to = asString(rec.to);
    if (!id || !from || !to) continue;
    if (!nodeIds.has(from) || !nodeIds.has(to)) continue;
    edges.push({
      id,
      from,
      to,
      relationType: normalizeRelation(rec.relation_type),
      scopeId: asString(rec.scope_id),
    });
  }

  const scopeFilter = Array.isArray(root.scope_filter)
    ? root.scope_filter.filter((s): s is string => typeof s === "string")
    : [];

  return freezeView({
    nodes,
    edges,
    scopeFilter,
    depth: Math.max(0, Math.trunc(asFiniteNumber(root.depth))),
    truncation: normalizeTruncation(root.truncation),
  });
}

/** A node placed at an absolute (x, y) coordinate by the layout pass. */
export interface PositionedNode extends ConceptGraphNode {
  x: number;
  y: number;
  /** Pixel radius, derived from `connectionsCount`. */
  radius: number;
}

export interface GraphLayout {
  width: number;
  height: number;
  nodes: PositionedNode[];
}

export interface LayoutOptions {
  width?: number;
  height?: number;
  /** Minimum node radius in px. */
  minRadius?: number;
  /** Maximum node radius in px. */
  maxRadius?: number;
  /** Padding kept clear of the canvas edges, in px. */
  padding?: number;
}

/**
 * Compute a fully deterministic radial layout for the concept graph.
 *
 * Determinism is a hard requirement: the layout feeds both the SVG
 * renderer and a snapshot test, so the same `view` must always produce
 * byte-identical coordinates (no randomness, no force simulation, no
 * dependence on wall-clock or insertion-order hashing). Nodes are
 * ordered by `connectionsCount` (desc), then `label`, then `id` so the
 * ordering is stable regardless of the order the substrate emitted
 * them. The single most-connected node anchors the center; the rest are
 * distributed over concentric rings (≤ 10 per ring) at even angular
 * intervals. Node radius scales linearly with `connectionsCount`
 * between `minRadius` and `maxRadius`.
 */
export function computeRadialLayout(
  view: ConceptGraphView,
  options: LayoutOptions = {},
): GraphLayout {
  const width = options.width ?? 640;
  const height = options.height ?? 480;
  const minRadius = options.minRadius ?? 14;
  const maxRadius = options.maxRadius ?? 34;
  const padding = options.padding ?? 48;

  const ordered = [...view.nodes].sort((a, b) => {
    if (b.connectionsCount !== a.connectionsCount) {
      return b.connectionsCount - a.connectionsCount;
    }
    if (a.label !== b.label) return a.label.localeCompare(b.label);
    return a.id.localeCompare(b.id);
  });

  const maxConnections = ordered.reduce(
    (max, n) => Math.max(max, n.connectionsCount),
    0,
  );
  const radiusFor = (n: ConceptGraphNode): number => {
    if (maxConnections === 0) return minRadius;
    const t = n.connectionsCount / maxConnections;
    return minRadius + (maxRadius - minRadius) * t;
  };

  const cx = width / 2;
  const cy = height / 2;
  const maxRingRadius = Math.max(
    0,
    Math.min(width, height) / 2 - padding - maxRadius,
  );

  const positioned: PositionedNode[] = [];
  ordered.forEach((node, index) => {
    if (index === 0) {
      positioned.push({ ...node, x: cx, y: cy, radius: radiusFor(node) });
      return;
    }
    // Ring index 1, 2, 3, … each holding up to `perRing` nodes.
    const perRing = 10;
    const ringIndex = Math.floor((index - 1) / perRing) + 1;
    const slot = (index - 1) % perRing;
    const ringCount = Math.min(perRing, ordered.length - 1 - (ringIndex - 1) * perRing);
    const totalRings = Math.ceil((ordered.length - 1) / perRing);
    const ringRadius =
      totalRings === 0
        ? 0
        : (maxRingRadius * ringIndex) / Math.max(1, totalRings);
    // Offset alternating rings by half a slot so nodes on adjacent
    // rings don't line up on the same spoke.
    const angleOffset = ringIndex % 2 === 0 ? Math.PI / perRing : 0;
    const angle = (2 * Math.PI * slot) / Math.max(1, ringCount) + angleOffset;
    positioned.push({
      ...node,
      x: cx + ringRadius * Math.cos(angle),
      y: cy + ringRadius * Math.sin(angle),
      radius: radiusFor(node),
    });
  });

  return { width, height, nodes: positioned };
}
