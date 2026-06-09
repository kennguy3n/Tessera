// Showcase mock bridge (DEV ONLY).
//
// Installs a fake `window.tessera` populated with one persona's genuine
// LLM-generated artifacts so the live renderer can be screenshotted with real
// content (editors, sources, citations) instead of empty chrome.
//
// Activate by appending `?showcase=<persona>` to the dev URL, e.g.
//   http://localhost:5173/?showcase=healthcare#/create
// Guarded by `import.meta.env.DEV` in the entry point — never ships to prod.
//
// DESIGN-MODEL INVARIANT: the artifacts injected here are generated ONLY by a
// Tessera design text model (the Ternary-Bonsai family in sidecars/models.json)
// running on Tessera's own PrismML llama.cpp runtime — see
// scripts/showcase/generate.py, which hard-fails on any off-design model id.
// The `installedModel` / runtime identity below MUST therefore name a real
// Tessera model. Do NOT substitute an external/stand-in model (e.g. a generic
// Llama/Qwen Instruct build) here or in the generator without adding it to the
// product model registry first.

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
  return ds.artifacts.map((a) => ({
    id: artifactId(ds.id, a.slug),
    title: a.title,
    artifactType: a.type,
    templateId: a.templateId,
    content: a.content,
    citationCount: a.citationCount,
    createdAt: NOW,
    updatedAt: NOW,
    // Each artifact is an independent entity at its first revision.
    version: 1,
  }));
}

function buildSources(ds: ShowcaseDataset) {
  // Group the persona's input files under a single indexed local folder so the
  // Sources view shows a realistic, ready-to-query source for the demo.
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
  // Deliberate fallback: when an artifact reports `count` of 0 (e.g. a sheet or
  // base where citations aren't surfaced per-cell), show citations for every
  // source file so the provenance panel is never empty in the demo capture.
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

// Mirrors the `ternary-bonsai-4b-gguf` entry in sidecars/models.json (Tessera's
// design text model). This is the model that actually generated the artifacts
// above, via the PrismML llama.cpp runtime.
const installedModel = {
  modelId: "ternary-bonsai-4b-gguf",
  capability: "text" as const,
  format: "gguf" as const,
  filename: "ternary-bonsai-4b-q1_0_g128.gguf",
  path: "/models/ternary-bonsai-4b-q1_0_g128.gguf",
  downloadSizeMb: 1000,
  diskSizeMb: 1000,
  sha256: null,
  downloadedAt: NOW,
};
const MODEL_NAME = "Ternary-Bonsai 4B";

const settingsData = (artifacts: ReturnType<typeof buildArtifacts>) => ({
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
  let settings = settingsData(artifacts);

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
      // any-non-apple-silicon host so the GGUF (Q1_0_g128) build is the
      // platform-correct design model (Apple Silicon would use the MLX build).
      detectPlatform: async () => ({ os: "linux", arch: "x64", tier: "medium" }),
      getCurrentModel: async () => installedModel,
      getInstalledModels: async () => ({ text: installedModel }),
      recommendModel: async () => ({ id: installedModel.modelId, name: MODEL_NAME }),
      listModels: async () => [{ id: installedModel.modelId, name: MODEL_NAME }],
      isCapabilityAvailable: async () => true,
      onDownloadProgress: () => () => {},
    },
    model: {
      status: async () => ({ available: true, modelName: MODEL_NAME, status: "ready" }),
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
        get(_t, method: string | symbol) {
          // The Proxy protocol passes string | symbol; DevTools inspects
          // Symbol.toStringTag etc., so guard before calling string methods.
          if (typeof method === "symbol") return undefined;
          // Keep namespaces non-thenable: returning a function for `then`
          // would make `await api.<namespace>` silently resolve to undefined.
          if (method === "then") return undefined;
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
      get(_t, namespace: string | symbol) {
        if (typeof namespace === "symbol") return undefined;
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
