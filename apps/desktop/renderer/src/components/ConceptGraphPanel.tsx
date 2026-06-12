import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type PointerEvent as ReactPointerEvent,
} from "react";
import { useCspNonce } from "../utils/cspNonce";
import { useConceptGraph } from "../hooks/useSubstrate";
import { usePrefersReducedMotion } from "../hooks/usePrefersReducedMotion";
import {
  computeDegrees,
  computeFitBox,
  computeForceLayout,
  filterGraphView,
  freezeView,
  incidentTo,
  localGraphView,
  RELATION_LABELS,
  type ConceptGraphView,
  type ConceptNodeState,
  type ConceptRelation,
  type FitBox,
  type PositionedNode,
} from "../utils/conceptGraph";
import { formatSourceId } from "../utils/memories";
import type { SubstrateMemoryInfo } from "../types/ipc";

/**
 * Interactive node-link view of the knowledge-substrate concept graph,
 * rendered with a dependency-free SVG layer (no D3 / canvas / extra
 * graph library). Nodes are concepts; edges are typed relations (`is_a`,
 * `part_of`, `supersedes`, `contradicts`, …).
 *
 * The interaction model is modelled on Obsidian's graph view and then
 * extended for a *typed* knowledge graph:
 *   - a deterministic force-directed layout (computed in
 *     `utils/conceptGraph`) that the panel animates toward with an
 *     ease-out settle (skipped under `prefers-reduced-motion`);
 *   - fit-on-load + zoom-to-fit, fluid wheel-zoom and drag-to-pan;
 *   - hover/selection highlights the node and its neighbors and dims the
 *     rest; nodes can be dragged to reposition; a "local graph" mode
 *     restricts the view to a node's N-hop neighborhood;
 *   - legends double as filters — toggle relationship types and node
 *     kinds (lifecycle states); degree-based node sizing; and a graceful
 *     "show more" affordance when the substrate truncates the graph at
 *     the node cap.
 *
 * All non-trivial logic (defensive JSON parsing, the force layout, the
 * filter/neighborhood/fit math) lives in `utils/conceptGraph` so this
 * component stays a presentational + interaction shell over separately
 * unit-tested, deterministic functions.
 */

const STATE_COLORS: Record<ConceptNodeState, string> = {
  candidate: "var(--color-text-secondary, #6b7280)",
  canonical: "var(--color-primary, #7c3aed)",
  superseded: "var(--color-warning, #f59e0b)",
  contradicted: "var(--color-danger, #ef4444)",
  deleted: "var(--color-text-tertiary, #9ca3af)",
  unknown: "var(--color-text-secondary, #6b7280)",
};

const STATE_LABELS: Record<ConceptNodeState, string> = {
  candidate: "candidate",
  canonical: "canonical",
  superseded: "superseded",
  contradicted: "contradicted",
  deleted: "deleted",
  unknown: "unknown",
};

const RELATION_COLORS: Record<ConceptRelation, string> = {
  is_a: "#2563eb",
  part_of: "#0891b2",
  decided_by: "#7c3aed",
  supersedes: "#d97706",
  contradicts: "#dc2626",
  derived_from: "#059669",
  assigned_to: "#db2777",
  unknown: "#6b7280",
};

export interface ConceptGraphPanelProps {
  /** Scope label forwarded to the bridge; `null`/omitted = default scope. */
  scope?: string | null;
  /** Initial upper bound on nodes pulled from the substrate. */
  maxNodes?: number;
  /**
   * Memory plane used to surface source evidence + citations for a
   * selected concept. When omitted the panel still renders the graph
   * and relationships; the evidence section is simply empty.
   */
  memories?: SubstrateMemoryInfo[];
  /** SVG canvas height in px. Width is responsive via viewBox. */
  height?: number;
  /** Optional heading rendered above the canvas. */
  title?: string;
  /** `data-testid` forwarded to the root element. */
  "data-testid"?: string;
}

const CANVAS_WIDTH = 720;
/** Hard ceiling on the node cap reachable via "show more" (perf guard). */
const NODE_CAP_CEILING = 600;
const MIN_ZOOM = 0.35;
const MAX_ZOOM = 8;
/** Below this node count every label is shown; above it, labels are pruned. */
const LABEL_ALL_THRESHOLD = 36;
/** Edge labels are only ever shown wholesale below this edge count. */
const EDGE_LABEL_THRESHOLD = 24;

interface Point {
  x: number;
  y: number;
}

/**
 * Static panel CSS, hoisted to a module-level constant so the rules are
 * identical for every mount and don't depend on props. The only dynamic
 * style is `.cg-detail`'s `max-height` (driven by the `height` prop),
 * applied inline on the element itself rather than baked into this
 * stylesheet — otherwise two panels with different `height` props mounted
 * at once would collide in the cascade. Motion is gated behind
 * `prefers-reduced-motion` so the CSS transitions (highlight dimming,
 * control affordances) honour the accessibility setting even though the
 * JS settle animation is gated separately in the component.
 */
const CONCEPT_GRAPH_STYLES = `
  .cg-panel {
    display: flex;
    flex-direction: column;
    gap: var(--spacing-sm);
  }
  .cg-toolbar {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--spacing-sm);
    flex-wrap: wrap;
  }
  .cg-title { margin: 0; font-size: var(--font-size-md, 1rem); }
  .cg-toolbar-controls {
    display: flex;
    align-items: center;
    gap: var(--spacing-sm);
    flex-wrap: wrap;
  }
  .cg-controlbar {
    display: flex;
    align-items: center;
    gap: var(--spacing-xs);
    flex-wrap: wrap;
    padding: var(--spacing-xs) var(--spacing-sm);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 8px);
    background: var(--color-surface, #fff);
  }
  .cg-controlbar-group {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
  .cg-controlbar-sep {
    width: 1px;
    align-self: stretch;
    background: var(--color-border);
    margin: 0 0.25rem;
  }
  .cg-iconbtn {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    min-width: 1.9rem;
    height: 1.9rem;
    padding: 0 0.5rem;
    font-size: var(--font-size-sm);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
    background: var(--color-bg, #fff);
    color: var(--color-text, #111827);
    cursor: pointer;
    line-height: 1;
  }
  .cg-iconbtn:hover:not(:disabled) {
    background: var(--color-surface-hover, #f3f4f6);
  }
  .cg-iconbtn:disabled { opacity: 0.45; cursor: not-allowed; }
  .cg-iconbtn[aria-pressed="true"] {
    border-color: var(--color-primary, #7c3aed);
    color: var(--color-primary, #7c3aed);
    background: var(--color-primary-light, #ede9fe);
  }
  .cg-zoom-readout {
    font-size: var(--font-size-xs, 0.75rem);
    color: var(--color-text-secondary);
    min-width: 3ch;
    text-align: center;
    font-variant-numeric: tabular-nums;
  }
  .cg-scope-filter, .cg-hops {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }
  .cg-status {
    padding: var(--spacing-md);
    color: var(--color-text-secondary);
  }
  .cg-error { color: var(--color-danger); }
  .cg-banner {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--spacing-sm);
    padding: var(--spacing-xs) var(--spacing-sm);
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
    background: var(--color-warning-bg, #fef3c7);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-sm, 6px);
  }
  .cg-body {
    display: grid;
    grid-template-columns: minmax(0, 2fr) minmax(220px, 1fr);
    gap: var(--spacing-md);
    align-items: start;
  }
  .cg-canvas-wrap { position: relative; min-width: 0; }
  .cg-canvas {
    width: 100%;
    height: auto;
    display: block;
    background: var(--color-surface-soft, #f9fafb);
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 8px);
    touch-action: none;
    cursor: grab;
  }
  .cg-canvas.cg-panning { cursor: grabbing; }
  .cg-focus-pill {
    position: absolute;
    top: var(--spacing-sm);
    left: var(--spacing-sm);
    display: inline-flex;
    align-items: center;
    gap: 0.4rem;
    padding: 0.2rem 0.5rem;
    font-size: var(--font-size-xs, 0.75rem);
    background: var(--color-bg, #fff);
    border: 1px solid var(--color-primary, #7c3aed);
    color: var(--color-primary, #7c3aed);
    border-radius: var(--radius-button, 9999px);
  }
  .cg-focus-pill button {
    border: none;
    background: none;
    color: inherit;
    cursor: pointer;
    font-size: 1rem;
    line-height: 1;
    padding: 0;
  }
  .cg-edge { transition: opacity var(--transition-fast, 150ms ease); }
  .cg-node { cursor: pointer; }
  .cg-node-hit { fill: transparent; }
  .cg-node circle.cg-node-dot {
    transition: fill-opacity var(--transition-fast, 150ms ease);
  }
  .cg-node:focus { outline: none; }
  .cg-node:focus circle.cg-node-dot {
    stroke: var(--color-primary, #7c3aed);
    stroke-width: 3;
  }
  .cg-node-label {
    font-size: 11px;
    fill: var(--color-text, #111827);
    pointer-events: none;
    paint-order: stroke;
    stroke: var(--color-surface-soft, #f9fafb);
    stroke-width: 3px;
    stroke-linejoin: round;
  }
  .cg-edge-label {
    font-size: 9px;
    opacity: 0.85;
    pointer-events: none;
  }
  .cg-dim { opacity: 0.12; }
  .cg-detail {
    border: 1px solid var(--color-border);
    border-radius: var(--radius-md, 8px);
    padding: var(--spacing-md);
    background: var(--color-surface, #fff);
    overflow-y: auto;
  }
  .cg-detail-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--spacing-sm);
  }
  .cg-detail-title { margin: 0; font-size: var(--font-size-md, 1rem); }
  .cg-detail-actions {
    margin: var(--spacing-sm) 0 0;
    display: flex;
    gap: var(--spacing-xs);
    flex-wrap: wrap;
  }
  .cg-detail-meta {
    margin: 0.25rem 0 var(--spacing-sm);
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }
  .cg-detail-section { margin-top: var(--spacing-md); }
  .cg-detail-subhead {
    margin: 0 0 0.375rem;
    font-size: var(--font-size-sm);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-secondary);
  }
  .cg-detail-empty {
    margin: 0;
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }
  .cg-detail-list, .cg-evidence-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    font-size: var(--font-size-sm);
  }
  .cg-detail-list li {
    display: flex;
    align-items: center;
    gap: 0.4rem;
  }
  .cg-rel-dot {
    width: 8px;
    height: 8px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .cg-evidence-item {
    border-left: 2px solid var(--color-border);
    padding-left: var(--spacing-sm);
  }
  .cg-evidence-content { margin: 0; }
  .cg-evidence-cite {
    margin: 0.2rem 0 0;
    font-size: var(--font-size-xs, 0.75rem);
    color: var(--color-text-secondary);
  }
  .cg-legends {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing-md);
  }
  .cg-legend {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--spacing-sm);
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }
  .cg-legend-caption {
    text-transform: uppercase;
    letter-spacing: 0.04em;
    font-size: var(--font-size-xs, 0.75rem);
  }
  .cg-legend-item {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding: 0.1rem 0.4rem;
    border: 1px solid transparent;
    border-radius: var(--radius-sm, 6px);
    background: none;
    color: inherit;
    cursor: pointer;
    font-size: inherit;
  }
  .cg-legend-item:hover { background: var(--color-surface-hover, #f3f4f6); }
  .cg-legend-item[aria-pressed="false"] {
    opacity: 0.45;
    text-decoration: line-through;
  }
  .cg-legend-swatch {
    width: 12px;
    height: 3px;
    border-radius: 2px;
    flex: 0 0 auto;
  }
  .cg-legend-dot {
    width: 10px;
    height: 10px;
    border-radius: 50%;
    flex: 0 0 auto;
  }
  .cg-legend-trunc { font-style: italic; }
  @media (max-width: 720px) {
    .cg-body { grid-template-columns: 1fr; }
  }
  @media (prefers-reduced-motion: reduce) {
    .cg-edge, .cg-node circle.cg-node-dot { transition: none; }
  }
`;

export default function ConceptGraphPanel({
  scope = null,
  maxNodes = 120,
  memories = [],
  height = 460,
  title,
  "data-testid": dataTestId,
}: ConceptGraphPanelProps) {
  const cspNonce = useCspNonce();
  const markerPrefix = useId();
  const prefersReducedMotion = usePrefersReducedMotion();

  const [nodeCap, setNodeCap] = useState(maxNodes);
  // A new `maxNodes` prop resets the locally-expanded cap.
  useEffect(() => setNodeCap(maxNodes), [maxNodes]);

  const { graph, loading, error, refresh } = useConceptGraph(scope, nodeCap);

  const [scopeFilter, setScopeFilter] = useState<string>("all");
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [hoveredId, setHoveredId] = useState<string | null>(null);
  const [disabledRelations, setDisabledRelations] = useState<
    ReadonlySet<ConceptRelation>
  >(() => new Set());
  const [disabledStates, setDisabledStates] = useState<
    ReadonlySet<ConceptNodeState>
  >(() => new Set());
  const [localMode, setLocalMode] = useState(false);
  const [localHops, setLocalHops] = useState(1);
  const [labelsAll, setLabelsAll] = useState(false);

  // ----- scope filtering (preserved from the prior implementation) -----
  const scopes = useMemo(() => {
    const set = new Set<string>();
    for (const n of graph.nodes) set.add(n.scopeId);
    return [...set].sort();
  }, [graph.nodes]);

  const effectiveScopeFilter =
    scopeFilter !== "all" && scopes.includes(scopeFilter) ? scopeFilter : "all";

  useEffect(() => {
    if (scopeFilter !== "all" && !scopes.includes(scopeFilter)) {
      setScopeFilter("all");
      setSelectedId(null);
    }
  }, [scopes, scopeFilter]);

  const scopedView: ConceptGraphView = useMemo(() => {
    if (effectiveScopeFilter === "all") return graph;
    const nodes = graph.nodes.filter((n) => n.scopeId === effectiveScopeFilter);
    const ids = new Set(nodes.map((n) => n.id));
    const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
    // Freeze like every other derived view (filter/local-graph) so the
    // deep-frozen invariant holds uniformly for all views in the component.
    return freezeView({ ...graph, nodes, edges });
  }, [graph, effectiveScopeFilter]);

  // ----- which relation types / node kinds exist (for legend + filters) -----
  const relationsPresent = useMemo(() => {
    const set = new Set<ConceptRelation>();
    for (const e of scopedView.edges) set.add(e.relationType);
    return [...set];
  }, [scopedView.edges]);

  const statesPresent = useMemo(() => {
    const set = new Set<ConceptNodeState>();
    for (const n of scopedView.nodes) set.add(n.state);
    return [...set];
  }, [scopedView.nodes]);

  // ----- apply relation/kind filters, then optional local-graph scoping -----
  const filteredView = useMemo(() => {
    const relations =
      disabledRelations.size > 0
        ? new Set(relationsPresent.filter((r) => !disabledRelations.has(r)))
        : undefined;
    const states =
      disabledStates.size > 0
        ? new Set(statesPresent.filter((s) => !disabledStates.has(s)))
        : undefined;
    return filterGraphView(scopedView, { relations, states });
  }, [
    scopedView,
    disabledRelations,
    disabledStates,
    relationsPresent,
    statesPresent,
  ]);

  const view = useMemo(() => {
    if (localMode && selectedId) {
      return localGraphView(filteredView, selectedId, localHops);
    }
    return filteredView;
  }, [filteredView, localMode, selectedId, localHops]);

  const layout = useMemo(
    () => computeForceLayout(view, { width: CANVAS_WIDTH, height }),
    [view, height],
  );

  const baseFit = useMemo<FitBox>(() => computeFitBox(layout), [layout]);
  const degrees = useMemo(() => computeDegrees(view), [view]);
  const maxDegree = useMemo(
    () => [...degrees.values()].reduce((m, d) => Math.max(m, d), 0),
    [degrees],
  );

  // ===== settle animation: tween display positions toward the layout =====
  const displayRef = useRef<Map<string, Point>>(new Map());
  const [displayPos, setDisplayPos] = useState<Map<string, Point>>(new Map());
  const commitDisplay = useCallback((next: Map<string, Point>) => {
    displayRef.current = next;
    setDisplayPos(next);
  }, []);

  const [dragPos, setDragPos] = useState<Map<string, Point>>(new Map());
  // Mirror drag overrides into a ref so event callbacks can read the live
  // map without taking `dragPos` as a dependency (which would otherwise
  // recreate those callbacks — and re-prop every node — on every drag frame).
  const dragPosRef = useRef<Map<string, Point>>(dragPos);
  const commitDragPos = useCallback((next: Map<string, Point>) => {
    dragPosRef.current = next;
    setDragPos(next);
  }, []);
  // Drag overrides are stale once the layout (data/filter/size) changes.
  useEffect(() => commitDragPos(new Map()), [layout, commitDragPos]);

  useEffect(() => {
    const targets = layout.nodes;
    const animate =
      !prefersReducedMotion &&
      typeof requestAnimationFrame === "function" &&
      targets.length > 0;

    if (!animate) {
      const snapped = new Map<string, Point>();
      for (const n of targets) snapped.set(n.id, { x: n.x, y: n.y });
      commitDisplay(snapped);
      return;
    }

    const from = displayRef.current;
    const start = new Map<string, Point>();
    for (const n of targets) {
      // New nodes grow out of the canvas center; existing nodes ease from
      // wherever they currently are (so re-layouts feel continuous).
      start.set(
        n.id,
        from.get(n.id) ?? { x: layout.width / 2, y: layout.height / 2 },
      );
    }

    const DURATION = 650;
    const begin = performance.now();
    let frame = 0;
    const tick = (now: number) => {
      const t = Math.min(1, (now - begin) / DURATION);
      const eased = 1 - Math.pow(1 - t, 3); // ease-out cubic
      const next = new Map<string, Point>();
      for (const n of targets) {
        const s = start.get(n.id)!;
        next.set(n.id, {
          x: s.x + (n.x - s.x) * eased,
          y: s.y + (n.y - s.y) * eased,
        });
      }
      commitDisplay(next);
      if (t < 1) frame = requestAnimationFrame(tick);
    };
    frame = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(frame);
  }, [layout, prefersReducedMotion, commitDisplay]);

  // ===== pan / zoom (SVG viewBox) =====
  const svgRef = useRef<SVGSVGElement | null>(null);
  const [viewBox, setViewBox] = useState<FitBox>(baseFit);
  const viewBoxRef = useRef<FitBox>(baseFit);
  // Mirror baseFit into a ref so zoom math can read the current fit width
  // without taking it as a dependency — otherwise zoomAround (and the
  // non-passive wheel listener that closes over it) would be recreated and
  // the listener re-attached on every layout/filter change.
  const baseFitRef = useRef<FitBox>(baseFit);
  const applyViewBox = useCallback((box: FitBox) => {
    viewBoxRef.current = box;
    setViewBox(box);
  }, []);
  // Fit-on-load and re-fit whenever the layout changes (new data / filter).
  useEffect(() => {
    baseFitRef.current = baseFit;
    viewBoxRef.current = baseFit;
    setViewBox(baseFit);
  }, [baseFit]);

  const zoomAround = useCallback(
    (px: number, py: number, factor: number) => {
      const vb = viewBoxRef.current;
      const base = baseFitRef.current.width;
      const minW = base / MAX_ZOOM;
      const maxW = base / MIN_ZOOM;
      const targetW = vb.width * factor;
      const nw = Math.min(maxW, Math.max(minW, targetW));
      if (nw === vb.width) return;
      const scale = nw / vb.width;
      const nh = vb.height * scale;
      const worldX = vb.x + px * vb.width;
      const worldY = vb.y + py * vb.height;
      applyViewBox({
        x: worldX - px * nw,
        y: worldY - py * nh,
        width: nw,
        height: nh,
      });
    },
    [applyViewBox],
  );

  // Non-passive wheel listener so we can preventDefault the page scroll.
  useEffect(() => {
    const el = svgRef.current;
    if (!el) return;
    const onWheel = (e: WheelEvent) => {
      e.preventDefault();
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;
      const px = (e.clientX - rect.left) / rect.width;
      const py = (e.clientY - rect.top) / rect.height;
      // Scroll up (deltaY < 0) zooms in → smaller viewBox.
      const factor = Math.exp((e.deltaY > 0 ? 1 : -1) * 0.14);
      zoomAround(px, py, factor);
    };
    el.addEventListener("wheel", onWheel, { passive: false });
    return () => el.removeEventListener("wheel", onWheel);
  }, [zoomAround]);

  const fitToView = useCallback(() => applyViewBox(baseFit), [applyViewBox, baseFit]);
  const zoomByButton = useCallback(
    (factor: number) => zoomAround(0.5, 0.5, factor),
    [zoomAround],
  );

  const resetView = useCallback(() => {
    setSelectedId(null);
    setHoveredId(null);
    setLocalMode(false);
    setDisabledRelations(new Set());
    setDisabledStates(new Set());
    commitDragPos(new Map());
    applyViewBox(baseFit);
  }, [applyViewBox, baseFit, commitDragPos]);

  // ===== pointer interactions: drag-to-pan + drag-node + click-to-select =====
  const panRef = useRef<{ x: number; y: number; box: FitBox } | null>(null);
  const dragNodeRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    origin: Point;
    moved: boolean;
  } | null>(null);
  const suppressClickRef = useRef(false);
  const [isPanning, setIsPanning] = useState(false);

  const onBackgroundPointerDown = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      // Node pointerdowns stopPropagation, so reaching here means the
      // background was grabbed → start a pan.
      panRef.current = { x: e.clientX, y: e.clientY, box: viewBoxRef.current };
      setIsPanning(true);
      svgRef.current?.setPointerCapture(e.pointerId);
    },
    [],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<SVGSVGElement>) => {
      const el = svgRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const drag = dragNodeRef.current;
      if (drag) {
        const vb = viewBoxRef.current;
        const dx = ((e.clientX - drag.startX) / rect.width) * vb.width;
        const dy = ((e.clientY - drag.startY) / rect.height) * vb.height;
        if (!drag.moved && Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 3) {
          drag.moved = true;
          suppressClickRef.current = true;
        }
        const nextPoint = { x: drag.origin.x + dx, y: drag.origin.y + dy };
        const next = new Map(dragPosRef.current);
        next.set(drag.id, nextPoint);
        commitDragPos(next);
        return;
      }

      const pan = panRef.current;
      if (pan) {
        const dx = ((e.clientX - pan.x) / rect.width) * pan.box.width;
        const dy = ((e.clientY - pan.y) / rect.height) * pan.box.height;
        applyViewBox({
          x: pan.box.x - dx,
          y: pan.box.y - dy,
          width: pan.box.width,
          height: pan.box.height,
        });
      }
    },
    [applyViewBox, commitDragPos],
  );

  const endPointer = useCallback((e: ReactPointerEvent<SVGSVGElement>) => {
    const drag = dragNodeRef.current;
    panRef.current = null;
    dragNodeRef.current = null;
    setIsPanning(false);
    if (svgRef.current?.hasPointerCapture(e.pointerId)) {
      svgRef.current.releasePointerCapture(e.pointerId);
    }
    // Selection happens on pointer-up rather than the synthetic `click`:
    // `onNodePointerDown` captures the pointer on the <svg>, which redirects
    // the compatibility click to the SVG (not the node <g>), so a node's
    // `onClick` never fires in a real browser. A tap that didn't drift past
    // the drag threshold is treated as a selection.
    if (drag && !drag.moved) {
      setSelectedId(drag.id);
    }
  }, []);

  const onNodePointerDown = useCallback(
    (e: ReactPointerEvent<SVGGElement>, node: PositionedNode) => {
      e.stopPropagation();
      const current =
        dragPosRef.current.get(node.id) ??
        displayRef.current.get(node.id) ?? { x: node.x, y: node.y };
      dragNodeRef.current = {
        id: node.id,
        startX: e.clientX,
        startY: e.clientY,
        origin: current,
        moved: false,
      };
      svgRef.current?.setPointerCapture(e.pointerId);
    },
    [],
  );

  const onNodeClick = useCallback((id: string) => {
    if (suppressClickRef.current) {
      suppressClickRef.current = false;
      return;
    }
    setSelectedId(id);
  }, []);

  // ===== selection-derived detail data =====
  const selectedNode = useMemo(
    () => view.nodes.find((n) => n.id === selectedId) ?? null,
    [view.nodes, selectedId],
  );

  const selectedRelations = useMemo(() => {
    if (!selectedNode) return [];
    const labelOf = (id: string) =>
      view.nodes.find((n) => n.id === id)?.label ?? id;
    return view.edges
      .filter((e) => e.from === selectedNode.id || e.to === selectedNode.id)
      .map((e) => {
        const outgoing = e.from === selectedNode.id;
        return {
          id: e.id,
          relationType: e.relationType,
          direction: outgoing ? ("out" as const) : ("in" as const),
          otherLabel: labelOf(outgoing ? e.to : e.from),
        };
      });
  }, [selectedNode, view.edges, view.nodes]);

  const selectedEvidence = useMemo(() => {
    if (!selectedNode) return [];
    const label = selectedNode.label.trim();
    if (!label) return [];
    const escaped = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matcher = /\w/.test(label)
      ? new RegExp(`\\b${escaped}\\b`, "i")
      : null;
    const needle = label.toLowerCase();
    return memories
      .filter((m) =>
        matcher ? matcher.test(m.content) : m.content.toLowerCase().includes(needle),
      )
      .slice(0, 8);
  }, [selectedNode, memories]);

  // ===== highlight/dim: focus = hovered node, else selected node =====
  const focusId = hoveredId ?? selectedId;
  const focus = useMemo(() => {
    if (!focusId) return null;
    const { nodeIds, edgeIds } = incidentTo(view, focusId);
    return nodeIds.size > 0 ? { nodeIds, edgeIds } : null;
  }, [view, focusId]);

  // ===== rendering helpers =====
  const renderPos = useMemo(() => {
    const map = new Map<string, Point>();
    for (const n of layout.nodes) {
      map.set(n.id, dragPos.get(n.id) ?? displayPos.get(n.id) ?? { x: n.x, y: n.y });
    }
    return map;
  }, [layout.nodes, dragPos, displayPos]);

  const relationsUsed = useMemo(() => {
    const set = new Set<ConceptRelation>();
    for (const e of view.edges) set.add(e.relationType);
    return [...set];
  }, [view.edges]);

  const usedMarkerColors = useMemo(() => {
    const set = new Set<string>();
    for (const r of relationsUsed) set.add(RELATION_COLORS[r]);
    return [...set];
  }, [relationsUsed]);

  const markerId = (color: string) =>
    `${markerPrefix}-arrow-${color.replace(/[^a-zA-Z0-9]/g, "")}`;

  const zoom = baseFit.width > 0 ? baseFit.width / viewBox.width : 1;
  const nodeCount = layout.nodes.length;
  const showAllNodeLabels =
    labelsAll || nodeCount <= LABEL_ALL_THRESHOLD || zoom >= 1.3;
  const labelDegreeThreshold = Math.max(2, Math.ceil(maxDegree * 0.6));
  const labelVisible = (node: PositionedNode): boolean => {
    if (showAllNodeLabels) return true;
    if (focus?.nodeIds.has(node.id)) return true;
    return (degrees.get(node.id) ?? 0) >= labelDegreeThreshold;
  };
  const showEdgeLabels = view.edges.length <= EDGE_LABEL_THRESHOLD;

  const toggleRelation = (relation: ConceptRelation) => {
    setDisabledRelations((prev) => {
      const next = new Set(prev);
      if (next.has(relation)) next.delete(relation);
      else next.add(relation);
      return next;
    });
  };
  const toggleState = (state: ConceptNodeState) => {
    setDisabledStates((prev) => {
      const next = new Set(prev);
      if (next.has(state)) next.delete(state);
      else next.add(state);
      return next;
    });
  };

  const truncated = view.truncation !== "complete";
  const canShowMore = truncated && nodeCap < NODE_CAP_CEILING;

  return (
    <div data-testid={dataTestId ?? "concept-graph-panel"} className="cg-panel">
      <div className="cg-toolbar">
        {title ? <h3 className="cg-title">{title}</h3> : <span />}
        <div className="cg-toolbar-controls">
          {scopes.length > 1 && (
            <label className="cg-scope-filter">
              <span className="cg-scope-label">Scope</span>
              <select
                className="input"
                aria-label="Filter concept graph by scope"
                value={scopeFilter}
                onChange={(e) => {
                  setScopeFilter(e.target.value);
                  setSelectedId(null);
                }}
              >
                <option value="all">All scopes ({scopes.length})</option>
                {scopes.map((s) => (
                  <option key={s} value={s}>
                    {s.slice(0, 8)}…
                  </option>
                ))}
              </select>
            </label>
          )}
          <button
            type="button"
            className="btn btn-secondary cg-refresh"
            onClick={() => void refresh()}
          >
            Refresh
          </button>
        </div>
      </div>

      {loading ? (
        <p className="cg-status" aria-busy="true">
          Loading concept graph…
        </p>
      ) : error ? (
        <p className="cg-status cg-error" role="alert">
          {error}
        </p>
      ) : view.nodes.length === 0 ? (
        <p className="cg-status" data-testid="concept-graph-empty">
          {localMode && selectedId
            ? "This concept has no connections in the current view."
            : "No concepts yet. As Tessera extracts entities and relationships from your sources, they will appear here."}
        </p>
      ) : (
        <>
          <div
            className="cg-controlbar"
            role="toolbar"
            aria-label="Concept graph controls"
            data-testid="concept-graph-controls"
          >
            <div className="cg-controlbar-group">
              <button
                type="button"
                className="cg-iconbtn"
                aria-label="Zoom out"
                onClick={() => zoomByButton(1 / 0.8)}
              >
                −
              </button>
              <span className="cg-zoom-readout" aria-live="off">
                {Math.round(zoom * 100)}%
              </span>
              <button
                type="button"
                className="cg-iconbtn"
                aria-label="Zoom in"
                onClick={() => zoomByButton(0.8)}
              >
                +
              </button>
            </div>
            <div className="cg-controlbar-sep" aria-hidden="true" />
            <div className="cg-controlbar-group">
              <button
                type="button"
                className="cg-iconbtn"
                onClick={fitToView}
                data-testid="concept-graph-fit"
              >
                Fit
              </button>
              <button type="button" className="cg-iconbtn" onClick={resetView}>
                Reset
              </button>
            </div>
            <div className="cg-controlbar-sep" aria-hidden="true" />
            <div className="cg-controlbar-group">
              <button
                type="button"
                className="cg-iconbtn"
                aria-pressed={labelsAll}
                aria-label="Toggle all labels"
                onClick={() => setLabelsAll((v) => !v)}
              >
                Labels
              </button>
              <button
                type="button"
                className="cg-iconbtn"
                aria-pressed={localMode}
                disabled={!selectedId}
                data-testid="concept-graph-local-toggle"
                onClick={() => setLocalMode((v) => !v)}
                title={
                  selectedId
                    ? "Show only the selected concept's neighborhood"
                    : "Select a concept to focus its local graph"
                }
              >
                Local graph
              </button>
              {localMode && (
                <label className="cg-hops">
                  <span>Hops</span>
                  <select
                    className="input"
                    aria-label="Local graph hop distance"
                    value={localHops}
                    onChange={(e) => setLocalHops(Number(e.target.value))}
                  >
                    <option value={1}>1</option>
                    <option value={2}>2</option>
                    <option value={3}>3</option>
                  </select>
                </label>
              )}
            </div>
          </div>

          {truncated && (
            <div className="cg-banner" role="status" data-testid="concept-graph-truncation">
              <span>
                Showing the {nodeCount} most-connected concepts (graph{" "}
                {view.truncation.replace(/_/g, " ")}).
              </span>
              {canShowMore && (
                <button
                  type="button"
                  className="cg-iconbtn"
                  data-testid="concept-graph-show-more"
                  onClick={() =>
                    setNodeCap((cap) => Math.min(NODE_CAP_CEILING, cap + maxNodes))
                  }
                >
                  Show more
                </button>
              )}
            </div>
          )}

          <div className="cg-body">
            <div className="cg-canvas-wrap">
              <svg
                ref={svgRef}
                className={`cg-canvas${isPanning ? " cg-panning" : ""}`}
                role="img"
                aria-label={`Concept graph with ${view.nodes.length} concepts and ${view.edges.length} relationships`}
                viewBox={`${viewBox.x} ${viewBox.y} ${viewBox.width} ${viewBox.height}`}
                style={{ aspectRatio: `${CANVAS_WIDTH} / ${height}` }}
                data-testid="concept-graph-svg"
                onPointerDown={onBackgroundPointerDown}
                onPointerMove={onPointerMove}
                onPointerUp={endPointer}
                onPointerCancel={endPointer}
              >
                <defs>
                  {usedMarkerColors.map((color) => (
                    <marker
                      key={color}
                      id={markerId(color)}
                      viewBox="0 0 10 10"
                      refX="9"
                      refY="5"
                      markerWidth="7"
                      markerHeight="7"
                      orient="auto-start-reverse"
                    >
                      <path d="M 0 0 L 10 5 L 0 10 z" fill={color} />
                    </marker>
                  ))}
                </defs>
                <g className="cg-edges">
                  {view.edges.map((edge) => {
                    const from = renderPos.get(edge.from);
                    const to = renderPos.get(edge.to);
                    if (!from || !to) return null;
                    const color = RELATION_COLORS[edge.relationType];
                    const dimmed = focus ? !focus.edgeIds.has(edge.id) : false;
                    const mx = (from.x + to.x) / 2;
                    const my = (from.y + to.y) / 2;
                    const labelThisEdge =
                      showEdgeLabels || (focus ? focus.edgeIds.has(edge.id) : false);
                    return (
                      <g
                        key={edge.id}
                        className={`cg-edge${dimmed ? " cg-dim" : ""}`}
                      >
                        <line
                          x1={from.x}
                          y1={from.y}
                          x2={to.x}
                          y2={to.y}
                          stroke={color}
                          strokeWidth={1.5}
                          strokeOpacity={0.7}
                          markerEnd={`url(#${markerId(color)})`}
                        />
                        {labelThisEdge && (
                          <text
                            x={mx}
                            y={my}
                            className="cg-edge-label"
                            fill={color}
                            textAnchor="middle"
                          >
                            {RELATION_LABELS[edge.relationType]}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
                <g className="cg-nodes">
                  {layout.nodes.map((node) => {
                    const pos = renderPos.get(node.id) ?? { x: node.x, y: node.y };
                    const isSelected = node.id === selectedId;
                    const dimmed = focus ? !focus.nodeIds.has(node.id) : false;
                    const fill = STATE_COLORS[node.state] ?? STATE_COLORS.unknown;
                    return (
                      <g
                        key={node.id}
                        className={`cg-node${dimmed ? " cg-dim" : ""}`}
                        transform={`translate(${pos.x}, ${pos.y})`}
                        role="button"
                        tabIndex={0}
                        aria-pressed={isSelected}
                        aria-label={`${node.label} (${node.state}, ${node.connectionsCount} connections)`}
                        data-testid={`concept-node-${node.id}`}
                        onPointerDown={(e) => onNodePointerDown(e, node)}
                        onClick={() => onNodeClick(node.id)}
                        onPointerEnter={() => setHoveredId(node.id)}
                        onPointerLeave={() =>
                          setHoveredId((cur) => (cur === node.id ? null : cur))
                        }
                        onFocus={() => setHoveredId(node.id)}
                        onBlur={() =>
                          setHoveredId((cur) => (cur === node.id ? null : cur))
                        }
                        onKeyDown={(e) => {
                          if (e.key === "Enter" || e.key === " ") {
                            e.preventDefault();
                            setSelectedId(node.id);
                          }
                        }}
                      >
                        {/* Generous transparent hit area for easier grabbing. */}
                        <circle className="cg-node-hit" r={node.radius + 8} />
                        <circle
                          className="cg-node-dot"
                          r={node.radius}
                          fill={fill}
                          fillOpacity={isSelected ? 0.95 : 0.78}
                          stroke={
                            isSelected
                              ? "var(--color-text, #111827)"
                              : "var(--color-surface, #ffffff)"
                          }
                          strokeWidth={isSelected ? 3 : 1.5}
                        />
                        {labelVisible(node) && (
                          <text
                            className="cg-node-label"
                            y={node.radius + 12}
                            textAnchor="middle"
                          >
                            {node.label.length > 22
                              ? `${node.label.slice(0, 21)}…`
                              : node.label}
                          </text>
                        )}
                      </g>
                    );
                  })}
                </g>
              </svg>
              {localMode && selectedNode && (
                <div className="cg-focus-pill" data-testid="concept-graph-focus-pill">
                  <span>
                    Local: {selectedNode.label} · {localHops}-hop
                  </span>
                  <button
                    type="button"
                    aria-label="Exit local graph"
                    onClick={() => setLocalMode(false)}
                  >
                    ×
                  </button>
                </div>
              )}
            </div>

            <aside
              className="cg-detail"
              aria-live="polite"
              style={{ maxHeight: `${height}px` }}
            >
              {selectedNode ? (
                <div data-testid="concept-detail">
                  <div className="cg-detail-head">
                    <h4 className="cg-detail-title">{selectedNode.label}</h4>
                    <span className={`badge badge-state-${selectedNode.state}`}>
                      {selectedNode.state}
                    </span>
                  </div>
                  <p className="cg-detail-meta">
                    {selectedNode.connectionsCount} connection
                    {selectedNode.connectionsCount === 1 ? "" : "s"}
                  </p>
                  <div className="cg-detail-actions">
                    <button
                      type="button"
                      className="cg-iconbtn"
                      aria-pressed={localMode}
                      onClick={() => setLocalMode((v) => !v)}
                    >
                      {localMode ? "Exit local graph" : "Focus local graph"}
                    </button>
                  </div>

                  <section className="cg-detail-section">
                    <h5 className="cg-detail-subhead">Relationships</h5>
                    {selectedRelations.length === 0 ? (
                      <p className="cg-detail-empty">No relationships in view.</p>
                    ) : (
                      <ul className="cg-detail-list">
                        {selectedRelations.map((rel) => (
                          <li key={rel.id}>
                            <span
                              className="cg-rel-dot"
                              style={{ background: RELATION_COLORS[rel.relationType] }}
                              aria-hidden="true"
                            />
                            {rel.direction === "out" ? (
                              <>
                                {RELATION_LABELS[rel.relationType]} →{" "}
                                <strong>{rel.otherLabel}</strong>
                              </>
                            ) : (
                              <>
                                <strong>{rel.otherLabel}</strong>{" "}
                                {RELATION_LABELS[rel.relationType]} → this
                              </>
                            )}
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>

                  <section className="cg-detail-section">
                    <h5 className="cg-detail-subhead">
                      Source evidence ({selectedEvidence.length})
                    </h5>
                    {selectedEvidence.length === 0 ? (
                      <p className="cg-detail-empty">
                        No source evidence found for this concept.
                      </p>
                    ) : (
                      <ul className="cg-evidence-list">
                        {selectedEvidence.map((mem) => (
                          <li key={mem.id} className="cg-evidence-item">
                            <p className="cg-evidence-content">{mem.content}</p>
                            <p className="cg-evidence-cite">
                              {mem.sourceId
                                ? `Source ${formatSourceId(mem.sourceId)}`
                                : "No source citation"}
                              {" · "}
                              {mem.observationType}
                            </p>
                          </li>
                        ))}
                      </ul>
                    )}
                  </section>
                </div>
              ) : (
                <p className="cg-detail-empty" data-testid="concept-detail-empty">
                  Select a concept to see its relationships and source evidence.
                </p>
              )}
            </aside>
          </div>
        </>
      )}

      {(relationsPresent.length > 0 || statesPresent.length > 0) && (
        <div className="cg-legends">
          {relationsPresent.length > 0 && (
            <div
              className="cg-legend"
              aria-label="Relationship types (click to toggle)"
              data-testid="concept-graph-legend"
            >
              <span className="cg-legend-caption">Relationships</span>
              {relationsPresent.map((rel) => {
                const enabled = !disabledRelations.has(rel);
                return (
                  <button
                    key={rel}
                    type="button"
                    className="cg-legend-item"
                    aria-pressed={enabled}
                    onClick={() => toggleRelation(rel)}
                  >
                    <span
                      className="cg-legend-swatch"
                      style={{ background: RELATION_COLORS[rel] }}
                      aria-hidden="true"
                    />
                    {RELATION_LABELS[rel]}
                  </button>
                );
              })}
              {view.truncation !== "complete" && (
                <span className="cg-legend-trunc">
                  View truncated ({view.truncation.replace(/_/g, " ")})
                </span>
              )}
            </div>
          )}
          {statesPresent.length > 0 && (
            <div
              className="cg-legend"
              aria-label="Node kinds (click to toggle)"
              data-testid="concept-graph-node-legend"
            >
              <span className="cg-legend-caption">Node kinds</span>
              {statesPresent.map((state) => {
                const enabled = !disabledStates.has(state);
                return (
                  <button
                    key={state}
                    type="button"
                    className="cg-legend-item"
                    aria-pressed={enabled}
                    onClick={() => toggleState(state)}
                  >
                    <span
                      className="cg-legend-dot"
                      style={{ background: STATE_COLORS[state] }}
                      aria-hidden="true"
                    />
                    {STATE_LABELS[state]}
                  </button>
                );
              })}
            </div>
          )}
        </div>
      )}

      <style nonce={cspNonce}>{CONCEPT_GRAPH_STYLES}</style>
    </div>
  );
}
