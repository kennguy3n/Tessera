/**
 * Pure helpers for `SlideEditor` — content parsing, the Marp-Markdown
 * serializer used by the export pipeline, and the Shadow DOM applier
 * shared between the editor's MarpPreview and its unit tests.
 *
 * Extracted out of `SlideEditor.tsx` so the component file's exports
 * are all components — required for React Fast Refresh to preserve
 * editor state across HMR edits. Types are imported from
 * `./slideEditorTypes` (a dedicated type-only module), so there is
 * no runtime cycle with the component file: both this helpers module
 * and the component module independently consume types from the
 * third file, breaking the would-be A↔B dependency edge.
 */
import type { MarpRenderOptions } from "../services/marpRenderer";
import { yamlSingleQuote } from "../utils/yaml";
import type {
  Slide,
  SlideBlock,
  SlideContent,
  SlideLayout,
} from "./slideEditorTypes";

// Inline-image upload path: re-export the shared helper from
// `./inlineImage` rather than maintaining a second copy. The previous
// hand-rolled implementation had no size cap, which let a user inline
// a multi-MB image into the slide JSON and slow down every subsequent
// debounced save. Routing through the shared helper inherits the 5
// MiB cap and the human-readable rejection message used by the
// document editor, keeping both editors in lock-step. Re-exports are
// grouped with the regular imports at the file top per CONTRIBUTING.md
//
export { MAX_INLINE_IMAGE_BYTES, fileToDataUrl } from "./inlineImage";

export interface ParsedSlideContent {
  slides: Slide[];
  marpMode: boolean;
  marpSource: string;
  marpTheme: MarpRenderOptions["theme"] | undefined;
}

/**
 * Generate a stable, collision-resistant identifier for a slide or
 * block. Falls back to a `Math.random` + counter combination when the
 * `crypto.randomUUID` API is unavailable (older Electron renderers,
 * jsdom in unit tests, etc.) so callers never need a polyfill.
 *
 * IDs are persisted in the saved JSON. We deliberately use opaque
 * string IDs rather than indices because (a) drag-and-drop reorder
 * makes index-based React keys destroy and re-mount component
 * instances on every move, and (b) the find panel needs to refer to
 * a specific slide / block even across edits that change array
 * positions.
 */
let __slideIdCounter = 0;
export function newSlideId(prefix: "slide" | "block" = "slide"): string {
  const g = globalThis as unknown as {
    crypto?: { randomUUID?: () => string };
  };
  if (typeof g.crypto?.randomUUID === "function") {
    return `${prefix}-${g.crypto.randomUUID()}`;
  }
  __slideIdCounter += 1;
  // 36-char base alphanumerics keep the IDs roughly the same length
  // as the UUID fallback and avoid characters that would need
  // escaping in JSON or DOM attribute values.
  const rand = Math.random().toString(36).slice(2, 10);
  return `${prefix}-${Date.now().toString(36)}-${__slideIdCounter.toString(36)}-${rand}`;
}

/**
 * Ensure every slide and every block has a non-empty `id` string,
 * mutating in place is NOT done — a new array is returned so the
 * caller's setState can detect the migration without a deep equal.
 * When every input already has an ID, the original `slides` reference
 * is returned unchanged so callers can use referential equality to
 * short-circuit a re-render.
 *
 * Used by `parseSlideContent` to backfill IDs on legacy decks saved
 * before (which had no `Slide.id` / `SlideBlock.id`
 * field). Exported because the tests verify the migration and the
 * SlideEditor's content-sync effect uses it directly.
 */
export function backfillSlideIds(slides: readonly Slide[]): Slide[] {
  // Lazy clone-on-first-mutation: don't allocate a new `Slide[]` or
  // a new `blocks[]` until we hit the first ID-less slide/block. The
  // common case (already-migrated decks) returns the original array
  // and the original block arrays untouched — zero GC pressure and
  // referential equality is preserved end-to-end so React's setState
  // can short-circuit.
  let nextSlides: Slide[] | null = null;
  for (let i = 0; i < slides.length; i += 1) {
    const slide = slides[i];
    let nextBlocks: SlideBlock[] | null = null;
    for (let j = 0; j < slide.blocks.length; j += 1) {
      const block = slide.blocks[j];
      if (block.id) {
        // Only need to copy already-seen blocks into the new array
        // once we know we're cloning — i.e. when `nextBlocks` is
        // non-null. While `nextBlocks` is null, the original
        // `slide.blocks` is still the source of truth and we keep
        // walking.
        if (nextBlocks) nextBlocks.push(block);
        continue;
      }
      // First ID-less block — initialise the clone and back-fill
      // the prefix we already walked.
      if (!nextBlocks) {
        nextBlocks = slide.blocks.slice(0, j);
      }
      nextBlocks.push({ ...block, id: newSlideId("block") });
    }
    // `needsNewId` is true when this slide is missing its `id`. The
    // earlier `hasNewId` name was inverted — read as "has a new id"
    // but actually meant "needs one assigned" — so the polarity is
    // restored here for readability.
    const needsNewId = !slide.id;
    if (!needsNewId && !nextBlocks) {
      // Slide is already fully migrated. Pass through unchanged —
      // only copy it into `nextSlides` if a previous slide forced us
      // to clone the outer array.
      if (nextSlides) nextSlides.push(slide);
      continue;
    }
    // First slide that needs mutation — initialise the outer clone
    // and back-fill the prefix.
    if (!nextSlides) {
      nextSlides = slides.slice(0, i) as Slide[];
    }
    nextSlides.push({
      ...slide,
      id: slide.id || newSlideId("slide"),
      blocks: nextBlocks ?? slide.blocks,
    });
  }
  // ## Invariant — the `slides as Slide[]` cast is only safe under
  // the lazy-clone contract above:
  //
  //   * If ANY slide OR ANY block needed an id, `nextSlides` was
  //     initialised AND every subsequent slide was pushed onto it
  //     (either as-is or freshly cloned). The early-return at the
  //     top of the loop (`if (!needsNewId && !nextBlocks) { if
  //     (nextSlides) nextSlides.push(slide); continue; }`) is what
  //     keeps that contract: once we've started cloning, we MUST
  //     keep pushing — we never branch back to "leave the rest of
  //     the input alone".
  //   * If NO slide and NO block needed an id, `nextSlides` is
  //     still null. The caller's input was already fully migrated
  //     and we just hand the original reference back. The cast
  //     drops the `readonly` modifier — sound because callers
  //     (every internal caller in `slideEditorHelpers` / state
  //     setters in `SlideEditor`) already hold the array as
  //     mutable; `readonly` only appears at this function's
  //     parameter type to advertise that *we* don't mutate.
  //
  // A future refactor that mutated a slide in place (e.g. assigned
  // `slide.id = newSlideId(...)` directly instead of cloning) would
  // silently violate the invariant: `nextSlides` would stay null,
  // we'd `return slides as Slide[]`, and the lying-by-omission
  // mutation would leak through to the caller's previous-state
  // reference (breaking React's setState-with-prev-equality
  // short-circuit). If you need to add a new migration path, clone
  // — never mutate.
  return nextSlides ?? (slides as Slide[]);
}

export function parseSlideContent(content: string): ParsedSlideContent {
  const emptyDefault: ParsedSlideContent = {
    slides: backfillSlideIds([
      { id: "", title: "Title Slide", blocks: [{ id: "", type: "text", content: "" }], notes: "" },
    ]),
    marpMode: false,
    marpSource: "",
    marpTheme: undefined,
  };
  if (!content) return emptyDefault;
  try {
    const parsed = JSON.parse(content) as SlideContent;
    if (parsed.slides && Array.isArray(parsed.slides) && parsed.slides.length > 0) {
      return {
        slides: backfillSlideIds(parsed.slides),
        marpMode: parsed.marp?.enabled ?? false,
        marpSource: parsed.marp?.source ?? "",
        marpTheme: parsed.marp?.theme,
      };
    }
  } catch {
    // Not JSON — treat as single text slide
  }
  return {
    slides: backfillSlideIds([
      { id: "", title: "Slide 1", blocks: [{ id: "", type: "text", content }], notes: "" },
    ]),
    marpMode: false,
    marpSource: "",
    marpTheme: undefined,
  };
}

/**
 * Convert the structured `Slide[]` representation (used by the WYSIWYG slide
 * editor) into a Marp-Markdown string suitable for handing to the Marp CLI.
 *
 * This is the path taken when a user exports a slide artifact to PPTX without
 * having explicitly toggled Marp Mode — we synthesise a minimal Marp document
 * from the structured blocks so the Marp CLI has something to render.
 */
export function slidesToMarpMarkdown(
  slides: Slide[],
  options?: { theme?: string },
): string {
  const theme = options?.theme ?? "default";
  // `theme` originates from user-editable JSON (parsed.marp?.theme). Wrap it
  // in a YAML single-quoted scalar so a value containing a newline cannot
  // inject a second directive into the front-matter block. See
  // `utils/yaml.ts` for the full rationale.
  const header = [
    "---",
    "marp: true",
    `theme: ${yamlSingleQuote(theme)}`,
    "paginate: true",
    "---",
  ];
  const body = slides.map((slide) => renderSlideAsMarp(slide));
  // Marp requires `---` horizontal rules between slides to delimit them.
  // The opening front-matter `---...---` block separates config from the
  // first slide; subsequent slides each need their own leading `---`.
  return [header.join("\n"), body.join("\n\n---\n\n")].join("\n\n");
}

function renderSlideAsMarp(slide: Slide): string {
  const parts: string[] = [];
  if (slide.title) {
    parts.push(`# ${slide.title}`);
  }
  for (const block of slide.blocks) {
    const content = (block.content ?? "").trim();
    if (!content) continue;
    if (block.type === "bullets") {
      const lines = content
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter((line) => line.length > 0)
        .map((line) => `- ${line.replace(/^[-*]\s*/, "")}`);
      if (lines.length > 0) parts.push(lines.join("\n"));
    } else if (block.type === "diagram") {
      parts.push("```mermaid\n" + content + "\n```");
    } else if (block.type === "image") {
      // Render as Markdown image so Marp emits a real <img>.
      // `content` is the source URL (typically an inlined data:image/…
      // URL written by `fileToDataUrl`); `alt` falls back to empty when
      // unset, matching the HTML <img alt=""> convention for decorative
      // images. We intentionally do not strip the data URL even though
      // it can be large — the round-trip back through `parseSlideContent`
      // depends on it being present, and Marp handles base64 data URLs
      // natively.
      //
      // We use CommonMark's angle-bracket link-destination form
      // (`<url>`) unconditionally so URLs containing characters that
      // would otherwise terminate the `()` group — most notably `(`
      // and `)`, but also spaces — round-trip correctly. Per
      // CommonMark §6.4, the angle-bracket form accepts any character
      // except an unescaped `<`, `>`, or newline. None of those can
      // appear in a valid `data:image/…` URL (base64 uses
      // `A-Za-z0-9+/=` only) or in any valid HTTP(S) URL (`<` / `>` /
      // newline must be percent-encoded), so the angle-bracket form
      // is safe for every URL we're ever asked to emit. Brackets in
      // alt text are still stripped because the `[...]` group has no
      // angle-bracket escape hatch.
      const alt = (block.alt ?? "").replace(/[[\]]/g, "");
      parts.push(`![${alt}](<${content}>)`);
    } else {
      parts.push(content);
    }
  }
  if (slide.notes && slide.notes.trim().length > 0) {
    parts.push(`<!-- ${escapeHtmlComment(slide.notes.trim())} -->`);
  }
  return parts.join("\n\n");
}

/**
 * Escape a string so it can be embedded inside an HTML comment without the
 * embedded `-->` closing the comment early.
 *
 * Used by `renderSlideAsMarp` when materialising speaker notes for the Marp
 * CLI export pipeline. Without this, a user's notes containing `-->` would
 * prematurely terminate the comment and inject the trailing text into the
 * surrounding Marp Markdown, which then leaks into the rendered slide deck
 * (PPTX/PDF/HTML) as visible content. The standard mitigation (used by
 * mdast-util-to-markdown, remark, etc.) is to insert a space inside the
 * `-->` sequence so the HTML tokenizer no longer recognises a comment-end.
 */
export function escapeHtmlComment(text: string): string {
  // Replace every `-->` with `-- >`. The space breaks the HTML5 comment-end
  // production (`--` followed by `>`) without altering the visible characters
  // beyond a single space inside the comment body — speaker notes are not
  // rendered as text, so the cosmetic change is invisible to the audience.
  return text.replace(/-->/g, "-- >");
}

/**
 * Extract the `theme:` value from the YAML front-matter of a Marp source
 * string. Returns `undefined` if the source has no front-matter or no
 * `theme:` directive. Used by `SlideEditor` to keep the theme dropdown in
 * sync when the user manually edits the raw Marp source.
 *
 * Front-matter detection is anchored at the start of the string and uses a
 * non-greedy capture so trailing `---` separators between slides don't
 * accidentally extend the front-matter region. Quoting is tolerated by
 * trimming + stripping outer quote chars.
 */
export function extractFrontmatterTheme(src: string): string | undefined {
  const fmMatch = src.match(/^---\s*\n([\s\S]*?)\n---/);
  if (!fmMatch) return undefined;
  const themeMatch = fmMatch[1].match(/^theme:\s*(.+)$/m);
  if (!themeMatch) return undefined;
  let value = themeMatch[1].trim();
  // Strip a single layer of surrounding single or double quotes — YAML
  // allows both `theme: gaia`, `theme: "gaia"`, and `theme: 'gaia'`.
  if (
    (value.startsWith("'") && value.endsWith("'")) ||
    (value.startsWith('"') && value.endsWith('"'))
  ) {
    value = value.slice(1, -1);
  }
  return value;
}

/**
 * Return a copy of the given Marp source with its front-matter `theme:`
 * directive set to the given value. If the source has no front-matter,
 * prepend a minimal one (`marp: true` + `theme:`). If front-matter exists
 * but has no `theme:` line, append one at the end of the block.
 *
 * Used by `SlideEditor` so the theme dropdown rewrites the visible source
 * front-matter rather than diverging silently from it.
 */
export function setFrontmatterTheme(src: string, theme: string): string {
  const fmMatch = src.match(/^(---\s*\n)([\s\S]*?)(\n---)/);
  if (!fmMatch) {
    const prefix = src.length > 0 ? "\n\n" : "";
    return `---\nmarp: true\ntheme: ${theme}\n---${prefix}${src}`;
  }
  const [whole, open, body, close] = fmMatch;
  const themeRe = /^theme:\s*.+$/m;
  let newBody: string;
  if (themeRe.test(body)) {
    // Replace inside `body` with a function replacer to avoid `$&/$'/$\`/$$`
    // pattern interpretation in user-supplied content (e.g. an existing
    // `theme: "$50 Plan"` line). Same care applies for the outer splice.
    newBody = body.replace(themeRe, () => `theme: ${theme}`);
  } else {
    newBody = body.trimEnd() + `\ntheme: ${theme}`;
  }
  // Splice via slice() instead of String.replace because `newBody` is derived
  // from user-editable YAML and may contain `$&`, `$'`, `` $` ``, or `$$`
  // sequences — those would be interpreted as backreference placeholders by
  // String.prototype.replace and silently rewrite the frontmatter into
  // garbage (e.g. `$&` would expand to the entire matched frontmatter block).
  // The regex is anchored at `^`, so fmMatch.index is always 0; we still use
  // `match.index` explicitly so the call site reads correctly if the anchor
  // ever changes.
  const matchStart = fmMatch.index ?? 0;
  return (
    src.slice(0, matchStart) +
    `${open}${newBody}${close}` +
    src.slice(matchStart + whole.length)
  );
}

/**
 * Apply Marp-emitted CSS + HTML to a Shadow DOM safely.
 *
 * Exported for unit testing of the CSS injection / `</style>` breakout
 * defence; not part of the editor's public API. See the `useEffect` in
 * `MarpPreview` (in `SlideEditor.tsx`) for the full security rationale.
 */
export function applyMarpToShadow(
  shadow: ShadowRoot,
  html: string,
  css: string,
): void {
  const supportsConstructable =
    typeof CSSStyleSheet !== "undefined" &&
    typeof (CSSStyleSheet.prototype as { replaceSync?: unknown }).replaceSync ===
      "function" &&
    "adoptedStyleSheets" in shadow;

  if (supportsConstructable) {
    const existing = shadow.adoptedStyleSheets ?? [];
    let sheet = existing[0];
    if (!sheet) {
      sheet = new CSSStyleSheet();
      shadow.adoptedStyleSheets = [sheet];
    }
    try {
      sheet.replaceSync(css);
    } catch {
      sheet.replaceSync("");
    }
    shadow.querySelector(":scope > style[data-marp-fallback]")?.remove();
  } else {
    // Sanitise `</style` so the HTML parser cannot close the stylesheet
    // early when the fallback path injects raw CSS via a `<style>` element.
    //
    // We use the canonical CSS hex escape `\3c ` (= `<`) defined in CSS
    // Syntax §4.3.7, instead of the JS-style `\<` backslash escape that we
    // previously emitted. `\<` is silently dropped by the CSS parser so the
    // rule containing the payload becomes malformed; `\3c ` is a valid CSS
    // character escape that preserves the rule meaning while still
    // preventing the HTML tokenizer from recognising `</style`. The trailing
    // space after `\3c` is significant — it terminates the hex-digit run
    // per the CSS Syntax production for IDENT escapes.
    const safeCss = css.replace(/<\/style/gi, "\\3c /style");
    let styleEl = shadow.querySelector<HTMLStyleElement>(
      ":scope > style[data-marp-fallback]",
    );
    if (!styleEl) {
      styleEl = document.createElement("style");
      styleEl.setAttribute("data-marp-fallback", "");
      shadow.appendChild(styleEl);
    }
    styleEl.textContent = safeCss;
  }

  let deck = shadow.querySelector<HTMLDivElement>(".marp-preview-deck");
  if (!deck) {
    deck = document.createElement("div");
    deck.className = "marp-preview-deck";
    shadow.appendChild(deck);
  }
  deck.innerHTML = html;
}

// ─────────────────────────────────────────────────────────────────────
// UX helpers (block & slide mutations, layouts, find)
//
// Every helper below is PURE: takes a `Slide[]` (or `Slide`) plus
// arguments and returns a fresh structure. Callers feed the result
// into `setSlides(...)` — none of these helpers mutates its inputs.
// Keeping the mutation logic out of the component file lets the unit
// tests exercise the algorithms without booting a TipTap stack and
// keeps the `SlideEditor.tsx` callback bodies one-liners.
// ─────────────────────────────────────────────────────────────────────

/**
 * Return a freshly-constructed `Slide` populated with the block skeleton
 * for the given layout. The layout name only governs the initial block
 * composition — the user may add, remove, reorder, or retype any block
 * after insertion, and the layout itself is NOT persisted on the
 * `Slide` (see the JSDoc on `SlideLayout` for why).
 *
 * Pure: returns a new object on every call so callers can splice it
 * into `slides` without sharing references with a future slide. Notes
 * default to empty — the layout doesn't pre-fill them because that
 * would clutter the speaker-notes panel with sample text on every
 * insertion.
 */
/**
 * Build a fresh `SlideBlock` with a newly-minted `id`. Centralised so
 * every callsite (helpers below, SlideEditor's "+ Add Block" handler)
 * goes through one place and we can never accidentally construct a
 * block without an ID.
 *
 * Uses a truthiness check (`partial.id ? ... : ...`) — NOT nullish
 * coalescing (`?? ...`) — so an empty string is treated as missing
 * and we mint a fresh id. This harmonises with `appendBlock` and
 * `replaceBlock` which also use truthiness; without alignment, a
 * caller that did `buildBlock({ id: "", ... })` would keep the empty
 * id here only to have it silently regenerated downstream — a
 * surprising mid-pipeline mutation that breaks referential equality.
 */
export function buildBlock(
  partial: Omit<SlideBlock, "id"> & { id?: string },
): SlideBlock {
  return { ...partial, id: partial.id ? partial.id : newSlideId("block") };
}

export function buildSlideFromLayout(layout: SlideLayout): Slide {
  const baseId = newSlideId("slide");
  switch (layout) {
    case "blank":
      return {
        id: baseId,
        title: "",
        blocks: [buildBlock({ type: "text", content: "" })],
        notes: "",
      };
    case "title":
      return {
        id: baseId,
        title: "New Slide",
        blocks: [],
        notes: "",
      };
    case "titleContent":
      return {
        id: baseId,
        title: "New Slide",
        blocks: [buildBlock({ type: "text", content: "" })],
        notes: "",
      };
    case "twoColumn":
      return {
        id: baseId,
        title: "New Slide",
        blocks: [
          buildBlock({ type: "text", content: "" }),
          buildBlock({ type: "text", content: "" }),
        ],
        notes: "",
      };
    case "imageCaption":
      return {
        id: baseId,
        title: "New Slide",
        blocks: [
          buildBlock({ type: "image", content: "", alt: "" }),
          buildBlock({ type: "text", content: "" }),
        ],
        notes: "",
      };
  }
}

/**
 * Insert a duplicate of the slide at `index` immediately after it.
 * The duplicate is a deep clone — every block object is recreated so a
 * subsequent edit to either copy doesn't reach across via a shared
 * reference. Returns the new slide array plus the index of the inserted
 * copy so the caller can move focus / set `activeIndex` correctly.
 *
 * If `index` is out of range, returns the input array unchanged plus
 * `-1` (no-op). Callers may rely on referential equality of the array
 * to detect this case without a separate boolean.
 */
export function duplicateSlideAt(
  slides: Slide[],
  index: number,
): { slides: Slide[]; insertedAt: number } {
  if (index < 0 || index >= slides.length) {
    return { slides, insertedAt: -1 };
  }
  const original = slides[index];
  // CRITICAL: the duplicate gets a fresh `id` for both the slide and
  // every block. Reusing the originals' IDs would collide with the
  // source's React keys and corrupt drag-and-drop reorder + the find
  // panel's per-slide / per-block jump pointer.
  const copy: Slide = {
    id: newSlideId("slide"),
    title: original.title,
    notes: original.notes,
    blocks: original.blocks.map((b) => ({ ...b, id: newSlideId("block") })),
  };
  const next = [
    ...slides.slice(0, index + 1),
    copy,
    ...slides.slice(index + 1),
  ];
  return { slides: next, insertedAt: index + 1 };
}

/**
 * Move the slide at `from` to position `to` within the deck. Returns
 * a new array. Out-of-range / same-position moves are no-ops and
 * return the input reference unchanged so callers can use `===` to
 * short-circuit a re-render (same contract as `moveBlock`).
 */
export function moveSlide(
  slides: Slide[],
  from: number,
  to: number,
): Slide[] {
  if (
    from < 0 ||
    from >= slides.length ||
    to < 0 ||
    to >= slides.length ||
    from === to
  ) {
    return slides;
  }
  const next = [...slides];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return next;
}

/**
 * Move the block at `from` to position `to` within the active slide's
 * block list. Returns a new `Slide` (the input is not mutated). If
 * either index is out of range, returns the slide unchanged so the
 * caller's setState reuses the previous reference (preventing a
 * redundant re-render).
 */
export function moveBlock(slide: Slide, from: number, to: number): Slide {
  if (
    from < 0 ||
    from >= slide.blocks.length ||
    to < 0 ||
    to >= slide.blocks.length ||
    from === to
  ) {
    return slide;
  }
  const next = [...slide.blocks];
  const [moved] = next.splice(from, 1);
  next.splice(to, 0, moved);
  return { ...slide, blocks: next };
}

/**
 * Remove the block at `index`. Returns a new `Slide`. Out-of-range
 * removes are a no-op (reference-preserving — same rationale as
 * `moveBlock`). Removing the last block is allowed; the slide may
 * legitimately end up with zero blocks (the "title-only" layout).
 */
export function removeBlock(slide: Slide, index: number): Slide {
  if (index < 0 || index >= slide.blocks.length) return slide;
  return {
    ...slide,
    blocks: slide.blocks.filter((_, i) => i !== index),
  };
}

/**
 * Token-key encoding shared by every site that touches the upload
 * race-guard Map in `SlideEditor.tsx`. Centralising it here means a
 * future change to the key format (e.g. adding a per-attachment salt)
 * only touches this one helper plus the helpers below, instead of
 * three string-template sites scattered through the editor.
 */
export function uploadTokenKey(slideId: string, blockId: string): string {
  return `${slideId}|${blockId}`;
}

/**
 * Drop every upload-race token tied to a slide we're about to remove.
 *
 * `SlideEditor.tsx` keeps a `Map<"${slideId}|${blockId}", number>` to
 * disambiguate concurrent `FileReader` reads (the latest token wins;
 * stale completions are dropped). Without this cleanup the Map grew
 * for the lifetime of the editor — a long session that added &
 * deleted many image blocks would let it accumulate dead entries
 * indefinitely.
 *
 * The helper mutates `tokens` in place and returns `void`; callers
 * are React refs, not state, so mutation is the natural shape. Any
 * `Iterable<SlideBlock>` is accepted so the caller can pass either
 * the live `slide.blocks` array or a synthesised list (e.g. tests).
 */
export function discardUploadTokensForSlide(
  tokens: Map<string, number>,
  slideId: string,
  blocks: Iterable<SlideBlock>,
): void {
  for (const block of blocks) {
    tokens.delete(uploadTokenKey(slideId, block.id));
  }
}

/**
 * Drop the upload-race token for a single block we're about to remove.
 *
 * Companion to `discardUploadTokensForSlide`. Out-of-range / missing
 * blocks are a silent no-op so the helper is safe to call inside a
 * `setSlides` updater whose previous-state lookup may have raced
 * against another mutation.
 */
export function discardUploadTokensForBlock(
  tokens: Map<string, number>,
  slide: Slide,
  blockIndex: number,
): void {
  const outgoing = slide.blocks[blockIndex];
  if (!outgoing) return;
  tokens.delete(uploadTokenKey(slide.id, outgoing.id));
}

/**
 * Append a new block to a slide. Returns a new `Slide`. Used by the
 * "+ Add Block" button and by the layout-aware paste path. The new
 * block's `content` defaults to empty so the user immediately sees an
 * input to type into; for diagram blocks the caller is expected to
 * seed the default Mermaid DSL itself (the helper has no access to
 * that DSL string).
 */
export function appendBlock(slide: Slide, block: SlideBlock): Slide {
  // Defence-in-depth: callers should construct blocks via `buildBlock`,
  // but if a caller passes a block without an `id` we mint one so the
  // helper's contract ("every block in a Slide has an id") holds.
  const withId: SlideBlock = block.id ? block : { ...block, id: newSlideId("block") };
  return { ...slide, blocks: [...slide.blocks, withId] };
}

/**
 * Replace the block at `index` with `block`. Returns a new `Slide`.
 *
 * Two no-op short-circuits keep the reference-stable contract that
 * `moveBlock` / `removeBlock` follow:
 *   - Out-of-range `index` → return input slide reference unchanged.
 *   - `block` is referentially identical to the block already at
 *     `index` → return input slide reference unchanged. This is what
 *     preserves the `nextBlockForTypeChange` same-type optimisation
 *     end-to-end: that helper returns the input block unchanged when
 *     `block.type === nextType`, and without this identity check
 *     `replaceBlock` would still build a fresh array and a fresh
 *     `Slide`, defeating the optimisation and firing a redundant
 *     `debouncedSave`.
 *
 * Used by the per-block type select and the per-block content
 * textarea so the existing `updateSlide` call site can stay a
 * one-liner.
 */
export function replaceBlock(
  slide: Slide,
  index: number,
  block: SlideBlock,
): Slide {
  if (index < 0 || index >= slide.blocks.length) return slide;
  const existing = slide.blocks[index];
  // PR 7 round 4 identity short-circuit: if the caller hands us the
  // SAME block reference that's already at `index`, return the slide
  // unchanged. This preserves the `nextBlockForTypeChange` same-type
  // optimisation end-to-end — without it, `replaceBlock` would still
  // build a fresh array/Slide and the parent's
  // `if (updatedSlide === slide) return prev` short-circuit would
  // miss, firing a redundant `debouncedSave`.
  if (existing === block) return slide;
  // Preserve the existing block's `id` if the caller didn't supply
  // one. The common call shape is `replaceBlock(slide, i, { ...old,
  // type: nextType })` which carries the existing id forward; we only
  // mint a new id when the caller hands us a block with no id at all
  // (e.g. a freshly-constructed block bypassing `buildBlock`).
  const withId: SlideBlock = block.id
    ? block
    : { ...block, id: existing.id ?? newSlideId("block") };
  const next = [...slide.blocks];
  next[index] = withId;
  return { ...slide, blocks: next };
}

/**
 * Default `mermaid` source seeded into a new diagram block so the
 * Marp preview shows a meaningful figure the moment the user picks
 * the `diagram` type. Kept in the helpers module so the same string
 * is shared by `SlideEditor` (the type-change handler) and by
 * `nextBlockForTypeChange` (the pure helper that drives the
 * keep/seed/clear decision for the `content` field).
 */
export const DEFAULT_DIAGRAM_DSL = `flowchart LR
  Source --> Process --> Output`;

/**
 * Pure transition function for the type-select dropdown: returns the
 * `SlideBlock` value that should replace `block` when the user picks
 * `nextType` from the type picker.
 *
 * The `content` field is reset to `""` whenever the block crosses
 * the `image` boundary in either direction:
 *
 *   - **Switching INTO an image block** (`nextType === "image"`):
 *     reset so the file-input UI starts from a clean slate. The
 *     previous content is almost certainly prose or a mermaid DSL,
 *     not an image source URL, so leaving it would only confuse the
 *     image-preview surface.
 *
 *   - **Switching OUT of an image block** (`block.type === "image"`):
 *     reset because an image block's `content` is a potentially
 *     multi-megabyte `data:image/...;base64,...` URL written by
 *     `fileToDataUrl`. The new editor surface for `text` / `bullets`
 *     / `diagram` is a `<textarea>` and pasting a multi-MB data URL
 *     into a textarea janks the renderer and is never the user's
 *     intent (an image's URL is not the same kind of thing as prose
 *     or a mermaid DSL).
 *
 * If the user picks `diagram` and the current content is empty, we
 * seed the well-known starter DSL so the Marp preview shows
 * something meaningful immediately. Otherwise content is kept
 * verbatim so toggling `text` ↔ `bullets` is non-destructive (a
 * common workflow when rewriting an outline as prose or vice versa).
 *
 * The `alt` field is only meaningful for image blocks, so it's set
 * to `undefined` whenever the new type is not `image` (this also
 * frees the saved JSON of a dead `alt` field on non-image blocks).
 */
export function nextBlockForTypeChange(
  block: SlideBlock,
  nextType: SlideBlock["type"],
): SlideBlock {
  // Same-type re-selection is a no-op: return the input reference
  // unchanged so callers using `===` short-circuit a re-render (same
  // contract as `moveBlock` / `removeBlock` / `replaceBlock`). This
  // also makes the image→image case safe-by-construction — without
  // this guard, an image→image call would land in the boundary-clear
  // branch below and destroy the uploaded data URL. The UI's
  // `<select onChange>` doesn't fire on same-value re-selection, but
  // a programmatic caller (e.g. a future copy/paste-as path or a
  // bulk-edit dialog) could trigger it, and the helper's contract
  // should not depend on UI quirks.
  if (block.type === nextType) return block;
  const wasImage = block.type === "image";
  const becomesImage = nextType === "image";
  // Step 1 — clear when the block crosses the `image` boundary in
  // either direction (see doc-comment above for why a data URL must
  // not survive into a `<textarea>`, and why prose must not survive
  // into the image-source field).
  const carried = wasImage || becomesImage ? "" : block.content;
  // Step 2 — seed the diagram starter only when the new type is
  // `diagram` AND we have no carried content. The order matters: if
  // a user does image → diagram, step 1 clears the data URL and
  // step 2 then seeds the starter DSL, so the diagram preview shows
  // something meaningful instead of staying blank. A user with
  // prose already typed (text → diagram with existing content)
  // keeps their work — `carried` is non-empty so step 2 is a no-op.
  const content =
    nextType === "diagram" && !carried ? DEFAULT_DIAGRAM_DSL : carried;
  return {
    ...block,
    type: nextType,
    content,
    alt: becomesImage ? (block.alt ?? "") : undefined,
  };
}

/**
 * Total word count for a single slide — counts title, every block's
 * content, and notes. Used by the toolbar word counter. The split
 * regex (`/\s+/`) collapses runs of whitespace so `"foo  bar"` counts
 * as 2, not 3 (the empty string between the two spaces would
 * otherwise pad the count).
 *
 * Image blocks contribute their `alt` text (if any) plus 0 for the
 * data URL — the URL itself isn't human-readable content. Diagram
 * blocks contribute their DSL token count, which approximates the
 * "information density" of the diagram.
 */
export function slideWordCount(slide: Slide): number {
  const fragments: string[] = [slide.title, slide.notes];
  for (const block of slide.blocks) {
    if (block.type === "image") {
      fragments.push(block.alt ?? "");
    } else {
      fragments.push(block.content);
    }
  }
  return fragments
    .map((s) => s.trim())
    .filter((s) => s.length > 0)
    .reduce((acc, s) => acc + s.split(/\s+/).length, 0);
}

/**
 * Total word count across every slide in the deck. Used in the
 * SlideEditor toolbar header alongside the slide counter so the user
 * has a quick "how much content is in this deck" signal.
 *
 * Prefer `computeDeckWordCounts` when both per-slide AND deck totals
 * are needed in the same render pass — that variant shares the
 * per-slide tally between both callers and supports an opt-in cache.
 */
export function deckWordCount(slides: Slide[]): number {
  return slides.reduce((acc, slide) => acc + slideWordCount(slide), 0);
}

/**
 * Per-slide and deck-total word counts in one O(N + W) pass, where
 * `N` is the number of slides and `W` the total content length.
 *
 * perf: the SlideEditor toolbar shows
 * `Words: <active> / <total>` on every render. Before this helper
 * existed, the active count was computed inline (a fresh
 * `slideWordCount(activeSlide)` per render) AND `deckWordCount(slides)`
 * was memoised against `slides` — but a single keystroke on a 50-slide
 * deck produces a *new* `slides` reference (immutable update) and
 * blows the memo, re-tallying every slide every keystroke.
 *
 * With the optional `cache` parameter the caller (`SlideEditor.tsx`)
 * passes a long-lived `WeakMap<Slide, number>` held in a `useRef`.
 * Because the immutable-update pattern only allocates a new `Slide`
 * object for the slide(s) that actually changed, every unchanged
 * slide hits the cache in O(1) — a one-slide edit on an N-slide deck
 * drops from O(N * W) to O(W_changed_slide) per render.
 *
 * The cache survives the component lifetime (held by `useRef`) but is
 * a `WeakMap` so it doesn't pin abandoned Slide objects in memory
 * after they're replaced by an edit. Mirrors the same caching pattern
 * `BaseEditor` uses for `resolveLinkedRecords` (PR #84) and that
 * `SheetEditor` uses for its formula evaluation cache (PR #83).
 */
export function computeDeckWordCounts(
  slides: Slide[],
  cache?: WeakMap<Slide, number>,
): { perSlide: number[]; total: number } {
  const perSlide: number[] = new Array(slides.length);
  let total = 0;
  for (let i = 0; i < slides.length; i += 1) {
    const slide = slides[i];
    let count = cache?.get(slide);
    if (count === undefined) {
      count = slideWordCount(slide);
      cache?.set(slide, count);
    }
    perSlide[i] = count;
    total += count;
  }
  return { perSlide, total };
}

/**
 * A single match returned by `findInSlides`. The `location` field
 * identifies WHERE in the slide the match lives so the Find panel can
 * (eventually) jump the user to the specific block; for now the panel
 * only jumps to the slide index, but encoding the location lets us
 * add per-block jumping later without changing the data shape.
 */
export interface SlideFindMatch {
  slideIndex: number;
  /** Which field on the slide contained the match. */
  location: "title" | "notes" | { kind: "block"; blockIndex: number };
  /** Lowercased substring index of the match within the source field. */
  offset: number;
  /** Length of the matched substring (== query length for case-sensitive). */
  length: number;
}

export interface SlideFindOptions {
  caseSensitive?: boolean;
}

/**
 * Find every occurrence of `query` across the deck. Returns matches in
 * deck order: by `slideIndex`, then within a slide by field order
 * (title → blocks in array order → notes), then by `offset` within a
 * field.
 *
 * An empty query yields no matches (returning every position would be
 * meaningless and would blow up the result array). Case-insensitivity
 * is implemented by lowercasing both sides before `indexOf` —
 * Unicode-sensitive folding is left for a future PR (every Latin
 * locale Tessera ships templates for is correctly handled by the
 * basic ASCII lowercase pass).
 */
export function findInSlides(
  slides: Slide[],
  query: string,
  options: SlideFindOptions = {},
): SlideFindMatch[] {
  if (!query) return [];
  const caseSensitive = options.caseSensitive === true;
  const needle = caseSensitive ? query : query.toLowerCase();
  const results: SlideFindMatch[] = [];

  function findAllOccurrences(haystackRaw: string): number[] {
    if (!haystackRaw) return [];
    const haystack = caseSensitive ? haystackRaw : haystackRaw.toLowerCase();
    const offsets: number[] = [];
    let from = 0;
    while (from <= haystack.length - needle.length) {
      const idx = haystack.indexOf(needle, from);
      if (idx === -1) break;
      offsets.push(idx);
      from = idx + needle.length;
    }
    return offsets;
  }

  for (let s = 0; s < slides.length; s += 1) {
    const slide = slides[s];
    for (const offset of findAllOccurrences(slide.title)) {
      results.push({
        slideIndex: s,
        location: "title",
        offset,
        length: needle.length,
      });
    }
    for (let b = 0; b < slide.blocks.length; b += 1) {
      const block = slide.blocks[b];
      // Image blocks search their alt text, not the data URL — data
      // URLs aren't human-readable content and matching against them
      // would surface useless results (e.g. "img" matching the MIME
      // type prefix of every base64 image in the deck).
      const source = block.type === "image" ? (block.alt ?? "") : block.content;
      for (const offset of findAllOccurrences(source)) {
        results.push({
          slideIndex: s,
          location: { kind: "block", blockIndex: b },
          offset,
          length: needle.length,
        });
      }
    }
    for (const offset of findAllOccurrences(slide.notes)) {
      results.push({
        slideIndex: s,
        location: "notes",
        offset,
        length: needle.length,
      });
    }
  }

  return results;
}

// (Inline-image helpers are re-exported from `./inlineImage` at the
// top of this file, grouped with the regular imports per
// CONTRIBUTING.md — see the comment block above the import list.)
