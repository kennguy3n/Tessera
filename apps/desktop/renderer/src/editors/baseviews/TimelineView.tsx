/**
 * Timeline (Gantt-style) view for Bases.
 *
 * Requires two `date` fields — start and end — selected by the user.
 * Renders one horizontal bar per record with its left/right edges
 * positioned proportionally to the visible time range. Records missing
 * either date or with end < start are listed as "unscheduled" beneath
 * the chart so the user can see they exist but won't be silently
 * dropped from the view.
 *
 * The visible range is the union of all bar ranges, padded by a
 * configurable zoom factor (day / week / month). Zoom controls the
 * tick density of the header strip; the bar positions are always in
 * exact pixel terms relative to the rendered chart width, so a wider
 * window means bigger bars regardless of zoom.
 */
import { useMemo, useState } from "react";
import type { BaseField } from "../baseEditorTypes";
import type { BaseViewProps } from "./types";

type Zoom = "day" | "week" | "month";

const ONE_DAY_MS = 86_400_000;

export default function TimelineView({
  data,
  config,
  onConfigChange,
}: BaseViewProps) {
  const dateFields = data.fields.filter((f) => f.type === "date");
  const startField =
    data.fields.find((f) => f.name === config.timelineStartField) ?? null;
  const endField =
    data.fields.find((f) => f.name === config.timelineEndField) ?? null;
  const [zoom, setZoom] = useState<Zoom>("week");
  const titleField = config.titleField;

  const { scheduled, unscheduled, rangeStart, rangeEnd } = useMemo(() => {
    const scheduledOut: {
      record: Record<string, unknown>;
      index: number;
      start: Date;
      end: Date;
    }[] = [];
    const unscheduledOut: {
      record: Record<string, unknown>;
      index: number;
      reason: string;
    }[] = [];
    if (!startField || !endField) {
      return {
        scheduled: scheduledOut,
        unscheduled: unscheduledOut,
        rangeStart: null,
        rangeEnd: null,
      };
    }
    for (let i = 0; i < data.records.length; i++) {
      const r = data.records[i];
      const rawStart = r[startField.name];
      const rawEnd = r[endField.name];
      if (rawStart == null || rawStart === "") {
        unscheduledOut.push({
          record: r,
          index: i,
          reason: `missing ${startField.name}`,
        });
        continue;
      }
      if (rawEnd == null || rawEnd === "") {
        unscheduledOut.push({
          record: r,
          index: i,
          reason: `missing ${endField.name}`,
        });
        continue;
      }
      const start = parseLocalDate(String(rawStart));
      const end = parseLocalDate(String(rawEnd));
      if (!start || !end) {
        unscheduledOut.push({
          record: r,
          index: i,
          reason: "unparseable date",
        });
        continue;
      }
      if (end.getTime() < start.getTime()) {
        unscheduledOut.push({
          record: r,
          index: i,
          reason: `${endField.name} is before ${startField.name}`,
        });
        continue;
      }
      scheduledOut.push({ record: r, index: i, start, end });
    }
    if (scheduledOut.length === 0) {
      return {
        scheduled: scheduledOut,
        unscheduled: unscheduledOut,
        rangeStart: null,
        rangeEnd: null,
      };
    }
    let min = scheduledOut[0].start.getTime();
    let max = scheduledOut[0].end.getTime();
    for (const s of scheduledOut) {
      if (s.start.getTime() < min) min = s.start.getTime();
      if (s.end.getTime() > max) max = s.end.getTime();
    }
    // Pad the range by one tick on each side so the first/last bar
    // doesn't kiss the chart edge.
    const padMs =
      zoom === "day" ? ONE_DAY_MS : zoom === "week" ? 7 * ONE_DAY_MS : 30 * ONE_DAY_MS;
    return {
      scheduled: scheduledOut,
      unscheduled: unscheduledOut,
      rangeStart: new Date(min - padMs),
      rangeEnd: new Date(max + padMs),
    };
  }, [data.records, startField, endField, zoom]);

  if (dateFields.length < 2) {
    return (
      <EmptyMessage
        title="Timeline needs two date fields"
        description="Add a start date and end date field to use the Timeline view."
      />
    );
  }

  if (!startField || !endField) {
    return (
      <FieldPicker
        dateFields={dateFields}
        startField={startField}
        endField={endField}
        onPickStart={(name) =>
          onConfigChange({ ...config, timelineStartField: name })
        }
        onPickEnd={(name) =>
          onConfigChange({ ...config, timelineEndField: name })
        }
      />
    );
  }

  return (
    <div className="base-timeline" style={{ padding: "0.75rem" }}>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          gap: "0.5rem",
          marginBottom: "0.75rem",
          flexWrap: "wrap",
        }}
      >
        <label style={{ fontSize: "0.75rem" }}>
          Start:&nbsp;
          <select
            value={startField.name}
            onChange={(e) =>
              onConfigChange({ ...config, timelineStartField: e.target.value })
            }
          >
            {dateFields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label style={{ fontSize: "0.75rem" }}>
          End:&nbsp;
          <select
            value={endField.name}
            onChange={(e) =>
              onConfigChange({ ...config, timelineEndField: e.target.value })
            }
          >
            {dateFields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <div style={{ flex: 1 }} />
        <div style={{ display: "flex", gap: "0.25rem" }}>
          {(["day", "week", "month"] as Zoom[]).map((z) => (
            <button
              key={z}
              type="button"
              className="btn-sm"
              onClick={() => setZoom(z)}
              style={{
                fontWeight: zoom === z ? 600 : 400,
                background:
                  zoom === z
                    ? "var(--color-primary-soft, #ede9fe)"
                    : "transparent",
              }}
            >
              {z[0].toUpperCase() + z.slice(1)}
            </button>
          ))}
        </div>
      </div>

      {scheduled.length === 0 && (
        <EmptyMessage
          title="No scheduled records"
          description="None of the records have both a start and end date set."
        />
      )}

      {rangeStart && rangeEnd && scheduled.length > 0 && (
        <Chart
          scheduled={scheduled}
          rangeStart={rangeStart}
          rangeEnd={rangeEnd}
          zoom={zoom}
          titleField={titleField}
        />
      )}

      {unscheduled.length > 0 && (
        <div style={{ marginTop: "1.5rem" }}>
          <div
            style={{
              fontSize: "0.75rem",
              fontWeight: 600,
              marginBottom: "0.375rem",
              color: "var(--color-text-secondary, #6b7280)",
            }}
          >
            Unscheduled ({unscheduled.length})
          </div>
          <ul
            style={{
              listStyle: "none",
              padding: 0,
              margin: 0,
              fontSize: "0.75rem",
              color: "var(--color-text-secondary, #6b7280)",
            }}
          >
            {unscheduled.map(({ record, index, reason }) => (
              <li key={index} style={{ padding: "0.125rem 0" }}>
                <strong style={{ color: "inherit" }}>
                  {titleField
                    ? String(record[titleField] ?? "(untitled)")
                    : `Record ${index + 1}`}
                </strong>{" "}
                — {reason}
              </li>
            ))}
          </ul>
        </div>
      )}
    </div>
  );
}

function Chart({
  scheduled,
  rangeStart,
  rangeEnd,
  zoom,
  titleField,
}: {
  scheduled: {
    record: Record<string, unknown>;
    index: number;
    start: Date;
    end: Date;
  }[];
  rangeStart: Date;
  rangeEnd: Date;
  zoom: Zoom;
  titleField: string | null;
}) {
  const totalMs = rangeEnd.getTime() - rangeStart.getTime();

  // Compute ticks unconditionally — React rules-of-hooks requires the
  // hook to run on every render, regardless of whether we end up
  // bailing out for a degenerate range. The early return below
  // happens AFTER all hooks have run.
  const ticks = useMemo(() => {
    const out: { label: string; pct: number }[] = [];
    if (totalMs <= 0) return out;
    const start = new Date(rangeStart);
    const end = rangeEnd;
    const cursor = new Date(start);
    // Snap cursor to the next tick boundary depending on zoom.
    if (zoom === "day") {
      cursor.setHours(0, 0, 0, 0);
    } else if (zoom === "week") {
      cursor.setHours(0, 0, 0, 0);
      cursor.setDate(cursor.getDate() - cursor.getDay()); // Sun
    } else {
      cursor.setDate(1);
      cursor.setHours(0, 0, 0, 0);
    }
    while (cursor.getTime() <= end.getTime()) {
      const pct = ((cursor.getTime() - start.getTime()) / totalMs) * 100;
      let label = "";
      if (zoom === "day") {
        label = cursor.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        });
        cursor.setDate(cursor.getDate() + 1);
      } else if (zoom === "week") {
        label = cursor.toLocaleDateString(undefined, {
          month: "short",
          day: "numeric",
        });
        cursor.setDate(cursor.getDate() + 7);
      } else {
        label = cursor.toLocaleDateString(undefined, {
          month: "short",
          year: "2-digit",
        });
        cursor.setMonth(cursor.getMonth() + 1);
      }
      if (pct >= 0 && pct <= 100) {
        out.push({ label, pct });
      }
    }
    return out;
  }, [rangeStart, rangeEnd, totalMs, zoom]);

  if (totalMs <= 0) return null;

  return (
    <div
      style={{
        border: "1px solid var(--color-border, #e5e7eb)",
        borderRadius: "0.375rem",
        background: "var(--color-bg, #fff)",
      }}
    >
      <div
        style={{
          position: "relative",
          height: "32px",
          borderBottom: "1px solid var(--color-border, #e5e7eb)",
        }}
      >
        {ticks.map((t, i) => (
          <div
            key={i}
            style={{
              position: "absolute",
              left: `${t.pct}%`,
              top: 0,
              bottom: 0,
              fontSize: "0.7rem",
              color: "var(--color-text-secondary, #6b7280)",
              paddingLeft: "0.25rem",
              borderLeft: "1px dashed var(--color-border, #e5e7eb)",
              display: "flex",
              alignItems: "center",
            }}
          >
            {t.label}
          </div>
        ))}
      </div>
      <div>
        {scheduled.map(({ record, index, start, end }) => {
          const leftPct =
            ((start.getTime() - rangeStart.getTime()) / totalMs) * 100;
          const widthPct =
            ((end.getTime() - start.getTime()) / totalMs) * 100;
          // Single-day bars get a minimum visible width so they don't
          // collapse into a 0px sliver on multi-month zooms.
          const effectiveWidth = Math.max(widthPct, 0.5);
          return (
            <div
              key={index}
              style={{
                position: "relative",
                height: "32px",
                borderBottom: "1px solid var(--color-border, #f3f4f6)",
              }}
              title={`${
                titleField ? String(record[titleField] ?? "") : `Record ${index + 1}`
              } · ${start.toLocaleDateString()} → ${end.toLocaleDateString()}`}
            >
              <div
                style={{
                  position: "absolute",
                  top: "6px",
                  bottom: "6px",
                  left: `${leftPct}%`,
                  width: `${effectiveWidth}%`,
                  background: "var(--color-primary, #7C3AED)",
                  borderRadius: "0.25rem",
                  color: "var(--color-text-on-primary, #fff)",
                  fontSize: "0.75rem",
                  padding: "0 0.5rem",
                  display: "flex",
                  alignItems: "center",
                  whiteSpace: "nowrap",
                  overflow: "hidden",
                  textOverflow: "ellipsis",
                }}
              >
                {titleField
                  ? String(record[titleField] ?? "(untitled)")
                  : `Record ${index + 1}`}
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}

function FieldPicker({
  dateFields,
  startField,
  endField,
  onPickStart,
  onPickEnd,
}: {
  dateFields: BaseField[];
  startField: BaseField | null;
  endField: BaseField | null;
  onPickStart: (name: string) => void;
  onPickEnd: (name: string) => void;
}) {
  return (
    <div
      style={{
        padding: "2rem",
        textAlign: "center",
        color: "var(--color-text-secondary, #6b7280)",
      }}
    >
      <div style={{ marginBottom: "0.75rem" }}>
        Pick a start date field and an end date field for the timeline:
      </div>
      <div style={{ display: "flex", justifyContent: "center", gap: "1rem" }}>
        <label>
          Start:&nbsp;
          <select
            value={startField?.name ?? ""}
            onChange={(e) => e.target.value && onPickStart(e.target.value)}
          >
            <option value="">— choose —</option>
            {dateFields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
        <label>
          End:&nbsp;
          <select
            value={endField?.name ?? ""}
            onChange={(e) => e.target.value && onPickEnd(e.target.value)}
          >
            <option value="">— choose —</option>
            {dateFields.map((f) => (
              <option key={f.name} value={f.name}>
                {f.name}
              </option>
            ))}
          </select>
        </label>
      </div>
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

function parseLocalDate(s: string): Date | null {
  // Accept "YYYY-MM-DD" (the <input type=date> output) and ISO
  // datetimes; reject anything else so we don't render garbage bars.
  const m = /^(\d{4})-(\d{2})-(\d{2})/.exec(s);
  if (!m) return null;
  const y = Number.parseInt(m[1], 10);
  const mo = Number.parseInt(m[2], 10);
  const d = Number.parseInt(m[3], 10);
  if (mo < 1 || mo > 12 || d < 1 || d > 31) return null;
  const dt = new Date(y, mo - 1, d);
  return Number.isNaN(dt.getTime()) ? null : dt;
}
