/**
 * Pure layout math for the {@link TaskGantt} SVG view.
 *
 * Kept free of React / DOM so it can be unit-tested directly and so the
 * component file only exports a component (satisfying
 * `react-refresh/only-export-components`).
 *
 * Tasks are positioned across a horizontal time axis by `dueDate`,
 * falling back to `createdAt` for tasks without a due date (see
 * {@link taskDateMs}). Rows are ordered topologically by `dependsOn`
 * (see {@link orderTasksTopologically}) so dependency arrows read
 * top-to-bottom.
 */
import type { TaskInfo } from "../types/ipc";

// Layout constants (px).
export const LABEL_WIDTH = 168;
export const ROW_HEIGHT = 34;
export const BAR_HEIGHT = 18;
export const HEADER_HEIGHT = 28;
export const CHART_WIDTH = 640;
export const BAR_WIDTH = 88;
export const BAR_MIN_WIDTH = 10;
export const PAD_Y = 12;
const MAX_TICKS = 5;
const DAY_MS = 86_400_000;

export interface GanttRow {
  task: TaskInfo;
  /** 0-based row position after topological ordering. */
  rowIndex: number;
  /** Bar geometry in SVG user units. */
  x: number;
  y: number;
  width: number;
  height: number;
  /** Vertical center of the bar — dependency edges anchor here. */
  centerY: number;
  /** Resolved timestamp (ms) used for positioning. */
  dateMs: number;
}

export interface GanttDependency {
  /** Dependency task id (the one that must complete first). */
  fromId: string;
  /** Dependent task id (the one that declares `dependsOn`). */
  toId: string;
  x1: number;
  y1: number;
  x2: number;
  y2: number;
}

export interface GanttTick {
  x: number;
  label: string;
}

export interface GanttLayout {
  rows: GanttRow[];
  deps: GanttDependency[];
  ticks: GanttTick[];
  width: number;
  height: number;
}

/**
 * Resolve the timestamp (ms since epoch) used to position a task.
 * Prefers `dueDate`; falls back to `createdAt` so a task without a due
 * date still appears on the timeline. Returns `null` only if both are
 * unparseable (the caller buckets these at the domain minimum).
 */
export function taskDateMs(task: TaskInfo): number | null {
  const due = task.dueDate ? Date.parse(task.dueDate) : NaN;
  if (!Number.isNaN(due)) return due;
  const created = task.createdAt ? Date.parse(task.createdAt) : NaN;
  if (!Number.isNaN(created)) return created;
  return null;
}

/**
 * Order tasks so every dependency appears before the tasks that depend
 * on it (Kahn's algorithm). Ties are broken deterministically by
 * resolved date then title then id, so the view is stable across
 * reloads. Edges to unknown ids are ignored; if a cycle leaves nodes
 * unresolved, they're appended in the same deterministic tie-break
 * order rather than dropped.
 */
export function orderTasksTopologically(tasks: TaskInfo[]): TaskInfo[] {
  const byId = new Map<string, TaskInfo>();
  for (const t of tasks) byId.set(t.id, t);

  const tieBreak = (a: TaskInfo, b: TaskInfo): number => {
    const da = taskDateMs(a);
    const db = taskDateMs(b);
    const va = da ?? Number.POSITIVE_INFINITY;
    const vb = db ?? Number.POSITIVE_INFINITY;
    if (va !== vb) return va - vb;
    if (a.title !== b.title) return a.title.localeCompare(b.title);
    return a.id.localeCompare(b.id);
  };

  // indegree = number of (known) dependencies each task still waits on.
  const indegree = new Map<string, number>();
  const dependents = new Map<string, string[]>(); // dep id -> [dependent ids]
  for (const t of tasks) {
    indegree.set(t.id, 0);
  }
  for (const t of tasks) {
    for (const dep of t.dependsOn) {
      if (!byId.has(dep)) continue; // tolerate dangling refs
      indegree.set(t.id, (indegree.get(t.id) ?? 0) + 1);
      const list = dependents.get(dep) ?? [];
      list.push(t.id);
      dependents.set(dep, list);
    }
  }

  // Ready frontier: tasks with no remaining dependencies, kept sorted
  // by the deterministic tie-break so output ordering is stable.
  const ready = tasks.filter((t) => (indegree.get(t.id) ?? 0) === 0);
  ready.sort(tieBreak);

  const ordered: TaskInfo[] = [];
  const visited = new Set<string>();
  while (ready.length > 0) {
    const next = ready.shift() as TaskInfo;
    if (visited.has(next.id)) continue;
    visited.add(next.id);
    ordered.push(next);
    const outs = (dependents.get(next.id) ?? [])
      .map((id) => byId.get(id))
      .filter((t): t is TaskInfo => t !== undefined);
    for (const dependent of outs) {
      const deg = (indegree.get(dependent.id) ?? 0) - 1;
      indegree.set(dependent.id, deg);
      if (deg <= 0 && !visited.has(dependent.id)) {
        // Insert keeping `ready` sorted (small N; linear insert is fine).
        let i = 0;
        while (i < ready.length && tieBreak(ready[i], dependent) <= 0) i++;
        ready.splice(i, 0, dependent);
      }
    }
  }

  // Any task not yet emitted is part of a cycle (store should prevent
  // this) — append deterministically so nothing silently vanishes.
  if (ordered.length < tasks.length) {
    const leftover = tasks.filter((t) => !visited.has(t.id)).sort(tieBreak);
    ordered.push(...leftover);
  }
  return ordered;
}

export function formatGanttTick(ms: number): string {
  const d = new Date(ms);
  if (Number.isNaN(d.getTime())) return "";
  return d.toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/**
 * Pure layout pass: maps a task list to bar geometry, dependency edges,
 * and axis ticks. Exported for unit testing.
 */
export function computeGanttLayout(tasks: TaskInfo[]): GanttLayout {
  const ordered = orderTasksTopologically(tasks);

  // Time domain across all resolved dates. Unparseable tasks bucket at
  // the minimum so they still render at the left edge.
  const dates = ordered
    .map(taskDateMs)
    .filter((v): v is number => v !== null);
  let min = dates.length > 0 ? Math.min(...dates) : 0;
  let max = dates.length > 0 ? Math.max(...dates) : 0;
  if (min === max) {
    // Pad a degenerate (single-date / no-date) domain by a day on each
    // side so bars don't all collapse onto one pixel.
    min -= DAY_MS;
    max += DAY_MS;
  }
  const span = max - min;

  const chartLeft = LABEL_WIDTH;
  const chartRight = chartLeft + CHART_WIDTH;
  const scale = (ms: number): number =>
    chartLeft + ((ms - min) / span) * CHART_WIDTH;

  const rowById = new Map<string, GanttRow>();
  const rows: GanttRow[] = ordered.map((task, rowIndex) => {
    const dateMs = taskDateMs(task) ?? min;
    const end = scale(dateMs);
    // Bar of fixed width ending at the task's date, clamped into the
    // chart area so it stays visible regardless of the date.
    let x = end - BAR_WIDTH;
    let width = BAR_WIDTH;
    if (x < chartLeft) {
      x = chartLeft;
      width = Math.max(BAR_MIN_WIDTH, end - chartLeft);
    }
    if (x + width > chartRight) {
      width = Math.max(BAR_MIN_WIDTH, chartRight - x);
    }
    const y = HEADER_HEIGHT + PAD_Y + rowIndex * ROW_HEIGHT;
    const row: GanttRow = {
      task,
      rowIndex,
      x,
      y,
      width,
      height: BAR_HEIGHT,
      centerY: y + BAR_HEIGHT / 2,
      dateMs,
    };
    rowById.set(task.id, row);
    return row;
  });

  const deps: GanttDependency[] = [];
  for (const row of rows) {
    for (const depId of row.task.dependsOn) {
      const from = rowById.get(depId);
      if (!from) continue; // dangling dependency id — nothing to draw
      deps.push({
        fromId: depId,
        toId: row.task.id,
        x1: from.x + from.width,
        y1: from.centerY,
        x2: row.x,
        y2: row.centerY,
      });
    }
  }

  // Axis ticks: evenly spaced across the domain.
  const tickCount = Math.min(MAX_TICKS, Math.max(2, rows.length));
  const ticks: GanttTick[] = [];
  for (let i = 0; i < tickCount; i++) {
    const ms = min + (span * i) / (tickCount - 1);
    ticks.push({ x: scale(ms), label: formatGanttTick(ms) });
  }

  const height =
    HEADER_HEIGHT + PAD_Y * 2 + Math.max(1, rows.length) * ROW_HEIGHT;
  return { rows, deps, ticks, width: chartRight + PAD_Y, height };
}
