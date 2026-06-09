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
