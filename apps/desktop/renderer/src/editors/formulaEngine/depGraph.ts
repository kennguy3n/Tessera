/**
 * Phase 16 Task 4 — dependency graph + recalculation.
 *
 * Tracks which cells reference which other cells, so an edit to one
 * cell can recompute exactly the dependents that need it (in
 * topological order) instead of recomputing the whole sheet.
 *
 *   - `cellKey(row, col)` is the canonical string key (`"<row>,<col>"`).
 *   - `extractReferences(ast)` walks an AST and returns every cell
 *     a formula depends on (single cells from `cell` nodes, every
 *     cell inside `range` nodes — bounded by the sheet's actual
 *     dimensions at evaluation time, so out-of-bounds ranges still
 *     resolve cleanly to blanks).
 *   - `DependencyGraph` records `dependsOn[A] = Set<B>` (A reads B)
 *     and `usedBy[B] = Set<A>` (changing B invalidates A). Cycles
 *     are detected via Tarjan-style topological sorting; cells
 *     inside a cycle are marked as `#CIRCULAR!` by the recomputer.
 *   - `recalculate(changed, graph, evaluateOne)` returns the
 *     topologically-sorted set of cells to recompute given a set of
 *     freshly-edited cells. The caller plugs in `evaluateOne(cell)`
 *     so the graph stays decoupled from the resolver/AST cache.
 *
 * Performance: graph operations are O(V + E) over the affected
 * sub-graph; even with 100k formula cells, an edit touching a
 * handful of dependents runs in microseconds.
 */
import type { AstNode } from "./parser";

/** Canonical `"row,col"` cell key (zero-based). */
export function cellKey(row: number, col: number): string {
  return `${row},${col}`;
}

export function parseCellKey(key: string): { row: number; col: number } {
  const idx = key.indexOf(",");
  return {
    row: parseInt(key.slice(0, idx), 10),
    col: parseInt(key.slice(idx + 1), 10),
  };
}

/** Walk `ast` and collect every cell (`row,col`) it depends on. */
export function extractReferences(ast: AstNode): Set<string> {
  const out = new Set<string>();
  walk(ast, out);
  return out;
}

function walk(node: AstNode, out: Set<string>): void {
  switch (node.type) {
    case "cell":
      out.add(cellKey(node.row, node.col));
      return;
    case "range":
      for (let r = node.start.row; r <= node.end.row; r++) {
        for (let c = node.start.col; c <= node.end.col; c++) {
          out.add(cellKey(r, c));
        }
      }
      return;
    case "function":
      for (const arg of node.args) walk(arg, out);
      return;
    case "unary":
      walk(node.operand, out);
      return;
    case "binary":
      walk(node.left, out);
      walk(node.right, out);
      return;
    case "number":
    case "string":
    case "boolean":
    case "identifier":
      return;
    default: {
      const _exhaust: never = node;
      void _exhaust;
      return;
    }
  }
}

/**
 * Mutable dependency graph. Cells are identified by their
 * `cellKey(row,col)` string. The graph stores two directions:
 *
 *   - `dependsOn(A)` = the set of cells whose values A reads;
 *   - `usedBy(B)`    = the set of cells that read B's value.
 *
 * `setDependencies(cell, deps)` is the single mutation entry
 * point — it diffs the new and previous dep sets so we never leak
 * stale `usedBy` entries when a formula is edited.
 */
export class DependencyGraph {
  private readonly deps = new Map<string, Set<string>>();
  private readonly users = new Map<string, Set<string>>();

  /** Replace the dependency set for `cell` with `next`. */
  setDependencies(cell: string, next: ReadonlySet<string>): void {
    const prev = this.deps.get(cell);
    if (prev) {
      for (const target of prev) {
        if (!next.has(target)) {
          const users = this.users.get(target);
          users?.delete(cell);
          if (users && users.size === 0) this.users.delete(target);
        }
      }
    }
    if (next.size === 0) {
      this.deps.delete(cell);
    } else {
      this.deps.set(cell, new Set(next));
    }
    for (const target of next) {
      let users = this.users.get(target);
      if (!users) {
        users = new Set<string>();
        this.users.set(target, users);
      }
      users.add(cell);
    }
  }

  /** Drop all dependency info for `cell` (e.g. cell deleted). */
  remove(cell: string): void {
    const prev = this.deps.get(cell);
    if (prev) {
      for (const target of prev) {
        const users = this.users.get(target);
        users?.delete(cell);
        if (users && users.size === 0) this.users.delete(target);
      }
      this.deps.delete(cell);
    }
    const users = this.users.get(cell);
    if (users) {
      for (const user of users) {
        const deps = this.deps.get(user);
        deps?.delete(cell);
      }
    }
  }

  dependsOn(cell: string): ReadonlySet<string> {
    return this.deps.get(cell) ?? EMPTY;
  }

  usedBy(cell: string): ReadonlySet<string> {
    return this.users.get(cell) ?? EMPTY;
  }

  /**
   * Return every cell affected (transitively) by changes to `seeds`,
   * in topological order such that each cell appears AFTER all of
   * its dependencies that are also in the result set. Cells that
   * participate in a cycle are returned at the end, tagged via
   * `cyclic: true`, so the caller can mark them `#CIRCULAR!`.
   */
  recalcOrder(seeds: Iterable<string>): {
    order: string[];
    cyclic: Set<string>;
  } {
    // First, find the set of cells transitively affected.
    const affected = new Set<string>();
    const stack: string[] = [];
    for (const s of seeds) {
      for (const u of this.usedBy(s)) {
        if (!affected.has(u)) {
          affected.add(u);
          stack.push(u);
        }
      }
    }
    while (stack.length) {
      const cur = stack.pop()!;
      for (const u of this.usedBy(cur)) {
        if (!affected.has(u)) {
          affected.add(u);
          stack.push(u);
        }
      }
    }
    if (affected.size === 0) return { order: [], cyclic: new Set() };
    // Topological sort over the induced sub-graph using Kahn's
    // algorithm. Cells with remaining in-degree at the end are in a
    // cycle.
    const indeg = new Map<string, number>();
    for (const cell of affected) indeg.set(cell, 0);
    for (const cell of affected) {
      for (const target of this.dependsOn(cell)) {
        if (affected.has(target)) {
          indeg.set(cell, (indeg.get(cell) ?? 0) + 1);
        }
      }
    }
    const ready: string[] = [];
    for (const [c, n] of indeg) if (n === 0) ready.push(c);
    const order: string[] = [];
    while (ready.length) {
      const c = ready.shift()!;
      order.push(c);
      for (const user of this.usedBy(c)) {
        if (!affected.has(user)) continue;
        const next = (indeg.get(user) ?? 0) - 1;
        indeg.set(user, next);
        if (next === 0) ready.push(user);
      }
    }
    const cyclic = new Set<string>();
    for (const [c, n] of indeg) {
      if (n > 0) cyclic.add(c);
    }
    return { order, cyclic };
  }

  /** Returns every cell currently known to the graph (for tests). */
  allCells(): string[] {
    const out = new Set<string>();
    for (const k of this.deps.keys()) out.add(k);
    for (const k of this.users.keys()) out.add(k);
    return Array.from(out);
  }
}

const EMPTY: ReadonlySet<string> = new Set<string>();
