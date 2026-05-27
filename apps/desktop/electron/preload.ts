import { contextBridge, ipcRenderer } from "electron";
import type {
  AddCitationRequest,
  ExternalProviderConfigInput,
  ExternalProviderListModelsDraftOverrides,
  HybridSearchConfigUpdate,
  InstalledModelsByCapability,
  KchatConnectionStateView,
  KchatWebSocketEventPayload,
  ModelCapability,
  ModelDownloadProgress,
  OpenImageDialogOptions,
  ReplaceCitationRequest,
  SaveDialogOptions,
  SettingsData,
  TesseraApi,
  UpdateStatusInfo,
} from "../shared/types";

// Re-export the shared IPC types so existing call sites that import
// from "./preload" keep working. The canonical declarations live in
// `apps/desktop/shared/types.ts` so there is exactly one definition
// per wire type — see Workstream 1 of the production hardening plan.
export type {
  AddCitationRequest,
  ArtifactInfo,
  ArtifactVersionInfo,
  AutomationAction,
  AutomationApi,
  AutomationInfo,
  AutomationTrigger,
  BackfillEmbeddingsResult,
  CitationApi,
  CitationFreshness,
  CitationInfo,
  ComputeBackend,
  ConnectorApi,
  ConnectorFileInfo,
  ConnectorStatusInfo,
  CreateAutomationRequest,
  CreateTaskRequest,
  DeviceTier,
  DialogApi,
  DownloadPlan,
  DriveFileListResult,
  DrivePickerItem,
  DrivePickerSelection,
  DriveSyncResult,
  EmbeddingProgressInfo,
  ExportResult,
  ExternalProviderApi,
  ExternalProviderConfigInput,
  ExternalProviderConfigView,
  ExternalProviderTestResult,
  ExternalProviderType,
  ExtractedItem,
  GenerateChunk,
  GenerateRequest,
  HybridSearchConfigInfo,
  HybridSearchConfigUpdate,
  IndexedFileInfo,
  IndexingProgressInfo,
  InstalledModelRecord,
  InstalledModelsByCapability,
  MarpExportRequest,
  ModelApi,
  ModelCapability,
  ModelDownloadProgress,
  ModelFormat,
  ModelPlatform,
  ModelStatus,
  OpenImageDialogOptions,
  OpenImageDialogResult,
  PlatformInfo,
  ReplaceCitationRequest,
  ReplaceCitationResult,
  ResolvedModel,
  RuntimeApi,
  SaveDialogOptions,
  SaveDialogResult,
  SchedulerStatus,
  SchedulerStatusInfo,
  SearchHit,
  SearchHitInfo,
  SettingsApi,
  SettingsData,
  SourceApi,
  SourceDetailInfo,
  SourceInfo,
  TaskApi,
  TaskInfo,
  TaskPriority,
  TaskStatus,
  TemplateApi,
  TemplateInfo,
  TesseraApi,
  TypstExportRequest,
  TypstExportResult,
  UpdatesApi,
  UpdateStatusInfo,
  UpdateTaskRequest,
  KchatConnectionStateView,
  KchatWebSocketEventPayload,
} from "../shared/types";

/**
 * Typed subscription helper for the renderer-facing IPC event channels
 * (`model:token`, `runtime:downloadProgress`, `updates:status`, …).
 *
 * Electron's `ipcRenderer.on(channel, listener)` typings declare the
 * listener as `(event: IpcRendererEvent, ...args: any[]) => void`. Our
 * preload bridges want a *typed* payload callback (e.g.
 * `(progress: ModelDownloadProgress) => void`), so the previous code
 * wrote per-channel listener wrappers and reached for `as never` to
 * launder the type mismatch:
 *
 * ```ts
 * const listener = (_event: unknown, payload: SomeType) => callback(payload);
 * ipcRenderer.on(channel, listener as never);
 * ipcRenderer.removeListener(channel, listener as never);
 * ```
 *
 * That pattern had three downsides:
 *
 *   1. `as never` is the maximally-permissive escape hatch — once it
 *      compiles, drift in either Electron's signature or our typed
 *      payload would silently slip through.
 *   2. The cast was duplicated at every listener registration, which
 *      meant a future bug fix (e.g. logging the raw `IpcRendererEvent`)
 *      would have to be applied N times.
 *   3. The disposer closure had to be re-implemented per channel,
 *      including remembering to use the SAME function reference for
 *      `removeListener` (otherwise the listener leaks for the lifetime
 *      of the renderer process).
 *
 * The helper below contains the one cast in one place, behind a
 * generic `<T>` payload type. Callers stay strongly typed.
 *
 * The `IpcEventListener` alias exists purely so the cast site below
 * has a name to point at instead of inlining the full Electron
 * signature.
 */
type IpcEventListener = (
  event: Electron.IpcRendererEvent,
  // Electron's own type uses `...args: any[]`; we use `unknown[]` here
  // because the cast at the assignment site is the single point where
  // the dispatcher converts between the helper's typed `payload: T`
  // and Electron's variadic `...args: any[]` shape.
  ...args: unknown[]
) => void;

function subscribeIpc<T>(
  channel: string,
  callback: (payload: T) => void,
): () => void {
  // Capture the same function reference for both `on` and
  // `removeListener` so the disposer actually removes the listener
  // we registered (passing a fresh closure to `removeListener` would
  // silently leak the listener until the renderer is destroyed).
  const listener: IpcEventListener = (_event, ...args) => {
    callback(args[0] as T);
  };
  ipcRenderer.on(channel, listener);
  return () => {
    ipcRenderer.removeListener(channel, listener);
  };
}

const api: TesseraApi = {
  sources: {
    addLocalFolder: (folderPath: string) =>
      ipcRenderer.invoke("sources:addLocalFolder", folderPath),
    addLocalFile: (filePath: string) =>
      ipcRenderer.invoke("sources:addLocalFile", filePath),
    listSources: () => ipcRenderer.invoke("sources:list"),
    removeSource: (id: string) => ipcRenderer.invoke("sources:remove", id),
    searchSources: (query: string, limit: number) =>
      ipcRenderer.invoke("sources:search", query, limit),
    getDetail: (id: string) => ipcRenderer.invoke("sources:getDetail", id),
    reindex: (id: string) => ipcRenderer.invoke("sources:reindex", id),
    getIndexingProgress: (id: string) =>
      ipcRenderer.invoke("sources:getIndexingProgress", id),
    backfillEmbeddings: (batchSize?: number) =>
      ipcRenderer.invoke(
        "sources:backfillEmbeddings",
        batchSize ?? null,
      ),
    getEmbeddingProgress: () =>
      ipcRenderer.invoke("sources:getEmbeddingProgress"),
  },
  artifacts: {
    create: (title: string, artifactType: string, templateId?: string) =>
      ipcRenderer.invoke("artifacts:create", title, artifactType, templateId),
    update: (id: string, content: string) =>
      ipcRenderer.invoke("artifacts:update", id, content),
    list: () => ipcRenderer.invoke("artifacts:list"),
    get: (id: string) => ipcRenderer.invoke("artifacts:get", id),
    remove: (id: string) => ipcRenderer.invoke("artifacts:remove", id),
    exportArtifact: (
      id: string,
      format: string,
      contentOverride?: string | null,
    ) =>
      ipcRenderer.invoke(
        "artifacts:export",
        id,
        format,
        contentOverride ?? null,
      ),
    exportToFile: (
      id: string,
      format: string,
      filePath: string,
      contentOverride?: string | null,
    ) =>
      ipcRenderer.invoke(
        "artifacts:exportToFile",
        id,
        format,
        filePath,
        contentOverride ?? null,
      ),
    listVersions: (id: string) =>
      ipcRenderer.invoke("artifacts:listVersions", id),
    restoreVersion: (id: string, versionNumber: number) =>
      ipcRenderer.invoke("artifacts:restoreVersion", id, versionNumber),
    generateFromTemplate: (templateId: string, sourceIds: string[]) =>
      ipcRenderer.invoke(
        "artifacts:generateFromTemplate",
        templateId,
        sourceIds,
      ),
    extractTasksDecisions: (sourceId: string) =>
      ipcRenderer.invoke("artifacts:extractTasksDecisions", sourceId),
    compareSources: (sourceIdA: string, sourceIdB: string) =>
      ipcRenderer.invoke("artifacts:compareSources", sourceIdA, sourceIdB),
    exportEvidencePack: (artifactId: string, outputPath: string) =>
      ipcRenderer.invoke(
        "artifacts:exportEvidencePack",
        artifactId,
        outputPath,
      ),
    exportMarp: (req) => ipcRenderer.invoke("artifacts:exportMarp", req),
    exportTypst: (req) => ipcRenderer.invoke("artifacts:exportTypst", req),
  },
  templates: {
    list: () => ipcRenderer.invoke("templates:list"),
    get: (id: string) => ipcRenderer.invoke("templates:get", id),
  },
  citations: {
    list: (artifactId: string) =>
      ipcRenderer.invoke("citations:list", artifactId),
    add: (req: AddCitationRequest) => ipcRenderer.invoke("citations:add", req),
    remove: (artifactId: string, citationId: string) =>
      ipcRenderer.invoke("citations:remove", artifactId, citationId),
    checkChanged: (citationId: string) =>
      ipcRenderer.invoke("citations:checkChanged", citationId),
    checkFreshness: (citationId: string) =>
      ipcRenderer.invoke("citations:checkFreshness", citationId),
    replace: (req: ReplaceCitationRequest) =>
      ipcRenderer.invoke("citations:replace", req),
  },
  settings: {
    get: () => ipcRenderer.invoke("settings:get"),
    update: (settings: Partial<SettingsData>) =>
      ipcRenderer.invoke("settings:update", settings),
    // Hybrid retrieval config: channel name (`settings:*`),
    // handler registration (`registerSettingsHandlers`), and
    // preload surface (`window.tessera.settings`) all agree that
    // search tuning is a global setting. See `SettingsApi` in
    // `shared/types.ts` for the rationale.
    getHybridSearchConfig: () =>
      ipcRenderer.invoke("settings:getHybridSearchConfig"),
    updateHybridSearchConfig: (update: HybridSearchConfigUpdate) =>
      ipcRenderer.invoke("settings:updateHybridSearchConfig", update),
  },
  externalProvider: {
    get: () => ipcRenderer.invoke("externalProvider:get"),
    set: (provider: ExternalProviderConfigInput, apiKey: string | null) =>
      ipcRenderer.invoke("externalProvider:set", provider, apiKey),
    test: () => ipcRenderer.invoke("externalProvider:test"),
    listModels: (overrides?: ExternalProviderListModelsDraftOverrides) =>
      ipcRenderer.invoke("externalProvider:listModels", overrides),
    getTokenUsage: () => ipcRenderer.invoke("externalProvider:getTokenUsage"),
    resetTokenUsage: () =>
      ipcRenderer.invoke("externalProvider:resetTokenUsage"),
  },
  model: {
    status: () => ipcRenderer.invoke("model:status"),
    start: (modelPath: string) => ipcRenderer.invoke("model:start", modelPath),
    stop: () => ipcRenderer.invoke("model:stop"),
    generate: (request) => ipcRenderer.invoke("model:generate", request),
    cancelJob: () => ipcRenderer.invoke("model:cancelJob"),
    onToken: (callback) => subscribeIpc("model:token", callback),
  },
  runtime: {
    detectPlatform: () => ipcRenderer.invoke("runtime:detectPlatform"),
    // Each capability has its own slot: omitting the parameter
    // preserves the historical "text" default so existing renderer
    // call sites keep working unchanged.
    recommendModel: (capability?: ModelCapability) =>
      ipcRenderer.invoke("runtime:recommendModel", capability),
    listModels: (capability?: ModelCapability) =>
      ipcRenderer.invoke("runtime:listModels", capability),
    getCurrentModel: (capability?: ModelCapability) =>
      ipcRenderer.invoke("runtime:getCurrentModel", capability),
    getInstalledModels: (): Promise<InstalledModelsByCapability> =>
      ipcRenderer.invoke("runtime:getInstalledModels"),
    isCapabilityAvailable: (capability: ModelCapability): Promise<boolean> =>
      ipcRenderer.invoke("runtime:isCapabilityAvailable", capability),
    planDownload: (modelId: string) =>
      ipcRenderer.invoke("runtime:planDownload", modelId),
    // `downloadModel` handles both fresh-install and swap (delete-then-
    // fetch). There is intentionally no separate `swapModel` channel.
    // The slot is derived from the manifest entry's capability so the
    // renderer does not need to pass it explicitly.
    downloadModel: (modelId: string) =>
      ipcRenderer.invoke("runtime:downloadModel", modelId),
    deleteModel: (capability?: ModelCapability) =>
      ipcRenderer.invoke("runtime:deleteModel", capability),
    onDownloadProgress: (callback: (p: ModelDownloadProgress) => void) =>
      subscribeIpc<ModelDownloadProgress>("runtime:downloadProgress", callback),
  },
  vision: {
    isAvailable: (): Promise<boolean> =>
      ipcRenderer.invoke("vision:isAvailable"),
    describe: (req: {
      imagePath: string;
      mode: "describe" | "ocr" | "chart";
      maxTokens?: number;
    }): Promise<{
      content: string;
      stop: boolean;
      tokensPredicted: number;
      tokensEvaluated: number;
    }> => ipcRenderer.invoke("vision:describe", req),
  },
  imagegen: {
    isAvailable: (): Promise<boolean> =>
      ipcRenderer.invoke("imagegen:isAvailable"),
    // Returns a structured result the renderer can persist without
    // re-reading the file: { path, assetUrl, seed, width, height,
    // durationMs, sizeBytes }. The `assetUrl` field is a
    // `tessera-asset://` URL the renderer drops directly into
    // `<img src>` — see `assetProtocol.ts` for the protocol
    // contract. The main process keeps the actual PNG bytes — it
    // owns the on-disk path under userData and the renderer has no
    // way to read absolute filesystem paths directly.
    generate: (req: {
      prompt: string;
      width: number;
      height: number;
      steps?: number;
      cfgScale?: number;
      seed?: number;
      negativePrompt?: string;
      artifactId: string;
      sectionIndex?: number;
    }) => ipcRenderer.invoke("imagegen:generate", req),
    cancel: (): Promise<{ scheduled: boolean }> =>
      ipcRenderer.invoke("imagegen:cancel"),
  },
  connectors: {
    authenticate: (provider: string, clientId: string, clientSecret: string) =>
      ipcRenderer.invoke(
        "connectors:authenticate",
        provider,
        clientId,
        clientSecret,
      ),
    disconnect: (provider: string) =>
      ipcRenderer.invoke("connectors:disconnect", provider),
    status: (provider: string) =>
      ipcRenderer.invoke("connectors:status", provider),
    listDriveFiles: (folderId?: string, pageToken?: string) =>
      ipcRenderer.invoke("connectors:gdrive:listFiles", folderId, pageToken),
    selectItems: (items) =>
      ipcRenderer.invoke("connectors:gdrive:selectItems", items),
    syncDrive: (selectedFileIds?: string[]) =>
      ipcRenderer.invoke("connectors:gdrive:sync", selectedFileIds),
    sync: (provider: string) => ipcRenderer.invoke("connectors:sync", provider),
    getRedirectUri: (provider: string) =>
      ipcRenderer.invoke("connectors:getRedirectUri", provider),
    getAllRedirectUris: () =>
      ipcRenderer.invoke("connectors:getAllRedirectUris"),
  },
  tasks: {
    create: (req) => ipcRenderer.invoke("tasks:create", req),
    list: () => ipcRenderer.invoke("tasks:list"),
    get: (id) => ipcRenderer.invoke("tasks:get", id),
    update: (id, req) => ipcRenderer.invoke("tasks:update", id, req),
    remove: (id) => ipcRenderer.invoke("tasks:delete", id),
    reorder: (status, ids) => ipcRenderer.invoke("tasks:reorder", status, ids),
  },
  automations: {
    create: (req) => ipcRenderer.invoke("automations:create", req),
    list: () => ipcRenderer.invoke("automations:list"),
    get: (id) => ipcRenderer.invoke("automations:get", id),
    setEnabled: (id, enabled) =>
      ipcRenderer.invoke("automations:setEnabled", id, enabled),
    remove: (id) => ipcRenderer.invoke("automations:delete", id),
    schedulerStatus: () => ipcRenderer.invoke("automations:schedulerStatus"),
    runNow: () => ipcRenderer.invoke("automations:runNow"),
  },
  dialog: {
    showSaveDialog: (options: SaveDialogOptions) =>
      ipcRenderer.invoke("dialog:showSaveDialog", options),
    pickImage: (options?: OpenImageDialogOptions) =>
      ipcRenderer.invoke("dialog:pickImage", options ?? {}),
  },
  updates: {
    status: () => ipcRenderer.invoke("updates:status"),
    check: () => ipcRenderer.invoke("updates:check"),
    install: () => ipcRenderer.invoke("updates:install"),
    getAutoUpdateEnabled: () =>
      ipcRenderer.invoke("updates:getAutoUpdateEnabled"),
    setAutoUpdateEnabled: (enabled: boolean) =>
      ipcRenderer.invoke("updates:setAutoUpdateEnabled", enabled),
    onStatus: (cb: (s: UpdateStatusInfo) => void) =>
      subscribeIpc<UpdateStatusInfo>("updates:status", cb),
  },
  kchat: {
    isAvailable: () => ipcRenderer.invoke("kchat:isAvailable"),
    status: () => ipcRenderer.invoke("kchat:status"),
    connect: (token: string, serverUrl: string) =>
      ipcRenderer.invoke("kchat:connect", token, serverUrl),
    disconnect: () => ipcRenderer.invoke("kchat:disconnect"),
    listTeams: () => ipcRenderer.invoke("kchat:listTeams"),
    listChannels: (teamId: string) =>
      ipcRenderer.invoke("kchat:listChannels", teamId),
    listMembers: (channelId: string) =>
      ipcRenderer.invoke("kchat:listMembers", channelId),
    listChannelFiles: (channelId: string, page?: number, perPage?: number) =>
      ipcRenderer.invoke(
        "kchat:listChannelFiles",
        channelId,
        page ?? null,
        perPage ?? null,
      ),
    shareArtifact: (
      artifactId: string,
      channelId: string,
      format: "markdown" | "html" | "pdf" | "docx" | "json",
      includeCitations: boolean,
      includeEvidencePack: boolean,
    ) =>
      ipcRenderer.invoke(
        "kchat:shareArtifact",
        artifactId,
        channelId,
        format,
        includeCitations,
        includeEvidencePack,
      ),
    addChannelSource: (channelId: string, channelName: string) =>
      ipcRenderer.invoke("sources:addKchatChannel", channelId, channelName),
    /**
     * Block C Task 4 (Phase 13): trigger the historical-backfill
     * walk for an already-linked KChat channel. Returns a single
     * aggregate outcome rather than streaming progress; the
     * substrate emits per-page audit rows for operators that need
     * intermediate visibility. Idempotent — a re-trigger after
     * completion short-circuits at the substrate state read with
     * `outcome: "skipped" / reason: "already_completed"`.
     */
    backfillChannel: (channelId: string) =>
      ipcRenderer.invoke("sources:backfillKchatChannel", channelId),
    /**
     * Block D Task 1 (Phase 14): KChat post-body retrieval. The
     * renderer's evidence-search UI calls this alongside
     * `sources.search` so chat threads surface as evidence
     * alongside files. See the IPC handler in
     * `electron/ipc/kchat.ts` for the AEAD-verify gate, audit
     * shape, and permalink composition.
     */
    searchPosts: (query: string, limit: number) =>
      ipcRenderer.invoke("kchat:searchPosts", query, limit),
    // Block B Task 1: push-based delivery of KChat connection
    // state + WebSocket events. The status channel mirrors
    // `updates.onStatus` so the connection card / sidebar no
    // longer have to poll `kchat:status` to detect a
    // reconnect; the event channel surfaces the renderer-safe
    // projection emitted by the main-process
    // `KchatEventForwarder`. Both helpers return an
    // unsubscribe function the caller must invoke in the
    // React cleanup phase to avoid leaking IPC listeners.
    onStatusChange: (cb: (s: KchatConnectionStateView) => void) =>
      subscribeIpc<KchatConnectionStateView>("kchat:status", cb),
    onEvent: (cb: (e: KchatWebSocketEventPayload) => void) =>
      subscribeIpc<KchatWebSocketEventPayload>("kchat:event", cb),
  },
  audit: {
    listRecent: (limit?: number, offset?: number) =>
      ipcRenderer.invoke("audit:listRecent", limit, offset),
  },
};

contextBridge.exposeInMainWorld("tessera", api);
