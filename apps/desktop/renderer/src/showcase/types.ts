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
}
