import { app } from "electron";
import * as path from "path";
import * as fs from "fs";
import { ModelSidecar } from "./sidecar";
import type {
  AddCitationRequest,
  ArtifactInfo,
  ArtifactVersionInfo,
  AutomationInfo,
  CitationInfo,
  ExportResult,
  IndexingProgressInfo,
  ReplaceCitationRequest,
  ReplaceCitationResult,
  SearchHitInfo,
  SourceDetailInfo,
  SourceInfo,
  TaskInfo,
  TemplateInfo,
} from "../shared/types";

// Re-export the canonical shared types so existing call sites that
// import them from "./appState" keep working. The single source of
// truth is `apps/desktop/shared/types.ts`.
export type {
  AddCitationRequest,
  ArtifactInfo,
  ArtifactVersionInfo,
  AutomationInfo,
  CitationInfo,
  IndexedFileInfo,
  IndexingProgressInfo,
  ReplaceCitationRequest,
  ReplaceCitationResult,
  SearchHit,
  SearchHitInfo,
  SourceDetailInfo,
  SourceInfo,
  TaskInfo,
  TemplateInfo,
} from "../shared/types";

export interface NativeBridge {
  initBridge(dbPath: string, templateDir: string): void;
  bridgeAddLocalFolder(path: string): SourceInfo;
  bridgeAddLocalFile(path: string): SourceInfo;
  bridgeListSources(): SourceInfo[];
  bridgeRemoveSource(sourceId: string): void;
  bridgeSearchSources(query: string, limit: number): SearchHitInfo[];
  bridgeGetSourceDetail(sourceId: string): SourceDetailInfo;
  bridgeReindexSource(sourceId: string): SourceInfo;
  bridgeGetIndexingProgress(sourceId: string): IndexingProgressInfo;
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
    contentOverride?: string | null,
  ): ExportResult;
  bridgeExportArtifactToFile(
    artifactId: string,
    format: string,
    path: string,
    contentOverride?: string | null,
  ): void;
  bridgeListTemplates(): TemplateInfo[];
  bridgeGetTemplate(templateId: string): TemplateInfo | null;
  bridgeListCitations(artifactId: string): CitationInfo[];
  bridgeAddCitation(req: AddCitationRequest): CitationInfo;
  bridgeRemoveCitation(artifactId: string, citationId: string): void;
  bridgeCheckSourceChanged(citationId: string): boolean;
  bridgeCheckCitationFreshness(citationId: string): string;
  bridgeReplaceCitation(req: ReplaceCitationRequest): ReplaceCitationResult;
  bridgeListVersions(artifactId: string): ArtifactVersionInfo[];
  bridgeRestoreVersion(artifactId: string, versionNumber: number): ArtifactInfo;
  bridgeGenerateFromTemplate(
    templateId: string,
    sourceIds: string[],
  ): ArtifactInfo;
  bridgeExtractTasksDecisions(sourceId: string): string;
  bridgeCompareSources(sourceIdA: string, sourceIdB: string): ArtifactInfo;
  bridgeExportEvidencePack(artifactId: string, outputPath: string): string;
  // --- Tasks ---
  // `req_json` is a JSON-encoded `tessera_bridge::tasks::CreateTaskRequest`
  // / `UpdateTaskRequest`. JSON-tunneling is used because the napi macro
  // does not generate TS types for serde-default + Option-of-Option
  // fields cleanly; the bridge's serde_json deserialization gives the
  // backend full structural validation (including parse_opt_rfc3339).
  bridgeCreateTask(reqJson: string): TaskInfo;
  bridgeListTasks(): TaskInfo[];
  bridgeGetTask(taskId: string): TaskInfo | null;
  bridgeUpdateTask(taskId: string, reqJson: string): TaskInfo;
  bridgeDeleteTask(taskId: string): boolean;
  bridgeReorderTasks(status: string, ids: string[]): void;
  // --- Automations ---
  bridgeCreateAutomation(reqJson: string): AutomationInfo;
  bridgeListAutomations(): AutomationInfo[];
  bridgeGetAutomation(automationId: string): AutomationInfo | null;
  bridgeSetAutomationEnabled(automationId: string, enabled: boolean): void;
  bridgeDeleteAutomation(automationId: string): boolean;
  /** Enabled `Schedule` automations whose `next_scheduled_at <= now`. */
  bridgeDueScheduledAutomations(): AutomationInfo[];
  /** Enabled `OnGenerate` automations tied to the given template string id
   *  (e.g. `"prd-v1"`). The bridge hashes the id via
   *  `TemplateId::from_string` to match the UUID5 stored on the trigger. */
  bridgeMatchingOnGenerateAutomations(templateId: string): AutomationInfo[];
  /** Persist a run result. `status` is rendered verbatim by the UI. */
  bridgeRecordAutomationRun(automationId: string, status: string): void;
}

let bridge: NativeBridge | null = null;
let modelSidecar: ModelSidecar | null = null;

function resolveNativeAddon(): NativeBridge | null {
  // The compiled main bundle now lives at `dist-electron/electron/main.js`
  // (Workstream 1 sibling-rooted layout — see `tsconfig.electron.json`),
  // so `__dirname` at runtime is `<desktop>/dist-electron/electron/`.
  // The `__dirname`-relative fallbacks below compensate by going up
  // one more level than they did before; without this they'd resolve
  // inside `dist-electron/` itself (which never contains a sibling
  // `native/` directory) and degenerate into dead paths.
  const possiblePaths = [
    path.join(app.getAppPath(), "native", "tessera_bridge.node"),
    path.join(app.getAppPath(), "..", "native", "tessera_bridge.node"),
    path.join(__dirname, "..", "..", "native", "tessera_bridge.node"),
    // Sibling-of-main: build scripts that drop the .node binary next
    // to `main.js` end up at `dist-electron/electron/<binary>`.
    path.join(__dirname, "tessera_bridge.node"),
    // Legacy sibling-of-`dist-electron`: covers the historical layout
    // where main.js was at `dist-electron/main.js`.
    path.join(__dirname, "..", "tessera_bridge.node"),
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
  // electron-builder copies sidecars/llama-server/ into process.resourcesPath/sidecars/llama-server
  // for packaged builds. In dev we look relative to the repo root.
  // `__dirname` at runtime is `<desktop>/dist-electron/electron/` (see
  // the comment in `resolveNativeAddon` above), so the relative paths
  // below climb two extra levels to land at `<desktop>/` and
  // `<repo>/apps/` respectively — the `../../..` entry does NOT reach
  // the repo root, it reaches `apps/`, which is consistent with how the
  // pre-WS1 `../..` lookup behaved. Without the depth bump these would
  // silently resolve inside `dist-electron/`.
  const resourcesPath = (process as NodeJS.Process & { resourcesPath?: string })
    .resourcesPath;
  const possiblePaths = [
    resourcesPath &&
      path.join(resourcesPath, "sidecars", "llama-server", binaryName),
    path.join(app.getAppPath(), "sidecars", "llama-server", binaryName),
    path.join(app.getAppPath(), "..", "sidecars", "llama-server", binaryName),
    // `<desktop>/sidecars/...` (was previously the first `__dirname` entry).
    path.join(__dirname, "..", "..", "sidecars", "llama-server", binaryName),
    // `<repo>/apps/sidecars/...` (was previously the second entry — kept
    // for backwards compat even though the directory is not at the
    // canonical repo-root `sidecars/` location).
    path.join(
      __dirname,
      "..",
      "..",
      "..",
      "sidecars",
      "llama-server",
      binaryName,
    ),
  ].filter((p): p is string => typeof p === "string");
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
