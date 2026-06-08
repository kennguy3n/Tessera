// Showcase mock bridge (DEV ONLY).
//
// Installs a fake `window.tessera` populated with one persona's genuine
// LLM-generated artifacts so the live renderer can be screenshotted with real
// content (editors, sources, citations) instead of empty chrome.
//
// Activate by appending `?showcase=<persona>` to the dev URL, e.g.
//   http://localhost:5173/?showcase=healthcare#/create
// Guarded by `import.meta.env.DEV` in the entry point — never ships to prod.

import type { ShowcaseDataset } from "./types";
import { healthcareDataset } from "./generated/healthcare";
import { legalDataset } from "./generated/legal";
import { financeDataset } from "./generated/finance";
import { nonprofitDataset } from "./generated/nonprofit";
import { retailDataset } from "./generated/retail";

const DATASETS: Record<string, ShowcaseDataset> = {
  healthcare: healthcareDataset,
  legal: legalDataset,
  finance: financeDataset,
  nonprofit: nonprofitDataset,
  retail: retailDataset,
};

export function showcasePersonaFromQuery(): string | null {
  try {
    const params = new URLSearchParams(window.location.search);
    const persona = params.get("showcase");
    return persona && DATASETS[persona] ? persona : null;
  } catch {
    return null;
  }
}

const NOW = "2026-05-12T15:04:00.000Z";

function artifactId(personaId: string, slug: string): string {
  return `sc-${personaId}-${slug}`;
}

function buildArtifacts(ds: ShowcaseDataset) {
  return ds.artifacts.map((a, i) => ({
    id: artifactId(ds.id, a.slug),
    title: a.title,
    artifactType: a.type,
    templateId: a.templateId,
    content: a.content,
    citationCount: a.citationCount,
    createdAt: NOW,
    updatedAt: NOW,
    version: 1 + i,
  }));
}

function buildSources(ds: ShowcaseDataset) {
  // Group the persona's input files under a single indexed local folder, plus
  // a couple of representative connected sources so the Sources view looks real.
  const folderPath = `~/Documents/${ds.persona.org.replace(/[^A-Za-z0-9]+/g, "-")}`;
  return [
    {
      id: `sc-${ds.id}-src-local`,
      sourceType: "local_folder",
      path: folderPath,
      status: "ready",
      createdAt: NOW,
      lastIndexed: NOW,
      fileCount: ds.sourceFiles.length,
    },
  ];
}

function buildCitations(ds: ShowcaseDataset, artifactType: string, count: number) {
  const files = ds.sourceFiles.slice(0, Math.max(count, 0) || ds.sourceFiles.length);
  return files.map((f, i) => ({
    citationId: `sc-${ds.id}-cite-${i}`,
    sourceId: `sc-${ds.id}-src-local`,
    sourceType: "local_folder",
    sourceTitle: f,
    sourceUri: `file://${f}`,
    chunkHash: `hash-${i}`,
    page: null,
    confidence: 0.9 - i * 0.05,
    usedFor: artifactType,
    createdAt: NOW,
  }));
}

const installedModel = {
  modelId: "llama-3.2-3b-instruct",
  capability: "text" as const,
  format: "gguf" as const,
  filename: "llama-3.2-3b-instruct-q4_k_m.gguf",
  path: "/models/llama-3.2-3b-instruct-q4_k_m.gguf",
  downloadSizeMb: 1920,
  diskSizeMb: 1920,
  sha256: null,
  downloadedAt: NOW,
};

const settingsData = (ds: ShowcaseDataset, artifacts: ReturnType<typeof buildArtifacts>) => ({
  theme: "light",
  defaultExportFormat: "markdown",
  ignorePatterns: [".git", "node_modules"],
  watchPatterns: ["**/*.md"],
  onboardingCompleted: true,
  pinnedArtifactIds: artifacts.slice(0, 1).map((a) => a.id),
  recentArtifactIds: artifacts.map((a) => a.id),
  simplifiedNav: true,
  autoDownloadModel: true,
  createPageMode: "wizard",
});

/**
 * Build a `window.tessera`-shaped object for one persona. Methods exercised by
 * the showcase routes are implemented with real data; everything else falls
 * through a Proxy: `on*` subscription methods return a no-op unsubscribe, all
 * other unknown methods resolve to `undefined`.
 */
export function buildShowcaseApi(personaId: string): unknown {
  const ds = DATASETS[personaId];
  if (!ds) throw new Error(`Unknown showcase persona: ${personaId}`);

  const artifacts = buildArtifacts(ds);
  const sources = buildSources(ds);
  let settings = settingsData(ds, artifacts);

  const byId = new Map(artifacts.map((a) => [a.id, a]));

  const real: Record<string, Record<string, unknown>> = {
    settings: {
      get: async () => ({ ...settings }),
      update: async (patch: Record<string, unknown>) => {
        settings = { ...settings, ...patch };
        return { ...settings };
      },
      getHybridSearchConfig: async () => ({
        bm25Weight: 1, vectorWeight: 1, rrfK: 60, recencyDecayEnabled: true,
        recencyHalflifeSecs: 2592000, candidatePoolSize: 0,
      }),
    },
    sources: {
      listSources: async () => sources,
      searchSources: async () => [],
      getDetail: async (id: string) => ({
        source: sources.find((s) => s.id === id) ?? sources[0],
        files: ds.sourceFiles.map((f) => ({
          path: f, hash: f, lastModified: NOW, chunkCount: 6,
        })),
      }),
      getIndexingProgress: async () => null,
      healthReport: async () => ({ issues: [] }),
    },
    artifacts: {
      list: async () => artifacts,
      get: async (id: string) => byId.get(id) ?? artifacts[0],
      update: async (id: string, content: string) => {
        const a = byId.get(id);
        if (a) a.content = content;
        return a ?? artifacts[0];
      },
      listVersions: async () => [],
    },
    templates: {
      list: async () =>
        ds.artifacts.map((a) => ({
          id: a.templateId ?? a.slug,
          name: a.templateName,
          artifactType: a.type,
          description: `${a.templateName} grounded in ${ds.persona.org} sources`,
          sectionCount: 8,
          exportFormats: ["markdown", "pdf", "docx"],
        })),
      get: async (id: string) => {
        const a = ds.artifacts.find((x) => (x.templateId ?? x.slug) === id);
        return a
          ? {
              id, name: a.templateName, artifactType: a.type,
              description: a.templateName, sectionCount: 8,
              exportFormats: ["markdown", "pdf", "docx"],
            }
          : null;
      },
    },
    citations: {
      list: async (artifactId: string) => {
        const a = byId.get(artifactId);
        return a ? buildCitations(ds, a.artifactType, a.citationCount) : [];
      },
    },
    runtime: {
      detectPlatform: async () => ({ os: "macos", arch: "arm64", tier: "high" }),
      getCurrentModel: async () => installedModel,
      getInstalledModels: async () => ({ text: installedModel }),
      recommendModel: async () => ({ id: installedModel.modelId, name: "Llama 3.2 3B Instruct" }),
      listModels: async () => [{ id: installedModel.modelId, name: "Llama 3.2 3B Instruct" }],
      isCapabilityAvailable: async () => true,
      onDownloadProgress: () => () => {},
    },
    model: {
      status: async () => ({ available: true, modelName: "Llama 3.2 3B Instruct", status: "ready" }),
      onToken: () => () => {},
    },
    // Cloud connectors (Google Drive, etc.) report a clean disconnected state
    // so the Sources page renders its empty/connect affordances rather than
    // crashing on an undefined status.
    connectors: {
      status: async () => ({ provider: "google_drive", connected: false, status: "disconnected" }),
      list: async () => [],
      listDriveFiles: async () => [],
      getAllRedirectUris: async () => [],
      authenticate: async () => ({ connected: false, status: "disconnected" }),
      disconnect: async () => ({ connected: false, status: "disconnected" }),
      selectItems: async () => ({ ok: true }),
      sync: async () => ({ ok: true }),
      syncDrive: async () => ({ ok: true }),
    },
    // KChat is an enterprise messaging connector unrelated to the demo; report
    // it unavailable so the sidebar section renders nothing instead of polling.
    kchat: {
      isAvailable: async () => false,
      status: async () => ({ state: "disconnected" }),
      onStatusChange: () => () => {},
      onEvent: () => () => {},
      listTeams: async () => [],
      listChannels: async () => [],
    },
  };

  const passthrough = (namespace: string) =>
    new Proxy(
      {},
      {
        get(_t, method: string) {
          const impl = real[namespace]?.[method];
          if (impl) return impl;
          if (method.startsWith("on")) return () => () => {};
          return async () => undefined;
        },
      },
    );

  return new Proxy(
    {},
    {
      get(_t, namespace: string) {
        return passthrough(namespace);
      },
    },
  );
}

export function installShowcaseBridge(personaId: string): void {
  (window as unknown as { tessera: unknown }).tessera = buildShowcaseApi(personaId);
  (window as unknown as { tesseraCspNonce: string }).tesseraCspNonce = "showcase";
  console.info(`[showcase] mock bridge installed for persona "${personaId}"`);
}
