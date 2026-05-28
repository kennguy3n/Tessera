/**
 * Gallery view for Bases.
 *
 * Renders records as a responsive card grid. Each card shows:
 *   - cover image (from the configured `url` field, if any)
 *   - title (configured title field)
 *   - up to N selectable summary fields
 *
 * Users pick which fields appear on the card via the toolbar; the
 * choice persists in `BaseViewConfig.titleField` /
 * `galleryCoverField` and a local `cardFields` set scoped to the
 * gallery only (we don't push every UI toggle into the persisted
 * config — only the durable picks).
 */
import { useMemo, useState } from "react";
import type { BaseField } from "../baseEditorTypes";
import type { BaseViewProps } from "./types";

export default function GalleryView({
  data,
  config,
  onConfigChange,
  onRemoveRecord,
}: BaseViewProps) {
  const urlFields = data.fields.filter((f) => f.type === "url");
  const titleField = config.titleField;
  const coverField = config.galleryCoverField;

  // Which non-title, non-cover fields are shown as the card body.
  // Default: first three fields by file order, excluding cover/title.
  const defaultCardFields = useMemo(() => {
    return data.fields
      .filter((f) => f.name !== titleField && f.name !== coverField)
      .slice(0, 3)
      .map((f) => f.name);
  }, [data.fields, titleField, coverField]);
  const [cardFields, setCardFields] = useState<string[]>(defaultCardFields);

  // If the user adds/removes underlying fields, prune any stale picks
  // so we never render a non-existent field name.
  const visibleCardFields = useMemo(
    () =>
      cardFields.filter((n) =>
        data.fields.some(
          (f) => f.name === n && f.name !== titleField && f.name !== coverField,
        ),
      ),
    [cardFields, data.fields, titleField, coverField],
  );

  return (
    <div className="base-gallery" style={{ padding: "0.75rem" }}>
      <Toolbar
        fields={data.fields}
        urlFields={urlFields}
        titleField={titleField}
        coverField={coverField}
        cardFields={visibleCardFields}
        onTitleChange={(name) =>
          onConfigChange({ ...config, titleField: name || null })
        }
        onCoverChange={(name) =>
          onConfigChange({ ...config, galleryCoverField: name || null })
        }
        onToggleCardField={(name) => {
          setCardFields((prev) =>
            prev.includes(name)
              ? prev.filter((n) => n !== name)
              : [...prev, name],
          );
        }}
      />
      <div
        style={{
          display: "grid",
          gridTemplateColumns: "repeat(auto-fill, minmax(220px, 1fr))",
          gap: "1rem",
          marginTop: "0.75rem",
        }}
      >
        {data.records.map((record, index) => (
          <Card
            key={index}
            record={record}
            recordIndex={index}
            fields={data.fields}
            titleField={titleField}
            coverField={coverField}
            visibleCardFields={visibleCardFields}
            onDelete={onRemoveRecord}
          />
        ))}
        {data.records.length === 0 && (
          <div
            style={{
              gridColumn: "1 / -1",
              textAlign: "center",
              color: "var(--color-text-secondary, #6b7280)",
              padding: "2rem",
            }}
          >
            No records yet — add one from the toolbar.
          </div>
        )}
      </div>
    </div>
  );
}

function Toolbar({
  fields,
  urlFields,
  titleField,
  coverField,
  cardFields,
  onTitleChange,
  onCoverChange,
  onToggleCardField,
}: {
  fields: BaseField[];
  urlFields: BaseField[];
  titleField: string | null;
  coverField: string | null;
  cardFields: string[];
  onTitleChange: (name: string) => void;
  onCoverChange: (name: string) => void;
  onToggleCardField: (name: string) => void;
}) {
  return (
    <div
      style={{
        display: "flex",
        alignItems: "center",
        gap: "0.75rem",
        flexWrap: "wrap",
        fontSize: "0.75rem",
      }}
    >
      <label>
        Title:&nbsp;
        <select
          value={titleField ?? ""}
          onChange={(e) => onTitleChange(e.target.value)}
        >
          <option value="">—</option>
          {fields.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}
            </option>
          ))}
        </select>
      </label>
      <label>
        Cover:&nbsp;
        <select
          value={coverField ?? ""}
          onChange={(e) => onCoverChange(e.target.value)}
        >
          <option value="">— none —</option>
          {urlFields.map((f) => (
            <option key={f.name} value={f.name}>
              {f.name}
            </option>
          ))}
        </select>
      </label>
      <div style={{ display: "flex", gap: "0.25rem", flexWrap: "wrap" }}>
        <span
          style={{
            color: "var(--color-text-secondary, #6b7280)",
            marginRight: "0.25rem",
          }}
        >
          Card fields:
        </span>
        {fields
          .filter((f) => f.name !== titleField && f.name !== coverField)
          .map((f) => {
            const on = cardFields.includes(f.name);
            return (
              <button
                key={f.name}
                type="button"
                className="btn-sm"
                onClick={() => onToggleCardField(f.name)}
                style={{
                  fontWeight: on ? 600 : 400,
                  background: on
                    ? "var(--color-primary-soft, #ede9fe)"
                    : "transparent",
                }}
              >
                {f.name}
              </button>
            );
          })}
      </div>
    </div>
  );
}

function Card({
  record,
  recordIndex,
  fields,
  titleField,
  coverField,
  visibleCardFields,
  onDelete,
}: {
  record: Record<string, unknown>;
  recordIndex: number;
  fields: BaseField[];
  titleField: string | null;
  coverField: string | null;
  visibleCardFields: string[];
  onDelete: (recordIndex: number) => void;
}) {
  const coverUrl =
    coverField && typeof record[coverField] === "string" && record[coverField]
      ? String(record[coverField])
      : null;
  const title = titleField
    ? String(record[titleField] ?? "(untitled)")
    : `Record ${recordIndex + 1}`;
  return (
    <div
      style={{
        border: "1px solid var(--color-border, #e5e7eb)",
        borderRadius: "0.5rem",
        background: "var(--color-bg, #fff)",
        overflow: "hidden",
        display: "flex",
        flexDirection: "column",
      }}
    >
      {coverUrl ? (
        <img
          src={coverUrl}
          alt=""
          // The user is editing structured data, not the web. We
          // explicitly *don't* navigate on click; image is purely
          // visual. `loading="lazy"` keeps a large gallery from
          // hammering the network when scrolled.
          loading="lazy"
          referrerPolicy="no-referrer"
          style={{
            width: "100%",
            height: "120px",
            objectFit: "cover",
            background: "var(--color-surface, #f3f4f6)",
            display: "block",
          }}
          onError={(e) => {
            // Hide broken images rather than showing the browser's
            // default broken-image icon, which jars the layout.
            (e.currentTarget as HTMLImageElement).style.display = "none";
          }}
        />
      ) : (
        <div
          style={{
            height: "80px",
            background:
              "linear-gradient(135deg, var(--color-primary-soft, #ede9fe), var(--color-surface, #f9fafb))",
          }}
        />
      )}
      <div
        style={{
          padding: "0.625rem 0.75rem",
          display: "flex",
          flexDirection: "column",
          gap: "0.25rem",
          flex: 1,
        }}
      >
        <div style={{ fontWeight: 600, fontSize: "0.875rem" }}>{title}</div>
        {visibleCardFields.map((fname) => {
          const value = record[fname];
          if (value == null || value === "") return null;
          const type = fields.find((f) => f.name === fname)?.type;
          return (
            <div
              key={fname}
              style={{
                fontSize: "0.75rem",
                color: "var(--color-text-secondary, #6b7280)",
              }}
            >
              <span style={{ fontWeight: 500 }}>{fname}:</span>{" "}
              {type === "checkbox" ? (value ? "Yes" : "No") : String(value)}
            </div>
          );
        })}
        <div style={{ flex: 1 }} />
        <button
          type="button"
          className="btn-sm danger"
          onClick={() => onDelete(recordIndex)}
          style={{ alignSelf: "flex-end", marginTop: "0.5rem" }}
        >
          Delete
        </button>
      </div>
    </div>
  );
}
