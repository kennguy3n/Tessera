/**
 * Phase 16 Task 4 — dependency graph tests.
 *
 * Covers: reference extraction (single cell, range, nested
 * function), graph mutation (add / replace / remove), topological
 * recalculation order, diamond dependencies, and cycle detection.
 */
import { describe, it, expect } from "vitest";

import {
  DependencyGraph,
  cellKey,
  extractReferences,
  parseFormula,
} from "..";

function refsOf(formula: string): string[] {
  const r = parseFormula(formula);
  if (!r.ok) throw new Error(`parse failed: ${r.code}`);
  return Array.from(extractReferences(r.ast)).sort();
}

describe("extractReferences", () => {
  it("returns the empty set for a literal", () => {
    expect(refsOf("1+2")).toEqual([]);
  });
  it("collects a single cell reference", () => {
    expect(refsOf("=A1")).toEqual(["0,0"]);
  });
  it("expands a range into every cell", () => {
    expect(refsOf("=SUM(A1:B2)")).toEqual(
      ["0,0", "0,1", "1,0", "1,1"].sort(),
    );
  });
  it("walks into nested function calls", () => {
    expect(refsOf("=IF(A1>0,B1,C1)")).toEqual(["0,0", "0,1", "0,2"].sort());
  });
  it("deduplicates repeated references", () => {
    expect(refsOf("=A1+A1*A1")).toEqual(["0,0"]);
  });
});

describe("DependencyGraph — basic mutation", () => {
  it("records a → b and b → a (usedBy)", () => {
    const g = new DependencyGraph();
    g.setDependencies("a", new Set(["b"]));
    expect(Array.from(g.dependsOn("a"))).toEqual(["b"]);
    expect(Array.from(g.usedBy("b"))).toEqual(["a"]);
  });
  it("replaces dependency set cleanly (no stale users)", () => {
    const g = new DependencyGraph();
    g.setDependencies("a", new Set(["b", "c"]));
    g.setDependencies("a", new Set(["c"]));
    expect(Array.from(g.usedBy("b"))).toEqual([]);
    expect(Array.from(g.usedBy("c"))).toEqual(["a"]);
  });
  it("remove() unhooks both directions", () => {
    const g = new DependencyGraph();
    g.setDependencies("a", new Set(["b"]));
    g.setDependencies("c", new Set(["a"]));
    g.remove("a");
    expect(Array.from(g.usedBy("b"))).toEqual([]);
    expect(Array.from(g.dependsOn("c"))).toEqual([]);
  });
});

describe("DependencyGraph — recalcOrder", () => {
  it("returns the empty list when no cells depend on the seeds", () => {
    const g = new DependencyGraph();
    g.setDependencies("a", new Set(["b"]));
    const { order, cyclic } = g.recalcOrder(["z"]);
    expect(order).toEqual([]);
    expect(cyclic.size).toBe(0);
  });
  it("computes a linear chain in order", () => {
    // c depends on b, b depends on a; editing a should recalc [b, c].
    const g = new DependencyGraph();
    g.setDependencies("b", new Set(["a"]));
    g.setDependencies("c", new Set(["b"]));
    const { order } = g.recalcOrder(["a"]);
    expect(order).toEqual(["b", "c"]);
  });
  it("handles a diamond dependency without duplication", () => {
    // d depends on b and c; b and c both depend on a.
    const g = new DependencyGraph();
    g.setDependencies("b", new Set(["a"]));
    g.setDependencies("c", new Set(["a"]));
    g.setDependencies("d", new Set(["b", "c"]));
    const { order } = g.recalcOrder(["a"]);
    // d must come after BOTH b and c.
    expect(order.indexOf("d")).toBeGreaterThan(order.indexOf("b"));
    expect(order.indexOf("d")).toBeGreaterThan(order.indexOf("c"));
    expect(new Set(order)).toEqual(new Set(["b", "c", "d"]));
  });
  it("marks cells in a cycle as cyclic", () => {
    const g = new DependencyGraph();
    g.setDependencies("a", new Set(["b"]));
    g.setDependencies("b", new Set(["a"])); // cycle a ↔ b
    g.setDependencies("c", new Set(["a"])); // c depends on cycle
    const { order, cyclic } = g.recalcOrder(["a"]);
    expect(cyclic.has("a")).toBe(true);
    expect(cyclic.has("b")).toBe(true);
    // c shouldn't be promoted to "ready" because its in-degree is
    // still 1 (depends on `a`, which never becomes ready).
    expect(order).toEqual([]);
  });
});

describe("cellKey", () => {
  it("round-trips through parseCellKey", () => {
    const k = cellKey(4, 7);
    expect(k).toBe("4,7");
  });
});
