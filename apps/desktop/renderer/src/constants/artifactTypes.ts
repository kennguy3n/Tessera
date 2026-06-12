/**
 * Single source of truth for the creatable artifact types, mirroring
 * the Rust `ArtifactType` enum (`crates/tessera_core/src/types.rs`,
 * serialised `snake_case`). The command registry's "Create …"
 * commands and any other renderer surface that needs to enumerate the
 * artifact kinds read from here so the wire values can't drift from
 * the substrate.
 */

/** Wire value sent to `window.tessera.artifacts.create(title, type)`. */
export type ArtifactTypeId =
  | "document"
  | "slides"
  | "sheet"
  | "base"
  | "infographic"
  | "landing_page";

export interface ArtifactTypeSpec {
  /** `ArtifactType` wire value (snake_case). */
  readonly id: ArtifactTypeId;
  /** Singular human label, e.g. "Document". */
  readonly label: string;
  /** Default title for a freshly created, untitled artifact. */
  readonly defaultTitle: string;
  /** Extra palette search keywords beyond the label. */
  readonly keywords: readonly string[];
}

/**
 * Ordered by how often a user reaches for each kind, so the palette's
 * "Create …" group reads most-common-first.
 */
export const ARTIFACT_TYPES: readonly ArtifactTypeSpec[] = [
  {
    id: "document",
    label: "Document",
    defaultTitle: "Untitled document",
    keywords: ["doc", "write", "text", "report", "memo"],
  },
  {
    id: "slides",
    label: "Slide deck",
    defaultTitle: "Untitled deck",
    keywords: ["slides", "presentation", "deck", "marp"],
  },
  {
    id: "sheet",
    label: "Spreadsheet",
    defaultTitle: "Untitled sheet",
    keywords: ["sheet", "table", "grid", "spreadsheet", "budget"],
  },
  {
    id: "base",
    label: "Base",
    defaultTitle: "Untitled base",
    keywords: ["base", "database", "records", "fields"],
  },
  {
    id: "infographic",
    label: "Infographic",
    defaultTitle: "Untitled infographic",
    keywords: ["infographic", "visual", "canvas", "poster"],
  },
  {
    id: "landing_page",
    label: "Landing page",
    defaultTitle: "Untitled landing page",
    keywords: ["landing", "page", "html", "site", "web"],
  },
];
