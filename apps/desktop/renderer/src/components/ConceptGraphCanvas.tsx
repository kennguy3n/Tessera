import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type PointerEvent as ReactPointerEvent,
} from "react";
import {
  findNeighborInDirection,
  type ConceptGraphEdge,
  type ConceptRelation,
  type EdgeCurve,
  type FitBox,
  type Point,
  type PositionedNode,
  type SpatialDirection,
} from "../utils/conceptGraph";
import {
  buildEdgeControlPoints,
  computeLevelOfDetail,
  computeViewTransform,
  cullNodes,
  drawConceptGraph,
  hitTestNode,
  screenToWorld,
  worldToScreen,
  type SceneEdge,
  type SceneNode,
  type SceneTheme,
} from "../utils/conceptGraphRenderer";

/**
 * High-performance Canvas 2D renderer for large concept graphs — the
 * scale-out counterpart to the panel's SVG path. The panel switches to
 * this surface once the node count crosses `CANVAS_RENDER_THRESHOLD`,
 * where per-DOM-node cost starts to drop frames.
 *
 * It is a *thin shell*: every piece of non-trivial logic (the world→screen
 * transform, viewport culling, level-of-detail, hit-testing, edge control
 * points, the imperative draw) lives in `utils/conceptGraphRenderer` and
 * is unit-tested in isolation, and it reuses the *same* pure layout/curve
 * logic from `conceptGraph.ts` as the SVG path — no forked geometry. State
 * (selection, hover, roving focus, drag, viewBox) is owned by the panel
 * and threaded in as props + stable callbacks, so both renderers share one
 * interaction model.
 *
 * Performance: per frame we cull to the visible node set, pick a
 * level-of-detail from zoom + visible density (hiding leaf labels and
 * dimming/skipping edges when zoomed out on a dense graph), and draw in
 * one immediate-mode pass. Redraws are coalesced onto a single
 * `requestAnimationFrame`. Hit-testing runs only on discrete pointer
 * events (O(n) nearest-node), never per frame.
 *
 * Accessibility: the canvas is a single `role="application"` tab stop with
 * a *virtual* roving focus (drawn as a focus ring). Arrow keys traverse
 * the graph spatially, Shift+Arrows pan, +/−/0 zoom/fit, Enter/Space
 * select, Escape clears — mirroring the SVG path — and moves are announced
 * through the panel's shared live region. Motion is the panel's settle
 * tween, which it already gates on `prefers-reduced-motion`; this surface
 * adds no animation of its own.
 */

/** Multiplier applied to nodes/edges outside the focused neighborhood. */
const DIM_ALPHA = 0.16;

/** Per-node visual style resolved by the panel (state color or decay ramp). */
export interface CanvasNodeStyle {
  /** Concrete fill color (hex / rgb — never a CSS `var()`). */
  fill: string;
  /** Base alpha before interaction dimming (decay opacity, else 1). */
  alpha: number;
  /** Radius scale (decay size ramp, else 1). */
  sizeFactor: number;
}

export interface ConceptGraphCanvasProps {
  width: number;
  height: number;
  /** Layout nodes (base positions + radii); used for hit-test + nav. */
  nodes: ReadonlyArray<PositionedNode>;
  /** Visible edges. */
  edges: ReadonlyArray<ConceptGraphEdge>;
  /** Precomputed per-edge curvature (shared with the SVG path's memo). */
  edgeCurves: Map<string, EdgeCurve>;
  /** Live world positions by id (drag/settle overrides applied). */
  renderPos: Map<string, Point>;
  viewBox: FitBox;
  baseFit: FitBox;
  selectedId: string | null;
  rovingId: string | null;
  focus: { nodeIds: ReadonlySet<string>; edgeIds: ReadonlySet<string> } | null;
  /** Highest-degree node id (the `End`-key target). */
  hubId: string | null;
  labelsAll: boolean;
  /** Resolve a node's data-driven style (state color / decay ramp). */
  styleOf: (node: PositionedNode) => CanvasNodeStyle;
  relationColorOf: (rel: ConceptRelation) => string;
  relationLabelOf: (rel: ConceptRelation) => string;
  ariaLabel: string;
  testId?: string;
  onSelect: (id: string) => void;
  onHover: (id: string | null) => void;
  onRove: (id: string) => void;
  onDragNodeTo: (id: string, world: Point) => void;
  onClearSelection: () => void;
  onExitLocal: () => void;
  applyViewBox: (box: FitBox) => void;
  zoomAround: (px: number, py: number, factor: number) => void;
  panBy: (dx: number, dy: number) => void;
  fitToView: () => void;
  announce: (message: string) => void;
}

/** Fraction of the viewBox panned per Shift+Arrow press (matches SVG path). */
const KEYBOARD_PAN_STEP = 0.12;

const ARROW_DIRECTIONS: Record<string, SpatialDirection> = {
  ArrowUp: "up",
  ArrowDown: "down",
  ArrowLeft: "left",
  ArrowRight: "right",
};

/** Read a CSS custom property off `el`, falling back to `fallback`. */
function cssVar(el: Element, name: string, fallback: string): string {
  const v = getComputedStyle(el).getPropertyValue(name).trim();
  return v || fallback;
}

export default function ConceptGraphCanvas(props: ConceptGraphCanvasProps) {
  const {
    width,
    height,
    nodes,
    edges,
    edgeCurves,
    renderPos,
    viewBox,
    baseFit,
    selectedId,
    rovingId,
    focus,
    hubId,
    labelsAll,
    styleOf,
    relationColorOf,
    relationLabelOf,
    ariaLabel,
    testId,
    onSelect,
    onHover,
    onRove,
    onDragNodeTo,
    onClearSelection,
    onExitLocal,
    applyViewBox,
    zoomAround,
    panBy,
    fitToView,
    announce,
  } = props;

  const canvasRef = useRef<HTMLCanvasElement | null>(null);
  // Measured CSS size of the canvas; drives the backing-store size and the
  // world→screen transform. Seeded from the aspect ratio so the first draw
  // is sensible before the ResizeObserver fires.
  const [cssSize, setCssSize] = useState({ width, height });

  // Live position lookup with a base-layout fallback, stable per render.
  const posOf = useCallback(
    (id: string): Point => {
      const live = renderPos.get(id);
      if (live) return live;
      const node = nodes.find((n) => n.id === id);
      return node ? { x: node.x, y: node.y } : { x: 0, y: 0 };
    },
    [renderPos, nodes],
  );

  const radiusById = useMemo(() => {
    const map = new Map<string, number>();
    for (const n of nodes) map.set(n.id, n.radius);
    return map;
  }, [nodes]);

  const maxDegree = useMemo(() => {
    const deg = new Map<string, number>();
    for (const e of edges) {
      deg.set(e.from, (deg.get(e.from) ?? 0) + 1);
      deg.set(e.to, (deg.get(e.to) ?? 0) + 1);
    }
    let m = 0;
    for (const d of deg.values()) m = Math.max(m, d);
    return { deg, max: m };
  }, [edges]);

  // ----- imperative draw (coalesced onto one rAF) -----
  const drawRef = useRef<() => void>(() => {});
  drawRef.current = () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    const dpr = window.devicePixelRatio || 1;
    const cssW = cssSize.width;
    const cssH = cssSize.height;
    const bw = Math.max(1, Math.round(cssW * dpr));
    const bh = Math.max(1, Math.round(cssH * dpr));
    if (canvas.width !== bw) canvas.width = bw;
    if (canvas.height !== bh) canvas.height = bh;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, cssW, cssH);

    const theme: SceneTheme = {
      surface: cssVar(canvas, "--color-surface", "#ffffff"),
      nodeStroke: cssVar(canvas, "--color-surface", "#ffffff"),
      selectedStroke: cssVar(canvas, "--color-text", "#111827"),
      labelFill: cssVar(canvas, "--color-text-secondary", "#4b5563"),
      focusRing: cssVar(canvas, "--focus-ring", "#7c3aed"),
    };

    const t = computeViewTransform(viewBox, cssW, cssH);

    // Cull to the visible world rect (+ generous label padding), then build
    // the LOD from zoom + visible density.
    const live = nodes.map((n) => ({ node: n, p: posOf(n.id) }));
    const visible = cullNodes(
      live.map((l) => ({ ...l.node, x: l.p.x, y: l.p.y })),
      viewBox,
      48,
    );
    const visibleIds = new Set(visible.map((n) => n.id));
    const zoom = baseFit.width > 0 ? baseFit.width / viewBox.width : 1;
    const visibleEdges = edges.filter(
      (e) => visibleIds.has(e.from) || visibleIds.has(e.to),
    );
    const lod = computeLevelOfDetail({
      zoom,
      visibleNodeCount: visible.length,
      visibleEdgeCount: visibleEdges.length,
      maxDegree: maxDegree.max,
      labelsAll,
    });

    // Edge scene (screen-space). Only build labels when LOD allows.
    const controls = buildEdgeControlPoints(
      visibleEdges,
      posOf,
      (id) => radiusById.get(id) ?? 12,
      edgeCurves,
    );
    const sceneEdges: SceneEdge[] = [];
    for (const edge of visibleEdges) {
      const cp = controls.get(edge.id);
      if (!cp) continue;
      const dim = focus && !focus.edgeIds.has(edge.id);
      const labelText = relationLabelOf(edge.relationType);
      const at = worldToScreen(cp.control, t);
      sceneEdges.push({
        id: edge.id,
        from: worldToScreen(cp.from, t),
        to: worldToScreen(cp.to, t),
        control: at,
        color: relationColorOf(edge.relationType),
        alpha: dim ? DIM_ALPHA : 1,
        label: lod.drawEdgeLabels ? { text: labelText, at } : null,
      });
    }

    // Node scene (screen-space). Label visibility follows LOD + degree, but
    // the focused neighborhood always keeps its labels.
    const sceneNodes: SceneNode[] = [];
    for (const node of visible) {
      const screen = worldToScreen({ x: node.x, y: node.y }, t);
      const style = styleOf(node);
      const dim = focus && !focus.nodeIds.has(node.id);
      const degree = maxDegree.deg.get(node.id) ?? 0;
      const labelOn =
        lod.drawAllNodeLabels ||
        (focus?.nodeIds.has(node.id) ?? false) ||
        degree >= lod.minLabelDegree;
      const label = labelOn
        ? node.label.length > 22
          ? `${node.label.slice(0, 21)}…`
          : node.label
        : null;
      sceneNodes.push({
        id: node.id,
        x: screen.x,
        y: screen.y,
        radius: Math.max(1.5, node.radius * style.sizeFactor * t.scale),
        fill: style.fill,
        alpha: style.alpha * (dim ? DIM_ALPHA : 1),
        selected: node.id === selectedId,
        focused: node.id === rovingId,
        label,
      });
    }

    drawConceptGraph(ctx, { nodes: sceneNodes, edges: sceneEdges, lod, theme });
  };

  const rafRef = useRef<number | null>(null);
  const scheduleDraw = useCallback(() => {
    if (rafRef.current !== null) return;
    if (typeof requestAnimationFrame !== "function") {
      drawRef.current();
      return;
    }
    rafRef.current = requestAnimationFrame(() => {
      rafRef.current = null;
      drawRef.current();
    });
  }, []);

  // Redraw on any input that affects the frame.
  useEffect(() => {
    scheduleDraw();
  }, [
    scheduleDraw,
    cssSize,
    nodes,
    edges,
    edgeCurves,
    renderPos,
    viewBox,
    baseFit,
    selectedId,
    rovingId,
    focus,
    labelsAll,
    styleOf,
  ]);

  useEffect(
    () => () => {
      if (rafRef.current !== null) cancelAnimationFrame(rafRef.current);
    },
    [],
  );

  // ----- track CSS size -----
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || typeof ResizeObserver === "undefined") return;
    const ro = new ResizeObserver((entries) => {
      const rect = entries[0]?.contentRect;
      if (rect && rect.width > 0 && rect.height > 0) {
        setCssSize((prev) =>
          prev.width === rect.width && prev.height === rect.height
            ? prev
            : { width: rect.width, height: rect.height },
        );
      }
    });
    ro.observe(canvas);
    return () => ro.disconnect();
  }, []);

  // ----- wheel zoom (non-passive, lifecycle tied to the element) -----
  const wheelCleanupRef = useRef<(() => void) | null>(null);
  const attachCanvas = useCallback(
    (el: HTMLCanvasElement | null) => {
      canvasRef.current = el;
      if (wheelCleanupRef.current) {
        wheelCleanupRef.current();
        wheelCleanupRef.current = null;
      }
      if (!el) return;
      const onWheel = (e: WheelEvent) => {
        e.preventDefault();
        const rect = el.getBoundingClientRect();
        if (!rect.width || !rect.height) return;
        const px = (e.clientX - rect.left) / rect.width;
        const py = (e.clientY - rect.top) / rect.height;
        const factor = Math.exp((e.deltaY > 0 ? 1 : -1) * 0.14);
        zoomAround(px, py, factor);
      };
      el.addEventListener("wheel", onWheel, { passive: false });
      wheelCleanupRef.current = () => el.removeEventListener("wheel", onWheel);
    },
    [zoomAround],
  );

  // ----- pointer interactions: pan / drag-node / hover / select -----
  const panRef = useRef<{ x: number; y: number; box: FitBox } | null>(null);
  const dragRef = useRef<{
    id: string;
    startX: number;
    startY: number;
    origin: Point;
    moved: boolean;
  } | null>(null);
  const [isPanning, setIsPanning] = useState(false);

  const clientToWorld = useCallback(
    (clientX: number, clientY: number): Point | null => {
      const el = canvasRef.current;
      if (!el) return null;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return null;
      const t = computeViewTransform(viewBox, rect.width, rect.height);
      return screenToWorld(
        { x: clientX - rect.left, y: clientY - rect.top },
        t,
      );
    },
    [viewBox],
  );

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      const world = clientToWorld(e.clientX, e.clientY);
      if (!world) return;
      const hit = hitTestNode(nodes, world, posOf);
      if (hit) {
        dragRef.current = {
          id: hit,
          startX: e.clientX,
          startY: e.clientY,
          origin: posOf(hit),
          moved: false,
        };
      } else {
        panRef.current = { x: e.clientX, y: e.clientY, box: viewBox };
        setIsPanning(true);
      }
      canvasRef.current?.setPointerCapture(e.pointerId);
    },
    [clientToWorld, nodes, posOf, viewBox],
  );

  const onPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      const el = canvasRef.current;
      if (!el) return;
      const rect = el.getBoundingClientRect();
      if (!rect.width || !rect.height) return;

      const drag = dragRef.current;
      if (drag) {
        const t = computeViewTransform(viewBox, rect.width, rect.height);
        const dxWorld = (e.clientX - drag.startX) / t.scale;
        const dyWorld = (e.clientY - drag.startY) / t.scale;
        if (
          !drag.moved &&
          Math.hypot(e.clientX - drag.startX, e.clientY - drag.startY) > 3
        ) {
          drag.moved = true;
        }
        onDragNodeTo(drag.id, {
          x: drag.origin.x + dxWorld,
          y: drag.origin.y + dyWorld,
        });
        return;
      }

      const pan = panRef.current;
      if (pan) {
        const dxWorld = ((e.clientX - pan.x) / rect.width) * pan.box.width;
        const dyWorld = ((e.clientY - pan.y) / rect.height) * pan.box.height;
        applyViewBox({
          x: pan.box.x - dxWorld,
          y: pan.box.y - dyWorld,
          width: pan.box.width,
          height: pan.box.height,
        });
        return;
      }

      // Idle move → hover hit-test.
      const world = clientToWorld(e.clientX, e.clientY);
      onHover(world ? hitTestNode(nodes, world, posOf) : null);
    },
    [viewBox, onDragNodeTo, applyViewBox, clientToWorld, onHover, nodes, posOf],
  );

  const endPointer = useCallback(
    (e: ReactPointerEvent<HTMLCanvasElement>) => {
      const drag = dragRef.current;
      panRef.current = null;
      dragRef.current = null;
      setIsPanning(false);
      if (canvasRef.current?.hasPointerCapture(e.pointerId)) {
        canvasRef.current.releasePointerCapture(e.pointerId);
      }
      // A tap that didn't drift past the drag threshold selects the node.
      if (drag && !drag.moved) {
        onSelect(drag.id);
        onRove(drag.id);
      }
    },
    [onSelect, onRove],
  );

  const onPointerLeave = useCallback(() => {
    if (!dragRef.current && !panRef.current) onHover(null);
  }, [onHover]);

  // ----- keyboard navigation (virtual roving focus) -----
  const announceNode = useCallback(
    (id: string) => {
      const node = nodes.find((n) => n.id === id);
      if (!node) return;
      const c = node.connectionsCount;
      announce(`${node.label}, ${c} connection${c === 1 ? "" : "s"}`);
    },
    [nodes, announce],
  );

  const moveRoving = useCallback(
    (id: string | null) => {
      if (!id) return;
      onRove(id);
      announceNode(id);
    },
    [onRove, announceNode],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLCanvasElement>) => {
      const direction = ARROW_DIRECTIONS[e.key];
      if (direction) {
        e.preventDefault();
        if (e.shiftKey) {
          // Shift+Arrow pans the canvas.
          const vb = viewBox;
          if (direction === "up") panBy(0, -vb.height * KEYBOARD_PAN_STEP);
          else if (direction === "down") panBy(0, vb.height * KEYBOARD_PAN_STEP);
          else if (direction === "left") panBy(-vb.width * KEYBOARD_PAN_STEP, 0);
          else panBy(vb.width * KEYBOARD_PAN_STEP, 0);
          return;
        }
        // Plain Arrow traverses the graph spatially.
        if (!rovingId) {
          moveRoving(nodes[0]?.id ?? null);
          return;
        }
        const next = findNeighborInDirection(nodes, rovingId, direction);
        if (next) moveRoving(next);
        return;
      }
      switch (e.key) {
        case "Enter":
        case " ":
          e.preventDefault();
          if (rovingId) {
            onSelect(rovingId);
            onRove(rovingId);
          }
          return;
        case "Home":
          e.preventDefault();
          moveRoving(nodes[0]?.id ?? null);
          return;
        case "End":
          e.preventDefault();
          moveRoving(hubId);
          return;
        case "Escape":
          e.preventDefault();
          if (selectedId) onClearSelection();
          else onExitLocal();
          return;
        case "+":
        case "=":
          e.preventDefault();
          zoomAround(0.5, 0.5, 0.8);
          return;
        case "-":
        case "_":
          e.preventDefault();
          zoomAround(0.5, 0.5, 1 / 0.8);
          return;
        case "0":
        case "f":
        case "F":
          e.preventDefault();
          fitToView();
          return;
      }
    },
    [
      viewBox,
      rovingId,
      nodes,
      hubId,
      selectedId,
      panBy,
      moveRoving,
      onSelect,
      onRove,
      onClearSelection,
      onExitLocal,
      zoomAround,
      fitToView,
    ],
  );

  return (
    <canvas
      ref={attachCanvas}
      className={`cg-canvas cg-canvas-gl${isPanning ? " cg-panning" : ""}`}
      role="application"
      aria-roledescription="Concept graph canvas"
      aria-label={ariaLabel}
      tabIndex={0}
      data-testid={testId ?? "concept-graph-canvas"}
      style={{ aspectRatio: `${width} / ${height}`, width: "100%", touchAction: "none" }}
      onPointerDown={onPointerDown}
      onPointerMove={onPointerMove}
      onPointerUp={endPointer}
      onPointerCancel={endPointer}
      onPointerLeave={onPointerLeave}
      onKeyDown={onKeyDown}
    />
  );
}
