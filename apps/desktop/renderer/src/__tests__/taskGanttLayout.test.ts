/**
 * Tests for the pure Gantt layout helpers in
 * `components/taskGanttLayout`. These cover the two pieces of logic that
 * are easy to get subtly wrong:
 *
 *  1. `orderTasksTopologically` — dependencies come before dependents,
 *     ties are deterministic, and cycles / dangling refs degrade
 *     gracefully instead of throwing or dropping tasks.
 *  2. `computeGanttLayout` — every task gets a bar inside the chart and
 *     each (known) dependency edge produces a connector.
 */
import { describe, it, expect } from "vitest";
import type { TaskInfo } from "../types/ipc";
import {
  orderTasksTopologically,
  computeGanttLayout,
  LABEL_WIDTH,
  CHART_WIDTH,
} from "../components/taskGanttLayout";

function task(id: string, overrides: Partial<TaskInfo> = {}): TaskInfo {
  return {
    id,
    title: id,
    description: "",
    status: "todo",
    priority: "medium",
    position: 0,
    assignee: null,
    dueDate: null,
    sourceId: null,
    extractedItemId: null,
    dependsOn: [],
    createdAt: "2024-01-01T00:00:00Z",
    updatedAt: "2024-01-01T00:00:00Z",
    ...overrides,
  };
}

describe("orderTasksTopologically", () => {
  it("places dependencies before their dependents", () => {
    // c depends on b, b depends on a → order must be a, b, c.
    const tasks = [
      task("c", { dependsOn: ["b"], dueDate: "2024-03-01T00:00:00Z" }),
      task("a", { dueDate: "2024-01-15T00:00:00Z" }),
      task("b", { dependsOn: ["a"], dueDate: "2024-02-01T00:00:00Z" }),
    ];
    const ordered = orderTasksTopologically(tasks).map((t) => t.id);
    expect(ordered.indexOf("a")).toBeLessThan(ordered.indexOf("b"));
    expect(ordered.indexOf("b")).toBeLessThan(ordered.indexOf("c"));
  });

  it("is deterministic for independent tasks (date then title)", () => {
    const tasks = [
      task("z", { dueDate: "2024-02-01T00:00:00Z" }),
      task("y", { dueDate: "2024-01-01T00:00:00Z" }),
      task("x", { dueDate: "2024-01-01T00:00:00Z" }),
    ];
    // y and x share a date → title tie-break (x before y); z is later.
    expect(orderTasksTopologically(tasks).map((t) => t.id)).toEqual([
      "x",
      "y",
      "z",
    ]);
  });

  it("does not drop tasks when a dependency cycle is present", () => {
    // a <-> b cycle. The store rejects this, but the view must still
    // render both rather than throwing or losing a node.
    const tasks = [
      task("a", { dependsOn: ["b"] }),
      task("b", { dependsOn: ["a"] }),
      task("c"),
    ];
    const ordered = orderTasksTopologically(tasks).map((t) => t.id).sort();
    expect(ordered).toEqual(["a", "b", "c"]);
  });

  it("ignores dependency ids that don't exist", () => {
    const tasks = [task("a", { dependsOn: ["ghost"] }), task("b")];
    const ordered = orderTasksTopologically(tasks).map((t) => t.id).sort();
    expect(ordered).toEqual(["a", "b"]);
  });
});

describe("computeGanttLayout", () => {
  it("produces one bar per task, all within the chart bounds", () => {
    const tasks = [
      task("a", { dueDate: "2024-01-01T00:00:00Z" }),
      task("b", { dueDate: "2024-02-01T00:00:00Z" }),
      task("c", { dueDate: "2024-03-01T00:00:00Z" }),
    ];
    const { rows } = computeGanttLayout(tasks);
    expect(rows).toHaveLength(3);
    for (const row of rows) {
      expect(row.x).toBeGreaterThanOrEqual(LABEL_WIDTH);
      expect(row.x + row.width).toBeLessThanOrEqual(
        LABEL_WIDTH + CHART_WIDTH + 0.001,
      );
      expect(row.width).toBeGreaterThan(0);
    }
  });

  it("emits a connector for each known dependency edge", () => {
    const tasks = [
      task("a", { dueDate: "2024-01-01T00:00:00Z" }),
      task("b", {
        dueDate: "2024-02-01T00:00:00Z",
        dependsOn: ["a"],
      }),
    ];
    const { deps } = computeGanttLayout(tasks);
    expect(deps).toHaveLength(1);
    expect(deps[0]).toMatchObject({ fromId: "a", toId: "b" });
  });

  it("skips connectors for dangling dependency ids", () => {
    const tasks = [task("a", { dependsOn: ["does-not-exist"] })];
    const { deps } = computeGanttLayout(tasks);
    expect(deps).toHaveLength(0);
  });

  it("handles tasks with no dates without collapsing onto one pixel", () => {
    const tasks = [task("a", { dueDate: null }), task("b", { dueDate: null })];
    const { rows, width, height } = computeGanttLayout(tasks);
    expect(rows).toHaveLength(2);
    expect(width).toBeGreaterThan(0);
    expect(height).toBeGreaterThan(0);
  });
});
