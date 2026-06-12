import { describe, it, expect } from "vitest";
import {
  parseConceptGraph,
  computeRadialLayout,
  computeForceLayout,
  adaptiveIterations,
  computeFitBox,
  computeDegrees,
  buildAdjacency,
  incidentTo,
  localGraphView,
  filterGraphView,
  RELATION_LABELS,
  type ConceptGraphView,
} from "../utils/conceptGraph";

/**
 * A small mixed graph reused by the interaction-utility suites below: a
 * 4-relation chain (a→b→c→d) plus a side branch (b→e) and a contradicting
 * edge (d⇢a). States span canonical / candidate / superseded / contradicted
 * so node-kind filtering has something to bite on.
 */
function sampleGraph(): ConceptGraphView {
  return parseConceptGraph(
    JSON.stringify({
      nodes: [
        { id: "a", label: "Atlas", state: "canonical", scope_id: "s1", connections_count: 2 },
        { id: "b", label: "Beacon", state: "candidate", scope_id: "s1", connections_count: 3 },
        { id: "c", label: "Cosmos", state: "candidate", scope_id: "s1", connections_count: 2 },
        { id: "d", label: "Delta", state: "superseded", scope_id: "s1", connections_count: 2 },
        { id: "e", label: "Echo", state: "contradicted", scope_id: "s1", connections_count: 1 },
      ],
      edges: [
        { id: "ab", from: "a", to: "b", relation_type: "is_a", scope_id: "s1" },
        { id: "bc", from: "b", to: "c", relation_type: "part_of", scope_id: "s1" },
        { id: "cd", from: "c", to: "d", relation_type: "supersedes", scope_id: "s1" },
        { id: "be", from: "b", to: "e", relation_type: "part_of", scope_id: "s1" },
        { id: "da", from: "d", to: "a", relation_type: "contradicts", scope_id: "s1" },
      ],
      scope_filter: [],
      depth: 2,
      truncation: "complete",
    }),
  );
}

/**
 * Unit + snapshot coverage for the concept-graph parse/layout utility.
 * These are the non-trivial, React-free core of the Knowledge Graph
 * surface: defensive parsing of the untrusted JSON string the substrate
 * returns, and a deterministic radial layout that both the SVG renderer
 * and the snapshot below depend on being byte-stable.
 */

describe("parseConceptGraph", () => {
  it("returns an empty view for malformed / non-object JSON", () => {
    for (const bad of ["", "not json", "[]", "null", "42", '"str"']) {
      const view = parseConceptGraph(bad);
      expect(view.nodes).toEqual([]);
      expect(view.edges).toEqual([]);
    }
  });

  it("returns the canonical empty view (truncation 'complete') for every invalid input", () => {
    // Includes non-graph objects like `[]` and `"{}"`: an absent truncation
    // field must collapse to "complete", not "unknown", so the empty-view
    // contract holds uniformly regardless of which invalid shape was passed.
    for (const bad of ["", "not json", "[]", "null", "42", '"str"', "{}"]) {
      expect(parseConceptGraph(bad).truncation).toBe("complete");
    }
  });

  it("returns a deeply-frozen, immutable view (nodes/edges arrays + elements)", () => {
    const json = JSON.stringify({
      nodes: [
        { id: "a", label: "Atlas", state: "canonical", scope_id: "s1", connections_count: 1 },
      ],
      edges: [
        { id: "e1", from: "a", to: "a", relation_type: "is_a", scope_id: "s1" },
      ],
      scope_filter: ["s1"],
      depth: 1,
      truncation: "complete",
    });
    const view = parseConceptGraph(json);
    expect(Object.isFrozen(view)).toBe(true);
    expect(Object.isFrozen(view.nodes)).toBe(true);
    expect(Object.isFrozen(view.edges)).toBe(true);
    expect(Object.isFrozen(view.scopeFilter)).toBe(true);
    expect(Object.isFrozen(view.nodes[0])).toBe(true);
    expect(Object.isFrozen(view.edges[0])).toBe(true);
    // Mutating the immutable view throws in strict mode (modules are strict).
    expect(() => view.nodes.push(view.nodes[0])).toThrow();
    // The shared empty view is frozen too.
    expect(Object.isFrozen(parseConceptGraph("{}").nodes)).toBe(true);
  });

  it("normalizes PascalCase node state and snake_case relation_type", () => {
    const json = JSON.stringify({
      nodes: [
        { id: "a", label: "Atlas", state: "Canonical", scope_id: "s1", connections_count: 2 },
        { id: "b", label: "Beacon", state: "Superseded", scope_id: "s1", connections_count: 1 },
      ],
      edges: [
        { id: "e1", from: "a", to: "b", relation_type: "is_a", scope_id: "s1" },
      ],
      scope_filter: ["s1"],
      depth: 2,
      truncation: "complete",
    });
    const view = parseConceptGraph(json);
    expect(view.nodes.map((n) => n.state)).toEqual(["canonical", "superseded"]);
    expect(view.edges[0].relationType).toBe("is_a");
    expect(view.scopeFilter).toEqual(["s1"]);
    expect(view.depth).toBe(2);
  });

  it("maps unknown states/relations/truncation to the forward-compat fallback", () => {
    const json = JSON.stringify({
      nodes: [
        { id: "a", label: "A", state: "FutureState", scope_id: "s1", connections_count: 0 },
        { id: "b", label: "B", state: "candidate", scope_id: "s1", connections_count: 0 },
      ],
      edges: [
        { id: "e1", from: "a", to: "b", relation_type: "telepathically_linked", scope_id: "s1" },
      ],
      truncation: "some_new_reason",
    });
    const view = parseConceptGraph(json);
    expect(view.nodes[0].state).toBe("unknown");
    expect(view.edges[0].relationType).toBe("unknown");
    expect(view.truncation).toBe("unknown");
    // The unknown relation still has a human label for the legend.
    expect(RELATION_LABELS[view.edges[0].relationType]).toBe("related to");
  });

  it("drops nodes without an id and edges referencing missing nodes", () => {
    const json = JSON.stringify({
      nodes: [
        { label: "no id", state: "candidate", scope_id: "s1", connections_count: 0 },
        { id: "a", label: "A", state: "candidate", scope_id: "s1", connections_count: 1 },
      ],
      edges: [
        { id: "e1", from: "a", to: "ghost", relation_type: "is_a", scope_id: "s1" },
        { id: "e2", from: "a", to: "a", relation_type: "part_of", scope_id: "s1" },
      ],
    });
    const view = parseConceptGraph(json);
    expect(view.nodes.map((n) => n.id)).toEqual(["a"]);
    // e1 -> ghost dropped (dangling); e2 -> a kept (self-ref, both present).
    expect(view.edges.map((e) => e.id)).toEqual(["e2"]);
  });

  it("clamps negative / non-finite numeric fields", () => {
    const json = JSON.stringify({
      nodes: [
        { id: "a", label: "A", state: "candidate", scope_id: "s1", connections_count: -5 },
        { id: "b", label: "B", state: "candidate", scope_id: "s1", connections_count: 3.9 },
      ],
      edges: [],
      depth: -2,
    });
    const view = parseConceptGraph(json);
    expect(view.nodes[0].connectionsCount).toBe(0);
    expect(view.nodes[1].connectionsCount).toBe(3);
    expect(view.depth).toBe(0);
  });
});

describe("computeRadialLayout", () => {
  const view: ConceptGraphView = parseConceptGraph(
    JSON.stringify({
      nodes: [
        { id: "hub", label: "Hub", state: "canonical", scope_id: "s1", connections_count: 4 },
        { id: "n1", label: "N1", state: "candidate", scope_id: "s1", connections_count: 1 },
        { id: "n2", label: "N2", state: "candidate", scope_id: "s1", connections_count: 1 },
        { id: "n3", label: "N3", state: "candidate", scope_id: "s1", connections_count: 0 },
      ],
      edges: [
        { id: "e1", from: "hub", to: "n1", relation_type: "is_a", scope_id: "s1" },
        { id: "e2", from: "hub", to: "n2", relation_type: "part_of", scope_id: "s1" },
      ],
    }),
  );

  it("anchors the most-connected node at the canvas center", () => {
    const layout = computeRadialLayout(view, { width: 600, height: 400 });
    const hub = layout.nodes.find((n) => n.id === "hub");
    expect(hub).toBeDefined();
    expect(hub?.x).toBe(300);
    expect(hub?.y).toBe(200);
  });

  it("sizes the hub larger than leaf nodes", () => {
    const layout = computeRadialLayout(view);
    const hub = layout.nodes.find((n) => n.id === "hub")!;
    const leaf = layout.nodes.find((n) => n.id === "n3")!;
    expect(hub.radius).toBeGreaterThan(leaf.radius);
  });

  it("is fully deterministic across runs (same input → identical coords)", () => {
    const a = computeRadialLayout(view, { width: 600, height: 400 });
    const b = computeRadialLayout(view, { width: 600, height: 400 });
    expect(a).toEqual(b);
  });

  it("produces a stable snapshot for the lightweight SVG renderer", () => {
    const layout = computeRadialLayout(view, { width: 600, height: 400 });
    const rounded = layout.nodes.map((n) => ({
      id: n.id,
      x: Math.round(n.x * 1000) / 1000,
      y: Math.round(n.y * 1000) / 1000,
      radius: Math.round(n.radius * 1000) / 1000,
    }));
    expect(rounded).toMatchSnapshot();
  });

  it("handles an empty graph without throwing", () => {
    const layout = computeRadialLayout(parseConceptGraph("{}"));
    expect(layout.nodes).toEqual([]);
    expect(layout.width).toBeGreaterThan(0);
    expect(layout.height).toBeGreaterThan(0);
  });
});

describe("computeDegrees", () => {
  it("counts visible incident edges per node (self loop counts once)", () => {
    const view = parseConceptGraph(
      JSON.stringify({
        nodes: [
          { id: "a", label: "A", state: "candidate", scope_id: "s", connections_count: 0 },
          { id: "b", label: "B", state: "candidate", scope_id: "s", connections_count: 0 },
        ],
        edges: [
          { id: "ab", from: "a", to: "b", relation_type: "is_a", scope_id: "s" },
          { id: "aa", from: "a", to: "a", relation_type: "part_of", scope_id: "s" },
        ],
      }),
    );
    const degrees = computeDegrees(view);
    expect(degrees.get("a")).toBe(2); // ab + self loop (once)
    expect(degrees.get("b")).toBe(1);
  });

  it("reports zero for isolated nodes", () => {
    const view = parseConceptGraph(
      JSON.stringify({
        nodes: [{ id: "x", label: "X", state: "candidate", scope_id: "s", connections_count: 9 }],
        edges: [],
      }),
    );
    expect(computeDegrees(view).get("x")).toBe(0);
  });
});

describe("buildAdjacency / incidentTo", () => {
  it("maps each node to its undirected neighbors and incident edges", () => {
    const adj = buildAdjacency(sampleGraph());
    expect([...(adj.neighbors.get("b") ?? [])].sort()).toEqual(["a", "c", "e"]);
    expect([...(adj.edges.get("b") ?? [])].sort()).toEqual(["ab", "bc", "be"]);
  });

  it("excludes self loops from the neighbor set", () => {
    const view = parseConceptGraph(
      JSON.stringify({
        nodes: [{ id: "a", label: "A", state: "candidate", scope_id: "s", connections_count: 0 }],
        edges: [{ id: "aa", from: "a", to: "a", relation_type: "is_a", scope_id: "s" }],
      }),
    );
    const adj = buildAdjacency(view);
    expect([...(adj.neighbors.get("a") ?? [])]).toEqual([]);
    expect([...(adj.edges.get("a") ?? [])]).toEqual(["aa"]);
  });

  it("returns the focus + direct neighbors and incident edges for highlighting", () => {
    const { nodeIds, edgeIds } = incidentTo(sampleGraph(), "b");
    expect([...nodeIds].sort()).toEqual(["a", "b", "c", "e"]);
    expect([...edgeIds].sort()).toEqual(["ab", "bc", "be"]);
  });

  it("returns empty sets for an absent focus id", () => {
    const { nodeIds, edgeIds } = incidentTo(sampleGraph(), "ghost");
    expect(nodeIds.size).toBe(0);
    expect(edgeIds.size).toBe(0);
  });
});

describe("localGraphView", () => {
  it("keeps only the 1-hop neighborhood of the focus", () => {
    const local = localGraphView(sampleGraph(), "b", 1);
    expect(local.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c", "e"]);
    // Edges among the kept nodes only — "cd"/"da" reach out of the hop set
    // and are dropped, but "ab" (a↔b) is kept since both endpoints survive.
    expect(local.edges.map((e) => e.id).sort()).toEqual(["ab", "bc", "be"]);
  });

  it("expands to the 2-hop neighborhood", () => {
    const local = localGraphView(sampleGraph(), "e", 2);
    // e → b (1 hop) → a, c (2 hops). d is 3 hops from e, excluded.
    expect(local.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c", "e"]);
  });

  it("treats hops < 1 as a single hop", () => {
    const local = localGraphView(sampleGraph(), "b", 0);
    expect(local.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c", "e"]);
  });

  it("returns the original view unchanged when the focus is absent", () => {
    const view = sampleGraph();
    expect(localGraphView(view, "ghost", 1)).toBe(view);
  });

  it("produces a deeply-frozen sub-view", () => {
    const local = localGraphView(sampleGraph(), "b", 1);
    expect(Object.isFrozen(local)).toBe(true);
    expect(Object.isFrozen(local.nodes)).toBe(true);
    expect(() => local.nodes.push(local.nodes[0])).toThrow();
  });
});

describe("filterGraphView", () => {
  it("drops edges whose relation type is disabled", () => {
    const filtered = filterGraphView(sampleGraph(), {
      relations: new Set(["is_a", "part_of"]),
    });
    expect(filtered.edges.map((e) => e.id).sort()).toEqual(["ab", "bc", "be"]);
    // All nodes survive (only edges are filtered on the relation axis).
    expect(filtered.nodes).toHaveLength(5);
  });

  it("drops nodes whose state is disabled and any edges touching them", () => {
    const filtered = filterGraphView(sampleGraph(), {
      states: new Set(["canonical", "candidate"]),
    });
    // "d" (superseded) and "e" (contradicted) drop out.
    expect(filtered.nodes.map((n) => n.id).sort()).toEqual(["a", "b", "c"]);
    // Edges touching d/e ("cd", "be", "da") are removed; "ab"/"bc" remain.
    expect(filtered.edges.map((e) => e.id).sort()).toEqual(["ab", "bc"]);
  });

  it("returns the input unchanged when no axis is constrained", () => {
    const view = sampleGraph();
    expect(filterGraphView(view, {})).toBe(view);
  });

  it("applies relation and state filters together", () => {
    const filtered = filterGraphView(sampleGraph(), {
      relations: new Set(["part_of"]),
      states: new Set(["candidate", "contradicted"]),
    });
    expect(filtered.nodes.map((n) => n.id).sort()).toEqual(["b", "c", "e"]);
    expect(filtered.edges.map((e) => e.id).sort()).toEqual(["bc", "be"]);
  });
});

describe("computeForceLayout", () => {
  const view = sampleGraph();

  it("is fully deterministic across runs (same input → identical coords)", () => {
    const a = computeForceLayout(view, { width: 600, height: 400 });
    const b = computeForceLayout(view, { width: 600, height: 400 });
    expect(a).toEqual(b);
  });

  it("places every node strictly inside the padded canvas", () => {
    const width = 600;
    const height = 400;
    const padding = 56;
    const layout = computeForceLayout(view, { width, height, padding });
    expect(layout.nodes).toHaveLength(view.nodes.length);
    for (const n of layout.nodes) {
      expect(Number.isFinite(n.x)).toBe(true);
      expect(Number.isFinite(n.y)).toBe(true);
      expect(n.x).toBeGreaterThanOrEqual(padding + n.radius - 1e-6);
      expect(n.x).toBeLessThanOrEqual(width - padding - n.radius + 1e-6);
      expect(n.y).toBeGreaterThanOrEqual(padding + n.radius - 1e-6);
      expect(n.y).toBeLessThanOrEqual(height - padding - n.radius + 1e-6);
    }
  });

  it("sizes the most-connected node larger than a leaf", () => {
    const layout = computeForceLayout(view);
    const hub = layout.nodes.find((n) => n.id === "b")!; // degree 3
    const leaf = layout.nodes.find((n) => n.id === "e")!; // degree 1
    expect(hub.radius).toBeGreaterThan(leaf.radius);
  });

  it("centers a single node and never produces NaN", () => {
    const single = parseConceptGraph(
      JSON.stringify({
        nodes: [{ id: "solo", label: "Solo", state: "candidate", scope_id: "s", connections_count: 0 }],
        edges: [],
      }),
    );
    const layout = computeForceLayout(single, { width: 500, height: 300 });
    expect(layout.nodes[0].x).toBe(250);
    expect(layout.nodes[0].y).toBe(150);
  });

  it("handles an empty graph without throwing", () => {
    const layout = computeForceLayout(parseConceptGraph("{}"));
    expect(layout.nodes).toEqual([]);
    expect(layout.width).toBeGreaterThan(0);
  });

  it("keeps coincident-seeded / disconnected nodes finite (no repulsion blowup)", () => {
    const many = parseConceptGraph(
      JSON.stringify({
        nodes: Array.from({ length: 30 }, (_, i) => ({
          id: `n${i}`,
          label: `N${i}`,
          state: "candidate",
          scope_id: "s",
          connections_count: 0,
        })),
        edges: [],
      }),
    );
    const layout = computeForceLayout(many, { width: 700, height: 500 });
    expect(layout.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
  });

  it("stays finite and deterministic for a large graph using the adaptive default", () => {
    const big = parseConceptGraph(
      JSON.stringify({
        nodes: Array.from({ length: 400 }, (_, i) => ({
          id: `n${i}`,
          label: `N${i}`,
          state: "candidate",
          scope_id: "s",
          connections_count: 1,
        })),
        edges: Array.from({ length: 399 }, (_, i) => ({
          id: `e${i}`,
          from: `n${i}`,
          to: `n${i + 1}`,
          relation_type: "is_a",
        })),
      }),
    );
    const a = computeForceLayout(big, { width: 700, height: 500 });
    const b = computeForceLayout(big, { width: 700, height: 500 });
    expect(a.nodes.every((n) => Number.isFinite(n.x) && Number.isFinite(n.y))).toBe(true);
    expect(a.nodes.map((n) => [n.x, n.y])).toEqual(b.nodes.map((n) => [n.x, n.y]));
  });
});

describe("adaptiveIterations", () => {
  it("runs the full count for small graphs and floors/decreases for large ones", () => {
    expect(adaptiveIterations(1)).toBe(320);
    expect(adaptiveIterations(150)).toBe(320);
    // Beyond the full-iteration node count it scales down ∝ 1/n²…
    expect(adaptiveIterations(300)).toBeLessThan(320);
    expect(adaptiveIterations(300)).toBeGreaterThanOrEqual(60);
    // …monotonically non-increasing, and never below the floor.
    expect(adaptiveIterations(600)).toBeLessThanOrEqual(adaptiveIterations(300));
    expect(adaptiveIterations(600)).toBe(60);
    expect(adaptiveIterations(100000)).toBe(60);
  });

  it("holds work flat while the ∝1/n² schedule is active (before the floor)", () => {
    const baseline = 150 * 150 * adaptiveIterations(150);
    // 200 and 300 are still above MIN_ITERATIONS, so work tracks ~baseline.
    expect(200 * 200 * adaptiveIterations(200)).toBeLessThanOrEqual(baseline * 1.05);
    expect(300 * 300 * adaptiveIterations(300)).toBeLessThanOrEqual(baseline * 1.05);
  });

  it("keeps work far below a naive fixed-320 layout at large node counts", () => {
    for (const n of [200, 300, 450, 600]) {
      expect(n * n * adaptiveIterations(n)).toBeLessThan(n * n * 320);
    }
    // At the node cap the saving is large (>3x fewer repulsion ops).
    expect(320 / adaptiveIterations(600)).toBeGreaterThan(3);
  });
});

describe("computeFitBox", () => {
  it("returns the full canvas for an empty layout", () => {
    const box = computeFitBox(computeForceLayout(parseConceptGraph("{}")));
    expect(box.x).toBe(0);
    expect(box.y).toBe(0);
    expect(box.width).toBeGreaterThan(0);
    expect(box.height).toBeGreaterThan(0);
  });

  it("bounds every node (with radius) inside the box", () => {
    const layout = computeForceLayout(sampleGraph(), { width: 600, height: 400 });
    const box = computeFitBox(layout, { padding: 20, labelPadding: 10 });
    for (const n of layout.nodes) {
      expect(n.x - n.radius).toBeGreaterThanOrEqual(box.x);
      expect(n.x + n.radius).toBeLessThanOrEqual(box.x + box.width);
      expect(n.y - n.radius).toBeGreaterThanOrEqual(box.y);
      expect(n.y + n.radius).toBeLessThanOrEqual(box.y + box.height);
    }
  });
});
