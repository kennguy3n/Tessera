/**
 * SVG-based Gantt / timeline view for tasks.
 *
 * Renders one row per task laid out across a horizontal time axis
 * (positioned by `dueDate`, falling back to `createdAt`) and draws
 * dependency edges (`task.dependsOn`) as connector lines with an
 * arrowhead from each dependency's bar to the dependent's bar. Rows are
 * ordered topologically so the arrows read top-to-bottom.
 *
 * All layout math lives in the pure {@link computeGanttLayout} helper
 * (see `./taskGanttLayout`) so this file only renders.
 */
import { useMemo } from "react";
import type { TaskInfo } from "../types/ipc";
import { useCspNonce } from "../utils/cspNonce";
import {
  computeGanttLayout,
  formatGanttTick,
  HEADER_HEIGHT,
  PAD_Y,
} from "./taskGanttLayout";

function statusColor(status: string): string {
  switch (status) {
    case "in_progress":
      return "var(--color-primary)";
    case "done":
      return "var(--color-success, #15803d)";
    case "blocked":
      return "var(--color-danger, #b91c1c)";
    default:
      return "var(--color-text-secondary)";
  }
}

export interface TaskGanttProps {
  tasks: TaskInfo[];
}

export default function TaskGantt({ tasks }: TaskGanttProps) {
  const cspNonce = useCspNonce();
  const layout = useMemo(() => computeGanttLayout(tasks), [tasks]);

  if (tasks.length === 0) return null;

  const { rows, deps, ticks, width, height } = layout;

  return (
    <div className="task-gantt" data-testid="task-gantt">
      <svg
        className="task-gantt-svg"
        viewBox={`0 0 ${width} ${height}`}
        width={width}
        height={height}
        role="img"
        aria-label={`Task timeline with ${rows.length} tasks and ${deps.length} dependencies`}
      >
        <defs>
          <marker
            id="gantt-arrow"
            viewBox="0 0 10 10"
            refX="9"
            refY="5"
            markerWidth="7"
            markerHeight="7"
            orient="auto-start-reverse"
          >
            <path d="M 0 0 L 10 5 L 0 10 z" fill="var(--color-text-secondary)" />
          </marker>
        </defs>

        {/* Axis tick lines + labels */}
        {ticks.map((tick, i) => (
          <g key={`tick-${i}`} className="task-gantt-tick">
            <line
              x1={tick.x}
              y1={HEADER_HEIGHT}
              x2={tick.x}
              y2={height - PAD_Y}
              stroke="var(--color-border)"
              strokeDasharray="3 3"
            />
            <text
              x={tick.x}
              y={HEADER_HEIGHT - 8}
              textAnchor="middle"
              className="task-gantt-tick-label"
            >
              {tick.label}
            </text>
          </g>
        ))}

        {/* Dependency connectors (drawn under the bars/labels) */}
        {deps.map((dep) => (
          <line
            key={`dep-${dep.fromId}-${dep.toId}`}
            data-testid={`gantt-dep-${dep.fromId}-${dep.toId}`}
            x1={dep.x1}
            y1={dep.y1}
            x2={dep.x2}
            y2={dep.y2}
            stroke="var(--color-text-secondary)"
            strokeWidth={1.5}
            markerEnd="url(#gantt-arrow)"
          />
        ))}

        {/* Task rows: label + bar */}
        {rows.map((row) => (
          <g key={row.task.id} data-testid={`gantt-task-${row.task.id}`}>
            <text
              x={PAD_Y}
              y={row.centerY}
              dominantBaseline="middle"
              className="task-gantt-label"
            >
              {row.task.title}
            </text>
            <rect
              x={row.x}
              y={row.y}
              width={row.width}
              height={row.height}
              rx={4}
              fill={statusColor(row.task.status)}
            >
              <title>
                {`${row.task.title} — ${row.task.status}`}
                {row.task.dueDate ? ` (due ${formatGanttTick(row.dateMs)})` : ""}
              </title>
            </rect>
          </g>
        ))}
      </svg>

      <style nonce={cspNonce}>{`
        .task-gantt {
          overflow-x: auto;
          padding: var(--spacing-sm) 0;
        }
        .task-gantt-svg {
          font-family: inherit;
        }
        .task-gantt-label {
          font-size: var(--font-size-xs);
          fill: var(--color-text-body);
        }
        .task-gantt-tick-label {
          font-size: var(--font-size-xs);
          fill: var(--color-text-secondary);
        }
      `}</style>
    </div>
  );
}
