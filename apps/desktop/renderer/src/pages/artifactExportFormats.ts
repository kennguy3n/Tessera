/**
 * Per-artifact-type export-format whitelists, extracted from
 * `ArtifactEditorPage.tsx` so the page file's only runtime export is the
 * component (required for React Fast Refresh to preserve editor state
 * across HMR edits).
 *
 * Returns the list of export formats that make sense for a given artifact
 * type. Prevents nonsensical combinations like "Sheet → DOCX" (which would
 * render the sheet's `{columns, rows}` JSON as markdown) or "Document →
 * XLSX" (which would CSV-split the markdown content into a sheet).
 *
 * The mapping is intentionally explicit per type rather than a "deny-list"
 * because the deny-list approach silently broadens whenever a new format is
 * added. Keeping the list per type forces a deliberate decision each time.
 */
export function availableExportFormats(artifactType: string): string[] {
  switch (artifactType) {
    case "document":
      return ["markdown", "html", "json", "pdf", "docx"];
    case "slides":
      return ["markdown", "html", "json", "pdf", "pptx"];
    case "sheet":
      return ["csv", "json", "html", "pdf", "xlsx"];
    case "base":
      return ["csv", "json", "html", "pdf", "xlsx"];
    case "infographic":
      // Visual artifact — HTML preview, PDF print, JSON data export.
      return ["html", "json", "pdf"];
    case "landing_page":
      // Standalone web page — HTML primary, PDF for print, JSON data.
      return ["html", "json", "pdf"];
    default:
      // Unknown / future types: expose the safe-universal set rather than
      // nothing, so the user is never stranded with no export option.
      return ["json", "html", "pdf"];
  }
}
