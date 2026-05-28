/**
 * Pure helpers for `DocumentEditor`. Extracted out of the
 * component file so React Fast Refresh can preserve editor state
 * across HMR edits.
 */

/**
 * Normalize the artifact's serialized content into the TipTap-friendly
 * HTML string the editor expects on mount.
 *
 * Exported so it can be unit-tested independently of the TipTap
 * pipeline (which is not easy to load in a headless vitest run because
 * of the ProseMirror DOM module graph). The runtime caller is still
 * `useEditor(...).content` below — the export adds no production
 * behaviour change.
 */
export function parseDocumentContent(content: string): string {
  if (!content) return "<p></p>";
  // If content already looks like HTML, use it directly
  if (content.trim().startsWith("<")) return content;
  // Otherwise, wrap plain text in paragraphs
  return content
    .split("\n\n")
    .map((p) => `<p>${p.replace(/\n/g, "<br>")}</p>`)
    .join("");
}
