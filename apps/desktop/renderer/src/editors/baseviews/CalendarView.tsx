/**
 * Calendar view for Bases.
 *
 * Records that have a value in the configured `date` field are placed
 * on the calendar at that date. The user can navigate month / week /
 * day, click an empty day to create a new record pre-populated with
 * that date, or click an existing record chip to edit it inline.
 *
 * Dates are interpreted as local YYYY-MM-DD strings (the `<input
 * type="date">` browser format we already use in CellInput), matching
 * how BaseEditor's cell input stores them. No timezone math is done —
 * the view operates entirely in the user's local wall-clock.
 */
import { useMemo, useState } from "react";
import type { BaseField } from "../BaseEditor";
import type { BaseViewProps } from "./types";

type CalendarMode = "month" | "week" | "day";

export default function CalendarView({
  data,
  onConfigChange,
  config,
  onAddRecordWith,
  onUpdateCell,
}: BaseViewProps) {
  const dateFields = data.fields.filter((f) => f.type === "date");
  const dateField =
    data.fields.find((f) => f.name === config.calendarDateField) ?? null;

  // Anchor date controls which month/week/day is visible. Initialize
  // to today so the calendar opens to "now" rather than 1970.
  const [anchor, setAnchor] = useState<Date>(() => startOfDay(new Date()));
  const [mode, setMode] = useState<CalendarMode>("month");

  // Index records by their YYYY-MM-DD key so day-cell lookups are
  // O(1) instead of scanning every record per cell.
  const recordsByDay = useMemo(() => {
    const map = new Map<string, { record: Record<string, unknown>; index: number }[]>();
    if (!dateField) return map;
    for (let i = 0; i < data.records.length; i++) {
      const r = data.records[i];
      const raw = r[dateField.name];
      if (raw == null || raw === "") continue;
      const key = String(raw);
      if (!/^\d{4}-\d{2}-\d{2}/.test(key)) continue;
      // Use only the YYYY-MM-DD prefix so an ISO datetime ("2026-05-20T13:00")
      // still indexes to its calendar day.
      const dayKey = key.slice(0, 10);
      const list = map.get(dayKey) ?? [];
      list.push({ record: r, index: i });
      map.set(dayKey, list);
    }
    return map;
  }, [data.records, dateField]);

  if (dateFields.length === 0) {
    return (
      <EmptyMessage
        title="No date field"
        description="Add a date field to use the Calendar view."
      />
    );
  }
  if (!dateField) {
    return (
      <DateFieldPicker
        dateFields={dateFields}
        onPick={(name) =>
          onConfigChange({ ...config, calendarDateField: name })
        }
      />
    );
  }

  const navigate = (delta: number) => {
    const next = new Date(anchor);
    if (mode === "month") next.setMonth(next.getMonth() + delta);
    else if (mode === "week") next.setDate(next.getDate() + delta * 7);
    else next.setDate(next.getDate() + delta);
    setAnchor(next);
  };

  return (
    <div className="base-calendar" style={{ padding: "0.75rem" }}>
      <Toolbar
        anchor={anchor}
        mode={mode}
        onMode={setMode}
        onPrev={() => navigate(-1)}
        onNext={() => navigate(+1)}
        onToday={() => setAnchor(startOfDay(new Date()))}
        dateField={dateField}
        dateFields={dateFields}
        onDateFieldChange={(name) =>
          onConfigChange({ ...config, calendarDateField: name })
        }
      />
      {mode === "month" && (
        <MonthGrid
          anchor={anchor}
          recordsByDay={recordsByDay}
          titleField={config.titleField}
          dateField={dateField}
          onAddOnDay={(key) =>
            onAddRecordWith({ [dateField.name]: key })
          }
          onMoveRecord={(recordIndex, newKey) =>
            onUpdateCell(recordIndex, dateField.name, newKey)
          }
        />
      )}
      {mode === "week" && (
        <WeekStrip
          anchor={anchor}
          recordsByDay={recordsByDay}
          titleField={config.titleField}
          dateField={dateField}
          onAddOnDay={(key) =>
            onAddRecordWith({ [dateField.name]: key })
          }
        />
      )}
      {mode === "day" && (
        <DayPane
          anchor={anchor}
          recordsByDay={recordsByDay}
          titleField={config.titleField}
          dateField={dateField}
          onAddOnDay={(key) =>
            onAddRecordWith({ [dateField.name]: key })
          }
        />
      )}
    </div>
  );
}

function Toolbar({
  anchor,
  mode,
  onMode,
  onPrev,
  onNext,
  onToday,
  dateField,
  dateFields,
  onDateFieldChange,
}: {
  anchor: Date;
  mode: CalendarMode;
  onMode: (m: CalendarMode) => void;
  onPrev: () => void;
  onNext: () => void;
  onToday: () => void;
  dateField: BaseField;
  dateFields: BaseField[];
  onDateFieldChange: (name: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.5rem",
        marginBottom: "0.75rem",
        flexWrap: "wrap",
      }}
    >
      <button type="button" className="btn-sm" onClick={onPrev}>
        ←
      </button>
      <button type="button" className="btn-sm" onClick={onToday}>
        Today
      </button>
      <button type="button" className="btn-sm" onClick={onNext}>
        →
      </button>
      <strong style={{ marginLeft: "0.5rem" }}>{formatHeader(anchor, mode)}</strong>
      <div style={{ flex: 1 }} />
      <label
        style={{
          fontSize: "0.75rem",
          color: "var(--color-text-secondary, #6b7280)",
        }}
      >
        Date field:&nbsp;
        <select
          value={dateField.name}
          onChange={(e) => onDateFieldChange(e.target.value)}
        >
          {dateFields.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}
            </option>
          ))}
        </select>
      </label>
      <div style={{ display: "flex", gap: "0.25rem" }}>
        {(["month", "week", "day"] as CalendarMode[]).map((m) => (
          <button
            key={m}
            type="button"
            className="btn-sm"
            onClick={() => onMode(m)}
            style={{
              fontWeight: mode === m ? 600 : 400,
              background:
                mode === m
                  ? "var(--color-primary-soft, #ede9fe)"
                  : "transparent",
            }}
          >
            {m[0].toUpperCase() + m.slice(1)}
          </button>
        ))}
      </div>
    </div>
  );
}

function MonthGrid({
  anchor,
  recordsByDay,
  titleField,
  dateField,
  onAddOnDay,
  onMoveRecord,
}: {
  anchor: Date;
  recordsByDay: Map<string, { record: Record<string, unknown>; index: number }[]>;
  titleField: string | null;
  dateField: BaseField;
  onAddOnDay: (key: string) => void;
  onMoveRecord: (recordIndex: number, newKey: string) => void;
}) {
  const cells = monthCells(anchor);
  const monthIndex = anchor.getMonth();
  return (
    <div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          gap: "1px",
          background: "var(--color-border, #e5e7eb)",
          border: "1px solid var(--color-border, #e5e7eb)",
        }}
      >
        {["Sun", "Mon", "Tue", "Wed", "Thu", "Fri", "Sat"].map((d) => (
          <div
            key={d}
            style={{
              background: "var(--color-surface, #f9fafb)",
              padding: "0.5rem",
              fontSize: "0.75rem",
              fontWeight: 600,
              textAlign: "center",
              color: "var(--color-text-secondary, #6b7280)",
            }}
          >
            {d}
          </div>
        ))}
        {cells.map((d) => {
          const key = ymd(d);
          const inMonth = d.getMonth() === monthIndex;
          const recs = recordsByDay.get(key) ?? [];
          return (
            <div
              key={key}
              onClick={() => onAddOnDay(key)}
              onDragOver={(e) => e.preventDefault()}
              onDrop={(e) => {
                e.preventDefault();
                const raw = e.dataTransfer.getData("text/plain");
                const idx = Number.parseInt(raw, 10);
                if (Number.isFinite(idx)) onMoveRecord(idx, key);
              }}
              role="button"
              tabIndex={0}
              title={`Click to add a record on ${key}`}
              style={{
                background: inMonth
                  ? "var(--color-bg, #fff)"
                  : "var(--color-surface, #f9fafb)",
                minHeight: "88px",
                padding: "0.25rem",
                cursor: "pointer",
                display: "flex",
                flexDirection: "column",
                gap: "0.125rem",
                color: inMonth
                  ? "inherit"
                  : "var(--color-text-secondary, #9ca3af)",
              }}
            >
              <div
                style={{
                  fontSize: "0.75rem",
                  fontWeight: 500,
                  textAlign: "right",
                }}
              >
                {d.getDate()}
              </div>
              {recs.slice(0, 3).map(({ record, index }) => (
                <div
                  key={index}
                  draggable
                  onDragStart={(e) => {
                    e.stopPropagation();
                    e.dataTransfer.effectAllowed = "move";
                    e.dataTransfer.setData("text/plain", String(index));
                  }}
                  onClick={(e) => e.stopPropagation()}
                  title={titleField ? String(record[titleField] ?? "") : ""}
                  style={{
                    fontSize: "0.7rem",
                    background: "var(--color-primary, #7C3AED)",
                    color: "#fff",
                    padding: "0.125rem 0.375rem",
                    borderRadius: "0.25rem",
                    whiteSpace: "nowrap",
                    overflow: "hidden",
                    textOverflow: "ellipsis",
                  }}
                >
                  {titleField
                    ? String(record[titleField] ?? "(untitled)")
                    : `Record ${index + 1}`}
                </div>
              ))}
              {recs.length > 3 && (
                <div
                  style={{
                    fontSize: "0.7rem",
                    color: "var(--color-text-secondary, #6b7280)",
                  }}
                >
                  +{recs.length - 3} more
                </div>
              )}
            </div>
          );
        })}
      </div>
      <div
        style={{
          marginTop: "0.5rem",
          fontSize: "0.75rem",
          color: "var(--color-text-secondary, #6b7280)",
        }}
      >
        Date field: <strong>{dateField.name}</strong> · click a day to add ·
        drag a chip to reschedule
      </div>
    </div>
  );
}

function WeekStrip({
  anchor,
  recordsByDay,
  titleField,
  onAddOnDay,
  dateField,
}: {
  anchor: Date;
  recordsByDay: Map<string, { record: Record<string, unknown>; index: number }[]>;
  titleField: string | null;
  onAddOnDay: (key: string) => void;
  dateField: BaseField;
}) {
  const days = weekDays(anchor);
  return (
    <div>
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(7, 1fr)",
          gap: "0.5rem",
        }}
      >
        {days.map((d) => {
          const key = ymd(d);
          const recs = recordsByDay.get(key) ?? [];
          return (
            <div
              key={key}
              onClick={() => onAddOnDay(key)}
              role="button"
              tabIndex={0}
              style={{
                border: "1px solid var(--color-border, #e5e7eb)",
                borderRadius: "0.375rem",
                padding: "0.5rem",
                minHeight: "200px",
                cursor: "pointer",
                background: "var(--color-bg, #fff)",
              }}
            >
              <div style={{ fontSize: "0.75rem", fontWeight: 600 }}>
                {d.toLocaleDateString(undefined, {
                  weekday: "short",
                  month: "short",
                  day: "numeric",
                })}
              </div>
              <div
                style={{
                  display: "flex",
                  flexDirection: "column",
                  gap: "0.25rem",
                  marginTop: "0.25rem",
                }}
              >
                {recs.map(({ record, index }) => (
                  <div
                    key={index}
                    onClick={(e) => e.stopPropagation()}
                    style={{
                      fontSize: "0.75rem",
                      background: "var(--color-primary, #7C3AED)",
                      color: "#fff",
                      padding: "0.125rem 0.375rem",
                      borderRadius: "0.25rem",
                    }}
                  >
                    {titleField
                      ? String(record[titleField] ?? "(untitled)")
                      : `Record ${index + 1}`}
                  </div>
                ))}
                {recs.length === 0 && (
                  <span
                    style={{
                      fontSize: "0.7rem",
                      color: "var(--color-text-secondary, #9ca3af)",
                      fontStyle: "italic",
                    }}
                  >
                    Click to add
                  </span>
                )}
              </div>
            </div>
          );
        })}
      </div>
      <div
        style={{
          marginTop: "0.5rem",
          fontSize: "0.75rem",
          color: "var(--color-text-secondary, #6b7280)",
        }}
      >
        Date field: <strong>{dateField.name}</strong>
      </div>
    </div>
  );
}

function DayPane({
  anchor,
  recordsByDay,
  titleField,
  onAddOnDay,
  dateField,
}: {
  anchor: Date;
  recordsByDay: Map<string, { record: Record<string, unknown>; index: number }[]>;
  titleField: string | null;
  onAddOnDay: (key: string) => void;
  dateField: BaseField;
}) {
  const key = ymd(anchor);
  const recs = recordsByDay.get(key) ?? [];
  return (
    <div
      style={{
        border: "1px solid var(--color-border, #e5e7eb)",
        borderRadius: "0.5rem",
        padding: "1rem",
        background: "var(--color-bg, #fff)",
      }}
    >
      <div style={{ marginBottom: "0.75rem", fontWeight: 600 }}>
        {anchor.toLocaleDateString(undefined, {
          weekday: "long",
          year: "numeric",
          month: "long",
          day: "numeric",
        })}
      </div>
      {recs.length === 0 && (
        <div
          style={{
            color: "var(--color-text-secondary, #9ca3af)",
            fontStyle: "italic",
            marginBottom: "0.75rem",
          }}
        >
          No records for this day.
        </div>
      )}
      <div style={{ display: "flex", flexDirection: "column", gap: "0.375rem" }}>
        {recs.map(({ record, index }) => (
          <div
            key={index}
            style={{
              background: "var(--color-primary-soft, #ede9fe)",
              color: "var(--color-primary, #7C3AED)",
              padding: "0.375rem 0.5rem",
              borderRadius: "0.375rem",
              fontSize: "0.875rem",
            }}
          >
            {titleField
              ? String(record[titleField] ?? "(untitled)")
              : `Record ${index + 1}`}
          </div>
        ))}
      </div>
      <button
        type="button"
        className="btn-sm"
        onClick={() => onAddOnDay(key)}
        style={{ marginTop: "0.75rem" }}
      >
        + Record on this day
      </button>
      <div
        style={{
          marginTop: "0.5rem",
          fontSize: "0.75rem",
          color: "var(--color-text-secondary, #6b7280)",
        }}
      >
        Date field: <strong>{dateField.name}</strong>
      </div>
    </div>
  );
}

function DateFieldPicker({
  dateFields,
  onPick,
}: {
  dateFields: BaseField[];
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
        Pick a date field to drive the calendar:
      </div>
      <select
        defaultValue=""
        onChange={(e) => e.target.value && onPick(e.target.value)}
      >
        <option value="">— choose —</option>
        {dateFields.map((f) => (
          <option key={f.name} value={f.name}>
            {f.name}
          </option>
        ))}
      </select>
    </div>
  );
}

function EmptyMessage({
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

// --- Date helpers (local-time, no timezone math) -------------------------

function startOfDay(d: Date): Date {
  const c = new Date(d);
  c.setHours(0, 0, 0, 0);
  return c;
}

/**
 * Build the 6×7 month grid that includes the first-of-month and pads
 * with adjacent-month days at the start/end so every visible row has
 * 7 cells. Returns 42 consecutive `Date`s with `getMonth() === anchor`
 * for in-month days and other months for the padding.
 */
function monthCells(anchor: Date): Date[] {
  const year = anchor.getFullYear();
  const month = anchor.getMonth();
  const firstOfMonth = new Date(year, month, 1);
  const startDow = firstOfMonth.getDay(); // 0 = Sun
  const cells: Date[] = [];
  // 6 weeks × 7 days = 42 cells covers any month layout (even 31-day
  // months that start on Saturday).
  for (let i = 0; i < 42; i++) {
    const d = new Date(year, month, 1 - startDow + i);
    cells.push(d);
  }
  return cells;
}

function weekDays(anchor: Date): Date[] {
  const dow = anchor.getDay();
  const sunday = new Date(anchor);
  sunday.setDate(anchor.getDate() - dow);
  const days: Date[] = [];
  for (let i = 0; i < 7; i++) {
    const d = new Date(sunday);
    d.setDate(sunday.getDate() + i);
    days.push(d);
  }
  return days;
}

function ymd(d: Date): string {
  const y = d.getFullYear();
  const m = String(d.getMonth() + 1).padStart(2, "0");
  const day = String(d.getDate()).padStart(2, "0");
  return `${y}-${m}-${day}`;
}

function formatHeader(anchor: Date, mode: CalendarMode): string {
  if (mode === "month") {
    return anchor.toLocaleDateString(undefined, {
      month: "long",
      year: "numeric",
    });
  }
  if (mode === "week") {
    const days = weekDays(anchor);
    return `${days[0].toLocaleDateString(undefined, { month: "short", day: "numeric" })} – ${days[6].toLocaleDateString(undefined, { month: "short", day: "numeric", year: "numeric" })}`;
  }
  return anchor.toLocaleDateString(undefined, {
    weekday: "long",
    month: "long",
    day: "numeric",
    year: "numeric",
  });
}
