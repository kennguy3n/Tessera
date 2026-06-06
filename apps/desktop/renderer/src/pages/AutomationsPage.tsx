import { useCallback, useEffect, useMemo, useState } from "react";
import { Plus, Trash2, Zap, Clock, Play, AlertCircle } from "lucide-react";
import PageHeader from "../components/PageHeader";
import Button from "../components/Button";
import Modal from "../components/Modal";
import EmptyState from "../components/EmptyState";
import { useCspNonce } from "../utils/cspNonce";
import {
  useAutomationList,
  useAutomationMutations,
  useSchedulerStatus,
} from "../hooks/useAutomations";
import { useSourceList } from "../hooks/useSources";
import { useTemplateList } from "../hooks/useTemplates";
import type {
  AutomationAction,
  AutomationInfo,
  AutomationTrigger,
} from "../types/ipc";

type TriggerKind = AutomationTrigger["kind"];
type ActionKind = AutomationAction["kind"];

interface DraftAutomation {
  name: string;
  triggerKind: TriggerKind;
  intervalSeconds: number;
  triggerTemplateId: string;
  actionKind: ActionKind;
  actionSourceId: string;
  actionTemplateId: string;
  actionSourceIds: string[];
}

const EMPTY_DRAFT: DraftAutomation = {
  name: "",
  triggerKind: "schedule",
  // Default of 6 hours mirrors PROPOSAL.md's example ("re-index Google
  // Drive every 6 hours"). Users can change to any positive integer.
  intervalSeconds: 6 * 60 * 60,
  triggerTemplateId: "",
  actionKind: "reindex_source",
  actionSourceId: "",
  actionTemplateId: "",
  actionSourceIds: [],
};

function parseTrigger(json: string): AutomationTrigger | null {
  try {
    const v = JSON.parse(json) as AutomationTrigger;
    return v;
  } catch {
    return null;
  }
}

function parseAction(json: string): AutomationAction | null {
  try {
    const v = JSON.parse(json) as AutomationAction;
    return v;
  } catch {
    return null;
  }
}

function formatInterval(seconds: number): string {
  if (seconds < 60) return `every ${seconds}s`;
  const m = Math.round(seconds / 60);
  if (m < 60) return `every ${m}m`;
  const h = Math.round(seconds / 3600);
  if (h < 48) return `every ${h}h`;
  const d = Math.round(seconds / 86400);
  return `every ${d}d`;
}

function formatTrigger(t: AutomationTrigger | null): string {
  if (!t) return "(invalid trigger)";
  switch (t.kind) {
    case "schedule":
      return `Schedule: ${formatInterval(t.interval_seconds)}`;
    case "on_generate":
      return `On generate (template ${t.template_id.slice(0, 8)}…)`;
    case "on_kchat_message_match":
      return `On KChat message in ${t.channel_id.slice(0, 8)}… matching /${t.regex}/`;
  }
}

function formatAction(a: AutomationAction | null): string {
  if (!a) return "(invalid action)";
  switch (a.kind) {
    case "reindex_source":
      return `Reindex source ${a.source_id.slice(0, 8)}…`;
    case "generate_from_template":
      return `Generate from template ${a.template_id.slice(0, 8)}… using ${a.source_ids.length} source(s)`;
    case "sequence":
      return a.actions.length === 0
        ? "Sequence (no steps)"
        : `Sequence: ${a.actions.map(formatAction).join(" → ")}`;
  }
}

function formatTimestamp(iso: string | null): string {
  if (!iso) return "—";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  return d.toLocaleString(undefined, {
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

export default function AutomationsPage() {
  const cspNonce = useCspNonce();
  const { automations, loading, error, refresh } = useAutomationList();
  const { create, setEnabled, remove } = useAutomationMutations();
  const { sources } = useSourceList();
  const { templates } = useTemplateList();
  const {
    status: schedulerStatus,
    error: schedulerError,
    runNow,
  } = useSchedulerStatus();
  const [runNowError, setRunNowError] = useState<string | null>(null);
  const [runningNow, setRunningNow] = useState(false);
  // Visible error surface for enable/disable toggles and delete
  // operations. Without this, a failed bridge call from the inline
  // checkbox handler or the confirm-delete modal would produce an
  // unhandled promise rejection and the user would see no feedback at
  // all — the row would silently flip back on the next status poll.
  const [actionError, setActionError] = useState<string | null>(null);

  const handleRunNow = useCallback(async () => {
    setRunNowError(null);
    setRunningNow(true);
    try {
      await runNow();
      // After a manual tick the list of `lastRunAt` values likely
      // changed — refresh so the user sees the new state without
      // waiting for the next list-poll.
      await refresh();
    } catch (e) {
      setRunNowError(e instanceof Error ? e.message : String(e));
    } finally {
      setRunningNow(false);
    }
  }, [runNow, refresh]);

  const [createOpen, setCreateOpen] = useState(false);
  const [draft, setDraft] = useState<DraftAutomation>(EMPTY_DRAFT);
  const [submitError, setSubmitError] = useState<string | null>(null);
  const [submitting, setSubmitting] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState<AutomationInfo | null>(
    null,
  );

  useEffect(() => {
    if (error) console.error("[AutomationsPage] load error:", error);
  }, [error]);

  const parsed = useMemo(
    () =>
      automations.map((a) => ({
        info: a,
        trigger: parseTrigger(a.triggerJson),
        action: parseAction(a.actionJson),
      })),
    [automations],
  );

  const handleSubmitCreate = useCallback(async () => {
    if (!draft.name.trim()) {
      setSubmitError("Name is required");
      return;
    }
    let trigger: AutomationTrigger;
    if (draft.triggerKind === "schedule") {
      if (
        !Number.isFinite(draft.intervalSeconds) ||
        draft.intervalSeconds <= 0
      ) {
        setSubmitError("Schedule interval must be a positive number of seconds");
        return;
      }
      trigger = {
        kind: "schedule",
        interval_seconds: Math.round(draft.intervalSeconds),
      };
    } else if (draft.triggerKind === "on_generate") {
      if (!draft.triggerTemplateId) {
        setSubmitError("Pick a template for the on-generate trigger");
        return;
      }
      trigger = { kind: "on_generate", template_id: draft.triggerTemplateId };
    } else {
      // Exhaustive guard: the dropdown only exposes the kinds handled
      // above, so reaching here means a new `TriggerKind` was wired into
      // the UI without a create branch. Fail loudly instead of silently
      // building the wrong trigger.
      setSubmitError(`Unsupported trigger kind: ${draft.triggerKind}`);
      return;
    }

    let action: AutomationAction;
    if (draft.actionKind === "reindex_source") {
      if (!draft.actionSourceId) {
        setSubmitError("Pick a source to reindex");
        return;
      }
      action = { kind: "reindex_source", source_id: draft.actionSourceId };
    } else if (draft.actionKind === "generate_from_template") {
      if (!draft.actionTemplateId) {
        setSubmitError("Pick a template to generate from");
        return;
      }
      action = {
        kind: "generate_from_template",
        template_id: draft.actionTemplateId,
        source_ids: draft.actionSourceIds,
      };
    } else {
      // Exhaustive guard (see trigger branch above): the dropdown only
      // exposes the kinds handled here, so a new `ActionKind` reaching
      // this point is a wiring bug, not a valid create.
      setSubmitError(`Unsupported action kind: ${draft.actionKind}`);
      return;
    }

    setSubmitting(true);
    setSubmitError(null);
    try {
      await create({
        name: draft.name.trim(),
        trigger,
        action,
        enabled: true,
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

  const handleToggle = useCallback(
    async (a: AutomationInfo) => {
      setActionError(null);
      try {
        await setEnabled(a.id, !a.enabled);
        await refresh();
      } catch (e) {
        // Surface the failure rather than leaving the checkbox silently
        // reverting on the next 5-second status poll. Matches the
        // pattern used by `handleRunNow` and the TasksPage drag
        // handlers.
        setActionError(
          `Failed to ${a.enabled ? "disable" : "enable"} “${a.name}”: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }
    },
    [setEnabled, refresh],
  );

  const handleDelete = useCallback(
    async (a: AutomationInfo) => {
      setActionError(null);
      try {
        await remove(a.id);
        await refresh();
        setConfirmDelete(null);
      } catch (e) {
        // Keep the confirm modal open so the user can see the row they
        // tried to delete is still there; surface the error in the
        // page-level banner so it's visible even after they dismiss
        // the modal.
        setActionError(
          `Failed to delete “${a.name}”: ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
        setConfirmDelete(null);
      }
    },
    [remove, refresh],
  );

  return (
    <div className="automations-page">
      <PageHeader
        title="Automations"
        description="Schedule recurring source reindexes or fire actions when artifacts are generated."
        actions={
          <Button onClick={() => setCreateOpen(true)}>
            <Plus size={16} strokeWidth={2} aria-hidden="true" />
            <span style={{ marginLeft: 6 }}>New Automation</span>
          </Button>
        }
      />

      {/*
        Scheduler status panel. We surface the scheduler's running
        flag, last-tick timestamp, and any tick error so a user
        debugging "why didn't my reindex run?" doesn't have to open
        devtools. The "Run Now" button forces an immediate tick (for
        Schedule triggers) — handy after editing a source connector
        config and not wanting to wait 30s for the next interval.
      */}
      <div
        className="scheduler-status"
        data-testid="scheduler-status"
        role="status"
        aria-live="polite"
      >
        <div className="scheduler-status-meta">
          <span
            className={
              schedulerStatus?.running
                ? "scheduler-pill scheduler-pill-on"
                : "scheduler-pill scheduler-pill-off"
            }
          >
            <Clock size={14} strokeWidth={2} aria-hidden="true" />
            <span>
              {schedulerStatus?.running ? "Scheduler running" : "Scheduler idle"}
            </span>
          </span>
          <span className="scheduler-last-tick">
            Last tick: {formatTimestamp(schedulerStatus?.lastTickAt ?? null)}
            {schedulerStatus?.inFlight ? " (in progress)" : ""}
          </span>
        </div>
        <Button
          variant="secondary"
          onClick={() => void handleRunNow()}
          disabled={runningNow}
        >
          <Play size={14} strokeWidth={2} aria-hidden="true" />
          <span style={{ marginLeft: 6 }}>
            {runningNow ? "Running…" : "Run Now"}
          </span>
        </Button>
      </div>

      {(schedulerStatus?.lastTickError ||
        schedulerError ||
        runNowError ||
        actionError) && (
        <div role="alert" className="scheduler-error">
          <AlertCircle size={16} strokeWidth={2} aria-hidden="true" />
          <span>
            {actionError ||
              runNowError ||
              schedulerError ||
              schedulerStatus?.lastTickError}
          </span>
          {actionError && (
            <button
              type="button"
              onClick={() => setActionError(null)}
              aria-label="Dismiss error"
              style={{
                marginLeft: "auto",
                background: "transparent",
                border: "none",
                color: "inherit",
                cursor: "pointer",
                fontSize: "1.1rem",
                lineHeight: 1,
              }}
            >
              ×
            </button>
          )}
        </div>
      )}

      {loading && automations.length === 0 && (
        <div className="automations-loading">Loading automations…</div>
      )}

      {!loading && automations.length === 0 && (
        <EmptyState
          icon={<Zap size={48} strokeWidth={1.5} aria-hidden="true" />}
          title="No automations yet"
          message="Set up scheduled reindexes or template-triggered workflows to keep sources fresh and artifacts in sync."
          action={
            <Button onClick={() => setCreateOpen(true)}>
              Create automation
            </Button>
          }
        />
      )}

      {parsed.length > 0 && (
        <ul className="automation-list">
          {parsed.map(({ info, trigger, action }) => (
            <li key={info.id} className="automation-row">
              <div className="automation-row-head">
                <div className="automation-row-title-wrap">
                  <h3 className="automation-row-title">{info.name}</h3>
                  <label className="automation-toggle">
                    <input
                      type="checkbox"
                      checked={info.enabled}
                      onChange={() => void handleToggle(info)}
                    />
                    <span>{info.enabled ? "Enabled" : "Paused"}</span>
                  </label>
                </div>
                <button
                  className="automation-delete"
                  aria-label="Delete automation"
                  onClick={() => setConfirmDelete(info)}
                >
                  <Trash2 size={16} strokeWidth={1.75} />
                </button>
              </div>
              <div className="automation-row-meta">
                <div>
                  <strong>Trigger:</strong> {formatTrigger(trigger)}
                </div>
                <div>
                  <strong>Action:</strong> {formatAction(action)}
                </div>
                <div className="automation-row-stats">
                  <span>
                    <Clock size={12} strokeWidth={1.75} aria-hidden />
                    Last run: {formatTimestamp(info.lastRunAt)}
                    {info.lastRunStatus ? ` (${info.lastRunStatus})` : ""}
                  </span>
                  {info.nextScheduledAt && (
                    <span>
                      Next: {formatTimestamp(info.nextScheduledAt)}
                    </span>
                  )}
                </div>
              </div>
            </li>
          ))}
        </ul>
      )}

      <Modal
        isOpen={createOpen}
        onClose={() => {
          setCreateOpen(false);
          setSubmitError(null);
          setDraft(EMPTY_DRAFT);
        }}
        title="New Automation"
      >
        <form
          className="automation-form"
          onSubmit={(e) => {
            e.preventDefault();
            void handleSubmitCreate();
          }}
        >
          <label className="automation-form-field">
            <span>Name</span>
            <input
              autoFocus
              type="text"
              value={draft.name}
              onChange={(e) =>
                setDraft((d) => ({ ...d, name: e.target.value }))
              }
              required
              maxLength={120}
            />
          </label>

          <fieldset className="automation-form-section">
            <legend>Trigger</legend>
            <label className="automation-form-field">
              <span>Type</span>
              <select
                value={draft.triggerKind}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    triggerKind: e.target.value as TriggerKind,
                  }))
                }
              >
                <option value="schedule">Schedule</option>
                <option value="on_generate">When a template is generated</option>
              </select>
            </label>
            {draft.triggerKind === "schedule" && (
              <label className="automation-form-field">
                <span>Interval (seconds)</span>
                <input
                  type="number"
                  min={1}
                  step={1}
                  value={draft.intervalSeconds}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      intervalSeconds: Number(e.target.value),
                    }))
                  }
                />
                <small className="automation-form-hint">
                  {formatInterval(draft.intervalSeconds)}
                </small>
              </label>
            )}
            {draft.triggerKind === "on_generate" && (
              <label className="automation-form-field">
                <span>Template</span>
                <select
                  value={draft.triggerTemplateId}
                  onChange={(e) =>
                    setDraft((d) => ({
                      ...d,
                      triggerTemplateId: e.target.value,
                    }))
                  }
                >
                  <option value="">(choose…)</option>
                  {templates.map((t) => (
                    <option key={t.id} value={t.id}>
                      {t.name}
                    </option>
                  ))}
                </select>
              </label>
            )}
          </fieldset>

          <fieldset className="automation-form-section">
            <legend>Action</legend>
            <label className="automation-form-field">
              <span>Type</span>
              <select
                value={draft.actionKind}
                onChange={(e) =>
                  setDraft((d) => ({
                    ...d,
                    actionKind: e.target.value as ActionKind,
                  }))
                }
              >
                <option value="reindex_source">Reindex a source</option>
                <option value="generate_from_template">
                  Generate from a template
                </option>
              </select>
            </label>
            {draft.actionKind === "reindex_source" && (
              <label className="automation-form-field">
                <span>Source</span>
                <select
                  value={draft.actionSourceId}
                  onChange={(e) =>
                    setDraft((d) => ({ ...d, actionSourceId: e.target.value }))
                  }
                >
                  <option value="">(choose…)</option>
                  {sources.map((s) => (
                    <option key={s.id} value={s.id}>
                      {s.path}
                    </option>
                  ))}
                </select>
              </label>
            )}
            {draft.actionKind === "generate_from_template" && (
              <>
                <label className="automation-form-field">
                  <span>Template</span>
                  <select
                    value={draft.actionTemplateId}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        actionTemplateId: e.target.value,
                      }))
                    }
                  >
                    <option value="">(choose…)</option>
                    {templates.map((t) => (
                      <option key={t.id} value={t.id}>
                        {t.name}
                      </option>
                    ))}
                  </select>
                </label>
                <label className="automation-form-field">
                  <span>Sources (Cmd/Ctrl-click to multi-select)</span>
                  <select
                    multiple
                    value={draft.actionSourceIds}
                    onChange={(e) =>
                      setDraft((d) => ({
                        ...d,
                        actionSourceIds: Array.from(
                          e.target.selectedOptions,
                          (o) => o.value,
                        ),
                      }))
                    }
                    size={Math.min(6, Math.max(3, sources.length))}
                  >
                    {sources.map((s) => (
                      <option key={s.id} value={s.id}>
                        {s.path}
                      </option>
                    ))}
                  </select>
                </label>
              </>
            )}
          </fieldset>

          {submitError && (
            <div role="alert" className="automation-form-error">
              {submitError}
            </div>
          )}
          <div className="automation-form-actions">
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
        title="Delete automation?"
      >
        <p>
          This will permanently remove
          {confirmDelete ? ` "${confirmDelete.name}"` : " this automation"}.
        </p>
        <div className="automation-form-actions">
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

      <style nonce={cspNonce}>{`
        .scheduler-status {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--spacing-md);
          margin: var(--spacing-md) 0;
          padding: var(--spacing-sm) var(--spacing-md);
          background: var(--color-bg-subtle, #f8fafc);
          border: 1px solid var(--color-border, #e2e8f0);
          border-radius: var(--radius-md, 6px);
        }
        .scheduler-status-meta {
          display: flex;
          align-items: center;
          gap: var(--spacing-md);
          flex-wrap: wrap;
        }
        .scheduler-pill {
          display: inline-flex;
          align-items: center;
          gap: var(--spacing-xs);
          padding: 2px var(--spacing-sm);
          border-radius: 999px;
          font-size: var(--font-size-sm);
          font-weight: 500;
        }
        .scheduler-pill-on {
          background: var(--color-success-subtle, #ecfdf5);
          color: var(--color-success, #047857);
        }
        .scheduler-pill-off {
          background: var(--color-bg-muted, #e2e8f0);
          color: var(--color-text-secondary, #475569);
        }
        .scheduler-last-tick {
          font-size: var(--font-size-sm);
          color: var(--color-text-secondary, #475569);
        }
        .scheduler-error {
          display: flex;
          align-items: center;
          gap: var(--spacing-sm);
          margin: var(--spacing-md) 0;
          padding: var(--spacing-sm) var(--spacing-md);
          background: var(--color-danger-subtle, #fef2f2);
          color: var(--color-danger, #b91c1c);
          border: 1px solid var(--color-danger, #b91c1c);
          border-radius: var(--radius-md, 6px);
          font-size: var(--font-size-sm);
        }
        .automations-loading {
          padding: var(--spacing-xl);
          color: var(--color-text-secondary);
        }
        .automation-list {
          list-style: none;
          padding: 0;
          margin: 0;
          display: flex;
          flex-direction: column;
          gap: var(--spacing-sm);
        }
        .automation-row {
          background: var(--color-bg-elevated, #fff);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          padding: var(--spacing-md);
          display: flex;
          flex-direction: column;
          gap: var(--spacing-sm);
        }
        .automation-row-head {
          display: flex;
          align-items: center;
          justify-content: space-between;
          gap: var(--spacing-md);
        }
        .automation-row-title-wrap {
          display: flex;
          align-items: center;
          gap: var(--spacing-md);
        }
        .automation-row-title {
          margin: 0;
          font-size: var(--font-size-md);
          font-weight: var(--font-weight-semibold);
        }
        .automation-toggle {
          display: inline-flex;
          align-items: center;
          gap: 6px;
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
        }
        .automation-delete {
          background: transparent;
          border: none;
          color: var(--color-text-secondary);
          cursor: pointer;
          padding: 4px;
          border-radius: 4px;
        }
        .automation-delete:hover {
          color: var(--color-danger, #b91c1c);
          background: var(--color-danger-light, #fef2f2);
        }
        .automation-row-meta {
          display: flex;
          flex-direction: column;
          gap: 4px;
          font-size: var(--font-size-sm);
          color: var(--color-text-body);
        }
        .automation-row-stats {
          display: flex;
          gap: var(--spacing-md);
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
        }
        .automation-row-stats span {
          display: inline-flex;
          align-items: center;
          gap: 4px;
        }
        .automation-form {
          display: flex;
          flex-direction: column;
          gap: var(--spacing-sm);
        }
        .automation-form-field {
          display: flex;
          flex-direction: column;
          gap: 4px;
        }
        .automation-form-field span {
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
        }
        .automation-form-field input,
        .automation-form-field select {
          padding: 6px 8px;
          border: 1px solid var(--color-border);
          border-radius: var(--radius-input);
          font-size: var(--font-size-sm);
        }
        .automation-form-section {
          border: 1px solid var(--color-border);
          border-radius: var(--radius-md);
          padding: var(--spacing-sm);
          display: flex;
          flex-direction: column;
          gap: var(--spacing-sm);
        }
        .automation-form-section legend {
          padding: 0 var(--spacing-xs);
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
          font-weight: var(--font-weight-semibold);
          text-transform: uppercase;
          letter-spacing: 0.5px;
        }
        .automation-form-hint {
          font-size: var(--font-size-xs);
          color: var(--color-text-secondary);
        }
        .automation-form-error {
          color: var(--color-danger, #b91c1c);
          font-size: var(--font-size-xs);
          padding: 6px 8px;
          background: var(--color-danger-light, #fef2f2);
          border-radius: var(--radius-input);
        }
        .automation-form-actions {
          display: flex;
          justify-content: flex-end;
          gap: var(--spacing-sm);
          margin-top: var(--spacing-sm);
        }
      `}</style>
    </div>
  );
}
