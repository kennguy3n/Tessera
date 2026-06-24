import { describe, it, expect } from "vitest";
import {
  CANVAS_RENDER_THRESHOLD,
  computeViewTransform,
  worldToScreen,
  screenToWorld,
  isNodeVisible,
  cullNodes,
  computeLevelOfDetail,
  hitTestNode,
  buildEdgeControlPoints,
  drawConceptGraph,
  type ConceptGraphScene,
  type SceneTheme,
} from "../utils/conceptGraphRenderer";
import type {
  ConceptGraphEdge,
  FitBox,
  PositionedNode,
} from "../utils/conceptGraph";

const BOX: FitBox = { x: 0, y: 0, width: 100, height: 100 };

function node(id: string, x: number, y: number, radius = 8): PositionedNode {
  return {
    id,
    label: id,
    state: "candidate",
    scopeId: "s",
    connectionsCount: 0,
    x,
    y,
    radius,
  };
}

describe("computeViewTransform / worldToScreen / screenToWorld", () => {
  it("maps a square box onto a square canvas 1:1 and round-trips", () => {
    const t = computeViewTransform(BOX, 100, 100);
    expect(t.scale).toBe(1);
    expect(worldToScreen({ x: 50, y: 50 }, t)).toEqual({ x: 50, y: 50 });
    const rt = screenToWorld(worldToScreen({ x: 12, y: 34 }, t), t);
    expect(rt.x).toBeCloseTo(12, 9);
    expect(rt.y).toBeCloseTo(34, 9);
  });

  it("uses a uniform scale and centers on the slack axis (meet semantics)", () => {
    // 100x100 world into a 200x100 canvas: scale = min(2, 1) = 1, centered x.
    const t = computeViewTransform(BOX, 200, 100);
    expect(t.scale).toBe(1);
    // World x=0 lands at the left letterbox margin = (200-100)/2 = 50.
    expect(worldToScreen({ x: 0, y: 0 }, t)).toEqual({ x: 50, y: 0 });
    expect(worldToScreen({ x: 100, y: 100 }, t)).toEqual({ x: 150, y: 100 });
  });

  it("scales up when the canvas is larger than the box", () => {
    const t = computeViewTransform(BOX, 300, 300);
    expect(t.scale).toBe(3);
    expect(worldToScreen({ x: 50, y: 50 }, t)).toEqual({ x: 150, y: 150 });
  });

  it("never returns a non-finite transform for degenerate inputs", () => {
    const t = computeViewTransform({ x: 0, y: 0, width: 0, height: 0 }, 0, 0);
    expect(Number.isFinite(t.scale)).toBe(true);
    expect(Number.isFinite(t.offsetX)).toBe(true);
    expect(Number.isFinite(t.offsetY)).toBe(true);
  });
});

describe("isNodeVisible / cullNodes", () => {
  it("keeps nodes inside the box and drops far-offscreen ones", () => {
    expect(isNodeVisible(node("a", 50, 50), BOX)).toBe(true);
    expect(isNodeVisible(node("b", 500, 500), BOX)).toBe(false);
  });

  it("keeps a node whose body straddles the edge", () => {
    // center just outside but radius reaches in.
    expect(isNodeVisible(node("c", 104, 50, 8), BOX, 0)).toBe(true);
    expect(isNodeVisible(node("c", 120, 50, 8), BOX, 0)).toBe(false);
  });

  it("cullNodes preserves input order and respects padding", () => {
    const nodes = [
      node("in", 10, 10),
      node("edge", 110, 50, 4),
      node("far", 400, 400),
    ];
    const visible = cullNodes(nodes, BOX, 24);
    expect(visible.map((n) => n.id)).toEqual(["in", "edge"]);
  });
});

describe("computeLevelOfDetail", () => {
  it("shows all labels for a small graph at fit zoom", () => {
    const lod = computeLevelOfDetail({
      zoom: 1,
      visibleNodeCount: 20,
      visibleEdgeCount: 15,
      maxDegree: 4,
      labelsAll: false,
    });
    expect(lod.drawAllNodeLabels).toBe(true);
    expect(lod.drawEdges).toBe(true);
  });

  it("hides leaf labels but keeps hubs on a large graph zoomed out", () => {
    const lod = computeLevelOfDetail({
      zoom: 0.5,
      visibleNodeCount: 2000,
      visibleEdgeCount: 3000,
      maxDegree: 40,
      labelsAll: false,
    });
    expect(lod.drawAllNodeLabels).toBe(false);
    expect(lod.minLabelDegree).toBeGreaterThan(1);
  });

  it("dims edges as you zoom out on a dense graph", () => {
    const far = computeLevelOfDetail({
      zoom: 0.4,
      visibleNodeCount: 1000,
      visibleEdgeCount: 800,
      maxDegree: 20,
      labelsAll: false,
    });
    const near = computeLevelOfDetail({
      zoom: 1.4,
      visibleNodeCount: 1000,
      visibleEdgeCount: 800,
      maxDegree: 20,
      labelsAll: false,
    });
    expect(far.edgeAlpha).toBeLessThan(near.edgeAlpha);
  });

  it("skips edges entirely when very dense and far out", () => {
    const lod = computeLevelOfDetail({
      zoom: 0.4,
      visibleNodeCount: 4000,
      visibleEdgeCount: 5000,
      maxDegree: 60,
      labelsAll: false,
    });
    expect(lod.drawEdges).toBe(false);
  });

  it("honors the labelsAll override regardless of zoom/density", () => {
    const lod = computeLevelOfDetail({
      zoom: 0.2,
      visibleNodeCount: 5000,
      visibleEdgeCount: 6000,
      maxDegree: 80,
      labelsAll: true,
    });
    expect(lod.drawAllNodeLabels).toBe(true);
  });

  it("only shows edge labels when sparse and zoomed in", () => {
    expect(
      computeLevelOfDetail({
        zoom: 1.3,
        visibleNodeCount: 10,
        visibleEdgeCount: 8,
        maxDegree: 3,
        labelsAll: false,
      }).drawEdgeLabels,
    ).toBe(true);
    expect(
      computeLevelOfDetail({
        zoom: 1.3,
        visibleNodeCount: 200,
        visibleEdgeCount: 200,
        maxDegree: 10,
        labelsAll: false,
      }).drawEdgeLabels,
    ).toBe(false);
  });
});

describe("hitTestNode", () => {
  const nodes = [node("a", 10, 10, 8), node("b", 50, 50, 12)];

  it("returns the node whose body contains the point", () => {
    expect(hitTestNode(nodes, { x: 12, y: 11 })).toBe("a");
    expect(hitTestNode(nodes, { x: 52, y: 49 })).toBe("b");
  });

  it("returns null on empty canvas", () => {
    expect(hitTestNode(nodes, { x: 200, y: 200 })).toBeNull();
  });

  it("prefers the nearest center when targets overlap", () => {
    const overlapping = [node("big", 50, 50, 30), node("small", 55, 50, 6)];
    // Point inside both — nearest center (small at 55) wins.
    expect(hitTestNode(overlapping, { x: 55, y: 50 })).toBe("small");
  });

  it("uses the live position override when supplied", () => {
    const override = new Map([["a", { x: 100, y: 100 }]]);
    // 'a' has been dragged to (100,100); a hit there resolves to 'a'.
    expect(
      hitTestNode(nodes, { x: 101, y: 100 }, (id) => override.get(id)),
    ).toBe("a");
    // Its old spot no longer hits 'a'.
    expect(
      hitTestNode(nodes, { x: 10, y: 10 }, (id) => override.get(id)),
    ).toBeNull();
  });
});

describe("buildEdgeControlPoints", () => {
  const posOf = (id: string): { x: number; y: number } =>
    id === "a" ? { x: 0, y: 0 } : { x: 100, y: 0 };
  const radiusOf = (): number => 8;

  it("produces a straight-ish control point for a lone edge", () => {
    const edges: ConceptGraphEdge[] = [
      { id: "e", from: "a", to: "b", relationType: "is_a", scopeId: "s" },
    ];
    const cps = buildEdgeControlPoints(edges, posOf, radiusOf);
    const cp = cps.get("e");
    expect(cp).toBeDefined();
    // Endpoints preserved.
    expect(cp?.from).toEqual({ x: 0, y: 0 });
    expect(cp?.to).toEqual({ x: 100, y: 0 });
  });

  it("fans reciprocal edges to opposite sides of the midline", () => {
    const edges: ConceptGraphEdge[] = [
      { id: "ab", from: "a", to: "b", relationType: "is_a", scopeId: "s" },
      { id: "ba", from: "b", to: "a", relationType: "is_a", scopeId: "s" },
    ];
    const cps = buildEdgeControlPoints(edges, posOf, radiusOf);
    const ab = cps.get("ab");
    const ba = cps.get("ba");
    expect(ab).toBeDefined();
    expect(ba).toBeDefined();
    // Both bow off the y=0 midline, on opposite sides.
    expect(Math.sign((ab as { control: { y: number } }).control.y)).not.toBe(
      Math.sign((ba as { control: { y: number } }).control.y),
    );
  });

  it("places a self-loop control point above the node", () => {
    const edges: ConceptGraphEdge[] = [
      { id: "loop", from: "a", to: "a", relationType: "is_a", scopeId: "s" },
    ];
    const cps = buildEdgeControlPoints(edges, posOf, radiusOf);
    const loop = cps.get("loop");
    expect(loop?.control.y).toBeLessThan(0);
  });
});

const THEME: SceneTheme = {
  surface: "#fff",
  nodeStroke: "#000",
  selectedStroke: "#111",
  labelFill: "#222",
  focusRing: "#7c3aed",
};

/** Minimal recording 2D context for asserting the draw path. */
function recordingCtx() {
  const calls: Record<string, number> = {};
  const bump = (k: string) => {
    calls[k] = (calls[k] ?? 0) + 1;
  };
  const ctx = {
    calls,
    globalAlpha: 1,
    lineWidth: 1,
    strokeStyle: "",
    fillStyle: "",
    font: "",
    textAlign: "",
    textBaseline: "",
    lineJoin: "",
    save: () => bump("save"),
    restore: () => bump("restore"),
    beginPath: () => bump("beginPath"),
    moveTo: () => bump("moveTo"),
    quadraticCurveTo: () => bump("quadraticCurveTo"),
    arc: () => bump("arc"),
    fill: () => bump("fill"),
    stroke: () => bump("stroke"),
    fillText: () => bump("fillText"),
    strokeText: () => bump("strokeText"),
    setLineDash: () => bump("setLineDash"),
  };
  return ctx as unknown as CanvasRenderingContext2D & {
    calls: Record<string, number>;
  };
}

describe("drawConceptGraph", () => {
  const scene: ConceptGraphScene = {
    nodes: [
      {
        id: "a",
        x: 10,
        y: 10,
        radius: 8,
        fill: "#abc",
        alpha: 1,
        selected: true,
        focused: true,
        label: "A",
      },
      {
        id: "b",
        x: 50,
        y: 50,
        radius: 6,
        fill: "#def",
        alpha: 0.5,
        selected: false,
        focused: false,
        label: null,
      },
    ],
    edges: [
      {
        id: "e",
        from: { x: 10, y: 10 },
        to: { x: 50, y: 50 },
        control: { x: 30, y: 20 },
        color: "#999",
        label: { text: "is a", at: { x: 30, y: 30 } },
      },
    ],
    lod: {
      drawEdges: true,
      edgeAlpha: 0.7,
      drawAllNodeLabels: true,
      minLabelDegree: 1,
      drawEdgeLabels: true,
    },
    theme: THEME,
  };

  it("strokes one arc per node and one curve per edge", () => {
    const ctx = recordingCtx();
    drawConceptGraph(ctx, scene);
    expect(ctx.calls.arc).toBeGreaterThanOrEqual(2); // 2 node dots
    expect(ctx.calls.quadraticCurveTo).toBe(1); // 1 edge
  });

  it("draws the focus ring (dashed) only for the focused node", () => {
    const ctx = recordingCtx();
    drawConceptGraph(ctx, scene);
    // One node is focused → exactly one setLineDash call for its ring.
    expect(ctx.calls.setLineDash).toBe(1);
  });

  it("draws labels only for nodes with a non-null label", () => {
    const ctx = recordingCtx();
    drawConceptGraph(ctx, scene);
    // Node 'A' has a label, node 'b' is null → 1 node label fill (+1 edge label).
    // Edge label + 1 node label = 2 fillText.
    expect(ctx.calls.fillText).toBe(2);
  });

  it("skips edges entirely when LOD says not to draw them", () => {
    const ctx = recordingCtx();
    drawConceptGraph(ctx, {
      ...scene,
      lod: { ...scene.lod, drawEdges: false, drawEdgeLabels: false },
    });
    expect(ctx.calls.quadraticCurveTo ?? 0).toBe(0);
  });
});

describe("CANVAS_RENDER_THRESHOLD", () => {
  it("is a sensible positive integer", () => {
    expect(CANVAS_RENDER_THRESHOLD).toBeGreaterThan(0);
    expect(Number.isInteger(CANVAS_RENDER_THRESHOLD)).toBe(true);
  });
});
