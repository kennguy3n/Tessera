import { describe, it, expect } from "vitest";
import {
  parseConceptGraph,
  computeRadialLayout,
  RELATION_LABELS,
  type ConceptGraphView,
} from "../utils/conceptGraph";

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
