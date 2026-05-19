import { app } from "electron";
import * as path from "path";
import * as fs from "fs";
import { ModelSidecar } from "./sidecar";

interface NativeBridge {
  initBridge(dbPath: string, templateDir: string): void;
  bridgeAddLocalFolder(path: string): SourceInfo;
  bridgeAddLocalFile(path: string): SourceInfo;
  bridgeListSources(): SourceInfo[];
  bridgeRemoveSource(sourceId: string): void;
  bridgeSearchSources(query: string, limit: number): SearchHitInfo[];
  bridgeGetSourceDetail(sourceId: string): SourceDetailInfo;
  bridgeReindexSource(sourceId: string): SourceInfo;
  bridgeCreateArtifact(
    title: string,
    artifactType: string,
    templateId?: string | null,
  ): ArtifactInfo;
  bridgeUpdateArtifactContent(
    artifactId: string,
    content: string,
  ): ArtifactInfo;
  bridgeGetArtifact(artifactId: string): ArtifactInfo;
  bridgeListArtifacts(): ArtifactInfo[];
  bridgeDeleteArtifact(artifactId: string): void;
  bridgeExportArtifact(
    artifactId: string,
    format: string,
  ): { content: string; format: string };
  bridgeExportArtifactToFile(
    artifactId: string,
    format: string,
    path: string,
  ): void;
  bridgeListTemplates(): TemplateInfo[];
  bridgeGetTemplate(templateId: string): TemplateInfo | null;
  bridgeListCitations(artifactId: string): CitationInfo[];
  bridgeAddCitation(req: AddCitationRequest): CitationInfo;
  bridgeRemoveCitation(artifactId: string, citationId: string): void;
  bridgeCheckSourceChanged(citationId: string): boolean;
  bridgeListVersions(artifactId: string): ArtifactVersionInfo[];
  bridgeRestoreVersion(artifactId: string, versionNumber: number): ArtifactInfo;
  bridgeGenerateFromTemplate(templateId: string, sourceIds: string[]): ArtifactInfo;
  bridgeExtractTasksDecisions(sourceId: string): string;
  bridgeCompareSources(sourceIdA: string, sourceIdB: string): ArtifactInfo;
  bridgeExportEvidencePack(artifactId: string, outputPath: string): string;
}

export interface ArtifactVersionInfo {
  version: number;
  content: string;
  createdAt: string;
}

export interface SourceInfo {
  id: string;
  sourceType: string;
  path: string;
  status: string;
  createdAt: string;
  lastIndexed: string | null;
  fileCount: number;
}

export interface SearchHitInfo {
  content: string;
  excerpt: string;
  sourcePath: string;
  sourceId: string;
  chunkHash: string;
  chunkIndex: number;
  relevance: number;
}

export interface IndexedFileInfo {
  path: string;
  hash: string;
  lastModified: string;
  chunkCount: number;
}

export interface SourceDetailInfo {
  source: SourceInfo;
  files: IndexedFileInfo[];
}

export interface ArtifactInfo {
  id: string;
  title: string;
  artifactType: string;
  templateId: string | null;
  content: string;
  citationCount: number;
  createdAt: string;
  updatedAt: string;
  version: number;
}

export interface TemplateInfo {
  id: string;
  name: string;
  artifactType: string;
  description: string;
  sectionCount: number;
  exportFormats: string[];
}

export interface CitationInfo {
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

export interface AddCitationRequest {
  artifactId: string;
  sourceId: string;
  sourceType: string;
  sourceTitle: string;
  sourceUri: string;
  chunkHash: string;
  page: number | null;
  confidence: number;
  usedFor: string;
}

let bridge: NativeBridge | null = null;
let modelSidecar: ModelSidecar | null = null;

function resolveNativeAddon(): NativeBridge | null {
  const possiblePaths = [
    path.join(app.getAppPath(), "native", "tessera_bridge.node"),
    path.join(app.getAppPath(), "..", "native", "tessera_bridge.node"),
    path.join(__dirname, "..", "native", "tessera_bridge.node"),
    path.join(__dirname, "tessera_bridge.node"),
  ];

  for (const addonPath of possiblePaths) {
    if (fs.existsSync(addonPath)) {
      try {
        // eslint-disable-next-line @typescript-eslint/no-var-requires
        return require(addonPath) as NativeBridge;
      } catch {
        continue;
      }
    }
  }
  return null;
}

export function initAppState(): boolean {
  bridge = resolveNativeAddon();
  if (!bridge) {
    console.warn(
      "[Tessera] Native bridge not found. Running in fallback mode.",
    );
    return false;
  }

  const userData = app.getPath("userData");
  const dbPath = path.join(userData, "tessera.db");
  const templateDir = path.join(app.getAppPath(), "templates");

  try {
    bridge.initBridge(dbPath, templateDir);
    console.log("[Tessera] Native bridge initialized:", dbPath);
  } catch (err) {
    console.error("[Tessera] Failed to initialize native bridge:", err);
    bridge = null;
    return false;
  }

  modelSidecar = new ModelSidecar({
    binaryPath: resolveSidecarBinary(),
    port: 8384,
  });
  console.log("[Tessera] Model sidecar configured");

  return true;
}

function resolveSidecarBinary(): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  const binaryName = `llama-server${ext}`;
  const possiblePaths = [
    path.join(app.getAppPath(), "sidecars", "llama-server", binaryName),
    path.join(app.getAppPath(), "..", "sidecars", "llama-server", binaryName),
    path.join(__dirname, "..", "sidecars", "llama-server", binaryName),
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) return p;
  }
  return binaryName;
}

export function getBridge(): NativeBridge | null {
  return bridge;
}

export function isBridgeAvailable(): boolean {
  return bridge !== null;
}

export function getModelSidecar(): ModelSidecar | null {
  return modelSidecar;
}
