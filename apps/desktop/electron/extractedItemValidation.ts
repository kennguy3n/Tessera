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
 * XSS / prompt-injection handling for the `text` and `sourceCitation`
 * fields.
 *
 * # Why we do NOT escape here
 *
 * An earlier revision of this module pre-escaped these fields at
 * the validation seam, intending to make them "HTML-safe by
 * default" before they reached the renderer. That approach is
 * actively wrong for the actual render path in `SourceDetailPage.tsx`
 * (and every other current consumer): React renders the fields as
 * JSX text expressions (`{item.text}`, `{item.sourceCitation}`),
 * which DOM-binds via `setTextContent` / `createTextNode` and
 * auto-escapes the five HTML-significant characters. Pre-escaping
 * at the validation seam therefore produces visible double-escape
 * artifacts in the UI — e.g. `"AT&T memo"` would be displayed as
 * the literal string `"AT&amp;T memo"` instead of `"AT&T memo"`.
 * The same regression hits apostrophes (`"It's done"` →
 * `"It&#39;s done"`), comparison operators in extracted text
 * (`"x < 10"` → `"x &lt; 10"`), and quotes inside citations
 * (`'"Q4 earnings" report.pdf'`).
 *
 * # Where the XSS defense actually lives
 *
 * 1. **Render-site auto-escape (today's defense).** Every current
 *    consumer renders these fields via JSX text expressions, which
 *    React auto-escapes — so an LLM-injected payload like
 *    `<script>alert(1)</script>` or `<img onerror=stealCookies()>`
 *    appears in the DOM as inert text, not as executable HTML. The
 *    `xss / prompt injection passthrough` describe block in
 *    `extractedItemValidation.test.ts` pins this contract by
 *    rendering a hardcoded XSS-payload `ExtractedItem` through
 *    React's own renderer and asserting that no `<script>` /
 *    `<img>` / `<iframe>` element materialises.
 * 2. **Defense in depth for future `dangerouslySetInnerHTML` /
 *    attribute-construction paths.** If a future maintainer adds
 *    a markdown render path for `text` or builds an `<a href>` /
 *    `<img src>` from `sourceCitation`, the escape MUST happen at
 *    the construction site (not here), because:
 *      - HTML attribute escaping has different rules from text
 *        content escaping (e.g. `\`` matters in attributes, `/`
 *        matters in `<script>` text);
 *      - `href` / `src` need URL-scheme allow-listing
 *        (`javascript:` / `data:` blocking) on top of HTML escape;
 *      - markdown render paths typically run their own escape and
 *        would double-encode if we pre-escaped here.
 *    The construction-site escape is also where the existing
 *    `escapeHtml` helpers in `passwordVault.ts` /
 *    `providerOAuth.ts` / `LandingPageEditor.tsx` live, by the
 *    same principle.
 *
 * In short: the validation seam returns the raw extracted strings
 * unchanged, and the renderer is responsible for context-appropriate
 * escaping. The test suite pins both the pass-through invariant AND
 * the render-time-safety invariant so a regression on either side
 * fails CI.
 */

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
    // Pass the strings through unchanged. XSS defense for current
    // consumers comes from React's JSX text auto-escape; a future
    // `dangerouslySetInnerHTML` / HTML-attribute consumer must
    // escape at the construction site. See the doc block above for
    // why pre-escaping here is incorrect (it double-escapes in
    // every current render path).
    items.push({ itemType, text, sourceCitation, confidence });
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
