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
 * Locale-independent string comparison by UTF-16 code unit. Unlike
 * `String.prototype.localeCompare`, the result never depends on the host's
 * locale/collation, so a sort keyed on it is reproducible across machines.
 */
function compareCodepoint(a: string, b: string): number {
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
  const edges = view.edges.filter(
    (e) => keep.has(e.from) && keep.has(e.to),
  );
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
  const nodes = states
    ? view.nodes.filter((n) => states.has(n.state))
    : view.nodes.slice();
  const ids = new Set(nodes.map((n) => n.id));
  const edges = view.edges.filter((e) => {
    if (relations && !relations.has(e.relationType)) return false;
    return ids.has(e.from) && ids.has(e.to);
  });
  return freezeView({ ...view, nodes, edges });
}

export interface ForceLayoutOptions extends LayoutOptions {
  /** Simulation iterations. More = better-settled, O(n²) per step. */
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
 * `Math.random` — and (2) running a fixed `iterations` count with a
 * deterministic cooling schedule. This lets the renderer animate toward a
 * stable target while the layout itself stays unit-testable and
 * reproducible across machines.
 *
 * The simulation combines repulsion between every node pair (O(n²),
 * comfortably within the ~120-node cap), spring attraction along edges, a
 * gentle centering gravity, and a temperature that caps per-step
 * displacement and decays linearly to zero. Final coordinates are clamped
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
  const iterations = Math.max(0, Math.trunc(options.iterations ?? 320));
  const gravity = options.gravity ?? 0.06;

  const n = view.nodes.length;
  if (n === 0) return { width, height, nodes: [] };

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
