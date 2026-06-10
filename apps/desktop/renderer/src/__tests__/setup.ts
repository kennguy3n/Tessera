import "@testing-library/jest-dom/vitest";
import { beforeEach, vi } from "vitest";
import { __resetSettingsStoreForTests } from "../hooks/useSettings";

// jsdom does not implement SVG layout APIs; mermaid and other diagram
// libraries call getBBox/getComputedTextLength/getCTM during render. Stub
// just enough to let the layout pass complete.
if (typeof SVGElement !== "undefined") {
  const proto = SVGElement.prototype as unknown as {
    getBBox?: () => { x: number; y: number; width: number; height: number };
    getComputedTextLength?: () => number;
    getCTM?: () => { a: number; b: number; c: number; d: number; e: number; f: number };
    getScreenCTM?: () => { a: number; b: number; c: number; d: number; e: number; f: number };
  };
  if (!proto.getBBox) {
    proto.getBBox = () => ({ x: 0, y: 0, width: 100, height: 20 });
  }
  if (!proto.getComputedTextLength) {
    proto.getComputedTextLength = () => 100;
  }
  if (!proto.getCTM) {
    proto.getCTM = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  }
  if (!proto.getScreenCTM) {
    proto.getScreenCTM = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0 });
  }
}

// jsdom does not implement `Document.elementFromPoint` (a layout-dependent
// hit-testing API). Libraries that probe the element under a coordinate call
// it unconditionally — notably ProseMirror/TipTap, whose placeholder
// extension runs `posAtCoords` from a viewport-tracking plugin when the editor
// mounts (see prosemirror-view `posAtCoords`). With the API missing that
// throws "elementFromPoint is not a function", and because the plugin can fire
// asynchronously the throw surfaces as an *unhandled* error attributed to
// whichever test is running — an intermittent, platform-dependent failure that
// bit the Windows CI leg. Provide a no-op that reports "nothing here" (null);
// both ProseMirror and our own SheetEditor auto-fill treat a null hit as "no
// element at this point" and fall back gracefully.
if (typeof Document !== "undefined") {
  const docProto = Document.prototype as unknown as {
    elementFromPoint?: (x: number, y: number) => Element | null;
  };
  if (!docProto.elementFromPoint) {
    docProto.elementFromPoint = () => null;
  }
}

const mockApi = {
  sources: {
    addLocalFolder: vi.fn().mockResolvedValue({
      id: "src-1",
      sourceType: "local_folder",
      path: "/mock/folder",
      status: "connected",
      createdAt: new Date().toISOString(),
      lastIndexed: null,
      fileCount: 0,
    }),
    addLocalFile: vi.fn().mockResolvedValue({
      id: "src-2",
      sourceType: "local_file",
      path: "/mock/file.md",
      status: "connected",
      createdAt: new Date().toISOString(),
      lastIndexed: null,
      fileCount: 1,
    }),
    listSources: vi.fn().mockResolvedValue([]),
    removeSource: vi.fn().mockResolvedValue(undefined),
    searchSources: vi.fn().mockResolvedValue([]),
    searchEnriched: vi.fn().mockResolvedValue({
      hits: [],
      entities: [],
      facts: [],
      concepts: [],
      memories: [],
    }),
    getDetail: vi.fn().mockResolvedValue({
      source: {
        id: "src-1",
        sourceType: "local_folder",
        path: "/mock/folder",
        status: "connected",
        createdAt: new Date().toISOString(),
        lastIndexed: null,
        fileCount: 0,
      },
      files: [],
    }),
    reindex: vi.fn().mockResolvedValue({
      id: "src-1",
      sourceType: "local_folder",
      path: "/mock/folder",
      status: "connected",
      createdAt: new Date().toISOString(),
      lastIndexed: new Date().toISOString(),
      fileCount: 0,
    }),
    // empty-but-well-shaped default for
    // `sources.batchReindex`. Tests that exercise the bulk
    // re-index path override this with `vi.fn().mockResolvedValue({
    // total, succeeded, failed, results })` to drive the specific
    // outcome shape they need.
    batchReindex: vi
      .fn()
      .mockResolvedValue({ total: 0, succeeded: 0, failed: 0, results: [] }),
    getIndexingProgress: vi.fn().mockResolvedValue({
      status: "idle",
      scanned: 0,
      indexed: 0,
      unchanged: 0,
      skipped: 0,
      errors: 0,
      totalFiles: 0,
      currentPath: null,
      lastError: null,
    }),
    backfillEmbeddings: vi.fn().mockResolvedValue({
      // Match the real bridge's `BackfillEmbeddingsResult` shape
      // exactly — `embedded` + `progress` only. The earlier mock
      // also synthesised `failed` and `batchSize` fields that
      // don't exist on the real type; that
      // as a footgun for the renderer code.
      embedded: 0,
      progress: {
        status: "done",
        totalChunks: 0,
        embedded: 0,
        failed: 0,
        modelId: "hash-trick-v1",
        lastError: null,
      },
    }),
    getEmbeddingProgress: vi.fn().mockResolvedValue({
      status: "idle",
      totalChunks: 0,
      embedded: 0,
      failed: 0,
      modelId: null,
      lastError: null,
    }),
    // empty-but-well-shaped default for
    // `sources:healthReport`. SettingsPage now renders
    // `<SourceHealthDashboard />` which fires this on mount, so
    // every test that mounts SettingsPage needs a callable mock
    // here — otherwise the dashboard renders in an error state
    // ("sources.healthReport is not a function") and tests that
    // later assert against the dashboard's empty / loaded UI
    // observe the wrong DOM. Tests exercising the dashboard
    // directly override this via `sourceHealthDashboard.test.tsx`
    // with a populated `SourceHealthReport`. Default returns the
    // empty `sources` array + a `generatedAt` timestamp so the
    // dashboard renders its "No sources indexed yet" empty state.
    healthReport: vi.fn().mockResolvedValue({
      generatedAt: new Date().toISOString(),
      sources: [],
    }),
  },
  artifacts: {
    create: vi.fn().mockResolvedValue({
      id: "art-1",
      title: "Test Artifact",
      artifactType: "document",
      templateId: null,
      content: "",
      citationCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    }),
    update: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    remove: vi.fn(),
    exportArtifact: vi.fn(),
    // empty-but-well-shaped default for
    // `artifacts.batchExport`. Tests that exercise bulk export
    // override this with the expected per-item outcomes.
    batchExport: vi
      .fn()
      .mockResolvedValue({ total: 0, succeeded: 0, failed: 0, results: [] }),
    // default no
    // recovery journal present and discard-as-noop. Tests that
    // exercise the recovery flow override these per-case.
    checkRecovery: vi.fn().mockResolvedValue(null),
    discardRecovery: vi.fn().mockResolvedValue(undefined),
    // default empty queue
    // and retry/discard as noops. Tests exercising the queue UI
    // override these per-case with realistic outcomes.
    failedExports: vi.fn().mockResolvedValue([]),
    retryExport: vi.fn().mockResolvedValue(undefined),
    discardFailedExport: vi.fn().mockResolvedValue(undefined),
    exportToFile: vi.fn().mockResolvedValue(undefined),
    exportMarp: vi.fn().mockResolvedValue(undefined),
    exportTypst: vi.fn().mockResolvedValue(undefined),
    listVersions: vi.fn().mockResolvedValue([]),
    restoreVersion: vi.fn().mockResolvedValue({
      id: "art-1",
      title: "Restored",
      artifactType: "document",
      templateId: null,
      content: "",
      citationCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    }),
    generateFromTemplate: vi.fn().mockResolvedValue({
      id: "art-2",
      title: "Generated",
      artifactType: "document",
      templateId: "prd-v1",
      content: "",
      citationCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    }),
    extractTasksDecisions: vi.fn().mockResolvedValue([]),
    compareSources: vi.fn().mockResolvedValue({
      artifact: {
        id: "art-compare",
        title: "Compare",
        artifactType: "document",
        templateId: null,
        content: "",
        citationCount: 0,
        createdAt: new Date().toISOString(),
        updatedAt: new Date().toISOString(),
        version: 1,
      },
      comparison: {
        similarityScore: 0.42,
        commonThemes: [{ label: "shared concept", frequency: 7 }],
        uniqueToA: [{ label: "alpha only", frequency: 4 }],
        uniqueToB: [{ label: "beta only", frequency: 5 }],
      },
      labelA: "source-a",
      labelB: "source-b",
    }),
    exportEvidencePack: vi.fn().mockResolvedValue("/tmp/pack.zip"),
  },
  connectors: {
    status: vi.fn().mockResolvedValue({
      provider: "google_drive",
      connected: false,
      status: "disconnected",
    }),
    authenticate: vi.fn().mockResolvedValue({
      provider: "google_drive",
      connected: true,
      status: "connected",
    }),
    disconnect: vi.fn().mockResolvedValue({
      provider: "google_drive",
      connected: false,
      status: "disconnected",
    }),
    listDriveFiles: vi.fn().mockResolvedValue({
      nextPageToken: null,
      files: [],
    }),
    selectItems: vi.fn().mockResolvedValue([]),
    syncDrive: vi.fn().mockResolvedValue({
      added: 0,
      modified: 0,
      removed: 0,
      status: "ok",
    }),
  },
  citations: {
    list: vi.fn().mockResolvedValue([]),
    add: vi.fn().mockResolvedValue({
      citationId: "cit-1",
      sourceId: "src-1",
      sourceType: "local_folder",
      sourceTitle: "Mock Source",
      sourceUri: "file:///mock",
      chunkHash: "deadbeef",
      page: null,
      confidence: 1,
      usedFor: "test",
      createdAt: new Date().toISOString(),
    }),
    remove: vi.fn().mockResolvedValue(undefined),
    checkChanged: vi.fn().mockResolvedValue(false),
    checkFreshness: vi.fn().mockResolvedValue("fresh"),
    replace: vi.fn().mockResolvedValue({
      citation: {
        citationId: "cit-1",
        sourceId: "src-2",
        sourceType: "local_file",
        sourceTitle: "Replacement Source",
        sourceUri: "file:///mock/replacement",
        chunkHash: "feedbeef",
        page: null,
        confidence: 0.9,
        usedFor: "test",
        createdAt: new Date().toISOString(),
      },
      previousSourceUri: "file:///mock",
    }),
  },
  templates: {
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
  },
  settings: {
    get: vi.fn().mockResolvedValue({
      theme: "light",
      defaultExportFormat: "markdown",
      ignorePatterns: [".git", "node_modules"],
      watchPatterns: ["**/*.md"],
      // default mock treats the test environment as
      // "already-onboarded" so existing page-level tests don't
      // accidentally render the wizard. Wizard-specific tests
      // override this field explicitly.
      onboardingCompleted: true,
      // Default mock returns empty arrays so every page-level test
      // starts with a fresh "no pins / no recents" state. Tests
      // that exercise the command palette or sidebar Pinned
      // section override these fields with the
      // specific IDs they want to assert against.
      pinnedArtifactIds: [],
      recentArtifactIds: [],
      // UX-disclosure defaults mirror DEFAULT_CONFIG: simplified
      // sidebar on (secondary tools collapsed), model auto-download
      // on, guided Create wizard as the default mode. Tests that
      // exercise the power-user layouts override these explicitly.
      simplifiedNav: true,
      autoDownloadModel: true,
      createPageMode: "wizard",
      closeToTray: false,
    }),
    update: vi.fn().mockResolvedValue({
      theme: "light",
      defaultExportFormat: "markdown",
      ignorePatterns: [".git", "node_modules"],
      watchPatterns: ["**/*.md"],
      onboardingCompleted: true,
      pinnedArtifactIds: [],
      recentArtifactIds: [],
      simplifiedNav: true,
      autoDownloadModel: true,
      createPageMode: "wizard",
      closeToTray: false,
    }),
    // Hybrid search config lives on `settings` (not `sources`)
    // because the channel name is `settings:*` and the handler is
    // registered in `registerSettingsHandlers`. See `SettingsApi`
    // in `shared/types.ts` for the full rationale.
    getHybridSearchConfig: vi.fn().mockResolvedValue({
      bm25Weight: 1.0,
      vectorWeight: 1.0,
      rrfK: 60.0,
      recencyDecayEnabled: true,
      recencyHalflifeSecs: 30 * 24 * 60 * 60,
      candidatePoolSize: 0,
    }),
    updateHybridSearchConfig: vi.fn().mockResolvedValue({
      bm25Weight: 1.0,
      vectorWeight: 1.0,
      rrfK: 60.0,
      recencyDecayEnabled: true,
      recencyHalflifeSecs: 30 * 24 * 60 * 60,
      candidatePoolSize: 0,
    }),
    // ONNX embedding-model picker IPC. Test
    // doubles return the "idle, no models installed, HashTrick
    // active" baseline so every Settings page test renders the
    // card without throwing. Specific tests override these via
    // `vi.spyOn` when they care about a particular state.
    getEmbeddingModelStatus: vi.fn().mockResolvedValue({
      currentModelId: "hash-trick-v1-256d-char3-5",
      models: [],
      download: {
        status: "idle" as const,
        slug: null,
        bytesTotal: null,
        bytesDownloaded: 0,
        lastError: null,
      },
      nonAsciiChunks: 0,
      totalChunks: 0,
    }),
    getEmbeddingDownloadProgress: vi.fn().mockResolvedValue({
      status: "idle" as const,
      slug: null,
      bytesTotal: null,
      bytesDownloaded: 0,
      lastError: null,
    }),
    downloadEmbeddingModel: vi.fn().mockResolvedValue({
      slug: "all-MiniLM-L6-v2",
      displayName: "all-MiniLM-L6-v2",
      dim: 384,
      modelSizeBytes: 22 * 1024 * 1024,
      tokenizerSizeBytes: 700 * 1024,
      languages: "en",
      installed: true,
      modelId: "onnx:all-MiniLM-L6-v2:384d",
    }),
    switchEmbeddingModel: vi.fn().mockResolvedValue({
      slug: "all-MiniLM-L6-v2",
      displayName: "all-MiniLM-L6-v2",
      dim: 384,
      modelSizeBytes: 22 * 1024 * 1024,
      tokenizerSizeBytes: 700 * 1024,
      languages: "en",
      installed: true,
      modelId: "onnx:all-MiniLM-L6-v2:384d",
    }),
  },
  externalProvider: {
    get: vi.fn().mockResolvedValue({
      enabled: false,
      providerType: "openai_compatible",
      apiUrl: "",
      apiKeyRef: "tessera.external_provider.primary",
      modelName: "",
      maxTokens: 1024,
      temperature: 0.7,
      timeoutSecs: 60,
      maxRetries: 2,
      hasApiKey: false,
    }),
    set: vi.fn().mockImplementation(async (provider, apiKey) => ({
      ...provider,
      hasApiKey:
        apiKey === null ? false : apiKey === "" ? false : true,
    })),
    test: vi.fn().mockResolvedValue({ ok: true, latencyMs: 42 }),
    listModels: vi
      .fn()
      .mockResolvedValue({
        ok: true,
        models: ["gpt-3.5-turbo", "gpt-4o", "gpt-4o-mini"],
      }),
    getTokenUsage: vi.fn().mockResolvedValue({
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      lastResetDate: new Date(0).toISOString(),
    }),
    resetTokenUsage: vi.fn().mockResolvedValue({
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      lastResetDate: new Date().toISOString(),
    }),
  },
  model: {
    status: vi.fn().mockResolvedValue({
      available: false,
      modelName: null,
      status: "not_configured",
    }),
    start: vi.fn().mockResolvedValue(undefined),
    stop: vi.fn().mockResolvedValue(undefined),
    generate: vi.fn().mockResolvedValue(undefined),
    cancelJob: vi.fn().mockResolvedValue(undefined),
    onToken: vi.fn().mockReturnValue(() => undefined),
  },
  dialog: {
    showSaveDialog: vi.fn().mockResolvedValue({ canceled: true }),
    // Default mock: file picker is cancelled. Tests that need
    // a specific image path flip this with `vi.spyOn`.
    pickImage: vi
      .fn()
      .mockResolvedValue({ canceled: true, filePath: null }),
  },
  slides: {
    // Default mock: presentation "opens" with whatever slide count
    // the caller passed. Tests that assert on the request payload
    // inspect this spy's calls.
    startPresentation: vi
      .fn()
      .mockResolvedValue({ ok: true, slideCount: 0 }),
  },
  tasks: {
    create: vi.fn().mockResolvedValue({
      id: "task-1",
      title: "New Task",
      description: "",
      status: "todo",
      priority: "medium",
      position: 0,
      assignee: null,
      dueDate: null,
      sourceId: null,
      extractedItemId: null,
      dependsOn: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    update: vi.fn().mockImplementation(async (id: string) => ({
      id,
      title: "Updated",
      description: "",
      status: "todo",
      priority: "medium",
      position: 0,
      assignee: null,
      dueDate: null,
      sourceId: null,
      extractedItemId: null,
      dependsOn: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    })),
    remove: vi.fn().mockResolvedValue(true),
    reorder: vi.fn().mockResolvedValue(undefined),
  },
  automations: {
    create: vi.fn().mockResolvedValue({
      id: "auto-1",
      name: "Auto",
      triggerJson: '{"kind":"schedule","interval_seconds":3600}',
      actionJson: '{"kind":"reindex_source","source_id":"src-1"}',
      enabled: true,
      lastRunAt: null,
      lastRunStatus: null,
      nextScheduledAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    setEnabled: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(true),
    schedulerStatus: vi.fn().mockResolvedValue({
      running: true,
      lastTickAt: null,
      lastTickError: null,
      inFlight: false,
    }),
    runNow: vi.fn().mockResolvedValue({
      running: true,
      lastTickAt: new Date().toISOString(),
      lastTickError: null,
      inFlight: false,
    }),
  },
  runtime: {
    detectPlatform: vi.fn().mockResolvedValue({
      platform: "linux-x64",
      platformLabel: "Linux x64",
      totalRamGb: 16,
      tier: "high",
      tierLabel: "High (8+ GB RAM)",
      computeBackends: ["cpu"],
      preferredFormat: "gguf",
    }),
    recommendModel: vi.fn().mockResolvedValue(null),
    listModels: vi.fn().mockResolvedValue([]),
    getCurrentModel: vi.fn().mockResolvedValue(null),
    getInstalledModels: vi.fn().mockResolvedValue({
      text: null,
      vision: null,
      imagegen: null,
    }),
    isCapabilityAvailable: vi.fn(async (capability: string) => {
      // Default mock: text+vision always available; imagegen
      // unavailable because the default mocked platform reports a
      // CPU-only backend.
      return capability === "text" || capability === "vision";
    }),
    planDownload: vi.fn().mockResolvedValue({
      kind: "direct-download",
      modelId: "ternary-bonsai-1.7b-gguf",
      filename: "ternary-bonsai-1.7b-q1_0_g128.gguf",
      downloadSizeMb: 450,
      message: "Download Ternary-Bonsai 1.7B (450 MB).",
    }),
    downloadModel: vi.fn(),
    deleteModel: vi.fn().mockResolvedValue(undefined),
    onDownloadProgress: vi.fn().mockReturnValue(() => undefined),
  },
  vision: {
    // Default mock: vision is unavailable so renderer tests that
    // don't explicitly install a VLM don't accidentally show vision
    // UI. Tests that need vision flip this with `vi.spyOn`.
    isAvailable: vi.fn().mockResolvedValue(false),
    describe: vi.fn().mockResolvedValue({
      content: "",
      stop: true,
      tokensPredicted: 0,
      tokensEvaluated: 0,
    }),
  },
  imagegen: {
    // Default mock: imagegen is unavailable for the same reason —
    // most renderer tests run on the CPU-only mock platform and
    // shouldn't accidentally surface the Generate-image button.
    isAvailable: vi.fn().mockResolvedValue(false),
    generate: vi.fn().mockResolvedValue({
      path: "/mock/generated.png",
      // Mirrors the real IPC contract — the handler refuses to
      // ship a result whose path is outside
      // `<userData>/generated-images/`, so `assetUrl` is always
      // present on a successful generate. Tests that need to
      // assert on the URL value flip this with `vi.spyOn`.
      assetUrl: "tessera-asset://generated-images/mock/generated.png",
      seed: 0,
      width: 1024,
      height: 1024,
      durationMs: 0,
      sizeBytes: 0,
    }),
    cancel: vi.fn().mockResolvedValue({ scheduled: false }),
  },
  kchat: {
    isAvailable: vi.fn().mockResolvedValue(true),
    status: vi.fn().mockResolvedValue({ state: "disconnected" }),
    connect: vi.fn(),
    disconnect: vi.fn().mockResolvedValue({ disconnected: true }),
    listTeams: vi.fn().mockResolvedValue([]),
    listChannels: vi.fn().mockResolvedValue([]),
    listMembers: vi.fn().mockResolvedValue([]),
    listChannelFiles: vi.fn().mockResolvedValue([]),
    shareArtifact: vi.fn(),
    addChannelSource: vi
      .fn()
      .mockResolvedValue({ sourceId: "src-kchat-1", cacheDir: "/tmp/kchat" }),
    // historical-backfill IPC. Default
    // resolves with a clean "completed in zero pages" outcome so
    // components that touch the backfill surface (e.g. the
    // `KchatSettingsCard` action menu) render without standing
    // up the orchestrator + bridge stack. Tests that need to
    // exercise specific outcomes (skipped / aborted) override
    // this per-case.
    backfillChannel: vi.fn().mockResolvedValue({
      outcome: "completed",
      pagesWalked: 0,
      totalPostsIngested: 0,
      totalPostsUnchanged: 0,
      totalPostsSkippedRevoked: 0,
    }),
    // KChat post-body retrieval IPC.
    // Default returns an empty hit list so dialogs that fan out
    // a query into both `sources.search` and `kchat.searchPosts`
    // render the file results without an unexpected KChat row.
    // Tests that need to exercise the KChat branch override this
    // per-case (e.g. the citation panel + replace dialog
    // rendering tests in `citationPanelKchat.test.tsx`).
    searchPosts: vi.fn().mockResolvedValue([]),
    // thread-context retrieval. Default
    // returns an empty array so components that call this during
    // rendering (e.g. an auto-expand-thread affordance) don't
    // throw. Tests that exercise the expand-thread path override.
    fetchThreadContext: vi.fn().mockResolvedValue([]),
    // `.kcz`-extension localhost API surface.
    // Default snapshot says the server is running but the
    // extension has never checked in, so the Settings card +
    // sidebar render the "not detected" state. Tests exercising
    // the detected branch override this per-case.
    desktopBridgeStatus: vi.fn().mockResolvedValue({
      apiServerRunning: true,
      apiServerPort: 51234,
      portFilePath: "/tmp/test/tessera-kchat-port.json",
      lastExtensionContactAt: null,
    }),
    openInDesktop: vi
      .fn()
      .mockResolvedValue({ opened: true, url: "kchat://" }),
    openDesktopExtensions: vi
      .fn()
      .mockResolvedValue({ opened: true, url: "kchat://" }),
    // KChat channel backfill progress IPC.
    // Default returns the `idle` discriminator so the
    // SourceDetailPage's KChat backfill card renders the
    // pre-walk placeholder; tests that need to drive a specific
    // status (active / complete / error) override this
    // per-case. The 2000 ms poll cadence is fine for tests
    // because we use `waitFor` to observe at least one tick.
    backfillProgress: vi.fn().mockResolvedValue({
      channelId: "channel",
      oldestFetched: null,
      totalPosts: null,
      postsIngested: 0,
      status: "idle",
    }),
    // Block B Task 1: push-based subscriptions. Defaults return
    // a no-op unsubscribe so components that subscribe-on-mount
    // can render and unmount cleanly in tests without standing
    // up an actual IPC channel; tests that need to drive events
    // through the callback override these per-case (e.g. the
    // `KchatSidebarSection` pivot test in
    // `kchatSidebarSection.test.tsx`).
    onStatusChange: vi.fn().mockReturnValue(() => {}),
    onEvent: vi.fn().mockReturnValue(() => {}),
  },
  audit: {
    listRecent: vi.fn().mockResolvedValue([]),
    // default empty
    // archive list + rotate-as-noop. The Settings page's audit
    // archive section overrides these per-case.
    getArchives: vi.fn().mockResolvedValue([]),
    rotate: vi.fn().mockResolvedValue(null),
  },
  // LW-4: window-visibility signals. Defaults return a no-op
  // unsubscribe so components using `useSuspendablePolling` mount and
  // unmount cleanly without a real IPC channel; tests that need to
  // drive suspend/resume override these per-case.
  appLifecycle: {
    onSuspend: vi.fn().mockReturnValue(() => {}),
    onResume: vi.fn().mockReturnValue(() => {}),
  },
  // LW-12 resource-usage dashboard snapshot. Default is a lightweight,
  // fully-idle box (no models resident, on AC, indexing idle) so the
  // Settings → Performance card renders its populated state in tests;
  // cases that need a specific reading override per-case.
  resources: {
    getUsage: vi.fn().mockResolvedValue({
      resourceMode: "lightweight",
      memory: {
        rssBytes: 180 * 1024 * 1024,
        heapUsedBytes: 60 * 1024 * 1024,
        heapTotalBytes: 90 * 1024 * 1024,
        externalBytes: 8 * 1024 * 1024,
      },
      slm: {
        text: { running: false, endpoint: null },
        vision: { running: false, endpoint: null },
        imagegen: { state: "unloaded" },
      },
      connections: { writers: 1, readers: 2 },
      indexing: { deferredForMemory: false, pressure: null },
      battery: {
        hasBattery: false,
        isOnBattery: false,
        isCharging: true,
        percent: null,
        gating: false,
      },
    }),
  },
  // Knowledge substrate surface (Session 1). Defaults to an empty
  // memory plane + empty concept graph so substrate-consuming pages
  // (Home insights, Memory, Knowledge Graph) render their empty states
  // without errors; individual tests override these per case.
  substrate: {
    extractObservations: vi.fn().mockResolvedValue(0),
    getMemories: vi.fn().mockResolvedValue([]),
    pinMemory: vi.fn().mockResolvedValue(undefined),
    unpinMemory: vi.fn().mockResolvedValue(undefined),
    forgetMemory: vi.fn().mockResolvedValue(undefined),
    getConceptGraph: vi.fn().mockResolvedValue('{"nodes":[],"edges":[]}'),
    suggestRelatedSources: vi.fn().mockResolvedValue([]),
    runDecaySweep: vi
      .fn()
      .mockResolvedValue({ scored: 0, candidatesArchived: 0, supersededArchived: 0 }),
    triggerSynthesis: vi.fn().mockResolvedValue({
      windowId: "",
      scopeId: "",
      version: 0,
      recap: "",
      decisions: [],
      openQuestions: [],
      activeTasks: [],
    }),
  },
};

Object.defineProperty(window, "tessera", {
  value: mockApi,
  writable: true,
});

// preload exposes a per-session CSP nonce on
// `window.tesseraCspNonce`. Provide a deterministic test value so
// component-local `<style nonce={…}>` blocks render the attribute
// instead of crashing with "undefined" — and so tests that want to
// assert the nonce attribute on the rendered DOM have a known
// expected value to compare against.
// Reset the module-level shared `useSettings` store between tests so
// one test's mutations (pinned IDs, recent IDs, refresh state) do
// not leak into the next. The store is a singleton by design (see
// hooks/useSettings.ts header comment for the architectural
// rationale of the shared state) but that singleton-ness is exactly
// what bleeds across tests in a fresh-test-per-it suite. PR #87
// shared-store refactor companion.
beforeEach(() => {
  __resetSettingsStoreForTests();
});

Object.defineProperty(window, "tesseraCspNonce", {
  value: "test-csp-nonce",
  writable: true,
});
