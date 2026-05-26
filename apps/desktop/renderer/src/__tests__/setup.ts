import "@testing-library/jest-dom/vitest";

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
    }),
    update: vi.fn().mockResolvedValue({
      theme: "light",
      defaultExportFormat: "markdown",
      ignorePatterns: [".git", "node_modules"],
      watchPatterns: ["**/*.md"],
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
  },
};

Object.defineProperty(window, "tessera", {
  value: mockApi,
  writable: true,
});
