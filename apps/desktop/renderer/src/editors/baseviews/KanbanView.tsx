/**
 * Kanban view for Bases.
 *
 * Groups records into columns by the value of a user-selected `select`
 * field. Cards can be dragged between columns; on drop, the moved
 * record's value for the group field is updated, which is the single
 * source of truth — the view rerenders from the canonical record list
 * rather than maintaining a separate column model.
 *
 * Records whose group-field value isn't in the field's `options` list
 * (e.g. legacy records from before a column was renamed) bucket into
 * an "Other" column so they remain visible and movable rather than
 * silently disappearing.
 */
import { DragEvent, useMemo, useState } from "react";
import type { BaseField } from "../baseEditorTypes";
import type { BaseViewProps } from "./types";

const OTHER_COLUMN = "__other__";

export default function KanbanView({
  data,
  onUpdateCell,
  onConfigChange,
  config,
  onAddRecordWith,
}: BaseViewProps) {
  const selectFields = data.fields.filter((f) => f.type === "select");
  const groupField =
    data.fields.find((f) => f.name === config.kanbanGroupField) ?? null;

  const titleField = config.titleField;

  const [dragRecordIndex, setDragRecordIndex] = useState<number | null>(null);
  const [hoverColumn, setHoverColumn] = useState<string | null>(null);

  const columns = useMemo(() => {
    if (!groupField) return [];
    return [...(groupField.options ?? []), OTHER_COLUMN];
  }, [groupField]);

  // Group records by their value in the kanban field. Build an
  // index-based map so we can look up the original `records` index
  // when dispatching `onUpdateCell` after a drop.
  const recordsByColumn = useMemo(() => {
    const map = new Map<string, { record: Record<string, unknown>; index: number }[]>();
    if (!groupField) return map;
    const knownOptions = new Set(groupField.options ?? []);
    for (let i = 0; i < data.records.length; i++) {
      const r = data.records[i];
      const rawVal = r[groupField.name];
      const val = rawVal == null ? "" : String(rawVal);
      const bucket =
        val === "" || !knownOptions.has(val) ? OTHER_COLUMN : val;
      const list = map.get(bucket) ?? [];
      list.push({ record: r, index: i });
      map.set(bucket, list);
    }
    return map;
  }, [data.records, groupField]);

  if (selectFields.length === 0) {
    return (
      <EmptyState
        title="No select field to group by"
        description="Add a select field (with options for each column) to use the Kanban view."
      />
    );
  }

  if (!groupField) {
    return (
      <KanbanFieldPicker
        selectFields={selectFields}
        onPick={(name) =>
          onConfigChange({ ...config, kanbanGroupField: name })
        }
      />
    );
  }

  const onDragStart = (e: DragEvent<HTMLDivElement>, index: number) => {
    setDragRecordIndex(index);
    // setData with an effectAllowed/move dataTransfer is required by
    // Firefox to actually fire `drop` events; the payload itself is
    // unused since we keep state in React.
    e.dataTransfer.effectAllowed = "move";
    e.dataTransfer.setData("text/plain", String(index));
  };

  const onDragEnd = () => {
    setDragRecordIndex(null);
    setHoverColumn(null);
  };

  const onDragOverColumn = (e: DragEvent<HTMLDivElement>, column: string) => {
    e.preventDefault();
    e.dataTransfer.dropEffect = "move";
    setHoverColumn(column);
  };

  const onDropColumn = (e: DragEvent<HTMLDivElement>, column: string) => {
    e.preventDefault();
    setHoverColumn(null);
    if (dragRecordIndex == null) return;
    // The "Other" pseudo-column is a displayed-only catchall — it's not
    // an actual option the user can assign by dragging. Dropping onto
    // it (including a re-drop onto the column the card was already in)
    // MUST be a no-op: previously this branch overwrote whatever value
    // the card had (e.g. a legacy "Archived" string from before the
    // option was renamed) with "" because `String("Archived") !== ""`
    // bypassed the same-value guard below, silently destroying the
    // legacy data the card was showing.
    if (column === OTHER_COLUMN) {
      setDragRecordIndex(null);
      return;
    }
    const current = data.records[dragRecordIndex]?.[groupField.name];
    if (String(current ?? "") === column) {
      setDragRecordIndex(null);
      return;
    }
    onUpdateCell(dragRecordIndex, groupField.name, column);
    setDragRecordIndex(null);
  };

  return (
    <div
      className="base-kanban"
      style={{ display: "flex", gap: "1rem", overflowX: "auto", padding: "0.75rem" }}
    >
      {columns.map((column) => {
        const isOther = column === OTHER_COLUMN;
        const recs = recordsByColumn.get(column) ?? [];
        const isHover = hoverColumn === column;
        return (
          <div
            key={column}
            onDragOver={(e) => onDragOverColumn(e, column)}
            onDrop={(e) => onDropColumn(e, column)}
            style={{
              flex: "0 0 280px",
              background: isHover
                ? "var(--color-surface-hover, #f3f4f6)"
                : "var(--color-surface, #f9fafb)",
              borderRadius: "0.5rem",
              padding: "0.75rem",
              border: isHover
                ? "1px solid var(--color-primary, #7C3AED)"
                : "1px solid var(--color-border, #e5e7eb)",
              minHeight: "200px",
              display: "flex",
              flexDirection: "column",
              gap: "0.5rem",
            }}
          >
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                fontWeight: 600,
                fontSize: "0.875rem",
                color: isOther ? "var(--color-text-secondary, #6b7280)" : "inherit",
              }}
            >
              {/* Keep the column name and count in a single text node
                  so the header is queryable as one string (test
                  selectors and screen readers both prefer this). */}
              <span data-testid={`kanban-column-header-${isOther ? "other" : column}`}>
                {`${isOther ? "Other" : column} (${recs.length})`}
              </span>
              {!isOther && (
                <button
                  type="button"
                  className="btn-sm"
                  title="Add card to this column"
                  onClick={() =>
                    onAddRecordWith({ [groupField.name]: column })
                  }
                  style={{
                    padding: "0.125rem 0.4rem",
                    fontSize: "0.75rem",
                  }}
                >
                  +
                </button>
              )}
            </div>
            {recs.map(({ record, index }) => (
              // Key on the stable record id so React reconciles each
              // card by identity. Previously we keyed on the array
              // index, which meant any move between columns (or a
              // delete) caused React to swap the *content* of two
              // cards rather than transplanting the card itself --
              // visible as DOM input focus / drag state being lost on
              // reorder.
              <KanbanCard
                key={
                  typeof record.id === "string" ? record.id : String(index)
                }
                record={record}
                fields={data.fields}
                titleField={titleField}
                draggable
                onDragStart={(e) => onDragStart(e, index)}
                onDragEnd={onDragEnd}
                isDragging={dragRecordIndex === index}
              />
            ))}
            {recs.length === 0 && (
              <div
                style={{
                  fontSize: "0.75rem",
                  color: "var(--color-text-secondary, #9ca3af)",
                  fontStyle: "italic",
                  textAlign: "center",
                  marginTop: "1rem",
                }}
              >
                Drop here
              </div>
            )}
          </div>
        );
      })}
    </div>
  );
}

function KanbanCard({
  record,
  fields,
  titleField,
  draggable,
  onDragStart,
  onDragEnd,
  isDragging,
}: {
  record: Record<string, unknown>;
  fields: BaseField[];
  titleField: string | null;
  draggable: boolean;
  onDragStart: (e: DragEvent<HTMLDivElement>) => void;
  onDragEnd: () => void;
  isDragging: boolean;
}) {
  const title = titleField
    ? String(record[titleField] ?? "(untitled)")
    : "(untitled)";
  // Subtitle: show up to two non-title, non-empty fields so the card
  // carries enough info to be identifiable while dragging without
  // making the card massive.
  const subtitleFields = fields
    .filter((f) => f.name !== titleField)
    .map((f) => ({ name: f.name, value: record[f.name] }))
    .filter(({ value }) => value != null && String(value) !== "")
    .slice(0, 2);

  return (
    <div
      draggable={draggable}
      onDragStart={onDragStart}
      onDragEnd={onDragEnd}
      style={{
        background: "var(--color-bg, #fff)",
        border: "1px solid var(--color-border, #e5e7eb)",
        borderRadius: "0.375rem",
        padding: "0.5rem 0.625rem",
        cursor: "grab",
        opacity: isDragging ? 0.4 : 1,
        boxShadow: "0 1px 2px rgba(0,0,0,0.04)",
      }}
    >
      <div style={{ fontWeight: 500, fontSize: "0.875rem" }}>{title}</div>
      {subtitleFields.map(({ name, value }) => (
        <div
          key={name}
          style={{
            fontSize: "0.75rem",
            color: "var(--color-text-secondary, #6b7280)",
            marginTop: "0.125rem",
          }}
        >
          <span style={{ fontWeight: 500 }}>{name}:</span> {String(value)}
        </div>
      ))}
    </div>
  );
}

function KanbanFieldPicker({
  selectFields,
  onPick,
}: {
  selectFields: BaseField[];
  onPick: (name: string) => void;
}) {
  return (
    <div
      style={{
        padding: "2rem",
        textAlign: "center",
        color: "var(--color-text-secondary, #6b7280)",
      }}
    >
      <div style={{ marginBottom: "0.5rem" }}>
        Pick a select field to use as kanban columns:
      </div>
      <select
        defaultValue=""
        onChange={(e) => {
          if (e.target.value) onPick(e.target.value);
        }}
        style={{ padding: "0.25rem 0.5rem" }}
      >
        <option value="">— choose —</option>
        {selectFields.map((f) => (
          <option key={f.name} value={f.name}>
            {f.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function EmptyState({
  title,
  description,
}: {
  title: string;
  description: string;
}) {
  return (
    <div
      style={{
        padding: "3rem 1.5rem",
        textAlign: "center",
        color: "var(--color-text-secondary, #6b7280)",
      }}
    >
      <div style={{ fontWeight: 600, marginBottom: "0.5rem" }}>{title}</div>
      <div style={{ fontSize: "0.875rem" }}>{description}</div>
    </div>
  );
}
