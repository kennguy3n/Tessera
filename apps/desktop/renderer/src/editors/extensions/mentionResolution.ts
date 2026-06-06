/**
 * Pure helpers for the KChat `@mention` extension (Session 8
 * Task 2).
 *
 * These functions hold the trigger-detection and node-resolution
 * logic with no dependency on TipTap or the DOM mutation surface,
 * so they can be unit-tested directly. The TipTap `Node` in
 * `KchatMentionExtension.ts` delegates to them, and the share path
 * uses {@link resolveMentionsInHtml} to turn the stored mention
 * markup into the plain `@username` text KChat expects.
 */

/** Attribute names persisted on a mention node / its HTML span. */
export const MENTION_DATA_TYPE = "kchat-mention";

/** Parsed `@query` trigger immediately preceding the caret. */
export interface MentionQueryMatch {
  /** The text typed after `@` (may be empty right after `@`). */
  query: string;
  /**
   * Offset (within the supplied `textBeforeCaret`) of the `@`
   * character that opened the trigger. Callers translate this into
   * a ProseMirror range to splice when a user is chosen.
   */
  atOffset: number;
}

/**
 * Render the canonical `@username` text for a mention. Centralised
 * so the node's `renderText`, the HTML serialisation, and the
 * share-time resolver all agree on the exact form (single leading
 * `@`, no duplication if the label already carries one).
 */
export function mentionToText(label: string): string {
  const trimmed = label.trim().replace(/^@+/, "");
  return `@${trimmed}`;
}

/**
 * Detect a mention trigger ending at the caret.
 *
 * Given the text of the current text-block up to the caret, returns
 * the active `@query` when:
 *   - an `@` appears, AND
 *   - the `@` is at the start of the block or preceded by
 *     whitespace (so `e@mail` does not trigger), AND
 *   - the run after `@` contains no whitespace (the query is a
 *     single token).
 *
 * Returns `null` when there is no active trigger.
 */
export function matchMentionQuery(
  textBeforeCaret: string,
): MentionQueryMatch | null {
  if (typeof textBeforeCaret !== "string") return null;
  const atOffset = textBeforeCaret.lastIndexOf("@");
  if (atOffset === -1) return null;

  // The char before `@` must be whitespace or the block start.
  if (atOffset > 0) {
    const prev = textBeforeCaret[atOffset - 1];
    if (!/\s/.test(prev)) return null;
  }

  const query = textBeforeCaret.slice(atOffset + 1);
  // A whitespace in the run means the user moved past the mention.
  if (/\s/.test(query)) return null;
  // Guard against absurdly long runs (paste of a giant token).
  if (query.length > 60) return null;

  return { query, atOffset };
}

/**
 * Replace every mention span in `html` with its plain `@username`
 * text. Used by the share path so a document containing mention
 * nodes resolves to `@alice` (etc.) in the shared markdown / message
 * body regardless of how the host renders the span.
 *
 * The matcher is intentionally tolerant of attribute ordering and
 * extra attributes: it keys on `data-type="kchat-mention"` and
 * pulls the username from `data-label` (falling back to the span's
 * inner text, then `data-id`).
 */
export function resolveMentionsInHtml(html: string): string {
  if (typeof html !== "string" || html.length === 0) return html;
  const spanRe =
    /<span\b[^>]*\bdata-type=["']kchat-mention["'][^>]*>(.*?)<\/span>/gi;
  return html.replace(spanRe, (match, inner: string) => {
    const label =
      attrValue(match, "data-label") ??
      stripTags(inner) ??
      attrValue(match, "data-id");
    if (!label) return match;
    return mentionToText(label);
  });
}

/** Extract an attribute value from a tag string, or null. */
function attrValue(tag: string, attr: string): string | null {
  const re = new RegExp(`\\b${attr}=["']([^"']*)["']`, "i");
  const m = re.exec(tag);
  return m && m[1].length > 0 ? m[1] : null;
}

/** Strip any nested tags from an inner-HTML fragment. */
function stripTags(inner: string): string | null {
  const text = inner.replace(/<[^>]*>/g, "").trim();
  return text.length > 0 ? text : null;
}
