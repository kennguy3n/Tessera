/**
 * Schema validation for the JSON payload returned by
 * `bridgeExtractTasksDecisions`. Pulled into its own module so the
 * exhaustive validation contract can be unit-tested without spinning
 * up Electron — the IPC handler in `ipc.ts` is a thin wrapper around
 * `validateExtractedItems`.
 *
 * Contract (must match `ExtractedItem` in the renderer's
 * `src/types/ipc.ts` AND `bridge_extract_tasks_decisions` in the
 * Rust bridge):
 *
 *   { itemType: "task" | "decision",
 *     text: string,
 *     sourceCitation: string,
 *     confidence: number  (finite) }
 *
 * Mismatched items are dropped, NOT silently coerced — a Rust-side
 * rename like `itemType` → `item_type` must be detectable.
 *
 * Failure modes:
 *   - Non-array input: throw (Rust returned a totally-wrong shape).
 *   - Mixed valid + invalid items: drop the invalid ones, log a
 *     single summary via the injected logger, return the valid ones.
 *     This tolerates per-item confidence/text outliers that some Rust
 *     extractors legitimately emit.
 *   - All items invalid against non-empty input: throw, because at
 *     that point the entire bridge contract is broken and silently
 *     returning [] reads to the user as "the model found nothing".
 *     The renderer's existing IPC-error path then surfaces this in
 *     the UI rather than burying it in the main-process console.
 *
 */

import type { ExtractedItem } from "../shared/types";

// Re-export so existing callers that import `ExtractedItem` from this
// module keep working. The canonical declaration lives in
// `apps/desktop/shared/types.ts`.
export type { ExtractedItem };

/**
 * Minimal HTML escape for the `text` and `sourceCitation` fields
 * before the validated `ExtractedItem` reaches the renderer.
 *
 * # Why this lives at the validation seam
 *
 * The renderer renders extracted items as plain React text by
 * default (`<li>{item.text}</li>`-shaped JSX), which React itself
 * escapes via its `setTextContent` codepath. But there are two
 * realistic future regressions we want to defend against
 * structurally:
 *
 *   1. **A future maintainer adds a `dangerouslySetInnerHTML` /
 *      `Markdown` render path** for the `text` field (e.g. to
 *      surface inline `**bold**` or `> quote` from the LLM
 *      extractor), at which point the field is no longer escaped
 *      by React and a model-prompt-injection attack can inject
 *      `<script>` / `<img onerror>` / `javascript:` URIs through
 *      the source content into the renderer. This is a well-known
 *      attack surface for LLM-extracted content.
 *   2. **The renderer pipes `sourceCitation` into a markdown
 *      tooltip or an `<a href>` attribute** (the field is a
 *      free-form citation string, so this is a natural future
 *      enhancement). HTML-escaping it at the validation seam means
 *      the renderer never has to remember which fields are
 *      pre-escaped.
 *
 * Escaping at the validation seam means BOTH the React text path
 * (idempotent — `&amp;amp;` would only appear if React itself
 * regressed on its escape) and any future `dangerouslySetInnerHTML`
 * path are safe by default. The renderer can rely on a single
 * invariant: "every string that came through `validateExtractedItems`
 * is safe to drop into HTML without further escaping".
 *
 * # Escape set
 *
 * Mirrors the existing `escapeHtml` in `passwordVault.ts` /
 * `providerOAuth.ts` / `LandingPageEditor.tsx` so the contract is
 * consistent across the codebase. Escapes the five HTML-significant
 * characters: `&`, `<`, `>`, `"`, `'`. Order is significant —
 * `&` MUST be replaced first so that subsequent replacements
 * (which all emit `&...;` entities) don't get re-escaped.
 *
 * # Double-escape avoidance
 *
 * `escapeExtractedHtml("&amp;")` returns `"&amp;amp;"`, NOT `"&amp;"`.
 * This is the correct behaviour: the contract is "the input is
 * untrusted plain text" and the output is "HTML-safe text". If a
 * caller has already pre-escaped, that's a caller-side bug — the
 * validation seam is a fresh-input boundary. The test suite
 * pins this with an explicit "&amp;amp;" assertion so a future
 * "smart" double-escape-prevention refactor cannot regress the
 * invariant silently.
 */
export function escapeExtractedHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

/**
 * `console.warn`-shaped sink. Tests inject a recording fake so we can
 * assert that bridge mismatches are logged with enough detail to
 * diagnose the schema break, even when the throw path is exercised.
 */
export type WarnSink = (message: string) => void;

export interface ValidationOptions {
  /** Identifier used in the throw + warn messages for log searchability. */
  context: string;
  /** Where to write the human-readable single-line summary. */
  warn: WarnSink;
}

export function validateExtractedItems(
  payload: unknown,
  opts: ValidationOptions,
): ExtractedItem[] {
  if (!Array.isArray(payload)) {
    // We treat this as unambiguously a contract break — there's no
    // useful "partial result" to return when the top-level shape is
    // wrong, so throw immediately.
    throw new Error(
      `extractTasksDecisions: bridge returned non-array payload (got ${typeof payload})`,
    );
  }

  const items: ExtractedItem[] = [];
  const dropReasons: string[] = [];

  for (const raw of payload) {
    if (!raw || typeof raw !== "object") {
      dropReasons.push("non-object payload");
      continue;
    }
    const rec = raw as Record<string, unknown>;
    const itemType =
      rec.itemType === "task" || rec.itemType === "decision"
        ? rec.itemType
        : null;
    const text = typeof rec.text === "string" ? rec.text : null;
    const sourceCitation =
      typeof rec.sourceCitation === "string" ? rec.sourceCitation : null;
    const confidence =
      typeof rec.confidence === "number" && Number.isFinite(rec.confidence)
        ? rec.confidence
        : null;
    if (itemType === null) {
      dropReasons.push(`itemType=${JSON.stringify(rec.itemType)}`);
      continue;
    }
    if (text === null) {
      dropReasons.push("missing-text");
      continue;
    }
    if (sourceCitation === null) {
      dropReasons.push("missing-sourceCitation");
      continue;
    }
    if (confidence === null) {
      dropReasons.push(`bad-confidence=${JSON.stringify(rec.confidence)}`);
      continue;
    }
    // HTML-escape both string fields at the validation seam so the
    // renderer can treat them as HTML-safe regardless of which
    // rendering path it uses today or in the future
    // (`{text}` JSX text, `dangerouslySetInnerHTML`, a markdown
    // tooltip, an `<a href>` derived from `sourceCitation`, etc.).
    // See the doc comment on `escapeExtractedHtml` for the full
    // rationale and the test suite for the XSS attack surface
    // we're defending against (e.g. `<script>`, `<img onerror>`,
    // `javascript:` URIs from prompt-injected source content).
    items.push({
      itemType,
      text: escapeExtractedHtml(text),
      sourceCitation: escapeExtractedHtml(sourceCitation),
      confidence,
    });
  }

  if (dropReasons.length === 0) {
    return items;
  }

  // Always log a single summary per call so a Rust-side rename
  // (e.g. itemType → item_type) is recoverable from the Electron
  // main-process console.
  const headReasons = dropReasons.slice(0, 5).join(", ");
  const tail = dropReasons.length > 5 ? ", ..." : "";
  opts.warn(
    `[tessera] extractTasksDecisions(${opts.context}): dropped ${dropReasons.length}/${payload.length} item(s) failing schema validation: ${headReasons}${tail}`,
  );

  // 100% drop against a non-empty input is unambiguous "schema
  // mismatch" rather than "data quality" — throw so the renderer
  // surfaces this in the UI. Partial drops just return the valid items.
  if (payload.length > 0 && items.length === 0) {
    const summary = dropReasons.slice(0, 3).join("; ");
    const ellipsis = dropReasons.length > 3 ? "; ..." : "";
    throw new Error(
      `extractTasksDecisions: bridge schema mismatch — all ${payload.length} item(s) failed validation (${summary}${ellipsis}). The Rust bridge contract for itemType / text / sourceCitation / confidence has likely drifted; restart the app or report this to the Tessera developers.`,
    );
  }

  return items;
}
