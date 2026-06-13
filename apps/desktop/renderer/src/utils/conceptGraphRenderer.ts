/**
 * Renderer-agnostic geometry + draw helpers for the concept graph's
 * high-performance Canvas 2D path.
 *
 * The SVG renderer (`ConceptGraphPanel`) is ideal for small graphs — it
 * gets real DOM nodes (one tab stop per concept), CSS transitions, and
 * crisp vectors for free. It does not scale: every node/edge is a live
 * DOM subtree, so layout/paint cost grows with the graph and pan/zoom
 * stutters well before a few hundred nodes. For large graphs we switch
 * to a single `<canvas>` that redraws an immediate-mode scene each frame.
 *
 * Everything in this module is **pure** and free of the DOM, React, and
 * the `window.tessera` bridge, so the non-trivial bits — the world↔screen
 * transform, viewport culling, level-of-detail thresholds, and
 * hit-testing — are unit-testable in isolation and shared by the canvas
 * component (which stays a thin imperative shell). The single imperative
 * function, {@link drawConceptGraph}, takes its
 * `CanvasRenderingContext2D` as a parameter so it can be exercised in
 * tests with a recording stub context.
 *
 * It reuses the existing pure layout/curve logic from `conceptGraph.ts`
 * (radius, positions, quadratic edge control points) rather than forking
 * it — the layout is renderer-agnostic by design.
 */

import {
  compareCodepoint,
  computeEdgeCurves,
  quadraticControlPoint,
  type ConceptGraphEdge,
  type EdgeCurve,
  type FitBox,
  type Point,
  type PositionedNode,
} from "./conceptGraph";

/**
 * Node count at/above which the panel switches from the SVG renderer to
 * the Canvas renderer. Chosen empirically: below this the per-node DOM
 * cost is negligible and the SVG path's native a11y / CSS transitions are
 * worth keeping; above it, DOM node/edge count starts to cost real
 * layout/paint time and pan/zoom frames drop, so the immediate-mode
 * canvas (which culls + applies level-of-detail) wins. Exposed so the
 * component and its tests agree on one source of truth.
 */
export const CANVAS_RENDER_THRESHOLD = 220;

/**
 * Affine world→screen transform for a "meet"-style fit (uniform scale,
 * centered) — the canvas analogue of SVG's default
 * `preserveAspectRatio="xMidYMid meet"`. A single uniform `scale` keeps
 * circles round regardless of the canvas/viewBox aspect mismatch; the
 * content is centered in whichever axis has slack.
 */
export interface ViewTransform {
  /** World-units → CSS-pixels scale factor (uniform on both axes). */
  scale: number;
  /** CSS-pixel x of world-origin (0,0) after centering. */
  offsetX: number;
  /** CSS-pixel y of world-origin (0,0) after centering. */
  offsetY: number;
}

/**
 * Build the {@link ViewTransform} mapping the world-space `box` (the
 * current viewBox) into a CSS-pixel canvas of `cssWidth`×`cssHeight`.
 * Mirrors SVG `meet` semantics so the canvas frames the graph identically
 * to the SVG path: the larger axis is letterboxed, never stretched.
 * Degenerate inputs (zero/negative size) collapse to scale 1 so the
 * result is always finite.
 */
export function computeViewTransform(
  box: FitBox,
  cssWidth: number,
  cssHeight: number,
): ViewTransform {
  const safeW = box.width > 0 ? box.width : 1;
  const safeH = box.height > 0 ? box.height : 1;
  const scale =
    cssWidth > 0 && cssHeight > 0
      ? Math.min(cssWidth / safeW, cssHeight / safeH)
      : 1;
  const contentW = safeW * scale;
  const contentH = safeH * scale;
  const marginX = (cssWidth - contentW) / 2;
  const marginY = (cssHeight - contentH) / 2;
  return {
    scale,
    offsetX: marginX - box.x * scale,
    offsetY: marginY - box.y * scale,
  };
}

/** Map a world-space point to CSS-pixel canvas coordinates. */
export function worldToScreen(p: Point, t: ViewTransform): Point {
  return { x: p.x * t.scale + t.offsetX, y: p.y * t.scale + t.offsetY };
}

/** Inverse of {@link worldToScreen}: CSS-pixel → world. */
export function screenToWorld(p: Point, t: ViewTransform): Point {
  return { x: (p.x - t.offsetX) / t.scale, y: (p.y - t.offsetY) / t.scale };
}

/**
 * Whether a node's circle (plus its label allowance) intersects the
 * world-space `box`. Used to cull offscreen nodes before drawing so
 * per-frame work scales with what's *visible*, not the whole graph — the
 * crux of staying at 60fps when zoomed in on a large graph.
 */
export function isNodeVisible(
  node: { x: number; y: number; radius: number },
  box: FitBox,
  pad = 0,
): boolean {
  const r = node.radius + pad;
  return (
    node.x + r >= box.x &&
    node.x - r <= box.x + box.width &&
    node.y + r >= box.y &&
    node.y - r <= box.y + box.height
  );
}

/**
 * Filter `nodes` to those visible within `box` (see {@link isNodeVisible}).
 * `pad` (world units) keeps nodes whose center is just offscreen but whose
 * body/label still pokes in. Preserves input order.
 */
export function cullNodes<T extends { x: number; y: number; radius: number }>(
  nodes: ReadonlyArray<T>,
  box: FitBox,
  pad = 24,
): T[] {
  const out: T[] = [];
  for (const n of nodes) if (isNodeVisible(n, box, pad)) out.push(n);
  return out;
}

/**
 * Level-of-detail decision for one frame. Driven by zoom (1 = fit) and
 * the visible node/edge counts: when zoomed out on a dense graph we hide
 * labels and dim/skip edges so the frame stays cheap and legible; zooming
 * in progressively re-enables detail. Pure so the thresholds are
 * unit-tested and identical between the SVG and canvas paths.
 */
export interface LevelOfDetail {
  /** Whether to stroke edges at all (skipped entirely when far out + dense). */
  drawEdges: boolean;
  /** Global alpha applied to every edge (dims edges as you zoom out). */
  edgeAlpha: number;
  /** Whether to draw node labels for *every* visible node. */
  drawAllNodeLabels: boolean;
  /**
   * When `drawAllNodeLabels` is false, only label nodes whose visible
   * degree is at least this — so the densest hubs stay labelled even when
   * leaf labels are suppressed.
   */
  minLabelDegree: number;
  /** Whether to draw edge-relation labels (only when sparse + zoomed in). */
  drawEdgeLabels: boolean;
}

export interface LevelOfDetailInput {
  /** Current zoom (baseFit.width / viewBox.width); 1 = fit-to-view. */
  zoom: number;
  /** Number of nodes currently visible (post-cull). */
  visibleNodeCount: number;
  /** Number of edges currently visible (post-cull). */
  visibleEdgeCount: number;
  /** Max visible degree, for the hub-label threshold. */
  maxDegree: number;
  /** User override: "show every label regardless of zoom/density". */
  labelsAll: boolean;
}

/** Above this many visible edges we start fading edges when zoomed out. */
const EDGE_DIM_COUNT = 400;
/** Above this many visible edges, far-out frames skip edges entirely. */
const EDGE_SKIP_COUNT = 1500;
/** Visible-node count below which every label is drawn at fit zoom. */
const LABEL_ALL_NODE_COUNT = 80;
/** Zoom at/above which all labels are shown regardless of node count. */
const LABEL_ALL_ZOOM = 1.6;
/** Edge-label wholesale ceiling (visible edges) when zoomed in. */
const EDGE_LABEL_COUNT = 30;

export function computeLevelOfDetail(input: LevelOfDetailInput): LevelOfDetail {
  const { zoom, visibleNodeCount, visibleEdgeCount, maxDegree, labelsAll } =
    input;

  // Edges: always drawn when sparse; when dense, dim them as you zoom out
  // and skip them entirely when both very dense and far out.
  const dense = visibleEdgeCount > EDGE_DIM_COUNT;
  const veryDense = visibleEdgeCount > EDGE_SKIP_COUNT;
  const drawEdges = !(veryDense && zoom < 0.6);
  let edgeAlpha = 0.7;
  if (dense) {
    // Fade from ~0.18 (far out) to 0.7 (zoomed in) across zoom 0.4..1.4.
    const t = Math.min(1, Math.max(0, (zoom - 0.4) / 1.0));
    edgeAlpha = 0.18 + t * (0.7 - 0.18);
  }

  const drawAllNodeLabels =
    labelsAll ||
    zoom >= LABEL_ALL_ZOOM ||
    (visibleNodeCount <= LABEL_ALL_NODE_COUNT && zoom >= 1);

  // When not showing all labels, label only the higher-degree hubs; the
  // threshold relaxes as you zoom in so more labels appear progressively.
  const degreeFloor = Math.max(1, Math.ceil(maxDegree * 0.5));
  const zoomRelief = Math.floor(zoom * 2);
  const minLabelDegree = Math.max(1, degreeFloor - zoomRelief);

  const drawEdgeLabels =
    !veryDense && visibleEdgeCount <= EDGE_LABEL_COUNT && zoom >= 1.1;

  return {
    drawEdges,
    edgeAlpha,
    drawAllNodeLabels,
    minLabelDegree,
    drawEdgeLabels,
  };
}

/**
 * Nearest node whose body contains `world` (a world-space point), or
 * `null` when the point hits empty canvas. `posOf`, when supplied, returns
 * the *live* render position of a node id (drag/settle override) so
 * hit-testing matches what the user sees mid-drag. A small `slop` (world
 * units) widens the target for easier grabbing, mirroring the SVG path's
 * transparent hit-halo. O(n) per call — trivial even at the node ceiling,
 * and called only on discrete pointer events (never per frame).
 */
export function hitTestNode(
  nodes: ReadonlyArray<PositionedNode>,
  world: Point,
  posOf?: (id: string) => Point | undefined,
  slop = 6,
): string | null {
  let best: string | null = null;
  let bestDist = Infinity;
  for (const node of nodes) {
    const pos = posOf?.(node.id) ?? { x: node.x, y: node.y };
    const dx = world.x - pos.x;
    const dy = world.y - pos.y;
    const dist = Math.hypot(dx, dy);
    const reach = node.radius + slop;
    if (dist <= reach && dist < bestDist) {
      bestDist = dist;
      best = node.id;
    }
  }
  return best;
}

/** A node ready to draw: live position, radius, fill, alpha, decoration. */
export interface SceneNode {
  id: string;
  x: number;
  y: number;
  radius: number;
  /** Fill color (CSS string already resolved by the component/theme). */
  fill: string;
  /** 0..1 alpha for decay/dim encoding. */
  alpha: number;
  /** Whether to draw the selected stroke (thick contrast outline). */
  selected: boolean;
  /** Whether to draw the keyboard-focus ring (dashed). */
  focused: boolean;
  /** Label text (already truncated), or null to suppress. */
  label: string | null;
}

/** An edge ready to draw: live endpoints + a quadratic control point. */
export interface SceneEdge {
  id: string;
  from: Point;
  to: Point;
  control: Point;
  color: string;
  /**
   * Per-edge alpha multiplier (default 1), composed with the LOD's global
   * `edgeAlpha`. Used to dim edges not incident to the focused node while
   * keeping the focused neighborhood prominent.
   */
  alpha?: number;
  /** Label text + anchor, or null to suppress (LOD/collision). */
  label: { text: string; at: Point } | null;
}

/** Theme-resolved colors the imperative draw needs. */
export interface SceneTheme {
  /** Background fill (also the label halo color). */
  surface: string;
  /** Stroke around an unselected node dot. */
  nodeStroke: string;
  /** Stroke around a selected node dot. */
  selectedStroke: string;
  /** Label text fill. */
  labelFill: string;
  /** Keyboard focus-ring color. */
  focusRing: string;
}

export interface ConceptGraphScene {
  nodes: SceneNode[];
  edges: SceneEdge[];
  lod: LevelOfDetail;
  theme: SceneTheme;
}

/**
 * Build the world-space quadratic control point for every edge, reusing
 * the canonical (id-ordered) endpoint basis from `conceptGraph.ts` so
 * parallel/reciprocal edges fan apart exactly as in the SVG path. `posOf`
 * supplies live (dragged/settled) endpoint positions. Self-loops get a
 * control point above the node so they read as a small arc. Returns a map
 * keyed by edge id for O(1) lookup while assembling the scene.
 */
export function buildEdgeControlPoints(
  edges: ReadonlyArray<ConceptGraphEdge>,
  posOf: (id: string) => Point,
  radiusOf: (id: string) => number,
  curves: Map<string, EdgeCurve> = computeEdgeCurves(edges),
  compareId: (a: string, b: string) => number = compareCodepoint,
): Map<string, { from: Point; to: Point; control: Point }> {
  const out = new Map<string, { from: Point; to: Point; control: Point }>();
  for (const edge of edges) {
    const from = posOf(edge.from);
    const to = posOf(edge.to);
    const curve = curves.get(edge.id);
    if (curve?.selfLoop) {
      const r = radiusOf(edge.from);
      const loopR = r + 10 + curve.loopIndex * 7;
      out.set(edge.id, {
        from,
        to,
        // A control point well above the node makes the quadratic bulge
        // upward into a readable little loop.
        control: { x: from.x, y: from.y - r - loopR * 1.8 },
      });
      continue;
    }
    const swap = compareId(edge.from, edge.to) > 0;
    const canonFrom = swap ? to : from;
    const canonTo = swap ? from : to;
    out.set(edge.id, {
      from,
      to,
      control: quadraticControlPoint(canonFrom, canonTo, curve?.offset ?? 0),
    });
  }
  return out;
}

/**
 * Draw a fully-assembled {@link ConceptGraphScene} into `ctx`. The caller
 * is responsible for sizing the backing store for device-pixel-ratio,
 * clearing the frame, and applying the world→screen transform *before*
 * calling this (so all scene coordinates here are already in the
 * transformed space and line widths are in screen px). Edges are stroked
 * first (so nodes sit on top), then node dots, then labels last (so text
 * is never occluded). Self-loops and curves use the precomputed control
 * points. Pure aside from the `ctx` mutations it is asked to perform,
 * which lets a recording stub assert the draw in tests.
 */
export function drawConceptGraph(
  ctx: CanvasRenderingContext2D,
  scene: ConceptGraphScene,
): void {
  const { nodes, edges, lod, theme } = scene;

  if (lod.drawEdges) {
    ctx.save();
    ctx.lineWidth = 1.5;
    for (const edge of edges) {
      ctx.globalAlpha = lod.edgeAlpha * (edge.alpha ?? 1);
      ctx.beginPath();
      ctx.moveTo(edge.from.x, edge.from.y);
      ctx.quadraticCurveTo(
        edge.control.x,
        edge.control.y,
        edge.to.x,
        edge.to.y,
      );
      ctx.strokeStyle = edge.color;
      ctx.stroke();
    }
    ctx.restore();
  }

  // Node dots (with selected stroke / focus ring).
  for (const node of nodes) {
    ctx.save();
    ctx.globalAlpha = node.alpha;
    ctx.beginPath();
    ctx.arc(node.x, node.y, node.radius, 0, Math.PI * 2);
    ctx.fillStyle = node.fill;
    ctx.fill();
    ctx.lineWidth = node.selected ? 3 : 1.5;
    ctx.strokeStyle = node.selected ? theme.selectedStroke : theme.nodeStroke;
    ctx.stroke();
    ctx.restore();

    if (node.focused) {
      ctx.save();
      ctx.beginPath();
      ctx.arc(node.x, node.y, node.radius + 5, 0, Math.PI * 2);
      ctx.lineWidth = 2.5;
      ctx.strokeStyle = theme.focusRing;
      ctx.setLineDash([3, 2.5]);
      ctx.stroke();
      ctx.restore();
    }
  }

  // Edge labels (sparse + zoomed in only).
  if (lod.drawEdgeLabels) {
    ctx.save();
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.font = "9px system-ui, sans-serif";
    ctx.lineWidth = 3;
    ctx.lineJoin = "round";
    ctx.strokeStyle = theme.surface;
    for (const edge of edges) {
      if (!edge.label) continue;
      ctx.strokeText(edge.label.text, edge.label.at.x, edge.label.at.y);
      ctx.fillStyle = edge.color;
      ctx.fillText(edge.label.text, edge.label.at.x, edge.label.at.y);
    }
    ctx.restore();
  }

  // Node labels last so text is never occluded by later dots/edges.
  ctx.save();
  ctx.textAlign = "center";
  ctx.textBaseline = "top";
  ctx.font = "11px system-ui, sans-serif";
  ctx.lineWidth = 3;
  ctx.lineJoin = "round";
  for (const node of nodes) {
    if (!node.label) continue;
    const ty = node.y + node.radius + 3;
    ctx.strokeStyle = theme.surface;
    ctx.strokeText(node.label, node.x, ty);
    ctx.fillStyle = theme.labelFill;
    ctx.fillText(node.label, node.x, ty);
  }
  ctx.restore();
}
