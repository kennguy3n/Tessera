/**
 * Marp renderer service — turns Marp-flavored Markdown into HTML slides
 * using the official @marp-team/marp-core engine. The Marpit framework
 * lives underneath and handles directive parsing, slide separation, and
 * CSS theming.
 *
 * Tessera surfaces this in two places:
 *   1. SlideEditor "Marp Mode" — live preview while authoring raw Marp md.
 *   2. PPTX export — pre-render to HTML, then hand to Marp CLI (see
 *      apps/desktop/electron/marpExport.ts).
 */
import { Marp, MarpOptions } from "@marp-team/marp-core";

export interface MarpRenderResult {
  /** Full <section>...</section> markup for every slide, joined. */
  html: string;
  /** CSS string the renderer emitted, scoped to the current theme. */
  css: string;
  /** Number of slides found in the input. */
  slideCount: number;
  /** Per-slide comment-derived speaker notes (one entry per slide). */
  notes: string[];
}

export interface MarpRenderOptions extends MarpOptions {
  /** Built-in theme name: 'default' | 'gaia' | 'uncover'. Default: 'default'. */
  theme?: "default" | "gaia" | "uncover" | string;
  /** Inline header text for every slide. */
  header?: string;
  /** Inline footer text for every slide. */
  footer?: string;
  /** Enable HTML rendering inside markdown (security: off by default). */
  html?: boolean;
}

export const SUPPORTED_THEMES = ["default", "gaia", "uncover"] as const;

const DEFAULT_OPTIONS: MarpRenderOptions = {
  // Marp Core inherits these defaults but we re-state them so the surface
  // is explicit.
  html: false,
  // Math is allowed via katex (Marp's bundled MathJax/KaTeX engine).
  math: "katex",
};

let cachedMarp: Marp | null = null;
let cachedOptionsKey: string | null = null;

function getMarp(options: MarpRenderOptions): Marp {
  const merged: MarpRenderOptions = { ...DEFAULT_OPTIONS, ...options };
  const key = JSON.stringify(merged);
  if (cachedMarp && cachedOptionsKey === key) return cachedMarp;
  cachedMarp = new Marp(merged);
  cachedOptionsKey = key;
  return cachedMarp;
}

/** Reset the cached Marp instance — for tests. */
export function resetMarpForTests() {
  cachedMarp = null;
  cachedOptionsKey = null;
}

export class MarpRenderError extends Error {
  constructor(message: string, options?: { cause?: unknown }) {
    super(message, options);
    this.name = "MarpRenderError";
  }
}

/**
 * Render Marp Markdown to HTML slides.
 *
 * Empty / whitespace-only input is accepted and produces an empty deck.
 */
export function renderMarp(
  markdown: string,
  options: MarpRenderOptions = {},
): MarpRenderResult {
  try {
    const marp = getMarp(options);
    const { html, css } = marp.render(markdown ?? "");
    const slideCount = countSlides(html);
    const notes = extractSpeakerNotes(markdown ?? "");
    return { html, css, slideCount, notes };
  } catch (err) {
    throw new MarpRenderError(
      `Marp render failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

/**
 * Tessera ships a paired-down Marp directive convenience helper used by the
 * SlideEditor "Marp Mode" toolbar. Builds a leading directive block from the
 * supplied options, then appends the user's markdown.
 */
export function buildMarpFrontmatter(opts: {
  theme?: string;
  paginate?: boolean;
  header?: string;
  footer?: string;
  backgroundColor?: string;
  klass?: string;
}): string {
  const lines = ["---", "marp: true"];
  if (opts.theme) lines.push(`theme: ${opts.theme}`);
  if (opts.paginate) lines.push(`paginate: true`);
  if (opts.header) lines.push(`header: '${opts.header.replace(/'/g, "''")}'`);
  if (opts.footer) lines.push(`footer: '${opts.footer.replace(/'/g, "''")}'`);
  if (opts.backgroundColor) lines.push(`backgroundColor: ${opts.backgroundColor}`);
  if (opts.klass) lines.push(`class: ${opts.klass}`);
  lines.push("---");
  return lines.join("\n");
}

/** Count `<section>` slide elements in the rendered HTML. */
function countSlides(html: string): number {
  const matches = html.match(/<section[\s>]/g);
  return matches ? matches.length : 0;
}

/**
 * Extract speaker notes from `<!-- notes -->` HTML comments. Marp Core embeds
 * comments as `data-marpit-pagination-total` attributes only in some builds,
 * so we parse the markdown ourselves to ensure a stable, version-independent
 * surface.
 *
 * One entry per slide. Slides without a notes comment yield "".
 */
export function extractSpeakerNotes(markdown: string): string[] {
  const slides = splitSlides(markdown);
  // Use `matchAll` (with a fresh global regex) so each call returns a new
  // iterator with its own internal state — avoids the `lastIndex` carry-over
  // hazard of reusing a single RegExp across map iterations.
  return slides.map((slide) => {
    const found: string[] = [];
    for (const m of slide.matchAll(/<!--\s*([\s\S]*?)\s*-->/g)) {
      const body = m[1].trim();
      if (body) found.push(body);
    }
    return found.join("\n");
  });
}

/**
 * Split a Marp markdown source on `---` slide separators, accounting for the
 * YAML-ish front-matter block at the top (which is delimited by --- on both
 * sides but is NOT itself a slide separator).
 */
export function splitSlides(markdown: string): string[] {
  const trimmed = markdown ?? "";
  if (!trimmed) return [];
  const lines = trimmed.split("\n");
  const slides: string[] = [];
  let cur: string[] = [];
  let inFrontmatter = false;
  let lineIdx = 0;
  // Detect leading frontmatter
  if (lines[0]?.trim() === "---") {
    inFrontmatter = true;
    cur.push(lines[0]);
    lineIdx = 1;
  }
  for (; lineIdx < lines.length; lineIdx++) {
    const line = lines[lineIdx];
    if (line.trim() === "---") {
      if (inFrontmatter) {
        cur.push(line);
        inFrontmatter = false;
      } else {
        slides.push(cur.join("\n"));
        cur = [];
      }
      continue;
    }
    cur.push(line);
  }
  if (cur.length > 0) slides.push(cur.join("\n"));
  return slides.filter((s) => s.trim().length > 0);
}

/** Test introspection helpers. */
export const __testing = {
  DEFAULT_OPTIONS,
  countSlides,
};
