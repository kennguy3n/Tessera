// Showcase harness types.
//
// The showcase harness is a DEV-ONLY tool used to capture data-rich product
// screenshots for the marketing/demo material under `docs/showcase/`. It loads
// genuine local-LLM-generated artifacts (see `scripts/showcase/generate.py`)
// into the live renderer through a mock `window.tessera` bridge so the real
// editors render real content. It is never wired into production builds.

export interface ShowcasePersona {
  name: string;
  role: string;
  org: string;
  market: string;
  blurb: string;
}

export interface ShowcaseArtifact {
  slug: string;
  title: string;
  /** "document" | "slides" | "sheet" | "base" */
  type: string;
  templateId: string | null;
  templateName: string;
  citationCount: number;
  /** On-disk content string in the exact format the matching editor parses. */
  content: string;
}

export interface ShowcaseDataset {
  id: string;
  persona: ShowcasePersona;
  /** Input source filenames the artifacts were grounded in. */
  sourceFiles: string[];
  artifacts: ShowcaseArtifact[];
}

/**
 * An observation-typed memory item surfaced in the "Knowledge" tab of an
 * enriched search. Shape-compatible with the renderer's `SubstrateMemoryInfo`
 * (apps/desktop/shared/types.ts). Populated by the deterministic substrate
 * derivation (`scripts/showcase/derive_knowledge.py`), which extracts these
 * from the SAME genuine model-generated artifacts the rest of the showcase
 * uses — nothing here is hand-authored marketing copy.
 */
export interface ShowcaseMemoryItem {
  id: string;
  scopeId: string;
  observationType: string;
  content: string;
  state: string;
  retentionScore: number;
  pinCount: number;
  retrievalCount: number;
  corroborationCount: number;
  createdAt: number;
  lastAccessedAt: number;
  sourceId: string | null;
}

/** A concept-graph node surfaced in the "Knowledge" tab. Shape-compatible
 * with the renderer's `SubstrateConceptInfo`. */
export interface ShowcaseConcept {
  id: string;
  label: string;
  definition: string;
  state: string;
  relatedSourceIds: string[];
}

/**
 * A typed, directed edge between two concept nodes. Mirrors the substrate's
 * `concept_graph::Relation` wire shape: `from`/`to` are {@link ShowcaseConcept}
 * ids and `type` is a `concept_graph::RelationType` snake_case tag (`is_a`,
 * `part_of`, `supersedes`, `contradicts`, …). Emitted by the deterministic
 * derivation only where the persona's GENUINE source structure supports the
 * relation (a code is an instance of its class → `is_a`; an authoritative
 * later finding overrides an earlier claim → `supersedes` / `contradicts`).
 */
export interface ShowcaseRelation {
  from: string;
  to: string;
  type: string;
}

/**
 * The additive knowledge plane (entities / facts / concepts) the substrate
 * exposes for a persona, derived deterministically from that persona's genuine
 * artifacts. Loaded into the mock bridge so the live renderer's enriched
 * "Knowledge" tab and concept-graph source suggestions render real, traceable
 * data instead of empty chrome.
 */
export interface ShowcaseKnowledgePlane {
  entities: ShowcaseMemoryItem[];
  facts: ShowcaseMemoryItem[];
  concepts: ShowcaseConcept[];
  /**
   * Optional typed concept-graph edges. When present, the mock bridge emits
   * these as the graph's edges verbatim (the shipped UI's `is_a` / `part_of` /
   * `supersedes` / `contradicts` rendering); when absent, edges fall back to
   * the co-occurrence derivation in {@link buildConceptGraphJson}.
   */
  relations?: ShowcaseRelation[];
}
