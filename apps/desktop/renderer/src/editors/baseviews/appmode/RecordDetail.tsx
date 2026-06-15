/**
 * App-mode record detail page.
 *
 * A clean, readable, single-record surface used when the user clicks a
 * record while *using* a base (as opposed to the builder's expand-cell
 * modal). It lists every field with an inline editor — reusing the
 * grid's per-type `CellInput` so linked records, lookups, rollups,
 * formulas and auto-numbers all render exactly as they do elsewhere —
 * and offers previous / next navigation across the table's records.
 *
 * Edits write straight back through the same `onUpdateCell` the grid
 * uses (addressed by the record's CURRENT index in `records`), so the
 * detail page never holds a private copy of the data that could drift
 * from the document.
 */
import { useState } from "react";
import { CellInput, LongTextModal } from "../../BaseEditor";
import type { BaseTableResolver } from "../../baseDocumentHelpers";
import type { BaseRecord, BaseTable } from "../../baseEditorTypes";
import { recordTitle } from "./appConfig";

export interface RecordDetailProps {
  table: BaseTable;
  records: BaseRecord[];
  resolver: BaseTableResolver;
  recordId: string;
  onUpdateCell: (
    recordIndex: number,
    fieldName: string,
    value: unknown,
  ) => void;
  onRemoveRecord: (recordIndex: number) => void;
  onNavigate: (recordId: string) => void;
  onClose: () => void;
}

export default function RecordDetail({
  table,
  records,
  resolver,
  recordId,
  onUpdateCell,
  onRemoveRecord,
  onNavigate,
  onClose,
}: RecordDetailProps) {
  // Long-text fields open the shared full-screen editor; track which
  // field (by name) is currently expanded.
  const [expandField, setExpandField] = useState<string | null>(null);

  const index = records.findIndex((r) => r.id === recordId);
  if (index === -1) {
    return (
      <div className="base-app-detail" data-testid="base-app-record-detail">
        <p className="base-app-empty">This record is no longer available.</p>
        <button type="button" className="btn-sm" onClick={onClose}>
          Back
        </button>
      </div>
    );
  }

  const record = records[index];
  const fields = table.fields;
  const hasPrev = index > 0;
  const hasNext = index < records.length - 1;
  const expandedField = expandField
    ? fields.find((f) => f.name === expandField)
    : undefined;

  return (
    <div className="base-app-detail" data-testid="base-app-record-detail">
      <div className="base-app-detail-bar">
        <button
          type="button"
          className="btn-sm"
          onClick={onClose}
          data-testid="base-app-detail-back"
        >
          ← Back
        </button>
        <div className="base-app-detail-nav">
          <span className="base-app-detail-count">
            {index + 1} / {records.length}
          </span>
          <button
            type="button"
            className="btn-sm"
            disabled={!hasPrev}
            aria-label="Previous record"
            data-testid="base-app-detail-prev"
            onClick={() => hasPrev && onNavigate(records[index - 1].id)}
          >
            ↑ Prev
          </button>
          <button
            type="button"
            className="btn-sm"
            disabled={!hasNext}
            aria-label="Next record"
            data-testid="base-app-detail-next"
            onClick={() => hasNext && onNavigate(records[index + 1].id)}
          >
            ↓ Next
          </button>
        </div>
      </div>

      <h2 className="base-app-detail-title">{recordTitle(fields, record)}</h2>

      <dl className="base-app-detail-fields">
        {fields.map((field) => (
          <div key={field.name} className="base-app-detail-row">
            <dt className="base-app-detail-label">{field.name}</dt>
            <dd className="base-app-detail-value">
              <CellInput
                field={field}
                value={record[field.name]}
                record={record}
                recordIndex={index}
                allRecords={records}
                allFields={fields}
                resolver={resolver}
                onChange={(val) => onUpdateCell(index, field.name, val)}
                onExpand={
                  field.type === "long_text"
                    ? () => setExpandField(field.name)
                    : undefined
                }
                isExpanded={expandField === field.name}
              />
            </dd>
          </div>
        ))}
      </dl>

      <div className="base-app-detail-footer">
        <button
          type="button"
          className="btn-sm base-app-danger"
          data-testid="base-app-detail-delete"
          onClick={() => {
            onRemoveRecord(index);
            onClose();
          }}
        >
          Delete record
        </button>
      </div>

      {expandedField && (
        <LongTextModal
          field={expandedField}
          value={record[expandedField.name]}
          onChange={(val) => onUpdateCell(index, expandedField.name, val)}
          onClose={() => setExpandField(null)}
        />
      )}
    </div>
  );
}
