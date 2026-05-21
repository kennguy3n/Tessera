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
      id: "art-compare",
      title: "Compare",
      artifactType: "document",
      templateId: null,
      content: "",
      citationCount: 0,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
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
      description: "",
      trigger: { kind: "schedule", interval_seconds: 3600 },
      action: { kind: "reindex_source", source_id: "src-1" },
      enabled: true,
      lastRun: null,
      lastResult: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
    }),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn().mockResolvedValue(null),
    setEnabled: vi.fn().mockResolvedValue(undefined),
    remove: vi.fn().mockResolvedValue(true),
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
};

Object.defineProperty(window, "tessera", {
  value: mockApi,
  writable: true,
});
