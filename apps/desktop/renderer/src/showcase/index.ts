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

import type { ShowcaseDataset, ShowcaseKnowledgePlane } from "./types";
import { healthcareDataset } from "./generated/healthcare";
import { legalDataset } from "./generated/legal";
import { financeDataset } from "./generated/finance";
import { nonprofitDataset } from "./generated/nonprofit";
import { retailDataset } from "./generated/retail";
import { healthcareKnowledge } from "./generated/healthcare.knowledge";
import { legalKnowledge } from "./generated/legal.knowledge";
import { financeKnowledge } from "./generated/finance.knowledge";
import { nonprofitKnowledge } from "./generated/nonprofit.knowledge";
import { retailKnowledge } from "./generated/retail.knowledge";

const DATASETS: Record<string, ShowcaseDataset> = {
  healthcare: healthcareDataset,
  legal: legalDataset,
  finance: financeDataset,
  nonprofit: nonprofitDataset,
  retail: retailDataset,
};

// Additive knowledge planes (entities / facts / concepts) derived from the
// SAME genuine artifacts via scripts/showcase/derive_knowledge.py. Feed the
// enriched "Knowledge" tab, hybrid search, and concept-graph suggestions.
const KNOWLEDGE: Record<string, ShowcaseKnowledgePlane> = {
  healthcare: healthcareKnowledge,
  legal: legalKnowledge,
  finance: financeKnowledge,
  nonprofit: nonprofitKnowledge,
  retail: retailKnowledge,
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

// Map a derived source id (`sc-<persona>-src-NN`) back to its input filename
// and a plausible on-disk path so search hits carry real provenance.
function sourcePathFor(ds: ShowcaseDataset, sourceId: string): string {
  const folderPath = `~/Documents/${ds.persona.org.replace(/[^A-Za-z0-9]+/g, "-")}`;
  const num = sourceId.split("-").pop();
  const file = ds.sourceFiles.find((f) => f.split("-", 1)[0] === num) ?? ds.sourceFiles[0];
  return `${folderPath}/${file}`;
}

function tokenize(query: string): string[] {
  return query
    .toLowerCase()
    .split(/[^a-z0-9§]+/)
    .filter((t) => t.length >= 2);
}

function textMatches(text: string, tokens: string[]): boolean {
  if (tokens.length === 0) return true;
  const lc = text.toLowerCase();
  return tokens.some((t) => lc.includes(t));
}

// Hybrid-search hits over the persona's facts (each genuine observation is a
// retrievable chunk). When the query is empty we surface the strongest facts so
// the demo search box is never blank; otherwise we rank by token overlap and
// fall back to retention so retention-weighting (the substrate's 4th RRF
// signal) is visible.
function buildSearchHits(ds: ShowcaseDataset, plane: ShowcaseKnowledgePlane, query: string, limit: number) {
  const tokens = tokenize(query);
  const scored = plane.facts
    .map((f) => {
      const overlap = tokens.filter((t) => f.content.toLowerCase().includes(t)).length;
      const relevance = tokens.length === 0 ? f.retentionScore : overlap + f.retentionScore;
      return { f, overlap, relevance };
    })
    .filter((s) => tokens.length === 0 || s.overlap > 0)
    .sort((a, b) => b.relevance - a.relevance)
    .slice(0, limit);
  return scored.map(({ f, relevance }, i) => ({
    sourcePath: sourcePathFor(ds, f.sourceId ?? `sc-${ds.id}-src-local`),
    sourceId: f.sourceId ?? `sc-${ds.id}-src-local`,
    chunkHash: f.id,
    chunkContent: f.content,
    // Normalise into a 0..1 search-relevance band, highest first.
    relevanceScore: Number((0.94 - i * 0.04 + (relevance > 1 ? 0.02 : 0)).toFixed(3)),
    excerpt: f.content,
  }));
}

// Filter a knowledge plane by a query, mirroring `sources:searchEnriched`.
function buildEnriched(ds: ShowcaseDataset, plane: ShowcaseKnowledgePlane, query: string, limit: number) {
  const tokens = tokenize(query);
  const entities = plane.entities.filter((e) => textMatches(e.content, tokens));
  const facts = plane.facts.filter((f) => textMatches(f.content, tokens));
  const concepts = plane.concepts.filter(
    (c) => textMatches(c.label, tokens) || textMatches(c.definition, tokens),
  );
  // `memories` is the full ranked match set (entities + facts) by retention.
  const memories = [...entities, ...facts].sort((a, b) => b.retentionScore - a.retentionScore);
  return {
    hits: buildSearchHits(ds, plane, query, limit),
    entities,
    facts,
    concepts,
    memories,
  };
}

interface CgEdge {
  id: string;
  from: string;
  to: string;
  relation_type: string;
  scope_id: string;
}

// Edges derived purely from real co-occurrence — two concepts that cite at
// least one source in common are linked. When one concept's sources are a
// strict subset of the other's it is the narrower term, so the edge is typed
// `part_of` (pointing narrow → broad); otherwise the concepts merely co-occur
// and the edge is left untyped (`unknown`, rendered as "related to"). Used when
// a persona's plane carries no explicit `relations` — no semantic relation is
// invented beyond what the shared-source structure supports.
function coOccurrenceEdges(
  concepts: ShowcaseKnowledgePlane["concepts"],
  scopeId: string,
): CgEdge[] {
  const edges: CgEdge[] = [];
  for (let i = 0; i < concepts.length; i++) {
    for (let j = i + 1; j < concepts.length; j++) {
      const a = concepts[i];
      const b = concepts[j];
      const aSet = new Set(a.relatedSourceIds);
      const bSet = new Set(b.relatedSourceIds);
      const shares = b.relatedSourceIds.some((s) => aSet.has(s));
      if (!shares) continue;
      const aSubsetB =
        a.relatedSourceIds.length > 0 &&
        a.relatedSourceIds.every((s) => bSet.has(s));
      const bSubsetA =
        b.relatedSourceIds.length > 0 &&
        b.relatedSourceIds.every((s) => aSet.has(s));
      let from = a.id;
      let to = b.id;
      let relation = "unknown";
      if (aSubsetB && !bSubsetA) {
        relation = "part_of";
      } else if (bSubsetA && !aSubsetB) {
        from = b.id;
        to = a.id;
        relation = "part_of";
      }
      edges.push({
        id: `sc-cg-edge-${edges.length}`,
        from,
        to,
        relation_type: relation,
        scope_id: scopeId,
      });
    }
  }
  return edges;
}

// Serialize the persona's concept graph into the same JSON wire shape the
// native bridge emits (`concept_graph::GraphView`, parsed by
// `utils/conceptGraph.ts`): `{ nodes, edges, scope_filter, depth, truncation }`.
// Nodes are the genuine extracted concepts. Edges come from the plane's
// `relations` when present — the deterministically-derived `is_a` / `part_of` /
// `supersedes` / `contradicts` typing the substrate exposes (see
// `scripts/showcase/derive_knowledge.py`) — and otherwise fall back to the
// co-occurrence derivation above.
function buildConceptGraphJson(
  plane: ShowcaseKnowledgePlane,
  maxNodes: number | null = null,
): string {
  const scopeId =
    plane.entities[0]?.scopeId ?? plane.facts[0]?.scopeId ?? "sc-showcase-scope";
  const allConcepts = plane.concepts;

  // Build the full typed edge set FIRST — explicit `relations` when present
  // (the `is_a` / `part_of` / `supersedes` / `contradicts` typing), otherwise
  // the co-occurrence fallback — so connectivity is measured against the whole
  // graph rather than an arbitrary prefix of the concept array.
  const relations = plane.relations ?? [];
  const fullEdges: CgEdge[] =
    relations.length > 0
      ? relations.map((r, i) => ({
          id: `sc-cg-edge-${i}`,
          from: r.from,
          to: r.to,
          relation_type: r.type,
          scope_id: scopeId,
        }))
      : coOccurrenceEdges(allConcepts, scopeId);

  const degree = new Map<string, number>();
  for (const e of fullEdges) {
    degree.set(e.from, (degree.get(e.from) ?? 0) + 1);
    degree.set(e.to, (degree.get(e.to) ?? 0) + 1);
  }

  // Apply the node cap by keeping the MOST-CONNECTED concepts (the hub and its
  // neighbors) instead of array order, mirroring the substrate's node-limit
  // behavior: a truncated graph should still be a coherent subgraph, not lose
  // its enrichment-added category/claim nodes (which happen to be appended
  // last) before the densely-linked spine. Deterministic: degree descending,
  // ties broken by original index; the kept set is then restored to original
  // order so the serialized output is stable.
  const cap =
    typeof maxNodes === "number" && maxNodes > 0 ? maxNodes : allConcepts.length;
  const truncated = cap < allConcepts.length;
  const concepts = truncated
    ? allConcepts
        .map((c, i) => ({ c, i }))
        .sort(
          (a, b) =>
            (degree.get(b.c.id) ?? 0) - (degree.get(a.c.id) ?? 0) || a.i - b.i,
        )
        .slice(0, cap)
        .sort((a, b) => a.i - b.i)
        .map((x) => x.c)
    : allConcepts;
  const included = new Set(concepts.map((c) => c.id));

  // Only edges whose endpoints both survive the node cap are kept; node sizing
  // (`connections_count`) counts exactly those visible edges.
  const edges = fullEdges.filter(
    (e) => included.has(e.from) && included.has(e.to),
  );
  const incident = new Map<string, number>();
  for (const e of edges) {
    incident.set(e.from, (incident.get(e.from) ?? 0) + 1);
    incident.set(e.to, (incident.get(e.to) ?? 0) + 1);
  }

  const nodes = concepts.map((c) => ({
    id: c.id,
    label: c.label,
    state: c.state,
    scope_id: scopeId,
    connections_count: incident.get(c.id) ?? 0,
  }));

  return JSON.stringify({
    nodes,
    edges,
    scope_filter: [],
    depth: 2,
    truncation: truncated ? "node_limit_reached" : "complete",
  });
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
  closeToTray: false,
  modelIdleTimeoutSecs: 60,
  resourceMode: "lightweight",
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
  const plane = KNOWLEDGE[personaId] ?? { entities: [], facts: [], concepts: [] };
  let settings = settingsData(artifacts);

  // Mutable backup state so Settings → Backup is fully interactive in the demo
  // (configure persists, "Back up now" prepends a new entry).
  const backupDir = `~/.config/Tessera/backups`;
  let backupStatus = {
    autoBackup: true,
    backupDir,
    backupIntervalHours: 24,
    backupRetentionCount: 7,
    schedulerRunning: true,
    backupInFlight: false,
    lastBackupAt: Date.parse(NOW) - 6 * 3600 * 1000,
    lastBackupError: null as string | null,
  };
  const backups = [0, 1, 2].map((i) => ({
    path: `${backupDir}/tessera-2026-05-${String(12 - i).padStart(2, "0")}.sqlite3`,
    fileName: `tessera-2026-05-${String(12 - i).padStart(2, "0")}.sqlite3`,
    createdAtMs: Date.parse(NOW) - i * 24 * 3600 * 1000,
    sizeBytes: 4_600_000 - i * 120_000,
  }));

  const byId = new Map(artifacts.map((a) => [a.id, a]));

  // Mutable memory plane so the Memory page's pin / unpin / forget controls are
  // interactive in the demo (the row updates/disappears and a refresh reads the
  // mutated list back). Entities + facts are already `SubstrateMemoryInfo`-shaped.
  const memories = [...plane.entities, ...plane.facts].map((m) => ({ ...m }));
  const findMemory = (id: string) => memories.find((m) => m.id === id);

  const real: Record<string, Record<string, unknown>> = {
    // Bridge-readiness surface. The real app gates `<App/>` behind
    // `lifecycle.getBridgeState()` resolving to `ready`; the showcase has no
    // native store to open, so report `ready` immediately. Without this the
    // Proxy fallback resolves the snapshot read to `undefined`, which
    // `useBridgeReady` would store and then dereference (`.state`), crashing
    // the shell before any persona content renders.
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
      updateHybridSearchConfig: async (patch: Record<string, unknown>) => ({
        bm25Weight: 1, vectorWeight: 1, rrfK: 60, recencyDecayEnabled: true,
        recencyHalflifeSecs: 2592000, candidatePoolSize: 0, ...patch,
      }),
      getEmbeddingModelStatus: async () => ({
        currentModelId: "onnx:all-MiniLM-L6-v2:384d",
        models: [
          {
            slug: "all-MiniLM-L6-v2", displayName: "Semantic — English (MiniLM)",
            dim: 384, modelSizeBytes: 23_068_672, tokenizerSizeBytes: 466_944,
            languages: "English", installed: true, modelId: "onnx:all-MiniLM-L6-v2:384d",
          },
          {
            slug: "paraphrase-multilingual-MiniLM-L12-v2",
            displayName: "Semantic — Multilingual (XLM-R)",
            dim: 384, modelSizeBytes: 125_829_120, tokenizerSizeBytes: 5_242_880,
            languages: "50+ languages", installed: false,
            modelId: "onnx:paraphrase-multilingual-MiniLM-L12-v2:384d",
          },
        ],
        download: {
          status: "idle" as const, slug: null, bytesTotal: null,
          bytesDownloaded: 0, lastError: null,
        },
        nonAsciiChunks: 0,
        totalChunks: ds.sourceFiles.length * 6,
      }),
      getEmbeddingDownloadProgress: async () => null,
      downloadEmbeddingModel: async () => ({ ok: true }),
      switchEmbeddingModel: async () => ({ ok: true }),
    },
    sources: {
      listSources: async () => sources,
      // Hybrid search (BM25 + vector + RRF, retention-weighted) over the
      // persona's genuine observations.
      searchSources: async (query = "", limit = 10) =>
        buildSearchHits(ds, plane, query, limit),
      // Observation-enriched search: the chunk hits PLUS the additive
      // knowledge plane (entities / facts / concepts) shown in the
      // CitationPanel "Knowledge" tab. Mirrors `sources:searchEnriched`.
      searchEnriched: async (query = "", limit = 10) =>
        buildEnriched(ds, plane, query, limit),
      getDetail: async (id: string) => ({
        source: sources.find((s) => s.id === id) ?? sources[0],
        files: ds.sourceFiles.map((f) => ({
          path: f, hash: f, lastModified: NOW, chunkCount: 6,
        })),
      }),
      getIndexingProgress: async () => null,
      healthReport: async () => ({
        generatedAt: NOW,
        sources: sources.map((s) => ({
          sourceId: s.id,
          sourceType: s.sourceType,
          path: s.path,
          lastIndexed: NOW,
          status: "ready",
          health: "healthy" as const,
          chunkCount: ds.sourceFiles.length * 6,
          storageBytes: ds.sourceFiles.length * 18_000,
          staleFiles: 0,
        })),
      }),
    },
    // Knowledge substrate: concept-graph-driven "related sources" suggestions
    // for the artifact-creation flow, plus decay/synthesis no-ops. Built from
    // the persona's genuine concept graph.
    substrate: {
      // Memory plane read for the Memory page (`useMemories`) and HomePage
      // knowledge insights (`useKnowledgeInsights`). Genuine entity/fact
      // observations with their decay state + retention.
      getMemories: async () => memories.map((m) => ({ ...m })),
      pinMemory: async (id: string) => {
        const m = findMemory(id);
        if (m) m.pinCount += 1;
        return { ...(m ?? memories[0]) };
      },
      unpinMemory: async (id: string) => {
        const m = findMemory(id);
        if (m) m.pinCount = Math.max(0, m.pinCount - 1);
        return { ...(m ?? memories[0]) };
      },
      forgetMemory: async (id: string) => {
        const idx = memories.findIndex((m) => m.id === id);
        if (idx >= 0) memories.splice(idx, 1);
      },
      // Concept graph for the Memory page panel (`useConceptGraph`) + HomePage
      // top-concepts. JSON-serialized `GraphView`, bounded by `maxNodes`.
      getConceptGraph: async (_scope: string | null = null, maxNodes: number | null = null) =>
        buildConceptGraphJson(plane, maxNodes),
      suggestRelatedSources: async (selectedSourceIds: string[] = [], maxSuggestions = 10) => {
        const selected = new Set(selectedSourceIds);
        return plane.concepts
          .map((c) => ({
            entity: c.label,
            sourceIds: c.relatedSourceIds.filter((s) => !selected.has(s)),
            score: c.relatedSourceIds.length,
          }))
          .filter((s) => s.sourceIds.length > 0)
          .sort((a, b) => b.score - a.score)
          .slice(0, maxSuggestions);
      },
      runDecaySweep: async () => ({
        scored: plane.entities.length + plane.facts.length,
        candidatesArchived: 0,
        supersededArchived: 0,
      }),
    },
    // Local backup & recovery (Settings → Backup). Fully interactive in the
    // demo: configure persists, "Back up now" prepends a fresh entry, and the
    // HomePage freshness indicator reads `list()`.
    backup: {
      status: async () => ({ ...backupStatus }),
      list: async () => backups.map((b) => ({ ...b })),
      configure: async (patch: Record<string, unknown>) => {
        backupStatus = { ...backupStatus, ...patch };
        return { ...backupStatus };
      },
      create: async () => {
        const now = Date.parse(NOW);
        const fileName = `tessera-${new Date(now).toISOString().slice(0, 10)}.sqlite3`;
        const info = {
          path: `${backupDir}/${fileName}`,
          fileName,
          createdAtMs: now,
          sizeBytes: 4_720_000,
        };
        backups.unshift(info);
        backupStatus = { ...backupStatus, lastBackupAt: now };
        return { ...info };
      },
      restore: async (path: string) => ({
        stagedPath: `${path}.pending-restore`,
        requiresRestart: true,
      }),
      exportBundle: async (outPath: string) => ({
        path: outPath,
        sizeBytes: 5_100_000,
        entryCount: 4,
      }),
      importBundle: async () => ({
        stagedDbPath: `${backupDir}/import.pending-restore`,
        restoredFiles: [`${backupDir}/settings.json`],
      }),
    },
    // Native dialogs — return canceled so the demo never blocks on a real OS
    // picker, but the methods exist so the Settings handlers don't throw.
    dialog: {
      openDirectory: async () => ({ canceled: true, filePath: null }),
      showSaveDialog: async () => ({ canceled: true }),
      openBundle: async () => ({ canceled: true, filePath: null }),
      pickImage: async () => ({ canceled: true, filePath: null }),
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
      // "Generate" on the Create page calls this. The native bridge
      // returns a freshly-generated artifact; the showcase has no
      // model, so we resolve the persona's pre-built artifact for the
      // chosen template (same id resolution as `templates.get`) and
      // return it. Without this the Proxy fallthrough resolves to
      // `undefined`, and CreatePage's `artifact.id` throws
      // "Cannot read properties of undefined (reading 'id')".
      generateFromTemplate: async (templateId: string, _sourceIds: string[]) => {
        const match =
          ds.artifacts.find((a) => (a.templateId ?? a.slug) === templateId) ??
          ds.artifacts[0];
        return (
          (match && byId.get(artifactId(ds.id, match.slug))) ?? artifacts[0]
        );
      },
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
      recommendModel: async () => ({
        id: installedModel.modelId, name: MODEL_NAME,
        formatLabel: "GGUF (Q1_0_g128)", downloadSizeMb: installedModel.downloadSizeMb,
      }),
      listModels: async () => [{
        id: installedModel.modelId, name: MODEL_NAME,
        formatLabel: "GGUF (Q1_0_g128)", downloadSizeMb: installedModel.downloadSizeMb,
      }],
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
      // Maps provider → loopback redirect URI. The contract is a
      // `Record<string, string>` (see `ConnectorApi`); returning an
      // object (not `[]`) means the credential modal resolves a real
      // URI instead of being stuck on "Loading…". Google Drive stays
      // on `localhost` for OAuth backward-compatibility; everything
      // else uses the spec-preferred `127.0.0.1` loopback.
      getAllRedirectUris: async () => ({
        google_drive: "http://localhost:9876/callback",
        onedrive: "http://127.0.0.1:9877/callback",
        notion: "http://127.0.0.1:9878/callback",
        jira: "http://127.0.0.1:9879/callback",
        confluence: "http://127.0.0.1:9880/callback",
        figma: "http://127.0.0.1:9881/callback",
        hubspot: "http://127.0.0.1:9882/callback",
        slack: "http://127.0.0.1:9883/callback",
        email: "http://127.0.0.1:9884/callback",
        github: "http://127.0.0.1:9885/callback",
      }),
      authenticate: async () => ({ connected: false, status: "disconnected" }),
      disconnect: async () => ({ connected: false, status: "disconnected" }),
      selectItems: async () => ({ ok: true }),
      sync: async () => ({ ok: true }),
      syncDrive: async () => ({ ok: true }),
      inspectScopes: async () => null,
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
    // Tamper-evident audit log (Settings → Activity). The showcase persona is
    // a fresh local workspace, so there are no audit rows or rotated archives.
    audit: {
      listRecent: async () => [],
      listArchives: async () => [],
    },
    // External (cloud) LLM provider is intentionally unconfigured: the whole
    // demo runs on the on-device model, so the card renders its "not
    // configured" state rather than crashing on an undefined config.
    externalProvider: {
      get: async () => null,
      set: async () => ({ ok: true }),
      test: async () => ({ ok: false, error: "not configured" }),
      listModels: async () => [],
      getTokenUsage: async () => null,
      resetTokenUsage: async () => ({ ok: true }),
    },
    // Live resource meter. Returning null keeps the card in its "Measuring…"
    // state (the real card polls this every few seconds).
    resources: {
      getUsage: async () => null,
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

  // Memoise the per-namespace proxies so `window.tessera.<ns>` returns a
  // STABLE reference across accesses. The real preload exposes each namespace
  // as a fixed object; components legitimately use `window.tessera.<ns>` as a
  // `useEffect`/`useMemo` dependency (e.g. KchatSidebarSection's `[kchat, …]`).
  // Minting a fresh proxy on every `get` would make those deps change every
  // render, spinning the effect → setState → re-render loop forever ("Maximum
  // update depth exceeded"). Caching keeps the identity stable.
  const namespaceCache = new Map<string, unknown>();
  return new Proxy(
    {},
    {
      get(_t, namespace: string | symbol) {
        if (typeof namespace === "symbol") return undefined;
        let ns = namespaceCache.get(namespace);
        if (!ns) {
          ns = passthrough(namespace);
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
