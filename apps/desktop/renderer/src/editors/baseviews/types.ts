/**
 * Shared types for Base view components (Grid, Kanban, Calendar,
 * Timeline, Gallery, Form). Each view is a presentation over the same
 * `BaseContent` model — they all read records via `records[i][field]`
 * and write back via `onUpdateCell` / `onAddRecord` / `onRemoveRecord`,
 * so the underlying JSON shape is identical regardless of which view
 * the user is currently looking at.
 */
import type { BaseContent, BaseField, FieldType } from "../baseEditorTypes";

export type BaseViewKind =
  | "grid"
  | "kanban"
  | "calendar"
  | "timeline"
  | "gallery"
  | "form";

export interface BaseViewProps {
  data: BaseContent;
  /** Apply a single-cell change, e.g. moving a kanban card to a new column. */
  onUpdateCell: (recordIndex: number, fieldName: string, value: unknown) => void;
  /** Append a fresh empty record. Used by quick-create affordances. */
  onAddRecord: () => void;
  /**
   * Append a record pre-populated with `prefill`. Used by Calendar's
   * click-on-empty-day flow so the new record is created with the
   * correct date in the active date field.
   */
  onAddRecordWith: (prefill: Record<string, unknown>) => void;
  /** Delete a record by its original index in `data.records`. */
  onRemoveRecord: (recordIndex: number) => void;
  /**
   * Per-view config knobs (which select field maps to kanban
   * columns, which date field drives calendar, etc.). Persisted in
   * the editor state so a user's view preferences survive across
   * page changes — but NOT serialized into the artifact content
   * itself (the view choice is a renderer concern, not part of the
   * stored model).
   */
  config: BaseViewConfig;
  onConfigChange: (config: BaseViewConfig) => void;
}

export interface BaseViewConfig {
  /** Which `select` field is used to lay out kanban columns. */
  kanbanGroupField: string | null;
  /** Which `date` field is used by the calendar view. */
  calendarDateField: string | null;
  /** Which `date` field is the timeline bar start. */
  timelineStartField: string | null;
  /** Which `date` field is the timeline bar end. */
  timelineEndField: string | null;
  /** Optional `url` field used as the gallery card cover image. */
  galleryCoverField: string | null;
  /** Field shown as the card / cell title across non-grid views. */
  titleField: string | null;
  /**
   * Grid row density. Mirrors Airtable's row-height control; drives
   * both the virtualization row-height estimate and the per-cell
   * vertical padding / line clamp.
   */
  gridRowHeight: GridRowHeight;
  /**
   * Grid grouping: when set, rows are partitioned by this field's
   * value under collapsible group headers (Airtable's "Group"). Null
   * = flat list.
   */
  gridGroupField: string | null;
  /**
   * Grid row coloring: when set to a `select`/`multi_select` field,
   * each row shows a colored strip from the matching option color
   * (Airtable's "Color → by a select field").
   */
  gridColorField: string | null;
  /**
   * Number of leading columns frozen (sticky) during horizontal
   * scroll, like Airtable's frozen fields. 0 = none.
   */
  gridFrozenCount: number;
}

export type GridRowHeight = "short" | "medium" | "tall";

/** Pixel heights per density level — shared by the row renderer and
 *  the virtualization estimate so windowing math stays accurate. */
export const GRID_ROW_HEIGHTS: Record<GridRowHeight, number> = {
  short: 36,
  medium: 56,
  tall: 88,
};

export function defaultViewConfig(fields: BaseField[]): BaseViewConfig {
  // Pick reasonable defaults by scanning field types so the view
  // becomes meaningful immediately instead of forcing the user to
  // configure every dropdown before seeing data.
  const firstOfType = (t: FieldType): string | null =>
    fields.find((f) => f.type === t)?.name ?? null;
  // Prefer a field literally named "Status" / "State" / "Title" /
  // "Name" before falling back to the first field of the relevant
  // type — matches what users intuitively expect when they open a
  // freshly-imported Base.
  const named = (
    candidates: string[],
    type?: FieldType,
  ): string | null => {
    for (const cand of candidates) {
      const found = fields.find(
        (f) =>
          f.name.toLowerCase() === cand.toLowerCase() &&
          (type === undefined || f.type === type),
      );
      if (found) return found.name;
    }
    return null;
  };

  const dateFields = fields.filter((f) => f.type === "date").map((f) => f.name);

  return {
    kanbanGroupField:
      named(["status", "state", "stage", "column"], "select") ??
      firstOfType("select"),
    calendarDateField:
      named(["date", "due", "due date", "scheduled"], "date") ??
      firstOfType("date"),
    timelineStartField:
      named(["start", "start date", "begin", "from"], "date") ??
      dateFields[0] ?? null,
    timelineEndField:
      named(["end", "end date", "finish", "due", "to"], "date") ??
      dateFields[1] ?? dateFields[0] ?? null,
    galleryCoverField:
      named(["cover", "image", "thumbnail", "photo"], "url") ??
      firstOfType("url"),
    titleField:
      named(["title", "name", "label"]) ?? fields[0]?.name ?? null,
    gridRowHeight: "short",
    gridGroupField: null,
    gridColorField: null,
    gridFrozenCount: 0,
  };
}
