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

const NOW_SECS = Math.floor(Date.parse(NOW) / 1000);

/**
 * Build a DEV-only knowledge-substrate dataset (memory plane + concept
 * graph) for one persona so the Memory page, Knowledge Graph panel and
 * Home insights card render with real, persona-grounded content in
 * screenshots instead of empty states. This mirrors the real bridge
 * shapes: `getMemories` → `SubstrateMemoryInfo[]`, `getConceptGraph` →
 * a JSON *string* with the exact field casing the production serializer
 * emits (PascalCase `state`, snake_case `relation_type`/`truncation`).
 */
function buildSubstrate(ds: ShowcaseDataset) {
  const scopeId = `sc-${ds.id}-scope`;
  const sourceId = `sc-${ds.id}-src-local`;
  const org = ds.persona.org;
  const market = ds.persona.market;
  const role = ds.persona.role;
  // Derive a few concept surface terms from the indexed source filenames
  // (drop extensions, humanize) so the graph reflects the persona's data.
  const docTerms = ds.sourceFiles
    .slice(0, 3)
    .map((f) =>
      f
        .replace(/^.*\//, "")
        .replace(/\.[A-Za-z0-9]+$/, "")
        .replace(/[_-]+/g, " ")
        .trim(),
    )
    .filter((t) => t.length > 0);

  const mem = (
    slug: string,
    observationType: string,
    content: string,
    state: string,
    retentionScore: number,
    signal: { pin?: number; retrieval?: number; corroboration?: number } = {},
  ): {
    id: string;
    scopeId: string;
    observationType: string;
    content: string;
    state: string;
    retentionScore: number;
    pinCount: number;
    retrievalCount: number;
    corroborationCount: number;
    createdAt: number;
    lastAccessedAt: number;
    sourceId: string | null;
  } => ({
    id: `sc-${ds.id}-mem-${slug}`,
    scopeId,
    observationType,
    content,
    state,
    retentionScore,
    pinCount: signal.pin ?? 0,
    retrievalCount: signal.retrieval ?? 0,
    corroborationCount: signal.corroboration ?? 1,
    createdAt: NOW_SECS - 86_400 * 9,
    lastAccessedAt: NOW_SECS - 3_600,
    sourceId,
  });

  const memories = [
    mem("org", "entity", `${org} is the organization at the center of this workspace.`, "canonical", 0.97, { pin: 1, retrieval: 14, corroboration: 5 }),
    mem("market", "entity", `${org} operates in the ${market} market.`, "consolidated", 0.88, { retrieval: 9, corroboration: 4 }),
    mem("role", "entity", `The primary author is a ${role}.`, "reinforced", 0.72, { retrieval: 5, corroboration: 2 }),
    mem("fact-1", "fact", docTerms[0] ? `Key figures are sourced from "${docTerms[0]}".` : `Key figures are grounded in indexed sources.`, "canonical", 0.91, { pin: 1, retrieval: 11, corroboration: 3 }),
    mem("fact-2", "fact", docTerms[1] ? `Operational context is drawn from "${docTerms[1]}".` : `Operational context is drawn from indexed sources.`, "reinforced", 0.64, { retrieval: 4, corroboration: 2 }),
    mem("decision-1", "decision", `Decided to standardize reporting on the ${org} template set.`, "consolidated", 0.83, { retrieval: 7, corroboration: 3 }),
    mem("task-1", "task", `Review the latest ${market} figures before the next artifact generation.`, "candidate", 0.41, { retrieval: 1, corroboration: 1 }),
    mem("fact-old", "fact", `Earlier ${market} estimate, replaced by a newer corroborated figure.`, "superseded", 0.28, { retrieval: 2, corroboration: 1 }),
    mem("task-done", "task", `Initial source import for ${org} completed.`, "archived", 0.12, { retrieval: 1, corroboration: 1 }),
  ];

  // Concept graph: org hub linked to market/role + derived document concepts.
  // `state` here MUST be a concept-graph `NodeState` (PascalCase of
  // `candidate | canonical | superseded | contradicted | deleted`) — NOT a
  // memory decay state. `parseConceptGraph` normalizes anything else to
  // `unknown` and renders it with the neutral grey fallback, which would
  // defeat the showcase. (Devin Review PR #120.)
  const nodeDefs: { id: string; label: string; state: string }[] = [
    { id: "n-org", label: org, state: "Canonical" },
    { id: "n-market", label: market, state: "Canonical" },
    { id: "n-role", label: role, state: "Canonical" },
    ...docTerms.map((t, i) => ({
      id: `n-doc-${i}`,
      label: t,
      state: i === 0 ? "Canonical" : "Candidate",
    })),
    { id: "n-old", label: `Prior ${market} estimate`, state: "Superseded" },
  ];
  const edgeDefs: { from: string; to: string; relation_type: string }[] = [
    { from: "n-org", to: "n-market", relation_type: "part_of" },
    { from: "n-role", to: "n-org", relation_type: "assigned_to" },
    ...docTerms.map((_t, i) => ({
      from: `n-doc-${i}`,
      to: "n-org",
      relation_type: i === 2 ? "decided_by" : "derived_from",
    })),
    { from: "n-market", to: "n-old", relation_type: "supersedes" },
  ];
  const connections = new Map<string, number>();
  for (const e of edgeDefs) {
    connections.set(e.from, (connections.get(e.from) ?? 0) + 1);
    connections.set(e.to, (connections.get(e.to) ?? 0) + 1);
  }
  const conceptGraphJson = JSON.stringify({
    nodes: nodeDefs.map((n) => ({
      id: n.id,
      label: n.label,
      state: n.state,
      scope_id: scopeId,
      connections_count: connections.get(n.id) ?? 0,
    })),
    edges: edgeDefs.map((e, i) => ({
      id: `e-${i}`,
      from: e.from,
      to: e.to,
      relation_type: e.relation_type,
      scope_id: scopeId,
    })),
    scope_filter: [],
    truncation: "complete",
  });

  return { memories, conceptGraphJson };
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
  closeToTray: false,
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

  // Knowledge-substrate (Session 1) showcase data. `memoryById` is mutable so
  // pin/unpin/forget behave like the real bridge during screenshot capture.
  const { memories: substrateMemories, conceptGraphJson } = buildSubstrate(ds);
  const memoryById = new Map(substrateMemories.map((m) => [m.id, { ...m }]));

  const real: Record<string, Record<string, unknown>> = {
    // Bridge lifecycle: report `ready` so `useBridgeReady` mounts the real
    // app shell instead of hanging on the boot skeleton (the showcase bridge
    // is fully synchronous/in-memory, so it is ready immediately).
    lifecycle: {
      getBridgeState: async () => ({ state: "ready", error: null }),
      onBridgeState: () => () => {},
    },
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
    // Knowledge substrate (Session 1). Memory plane + concept graph wired with
    // persona-grounded data so the Memory page, Knowledge Graph panel and Home
    // insights card render real content. pin/unpin/forget mutate in place.
    substrate: {
      extractObservations: async () => 0,
      getMemories: async (scope?: string | null) => {
        const all = [...memoryById.values()];
        return scope ? all.filter((m) => m.scopeId === scope) : all;
      },
      pinMemory: async (id: string) => {
        const m = memoryById.get(id);
        if (!m) throw new Error(`Unknown memory: ${id}`);
        m.pinCount += 1;
        m.retentionScore = Math.min(1, m.retentionScore + 0.05);
        return { ...m };
      },
      unpinMemory: async (id: string) => {
        const m = memoryById.get(id);
        if (!m) throw new Error(`Unknown memory: ${id}`);
        m.pinCount = Math.max(0, m.pinCount - 1);
        return { ...m };
      },
      forgetMemory: async (id: string) => {
        memoryById.delete(id);
      },
      getConceptGraph: async () => conceptGraphJson,
      runDecaySweep: async () => ({
        scored: memoryById.size,
        candidatesArchived: 0,
        supersededArchived: 0,
      }),
      triggerSynthesis: async () => ({ memoriesCreated: 0, conceptsLinked: 0 }),
    },
    runtime: {
      // Report the REAL PlatformInfo shape (RuntimeStatus / ModelRuntimeCard
      // read computeBackends, totalRamGb, preferredFormat, *Label fields). A
      // non-Apple-Silicon host keeps the GGUF (Q1_0_g128) build platform-correct
      // (Apple Silicon would prefer MLX), and the medium tier is the one that
      // recommends the 4B design model the showcase advertises.
      detectPlatform: async () => ({
        platform: "linux-x64",
        platformLabel: "Linux x64",
        totalRamGb: 6,
        tier: "medium",
        tierLabel: "Medium (4-6 GB RAM)",
        computeBackends: ["cpu"],
        preferredFormat: "gguf",
      }),
      getCurrentModel: async () => installedModel,
      // Real bridge returns Record<ModelCapability, InstalledModelRecord|null>
      // with all three slots present; the showcase is text-only, so vision /
      // imagegen are explicitly null (uninstalled) rather than absent — matches
      // the real shape if any consumer enumerates capabilities via Object.keys.
      getInstalledModels: async () => ({
        text: installedModel,
        vision: null,
        imagegen: null,
      }),
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

  const makePassthrough = (namespace: string) =>
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

  // Cache one Proxy per namespace so repeated `window.tessera.<ns>` reads
  // return a STABLE object identity. Components routinely capture a namespace
  // into a `useEffect`/`useMemo` dependency (e.g. `KchatSidebarSection` deps on
  // `window.tessera.kchat`); minting a fresh Proxy on every access would change
  // that identity every render and spin those effects into an infinite update
  // loop. The real preload bridge exposes stable namespace objects, so this
  // matches production semantics.
  const namespaceCache = new Map<string, unknown>();

  return new Proxy(
    {},
    {
      get(_t, namespace: string | symbol) {
        if (typeof namespace === "symbol") return undefined;
        let ns = namespaceCache.get(namespace);
        if (!ns) {
          ns = makePassthrough(namespace);
          namespaceCache.set(namespace, ns);
        }
        return ns;
      },
    },
  );
}

export function installShowcaseBridge(personaId: string): void {
  (window as unknown as { tessera: unknown }).tessera = buildShowcaseApi(personaId);
  (window as unknown as { tesseraCspNonce: string }).tesseraCspNonce = "showcase";
  console.info(`[showcase] mock bridge installed for persona "${personaId}"`);
}
