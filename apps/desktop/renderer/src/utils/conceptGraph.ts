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

/**
 * Narrow an arbitrary string to a {@link ConceptRelation}. `unknown` is
 * accepted as well as the known tags so a *present-but-unrecognized*
 * relation (forward-compat) round-trips through persistence rather than
 * being silently dropped. Used by the defensive view-state parser so a
 * corrupt/old persisted blob can never inject a bogus relation type.
 */
export function isConceptRelation(value: unknown): value is ConceptRelation {
  return (
    typeof value === "string" &&
    (KNOWN_RELATIONS.has(value) || value === "unknown")
  );
}

/** Narrow an arbitrary string to a {@link ConceptNodeState}; see {@link isConceptRelation}. */
export function isConceptNodeState(value: unknown): value is ConceptNodeState {
  return (
    typeof value === "string" &&
    (KNOWN_STATES.has(value) || value === "unknown")
  );
}

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
export function freezeView(view: ConceptGraphView): ConceptGraphView {
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
 * Locale-independent string comparison by UTF-16 code unit. Unlike
 * `String.prototype.localeCompare`, the result never depends on the host's
 * locale/collation, so a sort keyed on it is reproducible across machines.
 */
export function compareCodepoint(a: string, b: string): number {
  return a < b ? -1 : a > b ? 1 : 0;
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
 * them. The label/id tie-breaks use a locale-INDEPENDENT codepoint
 * comparison (not `localeCompare`) so the "byte-identical coordinates"
 * guarantee holds across machines with different OS locales — relevant
 * if a layout is ever persisted/shared rather than recomputed locally.
 * The single most-connected node anchors the center; the rest are
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
    if (a.label !== b.label) return compareCodepoint(a.label, b.label);
    return compareCodepoint(a.id, b.id);
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
    const ringCount = Math.min(
      perRing,
      ordered.length - 1 - (ringIndex - 1) * perRing,
    );
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

/**
 * Deterministic ordering used by every layout pass: most-connected first
 * (so the densest hub anchors the view), then a locale-INDEPENDENT
 * codepoint tie-break on `label` and `id`. Shared by the radial and the
 * force layout so both seed from the same stable order — a prerequisite
 * for the force layout being reproducible (its phyllotaxis seed is keyed
 * on this index).
 */
function compareNodesForLayout(
  a: ConceptGraphNode,
  b: ConceptGraphNode,
): number {
  if (b.connectionsCount !== a.connectionsCount) {
    return b.connectionsCount - a.connectionsCount;
  }
  if (a.label !== b.label) return compareCodepoint(a.label, b.label);
  return compareCodepoint(a.id, b.id);
}

function clamp(value: number, lo: number, hi: number): number {
  return value < lo ? lo : value > hi ? hi : value;
}

/**
 * Visible-degree map: incident-edge count per node within `view`. A self
 * loop counts once. Used to size nodes (degree-based radius) so a node's
 * size reflects what is actually drawn after filtering / local-graph
 * scoping, rather than the substrate's global `connectionsCount`.
 */
export function computeDegrees(view: ConceptGraphView): Map<string, number> {
  const degrees = new Map<string, number>();
  for (const node of view.nodes) degrees.set(node.id, 0);
  for (const edge of view.edges) {
    if (edge.from === edge.to) {
      degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1);
      continue;
    }
    degrees.set(edge.from, (degrees.get(edge.from) ?? 0) + 1);
    degrees.set(edge.to, (degrees.get(edge.to) ?? 0) + 1);
  }
  return degrees;
}

/** Undirected adjacency: neighbor-ids and incident-edge-ids per node. */
export interface Adjacency {
  /** node id → set of directly-connected node ids (self loops excluded). */
  neighbors: Map<string, Set<string>>;
  /** node id → set of edge ids touching the node. */
  edges: Map<string, Set<string>>;
}

export function buildAdjacency(view: ConceptGraphView): Adjacency {
  const neighbors = new Map<string, Set<string>>();
  const edges = new Map<string, Set<string>>();
  for (const node of view.nodes) {
    neighbors.set(node.id, new Set());
    edges.set(node.id, new Set());
  }
  const link = (a: string, b: string) => {
    if (a !== b) neighbors.get(a)?.add(b);
  };
  for (const edge of view.edges) {
    if (!neighbors.has(edge.from) || !neighbors.has(edge.to)) continue;
    link(edge.from, edge.to);
    link(edge.to, edge.from);
    edges.get(edge.from)?.add(edge.id);
    edges.get(edge.to)?.add(edge.id);
  }
  return { neighbors, edges };
}

/**
 * The focus node plus its direct neighbors, and the edge ids incident to
 * the focus. Used to highlight a node + its 1-hop neighborhood while
 * dimming everything else (hover/selection emphasis). Returns empty sets
 * when `focusId` is absent from the view.
 */
export function incidentTo(
  view: ConceptGraphView,
  focusId: string,
  adjacency: Adjacency = buildAdjacency(view),
): { nodeIds: Set<string>; edgeIds: Set<string> } {
  const nodeIds = new Set<string>();
  const edgeIds = new Set<string>();
  if (!adjacency.neighbors.has(focusId)) return { nodeIds, edgeIds };
  nodeIds.add(focusId);
  for (const nb of adjacency.neighbors.get(focusId) ?? []) nodeIds.add(nb);
  for (const id of adjacency.edges.get(focusId) ?? []) edgeIds.add(id);
  return { nodeIds, edgeIds };
}

/**
 * Restrict the view to the `hops`-hop neighborhood of `focusId` (the
 * "local graph" mode): a BFS from the focus keeping every node reachable
 * within `hops` edges, plus the edges among the kept nodes. When the
 * focus id is absent the original view is returned unchanged so callers
 * never render an empty frame for a stale focus. `hops` is clamped to at
 * least 1.
 */
export function localGraphView(
  view: ConceptGraphView,
  focusId: string,
  hops = 1,
): ConceptGraphView {
  if (!view.nodes.some((n) => n.id === focusId)) return view;
  const adjacency = buildAdjacency(view);
  const keep = new Set<string>([focusId]);
  let frontier = [focusId];
  const maxHops = Math.max(1, Math.trunc(hops));
  for (let h = 0; h < maxHops && frontier.length > 0; h++) {
    const next: string[] = [];
    for (const id of frontier) {
      for (const nb of adjacency.neighbors.get(id) ?? []) {
        if (!keep.has(nb)) {
          keep.add(nb);
          next.push(nb);
        }
      }
    }
    frontier = next;
  }
  const nodes = view.nodes.filter((n) => keep.has(n.id));
  const edges = view.edges.filter((e) => keep.has(e.from) && keep.has(e.to));
  return freezeView({ ...view, nodes, edges });
}

/**
 * Client-side filter over relation types and node states. `relations` /
 * `states`, when supplied, are the *enabled* sets — an edge survives only
 * if its `relationType` is enabled and both endpoints survive, and a node
 * survives only if its `state` is enabled. An omitted axis means "keep
 * everything on that axis". Edges to dropped nodes are removed so the
 * renderer never draws a dangling line.
 */
export interface GraphFilter {
  relations?: ReadonlySet<ConceptRelation>;
  states?: ReadonlySet<ConceptNodeState>;
}

export function filterGraphView(
  view: ConceptGraphView,
  filter: GraphFilter,
): ConceptGraphView {
  const { relations, states } = filter;
  if (!relations && !states) return view;
  // No state filter ⇒ no node is dropped, so reuse the (already-frozen) node
  // array instead of copying it (saves an allocation up to the node cap).
  const nodes = states
    ? view.nodes.filter((n) => states.has(n.state))
    : view.nodes;
  const ids = new Set(nodes.map((n) => n.id));
  const edges = view.edges.filter((e) => {
    if (relations && !relations.has(e.relationType)) return false;
    return ids.has(e.from) && ids.has(e.to);
  });
  return freezeView({ ...view, nodes, edges });
}

/** Iteration count run by {@link computeForceLayout} for a small graph. */
const DEFAULT_ITERATIONS = 320;
/** Floor so even large graphs still settle into a usable shape. */
const MIN_ITERATIONS = 60;
/** Node count up to which the full {@link DEFAULT_ITERATIONS} is run. */
const FULL_ITERATION_NODES = 150;

/**
 * Deterministic, node-count-adaptive iteration count for the force layout.
 *
 * The repulsion pass is O(n²) per iteration, so running a fixed iteration
 * count makes total work grow as O(n²·iters). To keep the worst case near
 * the node cap from blocking the render thread, the iteration count is held
 * at {@link DEFAULT_ITERATIONS} up to {@link FULL_ITERATION_NODES} and then
 * scaled ∝ 1/n² beyond it, so n²·iters stays roughly flat (floored at
 * {@link MIN_ITERATIONS}). A pure function of `n`, so the layout stays
 * deterministic and reproducible.
 */
export function adaptiveIterations(n: number): number {
  if (n <= FULL_ITERATION_NODES) return DEFAULT_ITERATIONS;
  const scaled = Math.round(
    (DEFAULT_ITERATIONS * FULL_ITERATION_NODES * FULL_ITERATION_NODES) /
      (n * n),
  );
  return Math.max(MIN_ITERATIONS, scaled);
}

export interface ForceLayoutOptions extends LayoutOptions {
  /**
   * Simulation iterations. More = better-settled, O(n²) per step. When
   * omitted the count adapts to the node count (see {@link adaptiveIterations}):
   * the full {@link DEFAULT_ITERATIONS} for small graphs, scaled down for
   * large ones so total work stays bounded. An explicit value is honored
   * exactly (keeps callers / tests deterministic).
   */
  iterations?: number;
  /** Ideal edge length multiplier: k = idealEdge · √(area / n). */
  idealEdge?: number;
  /** Pull toward the canvas center, keeping disjoint components in view. */
  gravity?: number;
}

/**
 * Deterministic force-directed (Fruchterman–Reingold) layout.
 *
 * Like {@link computeRadialLayout} this is a *pure* function: the same
 * `view` and options always yield identical coordinates. Determinism is
 * achieved by (1) seeding node positions on a fixed phyllotaxis spiral
 * keyed on the stable {@link compareNodesForLayout} order — never
 * `Math.random` — and (2) running a deterministic, node-count-adaptive
 * iteration count (a pure function of `n`) with a deterministic cooling
 * schedule. This lets the renderer animate toward a stable target while
 * the layout itself stays unit-testable and reproducible across machines.
 *
 * The simulation combines repulsion between every node pair (O(n²) per
 * step — see {@link adaptiveIterations} for how the iteration count is
 * bounded so the worst case near the node cap stays cheap), spring
 * attraction along edges, a gentle centering gravity, and a temperature
 * that caps per-step displacement and decays linearly to zero. Final
 * coordinates are clamped
 * to the canvas interior (accounting for each node's radius). Node radius
 * scales with the square root of visible degree between `minRadius` and
 * `maxRadius` so area — not diameter — tracks connectivity.
 */
export function computeForceLayout(
  view: ConceptGraphView,
  options: ForceLayoutOptions = {},
): GraphLayout {
  const width = options.width ?? 720;
  const height = options.height ?? 460;
  const minRadius = options.minRadius ?? 12;
  const maxRadius = options.maxRadius ?? 34;
  const padding = options.padding ?? 56;
  const gravity = options.gravity ?? 0.06;

  const n = view.nodes.length;
  if (n === 0) return { width, height, nodes: [] };

  // Honor an explicit iteration count exactly; otherwise adapt to `n`.
  const iterations =
    options.iterations !== undefined
      ? Math.max(0, Math.trunc(options.iterations))
      : adaptiveIterations(n);

  const ordered = [...view.nodes].sort(compareNodesForLayout);
  const degrees = computeDegrees(view);
  const maxDegree = ordered.reduce(
    (max, node) => Math.max(max, degrees.get(node.id) ?? 0),
    0,
  );
  const radiusFor = (node: ConceptGraphNode): number => {
    if (maxDegree === 0) return minRadius;
    const t = Math.sqrt((degrees.get(node.id) ?? 0) / maxDegree);
    return minRadius + (maxRadius - minRadius) * t;
  };

  const cx = width / 2;
  const cy = height / 2;

  if (n === 1) {
    return {
      width,
      height,
      nodes: [{ ...ordered[0], x: cx, y: cy, radius: radiusFor(ordered[0]) }],
    };
  }

  const innerW = Math.max(1, width - 2 * padding);
  const innerH = Math.max(1, height - 2 * padding);
  const area = innerW * innerH;
  const k = (options.idealEdge ?? 1) * Math.sqrt(area / n);
  const spread = Math.max(1, Math.min(width, height) / 2 - padding);

  // Phyllotaxis seed: distinct, evenly-spread starting points (no two
  // coincident, which would otherwise make repulsion blow up to NaN).
  const GOLDEN_ANGLE = Math.PI * (3 - Math.sqrt(5));
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    const r = spread * Math.sqrt((i + 0.5) / n);
    const a = i * GOLDEN_ANGLE;
    xs[i] = cx + r * Math.cos(a);
    ys[i] = cy + r * Math.sin(a);
  }

  const index = new Map<string, number>();
  ordered.forEach((node, i) => index.set(node.id, i));
  const links: Array<[number, number]> = [];
  for (const edge of view.edges) {
    const a = index.get(edge.from);
    const b = index.get(edge.to);
    if (a === undefined || b === undefined || a === b) continue;
    links.push([a, b]);
  }

  const dispX = new Float64Array(n);
  const dispY = new Float64Array(n);
  const MIN_DIST = 0.01;
  let temp = spread * 0.5;
  const cooling = iterations > 0 ? temp / (iterations + 1) : 0;

  for (let step = 0; step < iterations; step++) {
    dispX.fill(0);
    dispY.fill(0);

    // Repulsion between every pair.
    for (let i = 0; i < n; i++) {
      for (let j = i + 1; j < n; j++) {
        let dx = xs[i] - xs[j];
        let dy = ys[i] - ys[j];
        let dist = Math.hypot(dx, dy);
        if (dist < MIN_DIST) {
          // Deterministic nudge keyed on indices (never random).
          dx = i - j;
          dy = ((i * 7 + j * 13) % 5) - 2;
          dist = Math.hypot(dx, dy) || 1;
        }
        const force = (k * k) / dist;
        const fx = (dx / dist) * force;
        const fy = (dy / dist) * force;
        dispX[i] += fx;
        dispY[i] += fy;
        dispX[j] -= fx;
        dispY[j] -= fy;
      }
    }

    // Spring attraction along edges.
    for (const [a, b] of links) {
      const dx = xs[a] - xs[b];
      const dy = ys[a] - ys[b];
      const dist = Math.hypot(dx, dy) || MIN_DIST;
      const force = (dist * dist) / k;
      const fx = (dx / dist) * force;
      const fy = (dy / dist) * force;
      dispX[a] -= fx;
      dispY[a] -= fy;
      dispX[b] += fx;
      dispY[b] += fy;
    }

    // Gentle centering gravity so disconnected nodes stay in frame.
    for (let i = 0; i < n; i++) {
      dispX[i] += (cx - xs[i]) * gravity;
      dispY[i] += (cy - ys[i]) * gravity;
    }

    // Integrate, capped by the current temperature, then clamp to canvas.
    for (let i = 0; i < n; i++) {
      const d = Math.hypot(dispX[i], dispY[i]) || MIN_DIST;
      const limited = Math.min(d, temp);
      xs[i] = clamp(xs[i] + (dispX[i] / d) * limited, padding, width - padding);
      ys[i] = clamp(
        ys[i] + (dispY[i] / d) * limited,
        padding,
        height - padding,
      );
    }

    temp = Math.max(0, temp - cooling);
  }

  const nodes: PositionedNode[] = ordered.map((node, i) => {
    const radius = radiusFor(node);
    return {
      ...node,
      x: clamp(xs[i], padding + radius, width - padding - radius),
      y: clamp(ys[i], padding + radius, height - padding - radius),
      radius,
    };
  });

  return { width, height, nodes };
}

/** An axis-aligned box in layout (world) coordinates. */
export interface FitBox {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Tight bounding box around every node in `layout` (including each node's
 * radius and room for its label below), expanded by `padding`. Drives
 * fit-on-load and the "zoom to fit" control: setting the SVG `viewBox` to
 * this box frames the whole graph regardless of how the force layout
 * settled. Falls back to the full canvas for an empty layout.
 */
export function computeFitBox(
  layout: GraphLayout,
  options: { padding?: number; labelPadding?: number } = {},
): FitBox {
  const padding = options.padding ?? 28;
  const labelPadding = options.labelPadding ?? 18;
  if (layout.nodes.length === 0) {
    return { x: 0, y: 0, width: layout.width, height: layout.height };
  }
  let minX = Infinity;
  let minY = Infinity;
  let maxX = -Infinity;
  let maxY = -Infinity;
  for (const node of layout.nodes) {
    const r = node.radius + labelPadding;
    minX = Math.min(minX, node.x - r);
    maxX = Math.max(maxX, node.x + r);
    minY = Math.min(minY, node.y - r);
    // Labels render below the node, so reserve a little extra vertically.
    maxY = Math.max(maxY, node.y + r + 12);
  }
  return {
    x: minX - padding,
    y: minY - padding,
    width: Math.max(1, maxX - minX + padding * 2),
    height: Math.max(1, maxY - minY + padding * 2),
  };
}

/** A 2D point in layout (world) coordinates. */
export interface Point {
  x: number;
  y: number;
}

/** Four-way compass direction used by keyboard spatial navigation. */
export type SpatialDirection = "up" | "down" | "left" | "right";

/** Anything carrying an id and a 2D position — the input to spatial nav. */
export interface SpatialNode extends Point {
  id: string;
}

/**
 * Weight applied to the *perpendicular* offset when ranking candidate
 * nodes for arrow-key navigation. A value > 1 biases selection toward
 * nodes that line up with the travel axis (so pressing → from a node
 * prefers the node most directly to its right over one that is closer
 * but well off-axis), which matches the spatial-navigation behaviour
 * users expect from a 2D canvas.
 */
const PERPENDICULAR_NAV_BIAS = 2.5;

/**
 * Spatial (directional) keyboard-navigation model for the graph: given
 * the laid-out nodes and the currently-focused node, return the id of
 * the node a single Arrow press should move focus to, or `null` when no
 * node lies in that direction.
 *
 * A candidate must lie strictly in the half-plane of travel (e.g. to the
 * right for `"right"`). Among those it minimises
 * `primary + PERPENDICULAR_NAV_BIAS · perpendicular`, where `primary` is
 * the distance along the travel axis and `perpendicular` the off-axis
 * distance — so the nearest *and best-aligned* node wins. Ties break on a
 * locale-independent codepoint compare of the id so the result is fully
 * deterministic (important for unit tests and for reproducible focus
 * order across machines).
 *
 * This is the spatial model rather than a graph-adjacency one: it works
 * even for disconnected nodes, never gets "stuck" on a low-degree node
 * with few neighbours, and maps 1:1 onto what the user sees on the
 * canvas. O(n) per keypress — cheap at the 600-node ceiling.
 */
export function findNeighborInDirection(
  nodes: ReadonlyArray<SpatialNode>,
  currentId: string,
  direction: SpatialDirection,
): string | null {
  const current = nodes.find((n) => n.id === currentId);
  if (!current) return null;
  let best: string | null = null;
  let bestScore = Infinity;
  for (const node of nodes) {
    if (node.id === currentId) continue;
    const dx = node.x - current.x;
    const dy = node.y - current.y;
    let primary: number;
    let perpendicular: number;
    switch (direction) {
      case "right":
        primary = dx;
        perpendicular = Math.abs(dy);
        break;
      case "left":
        primary = -dx;
        perpendicular = Math.abs(dy);
        break;
      case "down":
        primary = dy;
        perpendicular = Math.abs(dx);
        break;
      case "up":
        primary = -dy;
        perpendicular = Math.abs(dx);
        break;
    }
    // Must make positive progress along the travel axis.
    if (primary <= 0) continue;
    const score = primary + perpendicular * PERPENDICULAR_NAV_BIAS;
    if (
      score < bestScore ||
      (score === bestScore &&
        best !== null &&
        compareCodepoint(node.id, best) < 0)
    ) {
      bestScore = score;
      best = node.id;
    }
  }
  return best;
}

/**
 * Id of the highest visible-degree node (the most-connected hub in the
 * current view), used by the `End` key. Ties break by the same stable
 * {@link compareNodesForLayout} order the layouts use, so `End` lands on
 * a deterministic node. Returns `null` for an empty view.
 */
export function highestDegreeNodeId(
  view: ConceptGraphView,
  degrees: Map<string, number> = computeDegrees(view),
): string | null {
  let best: ConceptGraphNode | null = null;
  let bestDegree = -1;
  for (const node of view.nodes) {
    const degree = degrees.get(node.id) ?? 0;
    if (
      degree > bestDegree ||
      (degree === bestDegree &&
        best !== null &&
        compareNodesForLayout(node, best) < 0)
    ) {
      bestDegree = degree;
      best = node;
    }
  }
  return best ? best.id : null;
}

/**
 * Curvature assigned to one edge so that parallel / reciprocal edges
 * between the same node pair don't draw on top of each other.
 */
export interface EdgeCurve {
  /**
   * Signed perpendicular offset (world units) of the quadratic control
   * point, measured along the *canonical* normal of the endpoint pair
   * (see {@link quadraticControlPoint}). `0` draws a straight line.
   */
  offset: number;
  /** True when the edge is a self-loop (`from === to`). */
  selfLoop: boolean;
  /** 0-based index of this edge among self-loops on the same node. */
  loopIndex: number;
}

/** Spacing between adjacent parallel edges / self-loops, in world units. */
const PARALLEL_EDGE_STEP = 18;

/** Canonical, order-independent key for an unordered endpoint pair. */
function pairKey(a: string, b: string): string {
  return compareCodepoint(a, b) <= 0 ? `${a}\u0000${b}` : `${b}\u0000${a}`;
}

/**
 * Assign each edge a curvature so reciprocal/parallel edges fan apart.
 *
 * Edges are grouped by their unordered endpoint pair (so `a→b` and `b→a`
 * share a group and are separated), then spread symmetrically around the
 * straight midline: a lone edge gets a *gentle* constant bow (so labels
 * have room and crossing lines are easier to follow), two edges split to
 * opposite sides, three put one straight and two bowed, and so on.
 * Self-loops are flagged and fanned by index for the renderer to draw as
 * little loops. Deterministic: within a group edges are ordered by a
 * codepoint compare of their id, so the offsets are stable across runs.
 *
 * Pure and O(E): all heavy edge geometry stays here, unit-tested, leaving
 * the renderer to map an offset onto an SVG path. `step` is exposed for
 * tests.
 */
export function computeEdgeCurves(
  edges: ReadonlyArray<ConceptGraphEdge>,
  step: number = PARALLEL_EDGE_STEP,
): Map<string, EdgeCurve> {
  const groups = new Map<string, ConceptGraphEdge[]>();
  for (const edge of edges) {
    const key =
      edge.from === edge.to
        ? `self\u0000${edge.from}`
        : pairKey(edge.from, edge.to);
    const arr = groups.get(key);
    if (arr) arr.push(edge);
    else groups.set(key, [edge]);
  }

  const result = new Map<string, EdgeCurve>();
  for (const [key, group] of groups) {
    const selfLoop = key.startsWith("self\u0000");
    const ordered = [...group].sort((a, b) => compareCodepoint(a.id, b.id));
    const count = ordered.length;
    ordered.forEach((edge, index) => {
      if (selfLoop) {
        result.set(edge.id, { offset: 0, selfLoop: true, loopIndex: index });
        return;
      }
      // Symmetric spread around the midline; a single edge still bows
      // gently so its label has clearance and it's easier to trace.
      const centered = index - (count - 1) / 2;
      const offset = count === 1 ? step * 0.5 : centered * step;
      result.set(edge.id, { offset, selfLoop: false, loopIndex: 0 });
    });
  }
  return result;
}

/**
 * Control point for a quadratic edge curve: the midpoint of `from`/`to`
 * pushed `offset` world-units along the segment's unit normal. Callers
 * pass the endpoints in a *canonical* order (e.g. sorted by id) so every
 * edge in a parallel group shares one normal basis and their signed
 * offsets land on predictable, non-overlapping sides regardless of each
 * edge's own direction. Degenerate (coincident) endpoints fall back to a
 * vertical normal so the result is always finite.
 */
export function quadraticControlPoint(
  from: Point,
  to: Point,
  offset: number,
): Point {
  const mx = (from.x + to.x) / 2;
  const my = (from.y + to.y) / 2;
  const dx = to.x - from.x;
  const dy = to.y - from.y;
  const len = Math.hypot(dx, dy);
  if (len < 1e-6) {
    // Coincident endpoints: push straight up so we never divide by ~0.
    return { x: mx, y: my - offset };
  }
  const nx = -dy / len;
  const ny = dx / len;
  return { x: mx + nx * offset, y: my + ny * offset };
}

/** An SVG path for an edge plus the on-curve anchor for its label. */
export interface EdgePath {
  /** The `d` attribute for the `<path>`. */
  d: string;
  /** Point on the curve at t = 0.5, where a label should be anchored. */
  labelPoint: Point;
}

/**
 * Build the quadratic-bezier path for an edge from `from` to `to` with
 * the given `control` point, and the on-curve label anchor at t = 0.5.
 *
 * The path is drawn in the edge's true direction (`from` → `to`) so an
 * `orient="auto"` arrowhead marker points the right way even though the
 * `control` point is computed from the canonical endpoint order. The
 * label anchor uses the quadratic midpoint identity
 * `B(½) = ¼·from + ½·control + ¼·to`, which is symmetric in `from`/`to`
 * and therefore identical no matter which direction the edge is drawn.
 */
export function quadraticEdgePath(
  from: Point,
  to: Point,
  control: Point,
): EdgePath {
  return {
    d: `M ${from.x} ${from.y} Q ${control.x} ${control.y} ${to.x} ${to.y}`,
    labelPoint: quadraticMidpoint(from, to, control),
  };
}

/**
 * On-curve midpoint of the quadratic bezier `from → to` with `control`,
 * `B(½) = ¼·from + ½·control + ¼·to`. This is the correct edge-label anchor:
 * the raw `control` point lies *off* the drawn curve once an edge is bowed
 * (parallel/reciprocal pairs), so anchoring there floats the label away from
 * the line. Shared by the SVG path and the Canvas renderer so both place
 * labels identically.
 */
export function quadraticMidpoint(
  from: Point,
  to: Point,
  control: Point,
): Point {
  return {
    x: 0.25 * from.x + 0.5 * control.x + 0.25 * to.x,
    y: 0.25 * from.y + 0.5 * control.y + 0.25 * to.y,
  };
}

/**
 * A candidate edge-label placement: a center point, an estimated box,
 * and a priority (lower = placed first / more important).
 */
export interface LabelCandidate {
  /** Edge id the label belongs to. */
  id: string;
  /** Label box center. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Lower wins ties: e.g. focused edges get a smaller number. */
  priority: number;
}

/**
 * Greedy, collision-free label placement. Candidates are placed in
 * priority order (ties broken by a codepoint compare of the id for
 * determinism); a candidate is accepted only if its axis-aligned box
 * doesn't overlap any already-accepted box. Returns the set of edge ids
 * whose labels should render.
 *
 * O(k²) in the number of *candidates*, which the renderer keeps small
 * (all edges only below the wholesale threshold, otherwise just the
 * edges incident to the focused node), so this stays cheap even at the
 * node/edge ceiling. Pure and unit-testable in isolation.
 */
export function placeEdgeLabels(
  candidates: ReadonlyArray<LabelCandidate>,
): Set<string> {
  const ordered = [...candidates].sort(
    (a, b) => a.priority - b.priority || compareCodepoint(a.id, b.id),
  );
  const placed: Array<{ x: number; y: number; w: number; h: number }> = [];
  const accepted = new Set<string>();
  for (const c of ordered) {
    const halfW = c.width / 2;
    const halfH = c.height / 2;
    const overlaps = placed.some(
      (p) =>
        Math.abs(c.x - p.x) < halfW + p.w / 2 &&
        Math.abs(c.y - p.y) < halfH + p.h / 2,
    );
    if (!overlaps) {
      placed.push({ x: c.x, y: c.y, w: c.width, h: c.height });
      accepted.add(c.id);
    }
  }
  return accepted;
}
