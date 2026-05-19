export type ArtifactType = "document" | "slides" | "sheet" | "base";

export interface Artifact {
  id: string;
  title: string;
  artifactType: ArtifactType;
  templateId: string | null;
  content: string;
  citations: Citation[];
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface Citation {
  citationId: string;
  sourceId: string;
  sourceType: string;
  sourceTitle: string;
  sourceUri: string;
  chunkHash: string;
  page: number | null;
  confidence: number;
  usedFor: string;
  createdAt: string;
}
