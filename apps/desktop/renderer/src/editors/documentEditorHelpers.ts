/**
 * Pure helpers for `DocumentEditor`. Extracted out of the
 * component file so React Fast Refresh can preserve editor state
 * across HMR edits and so the helpers are reachable from headless
 * vitest runs without booting the TipTap / ProseMirror module graph
 * (which depends on DOM globals not available under jsdom in CI).
 *
 * Every helper here implements the real algorithm — no stubs, no
 * "TODO real implementation" markers. The Phase 18 PR 6 document
 * editor surface (tables, task lists, syntax-highlight code blocks,
 * find/replace, slash menu, image upload, char/word count) depends
 * on these helpers behaving identically whether they're called from
 * the live editor or from a test.
 */

// ─────────────────────────────────────────────────────────────────────
// Content normalisation
// ─────────────────────────────────────────────────────────────────────

/**
 * Tags we trust as "this is HTML the editor's own `getHTML()` produced
 * and round-tripped through storage". Anything starting with a tag
 * NOT on this list is treated as plain text and HTML-escaped — that
 * way a user pasting a Markdown file whose first character is `<`
 * (e.g. `<script>…`, `<iframe>…`, `<style>…`) can't slip a node into
 * the editor by accident. Tags here match the set of nodes TipTap's
 * `StarterKit` + this editor's enabled extensions can produce on
 * `getHTML()`. Add a new tag here when adding the corresponding
 * TipTap extension; otherwise the round-trip will lose data.
 *
 * NOTE: the entries are lowercase and matched against the lowercased
 * input. Self-closing tags (e.g. `<hr />`) are matched without the
 * closing slash.
 */
const TRUSTED_LEADING_TAGS = [
  "p",
  "h1",
  "h2",
  "h3",
  "h4",
  "h5",
  "h6",
  "ul",
  "ol",
  "li",
  "blockquote",
  "pre",
  "code",
  "table",
  "thead",
  "tbody",
  "tr",
  "th",
  "td",
  "hr",
  "br",
  "div",
  "span",
  "img",
  "a",
  "strong",
  "em",
  "b",
  "i",
  "u",
  "s",
  "del",
];

/**
 * Returns true iff `content` (post-trim) starts with one of the
 * `TRUSTED_LEADING_TAGS`. Used by `parseDocumentContent` to decide
 * whether to treat the input as already-HTML (return as-is) vs plain
 * text needing paragraph-wrap + HTML escaping.
 *
 * The check is structural — it matches `<tag` followed by `>`, ` `,
 * `\t`, `\n`, or `/` so that `<scriptx>` does NOT accidentally match
 * `<script` (we only allowlist whole tag names) and `<HTML>` matches
 * regardless of case.
 */
function startsWithTrustedTag(content: string): boolean {
  const trimmed = content.trim();
  if (!trimmed.startsWith("<")) return false;
  // Match `<tag` then a whitespace/`>`/`/` boundary. Case-insensitive.
  const match = trimmed.match(/^<([a-zA-Z][a-zA-Z0-9]*)([\s>/])/);
  if (!match) return false;
  return TRUSTED_LEADING_TAGS.includes(match[1].toLowerCase());
}

/**
 * Normalize the artifact's serialized content into the TipTap-friendly
 * HTML string the editor expects on mount.
 *
 * Exported so it can be unit-tested independently of the TipTap
 * pipeline. Behaviour:
 *   - Empty / nullish content → a single empty paragraph (TipTap's
 *     canonical "blank doc" representation).
 *   - Content that begins with a `TRUSTED_LEADING_TAGS` tag (after
 *     trimming) is treated as HTML and returned as-is — this is the
 *     common case after the editor's own `getHTML()` round-trip.
 *     `<script>`, `<iframe>`, `<style>`, `<object>`, `<embed>`, etc.
 *     are deliberately NOT on the trusted list, so a content payload
 *     starting with one of those gets HTML-escaped instead, removing
 *     the injection vector.
 *   - Otherwise, the input is treated as plain text and wrapped into
 *     paragraphs (`\n\n` → paragraph break, `\n` → `<br>`). HTML in
 *     the plain-text branch is escaped so the user's text reads
 *     literally in the editor, not as live HTML.
 */
export function parseDocumentContent(content: string | null | undefined): string {
  if (!content) return "<p></p>";
  if (startsWithTrustedTag(content)) return content;
  return content
    .split("\n\n")
    .map((p) => `<p>${escapeHtml(p).replace(/\n/g, "<br>")}</p>`)
    .join("");
}

/**
 * HTML-escape the five characters that change parser state (`<`, `>`,
 * `&`, `"`, `'`). Used by `parseDocumentContent` on the plain-text
 * branch so `<script>` in source content can't sneak through the
 * paragraph wrapper into the live editor.
 */
export function escapeHtml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#39;");
}

// ─────────────────────────────────────────────────────────────────────
// Word / character counting
// ─────────────────────────────────────────────────────────────────────

export interface DocCounts {
  /** Number of UTF-16 code units (matches `String.prototype.length`). */
  characters: number;
  /** Visible characters with whitespace stripped (Google-Docs style). */
  charactersNoSpaces: number;
  /** Whitespace-delimited word count; 0 for blank input. */
  words: number;
}

/**
 * Plain-text word/char counter shared by the editor footer and tests.
 * Operates on TipTap's `editor.getText()` output (a plain string) so
 * the counter never has to know about HTML or ProseMirror nodes.
 *
 * Word boundary is `/\s+/` — same heuristic Google Docs and most
 * editors use, deliberately lenient about punctuation (`hello,world`
 * is one word, matching user expectation that "I typed two words" =
 * "I pressed space once").
 */
export function countDocText(text: string): DocCounts {
  const characters = text.length;
  const charactersNoSpaces = text.replace(/\s+/g, "").length;
  const trimmed = text.trim();
  const words = trimmed.length === 0 ? 0 : trimmed.split(/\s+/).length;
  return { characters, charactersNoSpaces, words };
}

// ─────────────────────────────────────────────────────────────────────
// Slash command catalog
// ─────────────────────────────────────────────────────────────────────

/**
 * Single entry in the `/`-triggered insertion menu. Identified by
 * `id` (stable for tests / keyboard shortcuts) and grouped by
 * `category` so the rendered list can show section headers.
 *
 * `keywords` extends the searchable surface beyond the visible label
 * — e.g. typing `/photo` matches the `image` command.
 */
export interface SlashCommand {
  id: string;
  label: string;
  description: string;
  category: "blocks" | "lists" | "media" | "inline";
  keywords: string[];
}

/** The full catalog rendered by the slash menu. Order = display order. */
export const SLASH_COMMANDS: readonly SlashCommand[] = [
  {
    id: "heading-1",
    label: "Heading 1",
    description: "Large section title",
    category: "blocks",
    keywords: ["h1", "title", "heading"],
  },
  {
    id: "heading-2",
    label: "Heading 2",
    description: "Medium section title",
    category: "blocks",
    keywords: ["h2", "subtitle", "heading"],
  },
  {
    id: "heading-3",
    label: "Heading 3",
    description: "Small section title",
    category: "blocks",
    keywords: ["h3", "heading"],
  },
  {
    id: "paragraph",
    label: "Text",
    description: "Plain paragraph",
    category: "blocks",
    keywords: ["p", "text", "paragraph"],
  },
  {
    id: "blockquote",
    label: "Quote",
    description: "Block quote",
    category: "blocks",
    keywords: ["quote", "blockquote", "bq"],
  },
  {
    id: "code-block",
    label: "Code Block",
    description: "Monospaced block with syntax highlighting",
    category: "blocks",
    keywords: ["code", "snippet", "pre", "```"],
  },
  {
    id: "horizontal-rule",
    label: "Divider",
    description: "Horizontal rule",
    category: "blocks",
    keywords: ["hr", "divider", "rule", "---"],
  },
  {
    id: "bullet-list",
    label: "Bulleted List",
    description: "Unordered list",
    category: "lists",
    keywords: ["ul", "bullet", "list", "*"],
  },
  {
    id: "ordered-list",
    label: "Numbered List",
    description: "Ordered list",
    category: "lists",
    keywords: ["ol", "number", "list", "1."],
  },
  {
    id: "task-list",
    label: "Task List",
    description: "Checkbox to-do list",
    category: "lists",
    keywords: ["todo", "checkbox", "task", "[ ]"],
  },
  {
    id: "table",
    label: "Table",
    description: "Insert a 3×3 table",
    category: "blocks",
    keywords: ["table", "grid"],
  },
  {
    id: "image",
    label: "Image",
    description: "Upload or embed an image",
    category: "media",
    keywords: ["image", "photo", "picture", "img"],
  },
  {
    id: "mermaid",
    label: "Diagram",
    description: "Mermaid diagram block",
    category: "media",
    keywords: ["mermaid", "diagram", "chart", "flow"],
  },
];

/**
 * Filter the slash catalog by user query. Empty query returns the
 * full catalog in original order. Non-empty query matches against
 * `label`, `description`, and `keywords` (case-insensitive substring
 * on each), then sorts so label-prefix matches surface first, then
 * label substring matches, then keyword/description matches.
 *
 * Pure function — no editor coupling — so the test suite can pin the
 * exact ordering without booting TipTap.
 */
export function filterSlashCommands(
  query: string,
  catalog: readonly SlashCommand[] = SLASH_COMMANDS,
): SlashCommand[] {
  const q = query.trim().toLowerCase();
  if (q.length === 0) return [...catalog];

  type Scored = { cmd: SlashCommand; score: number };
  const scored: Scored[] = [];
  for (const cmd of catalog) {
    const label = cmd.label.toLowerCase();
    const description = cmd.description.toLowerCase();
    const keywords = cmd.keywords.map((k) => k.toLowerCase());

    let score = -1;
    if (label.startsWith(q)) score = 100 - label.length;
    else if (label.includes(q)) score = 80 - label.length;
    else if (keywords.some((k) => k === q)) score = 70;
    else if (keywords.some((k) => k.startsWith(q))) score = 60;
    else if (keywords.some((k) => k.includes(q))) score = 50;
    else if (description.includes(q)) score = 30;

    if (score >= 0) scored.push({ cmd, score });
  }

  scored.sort((a, b) => b.score - a.score);
  return scored.map((s) => s.cmd);
}

// ─────────────────────────────────────────────────────────────────────
// Find & replace text search
// ─────────────────────────────────────────────────────────────────────

export interface FindMatch {
  /** 0-based start index into the haystack string. */
  start: number;
  /** Exclusive end index (`start + matchLength`). */
  end: number;
}

export interface FindOptions {
  caseSensitive: boolean;
  wholeWord: boolean;
  regex: boolean;
}

/**
 * Find every occurrence of `needle` in `haystack` per `opts`.
 *
 * Returns `[]` for an empty `needle` (so the UI can clear highlights
 * by clearing the input) or for an invalid regex (so a half-typed
 * pattern like `[abc` doesn't crash the panel).
 *
 * The matcher is greedy and non-overlapping — `aaaa` searched for
 * `aa` yields two matches at offsets 0 and 2, matching what every
 * native find-in-page implementation does.
 *
 * Whole-word mode wraps the needle in `\b` boundaries (after regex
 * escaping if `regex` is false). This intentionally matches
 * `regex.exec` semantics rather than rolling our own word
 * boundary, because `\b` is the same Unicode-aware definition
 * Chrome and Firefox use for `Ctrl+F`'s "Match whole word".
 */
export function findAllMatches(
  haystack: string,
  needle: string,
  opts: FindOptions,
): FindMatch[] {
  if (needle.length === 0) return [];

  let pattern = opts.regex ? needle : escapeRegex(needle);
  if (opts.wholeWord) pattern = `\\b(?:${pattern})\\b`;
  let flags = "g";
  if (!opts.caseSensitive) flags += "i";

  let re: RegExp;
  try {
    re = new RegExp(pattern, flags);
  } catch {
    return [];
  }

  const out: FindMatch[] = [];
  let m: RegExpExecArray | null;
  while ((m = re.exec(haystack)) !== null) {
    // Defensive: zero-width matches (e.g. `(?=)` or `^$`) would
    // otherwise advance `lastIndex` by 0 and spin forever. Push the
    // match, then nudge `lastIndex` past it.
    out.push({ start: m.index, end: m.index + m[0].length });
    if (m.index === re.lastIndex) re.lastIndex += 1;
    // Hard cap to keep an unbounded regex (e.g. `.*` on a million-
    // character doc) from locking the renderer thread.
    if (out.length >= 10_000) break;
  }
  return out;
}

/**
 * Escape every regex metacharacter so a plain-text needle can be
 * safely composed into a `RegExp` for whole-word / case-insensitive
 * search. Exported because the slash-command unit tests use the
 * same escape for fuzzy-match prefix tests.
 */
export function escapeRegex(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/**
 * Pick the "active" match in a list, given a caret position in the
 * haystack and a navigation direction. Used by the find panel's
 * Next / Previous buttons.
 *
 * Behaviour matches Chromium's `Ctrl+F`:
 *   - `direction: "next"` returns the first match whose `start >= caret`,
 *     wrapping to index 0 if none qualify.
 *   - `direction: "previous"` returns the last match whose `start < caret`,
 *     wrapping to the final match if none qualify.
 *   - For an empty match list, returns -1.
 *
 * Pure index math — keeps the panel component thin.
 */
export function pickActiveMatch(
  matches: readonly FindMatch[],
  caret: number,
  direction: "next" | "previous",
): number {
  if (matches.length === 0) return -1;
  if (direction === "next") {
    for (let i = 0; i < matches.length; i += 1) {
      if (matches[i].start >= caret) return i;
    }
    return 0;
  }
  // previous
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    if (matches[i].start < caret) return i;
  }
  return matches.length - 1;
}

/**
 * Replace a single match in `haystack`, returning the new string.
 * Trivial wrapper that exists so the editor command (which mutates
 * the ProseMirror document) and the test (which just diffs strings)
 * agree on the replacement semantics.
 */
export function replaceOne(
  haystack: string,
  match: FindMatch,
  replacement: string,
): string {
  return haystack.slice(0, match.start) + replacement + haystack.slice(match.end);
}

/**
 * Replace every match in `haystack`, returning the new string. The
 * matches must be in ascending `start` order and non-overlapping
 * (the contract `findAllMatches` always satisfies). We walk in
 * reverse so each splice keeps the indices of earlier matches valid.
 */
export function replaceAll(
  haystack: string,
  matches: readonly FindMatch[],
  replacement: string,
): string {
  let out = haystack;
  for (let i = matches.length - 1; i >= 0; i -= 1) {
    out = replaceOne(out, matches[i], replacement);
  }
  return out;
}

// ─────────────────────────────────────────────────────────────────────
// Image embedding
// ─────────────────────────────────────────────────────────────────────

/**
 * Read a `File` (from a paste / drop / file-picker) as a data URL so
 * the editor can embed it inline as an `<img src="data:...">` node.
 *
 * Data URLs are intentionally chosen over an out-of-band upload
 * pipeline because Tessera artifacts are self-contained JSON blobs
 * stored locally — embedding the bytes keeps the artifact portable
 * (export, version restore, copy/paste across machines) without
 * needing a separate asset-store schema. The trade-off is artifact
 * size, which the call-site bounds via `MAX_IMAGE_BYTES`.
 */
export const MAX_IMAGE_BYTES = 5 * 1024 * 1024; // 5 MiB — soft cap

export function fileToDataUrl(file: File): Promise<string> {
  return new Promise((resolve, reject) => {
    if (file.size > MAX_IMAGE_BYTES) {
      reject(
        new Error(
          `Image is ${(file.size / 1024 / 1024).toFixed(1)} MiB; the inline-embed cap is ${(
            MAX_IMAGE_BYTES /
            1024 /
            1024
          ).toFixed(0)} MiB.`,
        ),
      );
      return;
    }
    const reader = new FileReader();
    reader.onload = () => {
      const result = reader.result;
      if (typeof result !== "string") {
        reject(new Error("FileReader produced a non-string result"));
        return;
      }
      resolve(result);
    };
    reader.onerror = () =>
      reject(reader.error ?? new Error("Failed to read image file"));
    reader.readAsDataURL(file);
  });
}
