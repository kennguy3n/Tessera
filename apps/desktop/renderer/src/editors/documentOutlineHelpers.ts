/**
 * Pure helpers for the DocumentEditor outline panel, the
 * table-of-contents block, and the reading-time footer stat.
 *
 * Operates on a ProseMirror document node but performs no DOM work and
 * dispatches no transactions, so it is unit-testable against a
 * headless editor's `editor.state.doc`.
 */
import type { Node as ProseMirrorNode } from "@tiptap/pm/model";

export interface HeadingEntry {
  /** Heading level 1–6. */
  level: number;
  /** Flattened text content of the heading. */
  text: string;
  /** ProseMirror position of the heading node (for setTextSelection). */
  pos: number;
  /** Stable-ish id (slug + position) for keys and scroll anchoring. */
  id: string;
}

/**
 * Slugify heading text for anchor ids. Deterministic and Unicode-aware:
 * lowercase, then collapse every run of non-alphanumeric characters to a
 * single `-`, then trim leading/trailing `-`. Unicode letters and digits
 * are KEPT (e.g. "Café Crème" → "café-crème", "概述" → "概述") so
 * non-Latin headings produce meaningful slugs rather than empty strings.
 *
 * This intentionally mirrors the Rust exporter's `slugify`
 * (`crates/tessera_export/src/html.rs`) character-for-character. (The
 * in-app id additionally appends `-<pos>` for uniqueness; the export
 * disambiguates collisions with a numeric suffix — but the slug stem
 * each derives from identical heading text is the same.)
 */
export function slugifyHeading(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "-")
    .replace(/^-+|-+$/g, "");
}

/**
 * Walk the document and collect every heading node in document order.
 *
 * Each entry carries the PM position so a click can
 * `setTextSelection` + scroll to it, the level for indentation, and a
 * slug-based id (suffixed with position to stay unique when two
 * headings share text).
 */
export function collectHeadings(doc: ProseMirrorNode): HeadingEntry[] {
  const headings: HeadingEntry[] = [];
  doc.descendants((node, pos) => {
    if (node.type.name !== "heading") return;
    const text = node.textContent.trim();
    const levelAttr = (node.attrs as { level?: number }).level;
    const level = typeof levelAttr === "number" ? levelAttr : 1;
    const slug = slugifyHeading(text) || "heading";
    headings.push({ level, text, pos, id: `${slug}-${pos}` });
  });
  return headings;
}

/** Words-per-minute baseline for the reading-time estimate. */
export const READING_WPM = 220;

/**
 * Estimate reading time in minutes (always ≥1 for non-empty docs).
 * Pure integer minutes; the formatter adds the unit.
 */
export function estimateReadingTimeMinutes(
  words: number,
  wpm: number = READING_WPM,
): number {
  if (words <= 0) return 0;
  return Math.max(1, Math.ceil(words / wpm));
}

/** Human-readable reading time, e.g. "1 min read" / "4 min read". */
export function formatReadingTime(words: number): string {
  const minutes = estimateReadingTimeMinutes(words);
  if (minutes <= 0) return "0 min read";
  return `${minutes} min read`;
}

/**
 * Given the vertical offsets of each heading (relative to the scroll
 * container) and the current scrollTop, return the index of the
 * heading that should be marked "active" in the outline.
 *
 * The active heading is the last one whose offset is at or above the
 * scroll position (plus a small top bias so a heading becomes active
 * just before it reaches the very top). Returns -1 when there are no
 * headings.
 */
export function pickActiveHeadingIndex(
  offsets: readonly number[],
  scrollTop: number,
  bias: number = 24,
): number {
  if (offsets.length === 0) return -1;
  let active = 0;
  for (let i = 0; i < offsets.length; i++) {
    if (offsets[i] - bias <= scrollTop) {
      active = i;
    } else {
      break;
    }
  }
  return active;
}
