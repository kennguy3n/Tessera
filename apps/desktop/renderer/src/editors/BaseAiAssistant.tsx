import React, { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { BaseField, BaseRecord } from "./baseEditorTypes";
import {
  buildSchemaPrompt,
  parseSchemaResponse,
  buildFormulaPrompt,
  parseFormulaResponse,
  buildFillPrompt,
  parseFillResponse,
  buildSummarizePrompt,
  parseTextResponse,
  type AiSchemaSuggestion,
} from "./baseAiHelpers";
import { evaluateBaseFormula } from "./baseFormulaEngine";
import {
  useActiveGeneration,
  notifyGenerationStarted,
} from "../hooks/useActiveGeneration";

/**
 * Local-model AI assistant for the Base editor.
 *
 * Four on-device capabilities, each a thin shell over the pure
 * prompt-build / parse-validate helpers in `baseAiHelpers`:
 *   - **Schema**: generate a new table (name + fields) from a prompt.
 *   - **Fields**: suggest extra fields to add to the current table.
 *   - **Formula**: natural-language → a validated formula field.
 *   - **Fill**: enrich a column row-by-row from the other columns
 *     (bounded + cancellable), with a preview before applying.
 *   - **Summarize**: a prose summary of the selected (or all) records.
 *
 * ## Privacy / local-first
 * Every prompt is sent ONLY to `window.tessera.model.generate` (the
 * on-device model). There are no network AI calls and no document
 * content leaves the device. Prompt + completion text is never logged.
 *
 * ## Streaming + cancellation
 * Generation streams via the broadcast `model:token` channel. We run
 * exactly one prompt at a time (guarded by `busyRef`), accumulate
 * tokens until `done`, and surface the shared Stop control through
 * `useActiveGeneration`. The per-row Fill loop also checks a
 * `cancelRef` between rows so cancelling stops promptly without
 * applying a half-filled column.
 */

type Mode = "schema" | "fields" | "formula" | "fill" | "summarize";

export interface BaseAiAssistantProps {
  fields: BaseField[];
  records: BaseRecord[];
  selectedIds: Set<string>;
  onCreateTable: (name: string, fields: BaseField[]) => void;
  onAddFields: (fields: BaseField[]) => void;
  onApplyCellValues: (fieldName: string, values: Map<string, unknown>) => void;
  onClose: () => void;
}

interface RunHandle {
  text: string;
}

/** Run a single prompt against the local model, resolving with the
 *  full accumulated completion when the stream completes. Rejects on
 *  an error chunk or a battery-gated dispatch. */
function useModelRunner() {
  // Accumulator + resolver live in refs so the broadcast token
  // listener (registered once per active run) can reach them without
  // re-subscribing on every token.
  const runRef = useRef<{
    buffer: string;
    resolve: (h: RunHandle) => void;
    reject: (e: Error) => void;
  } | null>(null);

  useEffect(() => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api?.model?.onToken) return;
    const unsub = api.model.onToken((chunk) => {
      const run = runRef.current;
      if (!run) return;
      if (chunk.error) {
        const err = new Error(chunk.error);
        runRef.current = null;
        run.reject(err);
        return;
      }
      if (chunk.token) run.buffer += chunk.token;
      if (chunk.done) {
        const text = run.buffer;
        runRef.current = null;
        run.resolve({ text });
      }
    });
    return unsub;
  }, []);

  return useCallback((prompt: string, maxTokens?: number): Promise<RunHandle> => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api?.model?.generate) {
      return Promise.reject(new Error("The on-device model is unavailable."));
    }
    if (runRef.current) {
      return Promise.reject(new Error("A generation is already in progress."));
    }
    return new Promise<RunHandle>((resolve, reject) => {
      runRef.current = { buffer: "", resolve, reject };
      notifyGenerationStarted();
      api.model
        .generate({ prompt, maxTokens })
        .then((res) => {
          // Battery-gated dispatch resolves a sentinel instead of
          // streaming — surface it and clear the pending run.
          if (res && typeof res === "object" && "status" in res) {
            runRef.current = null;
            reject(
              new Error(
                "Generation paused — device battery is below 20%. Plug in to continue.",
              ),
            );
          }
        })
        .catch((e: unknown) => {
          runRef.current = null;
          reject(e instanceof Error ? e : new Error(String(e)));
        });
    });
  }, []);
}

const MODE_LABELS: Record<Mode, string> = {
  schema: "New table",
  fields: "Suggest fields",
  formula: "Formula",
  fill: "Fill column",
  summarize: "Summarize",
};

export default function BaseAiAssistant({
  fields,
  records,
  selectedIds,
  onCreateTable,
  onAddFields,
  onApplyCellValues,
  onClose,
}: BaseAiAssistantProps) {
  const [mode, setMode] = useState<Mode>("schema");
  const [prompt, setPrompt] = useState("");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const run = useModelRunner();
  const { isActive, cancel } = useActiveGeneration();

  // Per-mode result previews.
  const [schemaPreview, setSchemaPreview] = useState<AiSchemaSuggestion | null>(
    null,
  );
  const [fieldsPreview, setFieldsPreview] = useState<BaseField[] | null>(null);
  const [formulaPreview, setFormulaPreview] = useState<string | null>(null);
  const [summary, setSummary] = useState<string | null>(null);

  // Fill state.
  const [fillFieldName, setFillFieldName] = useState("");
  const [fillProgress, setFillProgress] = useState<{ done: number; total: number } | null>(
    null,
  );
  const [fillPreview, setFillPreview] = useState<Map<string, unknown> | null>(
    null,
  );
  const cancelRef = useRef(false);

  // Close on Escape (only when not mid-generation — Escape during a
  // run should be reserved for cancelling via the Stop button).
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape" && !busy) onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose, busy]);

  const fillTargets = useMemo(
    () =>
      fields.filter(
        (f) =>
          f.type !== "formula" &&
          f.type !== "rollup" &&
          f.type !== "lookup" &&
          f.type !== "auto_number" &&
          f.type !== "created_time" &&
          f.type !== "modified_time" &&
          f.type !== "attachment" &&
          f.type !== "linked_record",
      ),
    [fields],
  );

  const clearPreviews = () => {
    setSchemaPreview(null);
    setFieldsPreview(null);
    setFormulaPreview(null);
    setSummary(null);
    setFillPreview(null);
    setFillProgress(null);
    setError(null);
  };

  const handleGenerate = useCallback(async () => {
    clearPreviews();
    setBusy(true);
    cancelRef.current = false;
    try {
      if (mode === "schema") {
        const { text } = await run(buildSchemaPrompt(prompt), 700);
        const res = parseSchemaResponse(text);
        if (!res.ok) throw new Error(res.error);
        setSchemaPreview(res.value);
      } else if (mode === "fields") {
        // Reuse the schema parser but keep only the fields, framing
        // the prompt around the existing columns so suggestions
        // complement rather than duplicate them.
        const existing = fields.map((f) => f.name).join(", ");
        const framed = `${prompt}\n\nThe table already has these fields: ${existing}. Suggest additional, non-duplicate fields.`;
        const { text } = await run(buildSchemaPrompt(framed), 500);
        const res = parseSchemaResponse(text);
        if (!res.ok) throw new Error(res.error);
        const taken = new Set(fields.map((f) => f.name.toLowerCase()));
        const fresh = res.value.fields.filter(
          (f) => !taken.has(f.name.toLowerCase()),
        );
        if (fresh.length === 0) {
          throw new Error("No new fields were suggested.");
        }
        setFieldsPreview(fresh);
      } else if (mode === "formula") {
        const { text } = await run(buildFormulaPrompt(prompt, fields), 200);
        const res = parseFormulaResponse(text);
        if (!res.ok) throw new Error(res.error);
        // Validate by evaluating against the first record (or an empty
        // one) — a formula that throws or references unknown fields is
        // rejected before it can be saved.
        const sample = records[0] ?? { id: "__sample" };
        try {
          evaluateBaseFormula(res.value, fields, sample);
        } catch {
          throw new Error(
            "The suggested formula could not be evaluated against this table.",
          );
        }
        setFormulaPreview(res.value);
      } else if (mode === "summarize") {
        const scope =
          selectedIds.size > 0
            ? records.filter((r) => selectedIds.has(r.id))
            : records;
        if (scope.length === 0) throw new Error("There are no records to summarize.");
        const { text } = await run(
          buildSummarizePrompt(scope, fields, prompt),
          400,
        );
        const res = parseTextResponse(text);
        if (!res.ok) throw new Error(res.error);
        setSummary(res.value);
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [mode, prompt, fields, records, selectedIds, run]);

  // Fill runs a bounded, cancellable, row-by-row loop. Only records in
  // scope (selection if any, else all) with an EMPTY target cell are
  // filled, so re-running doesn't clobber manual edits.
  const handleFill = useCallback(async () => {
    clearPreviews();
    const target = fields.find((f) => f.name === fillFieldName);
    if (!target) {
      setError("Choose a field to fill.");
      return;
    }
    const sources = fields.filter(
      (f) => f.name !== target.name && f.type !== "attachment",
    );
    const scopeAll =
      selectedIds.size > 0
        ? records.filter((r) => selectedIds.has(r.id))
        : records;
    const scope = scopeAll.filter((r) => {
      const v = r[target.name];
      return v == null || v === "" || (Array.isArray(v) && v.length === 0);
    });
    if (scope.length === 0) {
      setError("Every target cell in scope is already filled.");
      return;
    }
    setBusy(true);
    cancelRef.current = false;
    const out = new Map<string, unknown>();
    try {
      for (let i = 0; i < scope.length; i++) {
        if (cancelRef.current) break;
        setFillProgress({ done: i, total: scope.length });
        const record = scope[i];
        const { text } = await run(
          buildFillPrompt(prompt, target, sources, record),
          120,
        );
        const res = parseFillResponse(text, target);
        if (res.ok) out.set(record.id, res.value);
        // A per-row parse failure is non-fatal — skip that row rather
        // than abort the whole batch.
      }
      setFillProgress({ done: scope.length, total: scope.length });
      if (out.size === 0) {
        throw new Error("No values could be generated for the chosen field.");
      }
      setFillPreview(out);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  }, [fields, fillFieldName, prompt, records, selectedIds, run]);

  const handleCancel = useCallback(() => {
    cancelRef.current = true;
    void cancel();
  }, [cancel]);

  const promptPlaceholder: Record<Mode, string> = {
    schema: "Describe the table you want, e.g. 'a CRM of customers with stage and deal value'",
    fields: "What is this table about? e.g. 'project tasks'",
    formula: "Describe the formula, e.g. 'price times quantity with 8% tax'",
    fill: "Optional instruction, e.g. 'classify sentiment as Positive/Negative'",
    summarize: "Optional focus, e.g. 'highlight overdue items'",
  };

  return (
    <div
      className="base-ai-backdrop"
      role="presentation"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget && !busy) onClose();
      }}
      style={{
        position: "fixed",
        inset: 0,
        background: "rgba(0,0,0,0.45)",
        display: "flex",
        alignItems: "center",
        justifyContent: "center",
        zIndex: 1000,
      }}
    >
      <div
        className="base-ai-panel card"
        role="dialog"
        aria-modal="true"
        aria-label="AI assistant"
        style={{
          background: "var(--color-bg, #fff)",
          color: "var(--color-text, #111)",
          borderRadius: "var(--radius-lg, 12px)",
          border: "1px solid var(--color-border, #e5e7eb)",
          width: "min(640px, 94vw)",
          maxHeight: "88vh",
          overflowY: "auto",
          boxShadow: "0 16px 48px rgba(0,0,0,0.28)",
          padding: "1rem 1.25rem",
        }}
      >
        <div
          style={{
            display: "flex",
            alignItems: "center",
            justifyContent: "space-between",
            marginBottom: "0.5rem",
          }}
        >
          <h2 style={{ margin: 0, fontSize: "1.05rem" }}>AI assistant</h2>
          <button
            type="button"
            className="btn-sm"
            onClick={onClose}
            aria-label="Close"
            title="Close"
            disabled={busy}
          >
            ×
          </button>
        </div>
        <p
          style={{
            margin: "0 0 0.75rem",
            fontSize: "0.78rem",
            color: "var(--color-text-secondary, #6b7280)",
          }}
        >
          Runs entirely on your device. No data leaves Tessera.
        </p>

        <div
          role="tablist"
          aria-label="AI mode"
          style={{ display: "flex", gap: "0.3rem", flexWrap: "wrap", marginBottom: "0.6rem" }}
        >
          {(Object.keys(MODE_LABELS) as Mode[]).map((m) => (
            <button
              key={m}
              type="button"
              role="tab"
              aria-selected={mode === m}
              className="btn-sm"
              disabled={busy}
              onClick={() => {
                setMode(m);
                clearPreviews();
              }}
              style={{
                background:
                  mode === m
                    ? "var(--color-primary-soft, #ede9fe)"
                    : "transparent",
                fontWeight: mode === m ? 600 : 400,
              }}
            >
              {MODE_LABELS[m]}
            </button>
          ))}
        </div>

        {mode === "fill" && (
          <label
            style={{ display: "block", fontSize: "0.8rem", marginBottom: "0.4rem" }}
          >
            Field to fill
            <select
              className="input"
              value={fillFieldName}
              onChange={(e) => setFillFieldName(e.target.value)}
              disabled={busy}
              style={{ display: "block", width: "100%", marginTop: "0.2rem" }}
            >
              <option value="">Choose a field…</option>
              {fillTargets.map((f) => (
                <option key={f.name} value={f.name}>
                  {f.name} ({f.type})
                </option>
              ))}
            </select>
          </label>
        )}

        <textarea
          className="input"
          value={prompt}
          onChange={(e) => setPrompt(e.target.value)}
          placeholder={promptPlaceholder[mode]}
          rows={3}
          disabled={busy}
          style={{ width: "100%", resize: "vertical" }}
        />

        <div style={{ display: "flex", gap: "0.4rem", marginTop: "0.6rem", alignItems: "center" }}>
          {mode === "fill" ? (
            <button
              type="button"
              className="btn-sm"
              onClick={() => void handleFill()}
              disabled={busy || fillFieldName === ""}
            >
              Generate
            </button>
          ) : (
            <button
              type="button"
              className="btn-sm"
              onClick={() => void handleGenerate()}
              disabled={busy || (mode !== "summarize" && prompt.trim() === "")}
            >
              Generate
            </button>
          )}
          {isActive && (
            <button
              type="button"
              className="btn-sm"
              onClick={handleCancel}
              data-testid="base-ai-stop"
            >
              Stop
            </button>
          )}
          {fillProgress && (
            <span style={{ fontSize: "0.78rem", color: "var(--color-text-secondary, #6b7280)" }}>
              {fillProgress.done}/{fillProgress.total}
            </span>
          )}
        </div>

        {error && (
          <div
            role="alert"
            style={{
              marginTop: "0.6rem",
              fontSize: "0.82rem",
              color: "var(--color-danger, #b91c1c)",
            }}
          >
            {error}
          </div>
        )}

        {/* ── Previews ───────────────────────────────────────────── */}

        {schemaPreview && (
          <div style={{ marginTop: "0.8rem" }}>
            <strong style={{ fontSize: "0.9rem" }}>
              Table: {schemaPreview.tableName}
            </strong>
            <ul style={{ margin: "0.3rem 0", paddingLeft: "1.1rem", fontSize: "0.85rem" }}>
              {schemaPreview.fields.map((f) => (
                <li key={f.name}>
                  {f.name} — <em>{f.type}</em>
                  {f.options?.length ? ` (${f.options.join(", ")})` : ""}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="btn-sm"
              onClick={() => {
                onCreateTable(schemaPreview.tableName, schemaPreview.fields);
                onClose();
              }}
            >
              Create table
            </button>
          </div>
        )}

        {fieldsPreview && (
          <div style={{ marginTop: "0.8rem" }}>
            <strong style={{ fontSize: "0.9rem" }}>Suggested fields</strong>
            <ul style={{ margin: "0.3rem 0", paddingLeft: "1.1rem", fontSize: "0.85rem" }}>
              {fieldsPreview.map((f) => (
                <li key={f.name}>
                  {f.name} — <em>{f.type}</em>
                  {f.options?.length ? ` (${f.options.join(", ")})` : ""}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className="btn-sm"
              onClick={() => {
                onAddFields(fieldsPreview);
                onClose();
              }}
            >
              Add {fieldsPreview.length} field
              {fieldsPreview.length === 1 ? "" : "s"}
            </button>
          </div>
        )}

        {formulaPreview && (
          <div style={{ marginTop: "0.8rem" }}>
            <strong style={{ fontSize: "0.9rem" }}>Formula</strong>
            <pre
              style={{
                background: "var(--color-bg-secondary, #f9fafb)",
                borderRadius: "var(--radius-md, 8px)",
                padding: "0.5rem",
                fontSize: "0.85rem",
                whiteSpace: "pre-wrap",
                margin: "0.3rem 0",
              }}
            >
              {formulaPreview}
            </pre>
            <button
              type="button"
              className="btn-sm"
              onClick={() => {
                onAddFields([
                  {
                    name: uniqueFormulaName(fields),
                    type: "formula",
                    formula: formulaPreview,
                  },
                ]);
                onClose();
              }}
            >
              Add as formula field
            </button>
          </div>
        )}

        {fillPreview && (
          <div style={{ marginTop: "0.8rem" }}>
            <strong style={{ fontSize: "0.9rem" }}>
              Preview ({fillPreview.size} value
              {fillPreview.size === 1 ? "" : "s"})
            </strong>
            <ul style={{ margin: "0.3rem 0", paddingLeft: "1.1rem", fontSize: "0.82rem", maxHeight: "180px", overflowY: "auto" }}>
              {Array.from(fillPreview.entries())
                .slice(0, 20)
                .map(([id, value]) => (
                  <li key={id}>{String(value)}</li>
                ))}
            </ul>
            <button
              type="button"
              className="btn-sm"
              onClick={() => {
                onApplyCellValues(fillFieldName, fillPreview);
                onClose();
              }}
            >
              Apply to {fillPreview.size} record
              {fillPreview.size === 1 ? "" : "s"}
            </button>
          </div>
        )}

        {summary && (
          <div
            style={{
              marginTop: "0.8rem",
              fontSize: "0.88rem",
              whiteSpace: "pre-wrap",
              background: "var(--color-bg-secondary, #f9fafb)",
              borderRadius: "var(--radius-md, 8px)",
              padding: "0.6rem",
            }}
          >
            {summary}
          </div>
        )}
      </div>
    </div>
  );
}

/** Pick a non-colliding name for an AI-generated formula field. */
function uniqueFormulaName(fields: BaseField[]): string {
  const taken = new Set(fields.map((f) => f.name));
  if (!taken.has("Formula")) return "Formula";
  for (let i = 2; ; i++) {
    const candidate = `Formula ${i}`;
    if (!taken.has(candidate)) return candidate;
  }
}
