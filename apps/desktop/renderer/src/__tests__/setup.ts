import "@testing-library/jest-dom/vitest";

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
  },
  artifacts: {
    create: vi.fn().mockResolvedValue({
      id: "art-1",
      title: "Test Artifact",
      artifactType: "document",
      templateId: null,
      content: "",
      citations: [],
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      version: 1,
    }),
    update: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    get: vi.fn(),
    remove: vi.fn(),
    exportArtifact: vi.fn(),
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
  },
};

Object.defineProperty(window, "tessera", {
  value: mockApi,
  writable: true,
});
