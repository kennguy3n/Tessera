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
import type { Slide, SlideContent } from "./slideEditorTypes";

export interface ParsedSlideContent {
  slides: Slide[];
  marpMode: boolean;
  marpSource: string;
  marpTheme: MarpRenderOptions["theme"] | undefined;
}

export function parseSlideContent(content: string): ParsedSlideContent {
  const emptyDefault: ParsedSlideContent = {
    slides: [
      { title: "Title Slide", blocks: [{ type: "text", content: "" }], notes: "" },
    ],
    marpMode: false,
    marpSource: "",
    marpTheme: undefined,
  };
  if (!content) return emptyDefault;
  try {
    const parsed = JSON.parse(content) as SlideContent;
    if (parsed.slides && Array.isArray(parsed.slides) && parsed.slides.length > 0) {
      return {
        slides: parsed.slides,
        marpMode: parsed.marp?.enabled ?? false,
        marpSource: parsed.marp?.source ?? "",
        marpTheme: parsed.marp?.theme,
      };
    }
  } catch {
    // Not JSON — treat as single text slide
  }
  return {
    slides: [{ title: "Slide 1", blocks: [{ type: "text", content }], notes: "" }],
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
