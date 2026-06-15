/**
 * App-mode shell.
 *
 * The runtime "use this base as a mini-app" surface. It renders a left
 * nav derived from the document + app config (a dashboard, one page per
 * table, and one page per authored form) and routes the main pane to
 * the dashboard, a record list, a record detail page, or a data-entry
 * form. Builder chrome (field management, view config, schema editing)
 * is intentionally absent here — this is the *using* experience.
 *
 * All record mutations are delegated back to the BaseEditor's existing
 * active-table handlers, which address records by their index in the
 * active table. To keep those indices valid, navigating to a table /
 * form page switches the active table first (synchronously in the click
 * handler, with an effect as a backstop), and record-mutating surfaces
 * only render once the active table matches the selected page.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import type { BaseTableResolver } from "../../baseDocumentHelpers";
import type {
  BaseAppConfig,
  BaseAppForm,
  BaseContent,
  BaseDocument,
  BaseField,
  BaseRecord,
} from "../../baseEditorTypes";
import {
  createForm,
  dataPageId,
  derivePages,
  DASHBOARD_PAGE_ID,
  formPageId,
  listFieldPreview,
  recordTitle,
  titleFieldName,
  type AppPage,
} from "./appConfig";
import AppDashboard from "./AppDashboard";
import AppForm from "./AppForms";
import RecordDetail from "./RecordDetail";

export interface AppShellProps {
  doc: BaseDocument;
  app: BaseAppConfig;
  activeTableId: string;
  data: BaseContent;
  resolver: BaseTableResolver;
  onSwitchTable: (tableId: string) => void;
  onUpdateCell: (
    recordIndex: number,
    fieldName: string,
    value: unknown,
  ) => void;
  onAddRecordWith: (prefill: Record<string, unknown>) => void;
  onRemoveRecord: (recordIndex: number) => void;
  onAppConfigChange: (app: BaseAppConfig) => void;
  onExitAppMode: () => void;
}

export default function AppShell({
  doc,
  app,
  activeTableId,
  data,
  resolver,
  onSwitchTable,
  onUpdateCell,
  onAddRecordWith,
  onRemoveRecord,
  onAppConfigChange,
  onExitAppMode,
}: AppShellProps) {
  const pages = useMemo(() => derivePages(doc, app), [doc, app]);
  const [selectedPageId, setSelectedPageId] =
    useState<string>(DASHBOARD_PAGE_ID);
  const [detailRecordId, setDetailRecordId] = useState<string | null>(null);
  const [editingApp, setEditingApp] = useState(false);

  // Resolve the selected page, falling back to the dashboard if the
  // current selection disappeared (e.g. its form / table was removed).
  const page: AppPage = pages.find((p) => p.id === selectedPageId) ?? pages[0];

  // Keep the active table aligned with table / form pages so the
  // index-based mutation handlers stay correct even if a render slipped
  // through before the click handler's switch committed.
  useEffect(() => {
    if (
      (page.kind === "data" || page.kind === "form") &&
      page.tableId !== activeTableId
    ) {
      onSwitchTable(page.tableId);
    }
  }, [page, activeTableId, onSwitchTable]);

  // Open the freshly-created record after a list "new record" click.
  // `onAddRecordWith` appends to the active table but returns nothing, so
  // we watch the record count and open the last row. We capture the table
  // id the add was requested ON (not a bare boolean): if the user switches
  // tables before the append lands, `data`/`activeTableId` now describe a
  // DIFFERENT table, so opening "the last row" would surface an unrelated
  // record. Gating on the captured id makes the open fire only on the
  // originating table and cancel otherwise.
  const prevCount = useRef(data.records.length);
  const pendingOpenTableId = useRef<string | null>(null);
  useEffect(() => {
    if (pendingOpenTableId.current !== null) {
      if (pendingOpenTableId.current !== activeTableId) {
        // Active table changed before the new record arrived — abandon.
        pendingOpenTableId.current = null;
      } else if (data.records.length > prevCount.current) {
        const last = data.records[data.records.length - 1];
        if (last) {
          setSelectedPageId(dataPageId(activeTableId));
          setDetailRecordId(last.id);
        }
        pendingOpenTableId.current = null;
      }
      // else: still on the right table, waiting for the append to land.
    }
    prevCount.current = data.records.length;
  }, [data.records, activeTableId]);

  const selectPage = (next: AppPage) => {
    setSelectedPageId(next.id);
    setDetailRecordId(null);
    if (next.kind === "data" || next.kind === "form") {
      onSwitchTable(next.tableId);
    }
  };

  const patchForm = (formId: string, patch: Partial<BaseAppForm>) =>
    onAppConfigChange({
      ...app,
      forms: app.forms.map((f) => (f.id === formId ? { ...f, ...patch } : f)),
    });

  const addForm = (tableId: string) => {
    const table = doc.tables.find((t) => t.id === tableId);
    if (!table) return;
    const form = createForm(table);
    onAppConfigChange({ ...app, forms: [...app.forms, form] });
    setSelectedPageId(formPageId(form.id));
    setDetailRecordId(null);
    onSwitchTable(table.id);
  };

  const removeForm = (formId: string) => {
    onAppConfigChange({
      ...app,
      forms: app.forms.filter((f) => f.id !== formId),
    });
    if (selectedPageId === formPageId(formId)) {
      setSelectedPageId(DASHBOARD_PAGE_ID);
      setDetailRecordId(null);
    }
  };

  return (
    <div className="base-app-shell" data-testid="base-app-shell">
      <nav className="base-app-nav" aria-label="App navigation">
        <div className="base-app-nav-head">
          {editingApp ? (
            <input
              className="base-app-name-input"
              type="text"
              aria-label="App name"
              value={app.name ?? ""}
              placeholder="App name"
              onChange={(e) =>
                onAppConfigChange({
                  ...app,
                  name:
                    e.target.value.trim() === "" ? undefined : e.target.value,
                })
              }
            />
          ) : (
            <span className="base-app-name">{app.name?.trim() || "App"}</span>
          )}
          <button
            type="button"
            className="btn-sm"
            aria-pressed={editingApp}
            aria-label="Edit app"
            title="Edit app"
            data-testid="base-app-edit-toggle"
            onClick={() => setEditingApp((e) => !e)}
          >
            ⚙
          </button>
        </div>

        <ul className="base-app-nav-list">
          {pages.map((p) => (
            <li key={p.id} className="base-app-nav-item">
              <button
                type="button"
                className="base-app-nav-link"
                aria-current={p.id === selectedPageId ? "page" : undefined}
                data-testid={`base-app-nav-${p.kind}`}
                onClick={() => selectPage(p)}
              >
                <span className="base-app-nav-icon" aria-hidden>
                  {p.kind === "dashboard" ? "▦" : p.kind === "form" ? "✎" : "▤"}
                </span>
                {p.label}
              </button>
              {editingApp && p.kind === "form" && (
                <button
                  type="button"
                  className="btn-sm base-app-danger"
                  aria-label={`Delete form ${p.label}`}
                  onClick={() => removeForm(p.formId)}
                >
                  ×
                </button>
              )}
            </li>
          ))}
        </ul>

        {editingApp && (
          <AppAuthoring
            doc={doc}
            app={app}
            onAddForm={addForm}
            onAppConfigChange={onAppConfigChange}
          />
        )}

        <div className="base-app-nav-foot">
          <button
            type="button"
            className="btn-sm"
            data-testid="base-app-exit"
            onClick={onExitAppMode}
          >
            ← Builder
          </button>
        </div>
      </nav>

      <main className="base-app-main">
        <AppContent
          page={page}
          app={app}
          doc={doc}
          data={data}
          activeTableId={activeTableId}
          resolver={resolver}
          editingApp={editingApp}
          detailRecordId={detailRecordId}
          onOpenRecord={(id) => setDetailRecordId(id)}
          onCloseDetail={() => setDetailRecordId(null)}
          onRequestNewRecord={() => {
            pendingOpenTableId.current = activeTableId;
            onAddRecordWith({});
          }}
          onUpdateCell={onUpdateCell}
          onAddRecordWith={onAddRecordWith}
          onRemoveRecord={onRemoveRecord}
          onAppConfigChange={onAppConfigChange}
          patchForm={patchForm}
        />
      </main>
    </div>
  );
}

interface AppContentProps {
  page: AppPage;
  app: BaseAppConfig;
  doc: BaseDocument;
  data: BaseContent;
  activeTableId: string;
  resolver: BaseTableResolver;
  editingApp: boolean;
  detailRecordId: string | null;
  onOpenRecord: (id: string) => void;
  onCloseDetail: () => void;
  onRequestNewRecord: () => void;
  onUpdateCell: (
    recordIndex: number,
    fieldName: string,
    value: unknown,
  ) => void;
  onAddRecordWith: (prefill: Record<string, unknown>) => void;
  onRemoveRecord: (recordIndex: number) => void;
  onAppConfigChange: (app: BaseAppConfig) => void;
  patchForm: (formId: string, patch: Partial<BaseAppForm>) => void;
}

function AppContent({
  page,
  app,
  doc,
  data,
  activeTableId,
  resolver,
  editingApp,
  detailRecordId,
  onOpenRecord,
  onCloseDetail,
  onRequestNewRecord,
  onUpdateCell,
  onAddRecordWith,
  onRemoveRecord,
  onAppConfigChange,
  patchForm,
}: AppContentProps) {
  if (page.kind === "dashboard") {
    return (
      <AppDashboard
        doc={doc}
        app={app}
        editing={editingApp}
        onAppConfigChange={onAppConfigChange}
      />
    );
  }

  // Both data and form pages mutate the active table by index, so wait
  // for the active-table switch to land before rendering them.
  if (page.tableId !== activeTableId) {
    return <p className="base-app-empty">Loading…</p>;
  }
  const table = resolver(activeTableId);
  if (!table) {
    return <p className="base-app-empty">This table no longer exists.</p>;
  }

  if (page.kind === "form") {
    const form = app.forms.find((f) => f.id === page.formId);
    if (!form) {
      return <p className="base-app-empty">This form no longer exists.</p>;
    }
    return (
      <AppForm
        form={form}
        table={table}
        data={data}
        editing={editingApp}
        onAddRecordWith={onAddRecordWith}
        onChange={(patch) => patchForm(form.id, patch)}
      />
    );
  }

  // Data page: detail view when a record is selected, else the list.
  if (detailRecordId) {
    return (
      <RecordDetail
        table={table}
        records={data.records}
        resolver={resolver}
        recordId={detailRecordId}
        onUpdateCell={onUpdateCell}
        onRemoveRecord={onRemoveRecord}
        onNavigate={onOpenRecord}
        onClose={onCloseDetail}
      />
    );
  }
  return (
    <DataList
      fields={table.fields}
      records={data.records}
      resolver={resolver}
      onOpen={onOpenRecord}
      onNew={onRequestNewRecord}
    />
  );
}

interface DataListProps {
  fields: BaseField[];
  records: BaseRecord[];
  resolver: BaseTableResolver;
  onOpen: (id: string) => void;
  onNew: () => void;
}

function DataList({ fields, records, resolver, onOpen, onNew }: DataListProps) {
  const titleName = titleFieldName(fields);
  // Up to three non-title fields make the secondary preview line.
  const secondary = fields.filter((f) => f.name !== titleName).slice(0, 3);

  return (
    <div className="base-app-list" data-testid="base-app-list">
      <div className="base-app-list-bar">
        <span className="base-app-list-count">
          {records.length} {records.length === 1 ? "record" : "records"}
        </span>
        <button
          type="button"
          className="btn-sm"
          data-testid="base-app-new-record"
          onClick={onNew}
        >
          + New record
        </button>
      </div>
      {records.length === 0 ? (
        <p className="base-app-empty">No records yet.</p>
      ) : (
        <ul className="base-app-list-rows">
          {records.map((record) => (
            <li key={record.id}>
              <button
                type="button"
                className="base-app-list-row"
                data-testid="base-app-list-row"
                onClick={() => onOpen(record.id)}
              >
                <span className="base-app-list-title">
                  {recordTitle(fields, record)}
                </span>
                {secondary.length > 0 && (
                  <span className="base-app-list-sub">
                    {secondary.map((f) => {
                      const preview = listFieldPreview(
                        f,
                        record,
                        records,
                        resolver,
                      );
                      if (!preview) return null;
                      return (
                        <span key={f.name} className="base-app-list-chip">
                          <span className="base-app-list-chip-key">
                            {f.name}
                          </span>
                          {preview}
                        </span>
                      );
                    })}
                  </span>
                )}
              </button>
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

interface AppAuthoringProps {
  doc: BaseDocument;
  app: BaseAppConfig;
  onAddForm: (tableId: string) => void;
  onAppConfigChange: (app: BaseAppConfig) => void;
}

function AppAuthoring({
  doc,
  app,
  onAddForm,
  onAppConfigChange,
}: AppAuthoringProps) {
  const [tableId, setTableId] = useState<string>(doc.tables[0]?.id ?? "");
  // Keep the selected table valid as tables come and go.
  const effectiveTableId = doc.tables.some((t) => t.id === tableId)
    ? tableId
    : (doc.tables[0]?.id ?? "");

  return (
    <div className="base-app-nav-author" data-testid="base-app-authoring">
      <div className="base-app-author-row">
        <select
          aria-label="Form table"
          value={effectiveTableId}
          onChange={(e) => setTableId(e.target.value)}
        >
          {doc.tables.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
        <button
          type="button"
          className="btn-sm"
          data-testid="base-app-add-form"
          disabled={!effectiveTableId}
          onClick={() => effectiveTableId && onAddForm(effectiveTableId)}
        >
          + Form
        </button>
      </div>
      <label className="base-app-author-default">
        <input
          type="checkbox"
          checked={app.defaultMode === "app"}
          onChange={(e) =>
            onAppConfigChange({
              ...app,
              defaultMode: e.target.checked ? "app" : undefined,
            })
          }
        />
        <span>Open in app mode by default</span>
      </label>
    </div>
  );
}
