import {
  DragEvent,
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
} from "react";
import { Plus, Trash2, Calendar, User } from "lucide-react";
import PageHeader from "../components/PageHeader";
import Button from "../components/Button";
import Modal from "../components/Modal";
import EmptyState from "../components/EmptyState";
import { useTaskList, useTaskMutations } from "../hooks/useTasks";
import {
  TASK_PRIORITIES,
  type TaskInfo,
  type TaskPriority,
  type TaskStatus,
} from "../types/ipc";

interface ColumnDef {
  status: TaskStatus;
  label: string;
  accent: string;
}

// Order matches PROPOSAL.md plan workflow: queue → active → done, with
// Blocked surfaced explicitly so users see stuck work rather than burying
// it in a "Done" filter. The accent colors are deliberately tied to the
// status (not the priority) so the column wall reads as a workflow board
// at a glance. The `status` values are drawn from the canonical
// `TaskStatus` union in `shared/types.ts` — TypeScript will fail the
// build if a column references a status that isn't in `TASK_STATUSES`,
// keeping the renderer and the IPC zod schema aligned.
const COLUMNS: ColumnDef[] = [
  { status: "todo", label: "Todo", accent: "var(--color-text-secondary)" },
  {
    status: "in_progress",
    label: "In Progress",
    accent: "var(--color-primary)",
  },
  { status: "blocked", label: "Blocked", accent: "var(--color-danger, #b91c1c)" },
  { status: "done", label: "Done", accent: "var(--color-success, #15803d)" },
];

// Pulled from the canonical const tuple in `shared/types.ts` so the
// dropdown options and the IPC zod schema can never drift.
const PRIORITIES: readonly TaskPriority[] = TASK_PRIORITIES;

interface DraftTask {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  assignee: string;
  dueDate: string;
}

const EMPTY_DRAFT: DraftTask = {
  title: "",
  description: "",
  status: "todo",
  priority: "medium",
  assignee: "",
  dueDate: "",
};

function formatDate(iso: string | null): string {
  if (!iso) return "";
  // Pure-display formatter; never throws. Bridge already guarantees
  // valid RFC 3339 for stored fields, but treat the renderer
  // defensively so an externally-edited DB row can't crash the page.
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleDateString(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function priorityColor(p: string): string {
  switch (p) {
    case "critical":
      return "var(--color-danger, #b91c1c)";
    case "high":
      // Was a bare `#c2410c` (orange-700) which broke in dark mode.
      // We use a dedicated `--color-priority-high` token (not
      // `--color-warning`) because `--color-warning` is #f59e0b
      // (amber) in light mode — switching to it would silently
      // shift the existing high-priority badge from orange-700 to
      // amber-500. The dedicated token preserves orange-700 in
      // light and uses orange-400 (`#fb923c`) in dark for contrast
      // on the dark bg.
      return "var(--color-priority-high, #c2410c)";
    case "medium":
      return "var(--color-primary)";
    default:
      return "var(--color-text-secondary)";
  }
}

export default function TasksPage() {
  const { tasks, loading, error, refresh } = useTaskList();
  const { create, update, remove, reorder } = useTaskMutations();

  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<DraftTask>(EMPTY_DRAFT);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<TaskInfo | null>(null);
  // Surfaced to the user when a drag-drop operation fails (network /
  // bridge error). Without this, a failed `update`/`reorder` would
  // produce an unhandled promise rejection and the column would silently
  // snap back to its old state with no indication of why.
  const [dragError, setDragError] = useState<string | null>(null);

  // Track which card is being dragged so onDrop on a column knows which
  // task to move. Using a ref instead of state avoids a re-render storm
  // during the drag pass.
  const dragSourceRef = useRef<TaskInfo | null>(null);
  const [dragOverColumn, setDragOverColumn] = useState<TaskStatus | null>(null);

  // Group tasks by status, sorting within each column by `position`. The
  // sort is local — the bridge stores `position` and returns rows in
  // insertion order, so without this the kanban columns would jumble
  // after `reorder` updates that don't refetch.
  const byStatus = useMemo(() => {
    const result: Record<TaskStatus, TaskInfo[]> = {
      todo: [],
      in_progress: [],
      done: [],
      blocked: [],
    };
    for (const t of tasks) {
      const status = t.status as TaskStatus;
      if (status in result) {
        result[status].push(t);
      } else {
        // Unknown status from a future migration — bucket into todo so
        // the row is still visible. The bridge currently rejects unknown
        // status strings on write so this is defensive only.
        result.todo.push(t);
      }
    }
    for (const status of Object.keys(result) as TaskStatus[]) {
      result[status].sort((a, b) => a.position - b.position);
    }
    return result;
  }, [tasks]);

  const handleSubmitCreate = useCallback(async () => {
    if (!draft.title.trim()) {
      setSubmitError("Title is required");
      return;
    }
    setSubmitting(true);
    setSubmitError(null);
    try {
      // Empty string ⇒ null so the bridge sees `None` instead of
      // attempting to parse "" as an RFC 3339 timestamp. The bridge
      // helper `parse_opt_rfc3339` already treats both as `None`, but
      // sending `null` is the more explicit wire shape.
      await create({
        title: draft.title.trim(),
        description: draft.description,
        status: draft.status,
        priority: draft.priority,
        assignee: draft.assignee.trim() || null,
        dueDate: draft.dueDate.trim() || null,
      });
      await refresh();
      setDraft(EMPTY_DRAFT);
      setCreateOpen(false);
    } catch (e) {
      setSubmitError(e instanceof Error ? e.message : String(e));
    } finally {
      setSubmitting(false);
    }
  }, [draft, create, refresh]);

  const handleDelete = useCallback(
    async (task: TaskInfo) => {
      try {
        await remove(task.id);
        await refresh();
        setConfirmDelete(null);
      } catch (err) {
        // Surface deletion failures in the same alert banner used for
        // drag/drop errors so the modal dismissing isn't the only
        // signal the user gets. Without this catch the rejection
        // becomes unhandled because the caller does `void
        // handleDelete(...)` to fire-and-forget.
        const message = err instanceof Error ? err.message : String(err);
        setDragError(`Failed to delete "${task.title}": ${message}`);
        setConfirmDelete(null);
      }
    },
    [remove, refresh],
  );

  // Same error-surface treatment as `onColumnDrop`: the dropdown
  // change handlers are async + fire-and-forget at the call site (`void
  // handleStatusChange(...)`), so a transient bridge failure would
  // otherwise become an unhandled promise rejection. Route any failure
  // through `dragError` so the user sees which task / which field
  // change failed; refresh state regardless to recover from a partial
  // write.
  const handleStatusChange = useCallback(
    async (task: TaskInfo, status: TaskStatus) => {
      if (task.status === status) return;
      try {
        await update(task.id, { status });
        await refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setDragError(
          `Failed to change status of "${task.title}" to ${status}: ${message}`,
        );
        try {
          await refresh();
        } catch {
          /* surfaced above */
        }
      }
    },
    [update, refresh],
  );

  const handlePriorityChange = useCallback(
    async (task: TaskInfo, priority: TaskPriority) => {
      if (task.priority === priority) return;
      try {
        await update(task.id, { priority });
        await refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setDragError(
          `Failed to change priority of "${task.title}" to ${priority}: ${message}`,
        );
        try {
          await refresh();
        } catch {
          /* surfaced above */
        }
      }
    },
    [update, refresh],
  );

  const onCardDragStart = useCallback((task: TaskInfo) => {
    dragSourceRef.current = task;
  }, []);

  const onCardDragEnd = useCallback(() => {
    dragSourceRef.current = null;
    setDragOverColumn(null);
  }, []);

  // `setDragOverColumn` already bails out of a re-render when the new
  // value is identical to the previous one, so we don't need to read
  // the current `dragOverColumn` in the callback — keeping it in deps
  // would recreate the callback on every column hover and update the
  // `onDragOver` prop on every column div, triggering unnecessary
  // reconciliation during a drag pass.
  const onColumnDragOver = useCallback(
    (status: TaskStatus, e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOverColumn(status);
    },
    [],
  );

  const onColumnDrop = useCallback(
    async (status: TaskStatus, e: DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      const source = dragSourceRef.current;
      dragSourceRef.current = null;
      setDragOverColumn(null);
      if (!source) return;
      // Drag-and-drop is a user-visible gesture; if the bridge errors
      // we want to surface the failure rather than letting it bubble
      // as an unhandled promise rejection (which is invisible in
      // production). On failure we still call `refresh()` so the UI
      // resyncs with the server's last-known good state — preventing
      // the dropped card from sticking in a "ghost" position when the
      // update silently failed.
      setDragError(null);
      try {
        if (source.status === status) {
          // Same-column drop: reorder the column so the dropped card is
          // last. A more granular within-column ordering would need a
          // drop-target index off the mouse Y, which is a future
          // refinement.
          const idsInColumn = byStatus[status].map((t) => t.id);
          const filtered = idsInColumn.filter((id) => id !== source.id);
          filtered.push(source.id);
          await reorder(status, filtered);
        } else {
          // Cross-column drop. The Rust `TaskStore::update` preserves the
          // existing `position` when not provided, so a bare
          // `update(source.id, { status })` would leave the moved task
          // with its old column's position — producing arbitrary order in
          // the target column (e.g. ties broken by `created_at DESC`, or
          // a card with position=5 inserted into a column whose existing
          // cards have positions 0–2). Follow the same flow as the
          // same-column branch: change status first, then call
          // `reorder()` with the moved card appended to the end of the
          // target column's current ordering so positions are reassigned
          // sequentially via the bridge's `reorder_tasks` (which is the
          // single source of truth for column ordering).
          await update(source.id, { status });
          const targetIds = byStatus[status].map((t) => t.id);
          // Defensive: if a future refactor adds background polling /
          // WebSocket updates that refresh `tasks` mid-drag, the moved
          // task could appear in `byStatus[status]` *before* this code
          // path observes it (the server-side `update` above already
          // changed its status). Without this guard the reorder list
          // would contain `source.id` twice, which the bridge's
          // `reorder_tasks` would resolve nondeterministically.
          if (!targetIds.includes(source.id)) {
            targetIds.push(source.id);
          }
          await reorder(status, targetIds);
        }
        await refresh();
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        setDragError(`Failed to move "${source.title}": ${message}`);
        // Refresh anyway so the UI doesn't keep showing a stale state
        // (e.g. the moved card visually in the wrong column because
        // the `update` half-succeeded). `refresh()` swallows its own
        // errors via the `useTaskList` hook, so it's safe to ignore.
        try {
          await refresh();
        } catch {
          // Already surfaced via setDragError above.
        }
      }
    },
    [byStatus, reorder, update, refresh],
  );

  // Surface the bridge's `parse_opt_rfc3339` rejection as a visible
  // error rather than swallowing it. The `useTaskList` hook puts the
  // last load error into `error`; if a write throws (e.g. invalid
  // due_date entered by the user) we already display via submitError.
  useEffect(() => {
    if (error) {
      console.error("[TasksPage] load error:", error);
    }
  }, [error]);

  return (
    <div className="tasks-page">
      <PageHeader
        title="Tasks"
        description="Track plan work. Drag cards across columns to move them between statuses."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={16} strokeWidth={2} aria-hidden="true" />
            <span style={{ marginLeft: 6 }}>New Task</span>
          </Button>
        }
      />

      {loading && tasks.length === 0 && (
        <div className="tasks-loading">Loading tasks…</div>
      )}

      {dragError && (
        <div role="alert" className="tasks-drag-error">
          {dragError}
          <button
            type="button"
            className="tasks-drag-error__dismiss"
            onClick={() => setDragError(null)}
            aria-label="Dismiss drag error"
          >
            ×
          </button>
        </div>
      )}

      {!loading && tasks.length === 0 && (
        <EmptyState
          title="No tasks yet"
          message="Create a task or extract tasks from one of your sources to populate this board."
          action={
            <Button onClick={() => setCreateOpen(true)}>Create task</Button>
          }
        />
      )}

      {tasks.length > 0 && (
        <div className="kanban">
          {COLUMNS.map((col) => (
            <div
              key={col.status}
              className={`kanban-col ${dragOverColumn === col.status ? "kanban-col-over" : ""}`}
              onDragOver={(e) => onColumnDragOver(col.status, e)}
              onDragLeave={() => setDragOverColumn(null)}
              onDrop={(e) => onColumnDrop(col.status, e)}
              data-testid={`column-${col.status}`}
            >
              <div
                className="kanban-col-header"
                style={{ borderTopColor: col.accent }}
              >
                <span className="kanban-col-label">{col.label}</span>
                <span className="kanban-col-count">
                  {byStatus[col.status].length}
                </span>
              </div>
              <div className="kanban-col-body">
                {byStatus[col.status].map((task) => (
                  <article
                    key={task.id}
                    className="task-card"
                    draggable
                    onDragStart={() => onCardDragStart(task)}
                    onDragEnd={onCardDragEnd}
                    data-testid={`task-${task.id}`}
                  >
                    <header className="task-card-head">
                      <span
                        className="task-card-priority"
                        style={{ background: priorityColor(task.priority) }}
                        title={`Priority: ${task.priority}`}
                        aria-label={`Priority ${task.priority}`}
                      />
                      <h3 className="task-card-title">{task.title}</h3>
                      <button
                        className="task-card-delete"
                        aria-label="Delete task"
                        onClick={() => setConfirmDelete(task)}
                      >
                        <Trash2 size={14} strokeWidth={1.75} />
                      </button>
                    </header>
                    {task.description && (
                      <p className="task-card-body">{task.description}</p>
                    )}
                    <div className="task-card-meta">
                      {task.assignee && (
                        <span className="task-card-chip">
                          <User size={12} strokeWidth={1.75} aria-hidden />
                          {task.assignee}
                        </span>
                      )}
                      {task.dueDate && (
                        <span className="task-card-chip">
                          <Calendar
                            size={12}
                            strokeWidth={1.75}
                            aria-hidden
                          />
                          {formatDate(task.dueDate)}
                        </span>
                      )}
                    </div>
                    <div className="task-card-controls">
                      <label className="task-card-control">
                        <span>Status</span>
                        <select
                          value={task.status}
                          onChange={(e) =>
                            void handleStatusChange(
                              task,
                              e.target.value as TaskStatus,
                            )
                          }
                        >
                          {COLUMNS.map((c) => (
                            <option key={c.status} value={c.status}>
                              {c.label}
                            </option>
                          ))}
                        </select>
                      </label>
                      <label className="task-card-control">
                        <span>Priority</span>
                        <select
                          value={task.priority}
                          onChange={(e) =>
                            void handlePriorityChange(
                              task,
                              e.target.value as TaskPriority,
                            )
                          }
                        >
                          {PRIORITIES.map((p) => (
                            <option key={p} value={p}>
                              {p}
                            </option>
                          ))}
                        </select>
                      </label>
                    </div>
                  </article>
                ))}
              </div>
            </div>
          ))}
        </div>
      )}

      <Modal
        isOpen={createOpen}
        onClose={() => {
          setCreateOpen(false);
          setSubmitError(null);
          setDraft(EMPTY_DRAFT);
        }}
        title="New Task"
      >
        <form
          className="task-form"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmitCreate();
          }}
        >
          <label className="task-form-field">
            <span>Title</span>
            <input
              autoFocus
              type="text"
              value={draft.title}
              onChange={(e) =>
                setDraft((d) => ({ ...d, title: e.target.value }))
              }
              required
              maxLength={200}
            />
          </label>
          <label className="task-form-field">
            <span>Description</span>
            <textarea
              value={draft.description}
              onChange={(e) =>
                setDraft((d) => ({ ...d, description: e.target.value }))
              }
              rows={3}
            />
          </label>
          <div className="task-form-row">
            <label className="task-form-field">
              <span>Status</span>
              <select
                value={draft.status}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    status: e.target.value as TaskStatus,
                  }))
                }
              >
                {COLUMNS.map((c) => (
                  <option key={c.status} value={c.status}>
                    {c.label}
                  </option>
                ))}
              </select>
            </label>
            <label className="task-form-field">
              <span>Priority</span>
              <select
                value={draft.priority}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    priority: e.target.value as TaskPriority,
                  }))
                }
              >
                {PRIORITIES.map((p) => (
                  <option key={p} value={p}>
                    {p}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="task-form-row">
            <label className="task-form-field">
              <span>Assignee</span>
              <input
                type="text"
                value={draft.assignee}
                onChange={(e) =>
                  setDraft((d) => ({ ...d, assignee: e.target.value }))
                }
                placeholder="optional"
              />
            </label>
            <label className="task-form-field">
              <span>Due date</span>
              <input
                type="date"
                value={draft.dueDate.slice(0, 10)}
                onChange={(e) =>
                  setDraft((d) => ({
                    // <input type="date"> emits YYYY-MM-DD; expand it
                    // to a full RFC 3339 string so the bridge's
                    // `parse_opt_rfc3339` accepts it. End-of-day UTC
                    // matches what a user picking "due on this day"
                    // typically means.
                    ...d,
                    dueDate: e.target.value
                      ? `${e.target.value}T23:59:59Z`
                      : "",
                  }))
                }
              />
            </label>
          </div>
          {submitError && (
            <div role="alert" className="task-form-error">
              {submitError}
            </div>
          )}
          <div className="task-form-actions">
            <Button
              variant="secondary"
              type="button"
              onClick={() => {
                setCreateOpen(false);
                setDraft(EMPTY_DRAFT);
                setSubmitError(null);
              }}
            >
              Cancel
            </Button>
            <Button type="submit" disabled={submitting}>
              {submitting ? "Creating…" : "Create"}
            </Button>
          </div>
        </form>
      </Modal>

      <Modal
        isOpen={confirmDelete !== null}
        onClose={() => setConfirmDelete(null)}
        title="Delete task?"
      >
        <p>
          This will permanently remove
          {confirmDelete ? ` "${confirmDelete.title}"` : " this task"} from
          your task board.
        </p>
        <div className="task-form-actions">
          <Button variant="secondary" onClick={() => setConfirmDelete(null)}>
            Cancel
          </Button>
          <Button
            variant="danger"
            onClick={() =>
              confirmDelete && void handleDelete(confirmDelete)
            }
          >
            Delete
          </Button>
        </div>
      </Modal>

      <style>{`
        .tasks-drag-error {
          margin: var(--spacing-md) 0;
          padding: var(--spacing-sm) var(--spacing-md);
          background: var(--color-danger-subtle, #fef2f2);
          color: var(--color-danger, #b91c1c);
          border: 1px solid var(--color-danger, #b91c1c);
          border-radius: var(--radius-md, 6px);
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--spacing-md);
          font-size: var(--font-size-sm);
        }
        .tasks-drag-error__dismiss {
          background: transparent;
          border: none;
          color: inherit;
          font-size: 1.25rem;
          line-height: 1;
          cursor: pointer;
          padding: 0 var(--spacing-xs);
        }
        .tasks-loading {
          padding: var(--spacing-xl);
          color: var(--color-text-secondary);
        }
        .kanban {
          display: grid;
          grid-template-columns: repeat(4, minmax(0, 1fr));
          gap: var(--spacing-md);
        }
        .kanban-col {
          background: var(--color-bg-subtle, #f8fafc);
          border-radius: var(--radius-md);
          display: flex;
          flex-direction: column;
          min-height: 240px;
          border: 1px solid transparent;
          transition: border-color var(--transition-fast);
        }
        .kanban-col-over {
          border-color: var(--color-primary);
        }
        .kanban-col-header {
          padding: var(--spacing-sm) var(--spacing-md);
          border-top: 3px solid var(--color-text-secondary);
          border-radius: var(--radius-md) var(--radius-md) 0 0;
          display: flex;
          justify-content: space-between;
          align-items: center;
          font-weight: var(--font-weight-semibold);
          color: var(--color-text-headline);
        }
        .kanban-col-count {
          font-size: var(--font-size-sm);
          color: var(--color-text-secondary);
        }
        .kanban-col-body {
          display: flex;
          flex-direction: column;
          gap: var(--spacing-sm);
          padding: var(--spacing-sm);
        }
        .task-card {
          background: var(--color-bg-elevated, #fff);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-input);
          padding: var(--spacing-sm);
          display: flex;
          flex-direction: column;
          gap: var(--spacing-xs);
          box-shadow: var(--shadow-sm, 0 1px 2px rgba(0,0,0,0.05));
          cursor: grab;
        }
        .task-card:active {
          cursor: grabbing;
        }
        .task-card-head {
          display: flex;
          align-items: center;
          gap: var(--spacing-xs);
        }
        .task-card-priority {
          width: 8px;
          height: 8px;
          border-radius: 50%;
          flex-shrink: 0;
        }
        .task-card-title {
          flex: 1;
          font-size: var(--font-size-sm);
          font-weight: var(--font-weight-medium);
          margin: 0;
        }
        .task-card-delete {
          background: transparent;
          border: none;
          color: var(--color-text-secondary);
          cursor: pointer;
          padding: 2px;
          border-radius: 4px;
        }
        .task-card-delete:hover {
          color: var(--color-danger, #b91c1c);
          background: var(--color-danger-light, #fef2f2);
        }
        .task-card-body {
          font-size: var(--font-size-xs);
          color: var(--color-text-body);
          margin: 0;
          white-space: pre-wrap;
        }
        .task-card-meta {
          display: flex;
          gap: var(--spacing-xs);
          flex-wrap: wrap;
        }
        .task-card-chip {
          display: inline-flex;
          align-items: center;
          gap: 4px;
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          background: var(--color-bg-subtle, #f1f5f9);
          padding: 2px 6px;
          border-radius: 999px;
        }
        .task-card-controls {
          display: flex;
          gap: var(--spacing-xs);
          margin-top: 2px;
        }
        .task-card-control {
          flex: 1;
          display: flex;
          flex-direction: column;
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
        }
        .task-card-control select {
          font-size: var(--font-size-xs);
          padding: 2px 4px;
          border: 1px solid var(--color-border);
          border-radius: 4px;
        }
        .task-form {
          display: flex;
          flex-direction: column;
          gap: var(--spacing-sm);
        }
        .task-form-field {
          display: flex;
          flex-direction: column;
          gap: 4px;
          flex: 1;
        }
        .task-form-field span {
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
        }
        .task-form-field input,
        .task-form-field select,
        .task-form-field textarea {
          padding: 6px 8px;
          border: 1px solid var(--color-border);
          border-radius: var(--radius-input);
          font-size: var(--font-size-sm);
        }
        .task-form-row {
          display: flex;
          gap: var(--spacing-sm);
        }
        .task-form-error {
          color: var(--color-danger, #b91c1c);
          font-size: var(--font-size-xs);
          padding: 6px 8px;
          background: var(--color-danger-light, #fef2f2);
          border-radius: var(--radius-input);
        }
        .task-form-actions {
          display: flex;
          justify-content: flex-end;
          gap: var(--spacing-sm);
          margin-top: var(--spacing-sm);
        }
      `}</style>
    </div>
  );
}
