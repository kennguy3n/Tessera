/**
 * On-device AI writing-assistant panel for the DocumentEditor.
 *
 * Floating panel (mirrors FindReplacePanel / CommentsPanel) that lets
 * the user run a writing action — improve, shorten, fix grammar,
 * change tone, summarize, translate, bullets, continue, or a free-form
 * "Ask AI" prompt — against the current selection, stream the result
 * with a Stop control, preview a word-level diff, and insert / replace
 * / append the accepted output.
 *
 * All generation goes through the local `window.tessera.model.generate`
 * surface via `useDocumentAi`. No document text leaves the device for
 * any Tessera-operated service.
 *
 * Thin shell: every non-trivial transform lives in the tested
 * `documentAiHelpers` / `documentAiApply` modules.
 */

import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import type { Editor } from "@tiptap/react";
import {
  DOCUMENT_AI_ACTIONS,
  DOCUMENT_AI_TONES,
  buildAiPrompt,
  canRunAction,
  cleanModelOutput,
  computeWordDiff,
  getDocumentAiAction,
} from "../ai/documentAiHelpers";
import {
  applyAiResult,
  type DocumentAiRange,
} from "../ai/documentAiApply";
import type {
  DocumentAiActionId,
  DocumentAiApplyMode,
  DocumentAiTone,
} from "../ai/documentAiTypes";
import { useDocumentAi } from "../../hooks/useDocumentAi";

export interface AiAssistantContext {
  /** Plain text of the selection captured when the panel opened. */
  selection: string;
  /** Up to a few hundred chars before the cursor (for `continue`). */
  precedingText: string;
  /** Document range the result will replace, or null when collapsed. */
  range: DocumentAiRange | null;
}

export interface AiAssistantPanelProps {
  editor: Editor;
  context: AiAssistantContext;
  /** Action to preselect (e.g. from the selection quick-toolbar). */
  initialAction?: DocumentAiActionId;
  onClose: () => void;
}

export function AiAssistantPanel({
  editor,
  context,
  initialAction,
  onClose,
}: AiAssistantPanelProps) {
  const ai = useDocumentAi();
  // `useDocumentAi` re-memoises its return object on every streaming token
  // (because `output` changes), but the imperative methods are individually
  // stable (`useCallback`). Destructure them so callbacks below can depend on
  // the stable references instead of the whole `ai` object — otherwise `run` /
  // `onKeyDown` would be recreated on every token during streaming.
  const { run: runGeneration, cancel: cancelGeneration } = ai;
  const [action, setAction] = useState<DocumentAiActionId>(
    initialAction ?? (context.selection.trim() ? "improve" : "custom"),
  );
  const [instruction, setInstruction] = useState("");
  const [tone, setTone] = useState<DocumentAiTone>("professional");
  const [language, setLanguage] = useState("Spanish");
  const [applyMode, setApplyMode] = useState<DocumentAiApplyMode>("replace");
  const promptInputRef = useRef<HTMLTextAreaElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);

  const hasSelection = context.selection.trim().length > 0;
  const cleaned = useMemo(() => cleanModelOutput(ai.output), [ai.output]);
  const activeAction = getDocumentAiAction(action);

  // The diff preview only makes sense for a selection-scoped rewrite
  // that will replace the selection.
  const diff = useMemo(() => {
    if (ai.status !== "done" || !hasSelection || applyMode !== "replace") {
      return null;
    }
    return computeWordDiff(context.selection, cleaned);
  }, [ai.status, hasSelection, applyMode, context.selection, cleaned]);

  // Focus the instruction box on open / when switching to custom so the
  // user can immediately type a prompt.
  useEffect(() => {
    if (action === "custom") {
      promptInputRef.current?.focus();
    }
  }, [action]);

  // When a run finishes, default the apply mode to the action's
  // recommendation (replace for edits, insert-below for summaries…).
  useEffect(() => {
    if (ai.status === "done" && activeAction) {
      setApplyMode(
        activeAction.defaultApply === "replace" && !hasSelection
          ? "insert-below"
          : activeAction.defaultApply,
      );
    }
  }, [ai.status, activeAction, hasSelection]);

  const runDisabled =
    ai.isStreaming ||
    !canRunAction(action, context.selection) ||
    (action === "custom" && instruction.trim().length === 0);

  const run = useCallback(() => {
    if (runDisabled) return;
    const prompt = buildAiPrompt({
      action,
      selection: context.selection,
      instruction,
      tone,
      language,
      precedingText: context.precedingText,
    });
    runGeneration(prompt);
  }, [
    runDisabled,
    action,
    context,
    instruction,
    tone,
    language,
    runGeneration,
  ]);

  const apply = useCallback(
    (mode: DocumentAiApplyMode) => {
      const text = cleaned;
      if (text.length === 0) return;
      const ok = applyAiResult(editor, context.range, mode, text, action);
      if (ok) onClose();
    },
    [cleaned, editor, context.range, action, onClose],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        if (ai.isStreaming) {
          cancelGeneration();
        } else {
          onClose();
        }
        return;
      }
      // Cmd/Ctrl+Enter runs the action from anywhere in the panel.
      if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        e.preventDefault();
        run();
      }
    },
    [ai.isStreaming, cancelGeneration, onClose, run],
  );

  const showResult = ai.output.length > 0 || ai.status === "streaming";

  return (
    <div
      ref={panelRef}
      className="ai-panel"
      data-testid="ai-assistant-panel"
      role="dialog"
      aria-label="AI writing assistant"
      onKeyDown={onKeyDown}
    >
      <div className="ai-panel-header">
        <span className="ai-panel-title">AI assistant</span>
        <span className="ai-panel-badge" title="Runs on your device">
          On-device
        </span>
        <button
          type="button"
          className="ai-panel-close"
          onClick={onClose}
          aria-label="Close AI assistant"
        >
          ✕
        </button>
      </div>

      {!hasSelection && action !== "custom" && action !== "continue" && (
        <p className="ai-panel-hint" data-testid="ai-needs-selection">
          Select text to use this action, or switch to Ask AI.
        </p>
      )}

      <div className="ai-panel-actions" role="group" aria-label="AI actions">
        {DOCUMENT_AI_ACTIONS.map((a) => {
          const disabled = a.needsSelection && !hasSelection;
          return (
            <button
              key={a.id}
              type="button"
              className={
                a.id === action ? "ai-action-chip active" : "ai-action-chip"
              }
              aria-pressed={a.id === action}
              disabled={disabled}
              title={a.description}
              onClick={() => setAction(a.id)}
            >
              {a.label}
            </button>
          );
        })}
      </div>

      {action === "tone" && (
        <label className="ai-panel-field">
          <span>Tone</span>
          <select
            value={tone}
            onChange={(e) => setTone(e.target.value as DocumentAiTone)}
          >
            {DOCUMENT_AI_TONES.map((t) => (
              <option key={t.id} value={t.id}>
                {t.label}
              </option>
            ))}
          </select>
        </label>
      )}

      {action === "translate" && (
        <label className="ai-panel-field">
          <span>Language</span>
          <input
            type="text"
            value={language}
            onChange={(e) => setLanguage(e.target.value)}
            placeholder="e.g. French"
          />
        </label>
      )}

      {(action === "custom" || hasSelection) && (
        <textarea
          ref={promptInputRef}
          className="ai-panel-prompt"
          value={instruction}
          onChange={(e) => setInstruction(e.target.value)}
          rows={action === "custom" ? 3 : 2}
          placeholder={
            action === "custom"
              ? "Ask AI to write something…"
              : "Optional: add extra instructions"
          }
          aria-label="AI instruction"
        />
      )}

      <div className="ai-panel-run-row">
        <button
          type="button"
          className="btn btn-primary ai-panel-run"
          onClick={run}
          disabled={runDisabled}
          data-testid="ai-run"
        >
          {ai.isStreaming ? "Generating…" : "Generate"}
        </button>
        {ai.isStreaming && (
          <button
            type="button"
            className="btn btn-secondary"
            onClick={cancelGeneration}
            data-testid="ai-stop"
          >
            Stop
          </button>
        )}
        <span className="ai-panel-shortcut">⌘⏎</span>
      </div>

      {ai.status === "error" && (
        <p className="ai-panel-error" role="alert" data-testid="ai-error">
          {ai.error ?? "Generation failed."}
        </p>
      )}
      {ai.status === "battery_low" && (
        <p className="ai-panel-error" role="alert">
          Generation paused — device battery is below 20%.
        </p>
      )}
      {ai.status === "cancelled" && (
        <p className="ai-panel-hint">Generation stopped.</p>
      )}

      {showResult && (
        <div className="ai-panel-result" data-testid="ai-result">
          {diff ? (
            <div className="ai-diff" aria-label="Suggested changes">
              {diff.map((seg, i) => (
                <span key={i} className={`ai-diff-${seg.kind}`}>
                  {seg.value}
                </span>
              ))}
            </div>
          ) : (
            <div className="ai-result-text">{cleaned}</div>
          )}
        </div>
      )}

      {ai.status === "done" && cleaned.length > 0 && (
        <div className="ai-panel-apply" role="group" aria-label="Apply result">
          {hasSelection && (
            <button
              type="button"
              className="btn btn-primary"
              onClick={() => apply("replace")}
              data-testid="ai-apply-replace"
            >
              Replace
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => apply("insert-below")}
            data-testid="ai-apply-insert"
          >
            Insert below
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={() => apply("append")}
            data-testid="ai-apply-append"
          >
            Append
          </button>
          <button
            type="button"
            className="btn btn-secondary"
            onClick={run}
            title="Run again"
          >
            Retry
          </button>
        </div>
      )}
    </div>
  );
}
