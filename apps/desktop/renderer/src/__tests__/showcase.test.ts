import { readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { afterEach, describe, expect, it } from "vitest";

import {
  buildShowcaseApi,
  installShowcaseBridge,
  showcasePersonaFromQuery,
} from "../showcase";
import { parseBaseDocument, linkTargetRecords } from "../editors/baseDocumentHelpers";
import {
  resolveLinkedRecords,
  aggregateValues,
  lookupValues,
} from "../editors/baseEditorHelpers";
import { parseSheetContent } from "../editors/sheetEditorHelpers";
import { parseA1Range } from "../editors/sheetCharts";
import { parseSlideContent } from "../editors/slideEditorHelpers";
import { isKnownSlideThemeId } from "../editors/slideThemes";
import { SLIDE_LAYOUTS } from "../editors/slideLayouts";
import { estimateReadingTimeMinutes } from "../editors/documentOutlineHelpers";
import type { BaseField, BaseRecord } from "../editors/baseEditorTypes";

// The set of model ids the showcase is ALLOWED to advertise = the
// `text`-capability entries in Tessera's real model registry. The mock bridge
// must never report an off-design stand-in model (e.g. a generic Llama/Qwen
// build); this mirrors the hard guard in scripts/showcase/generate.py.
// Resolve the repo-root registry relative to THIS test file (not process.cwd())
// so the path holds no matter where the runner is invoked from.
const HERE = dirname(fileURLToPath(import.meta.url));
const MODELS_JSON = resolve(HERE, "../../../../../sidecars/models.json");
const DESIGN_TEXT_MODEL_IDS = new Set<string>(
  (JSON.parse(readFileSync(MODELS_JSON, "utf8")).models as Array<{
    id: string;
    capability: string;
  }>)
    .filter((m) => m.capability === "text")
    .map((m) => m.id),
);

/**
 * The showcase harness is a DEV-only mock `window.tessera` bridge used to
 * capture data-rich product screenshots. These tests pin the mock's API shape
 * and its Proxy semantics so regressions surface if it drifts from the real
 * `TesseraApi` (the editors call the mock exactly as they call the real bridge).
 */

const PERSONAS = ["healthcare", "legal", "finance", "nonprofit", "retail"] as const;

// Valid lifecycle vocabularies, mirrored from the Rust enums (substrate
// `MemoryState` for observations, concept_graph `NodeState` for concept nodes)
// and from scripts/showcase/derive_knowledge.py. The mock must never serve a
// state the shipped UI can't model — `archived` is observation-only,
// `contradicted` concept-only.
const OBSERVATION_STATES = new Set([
  "candidate",
  "reinforced",
  "consolidated",
  "canonical",
  "superseded",
  "archived",
  "deleted",
]);
const CONCEPT_STATES = new Set([
  "candidate",
  "canonical",
  "superseded",
  "contradicted",
  "deleted",
]);
const RELATION_TYPES = new Set([
  "is_a",
  "part_of",
  "decided_by",
  "supersedes",
  "contradicts",
  "derived_from",
  "assigned_to",
  "unknown",
]);

// Minimal structural view of the mock bridge for assertions.
type Memory = { id: string; state: string; retentionScore: number };
type ConceptGraph = {
  nodes: Array<{ id: string; state: string; connections_count: number }>;
  edges: Array<{ from: string; to: string; relation_type: string }>;
  truncation: string;
};
type Api = {
  settings: { get: () => Promise<{ onboardingCompleted: boolean }> };
  artifacts: { list: () => Promise<Array<{ id: string; version: number; artifactType: string }>> };
  sources: { listSources: () => Promise<Array<{ id: string }>> };
  citations: { list: (artifactId: string) => Promise<Array<{ citationId: string }>> };
  substrate: {
    getMemories: () => Promise<Memory[]>;
    getConceptGraph: (scope?: string | null, maxNodes?: number | null) => Promise<string>;
  };
  runtime: {
    onDownloadProgress: () => () => void;
    getCurrentModel: () => Promise<{ modelId: string }>;
    getInstalledModels: () => Promise<{ text?: { modelId: string } }>;
  };
  // Namespace/method that is not implemented in `real`.
  nope: { missing: () => Promise<unknown> };
};

// The test harness installs a global mock on `window.tessera` (writable but
// non-configurable). Capture it once and restore by assignment after each test
// so `installShowcaseBridge` doesn't leak its persona-specific bridge.
const ORIGINAL_TESSERA = (window as unknown as { tessera: unknown }).tessera;

afterEach(() => {
  window.history.replaceState({}, "", "/");
  (window as unknown as { tessera: unknown }).tessera = ORIGINAL_TESSERA;
});

describe("showcasePersonaFromQuery", () => {
  it("resolves a known persona from the query string", () => {
    window.history.replaceState({}, "", "/?showcase=healthcare");
    expect(showcasePersonaFromQuery()).toBe("healthcare");
  });

  it("returns null for an unknown persona value", () => {
    window.history.replaceState({}, "", "/?showcase=does-not-exist");
    expect(showcasePersonaFromQuery()).toBeNull();
  });

  it("returns null when the param is absent", () => {
    window.history.replaceState({}, "", "/");
    expect(showcasePersonaFromQuery()).toBeNull();
  });
});

describe("buildShowcaseApi", () => {
  it("throws on an unknown persona", () => {
    expect(() => buildShowcaseApi("nope")).toThrow(/Unknown showcase persona/);
  });

  it.each(PERSONAS)(
    "advertises only a Tessera design text model for %s (no off-design models)",
    async (persona) => {
      const api = buildShowcaseApi(persona) as Api;
      const current = await api.runtime.getCurrentModel();
      const installed = await api.runtime.getInstalledModels();
      expect(DESIGN_TEXT_MODEL_IDS.has(current.modelId)).toBe(true);
      expect(installed.text).toBeDefined();
      expect(DESIGN_TEXT_MODEL_IDS.has(installed.text!.modelId)).toBe(true);
    },
  );

  it.each(PERSONAS)("exposes a working mock surface for %s", async (persona) => {
    const api = buildShowcaseApi(persona) as Api;

    const settings = await api.settings.get();
    expect(settings.onboardingCompleted).toBe(true);

    const sources = await api.sources.listSources();
    expect(sources).toHaveLength(1);

    const artifacts = await api.artifacts.list();
    expect(artifacts.length).toBeGreaterThan(0);
    // Each artifact is an independent entity at its first revision.
    expect(artifacts.every((a) => a.version === 1)).toBe(true);

    // Citations are surfaced for a real artifact so the provenance panel is
    // never empty in a capture.
    const citations = await api.citations.list(artifacts[0].id);
    expect(citations.length).toBeGreaterThan(0);
  });

  it.each(PERSONAS)(
    "serves only valid observation decay states for %s",
    async (persona) => {
      const api = buildShowcaseApi(persona) as Api;
      const memories = await api.substrate.getMemories();
      expect(memories.length).toBeGreaterThan(0);
      for (const m of memories) {
        expect(
          OBSERVATION_STATES.has(m.state),
          `${persona}: observation ${m.id} has unmodelled state ${m.state}`,
        ).toBe(true);
        expect(m.retentionScore).toBeGreaterThanOrEqual(0);
        expect(m.retentionScore).toBeLessThanOrEqual(1);
      }
    },
  );

  it.each(PERSONAS)(
    "serves a concept graph with valid node states and typed edges for %s",
    async (persona) => {
      const api = buildShowcaseApi(persona) as Api;
      const graph = JSON.parse(await api.substrate.getConceptGraph()) as ConceptGraph;
      const ids = new Set(graph.nodes.map((n) => n.id));
      for (const n of graph.nodes) {
        expect(
          CONCEPT_STATES.has(n.state),
          `${persona}: concept ${n.id} has unmodelled state ${n.state}`,
        ).toBe(true);
      }
      // Every edge is a modelled relation type whose endpoints are real nodes.
      for (const e of graph.edges) {
        expect(
          RELATION_TYPES.has(e.relation_type),
          `${persona}: edge has unmodelled relation ${e.relation_type}`,
        ).toBe(true);
        expect(ids.has(e.from)).toBe(true);
        expect(ids.has(e.to)).toBe(true);
      }
    },
  );

  it("emits the explicit typed concept-graph relations for healthcare", async () => {
    const api = buildShowcaseApi("healthcare") as Api;
    const graph = JSON.parse(await api.substrate.getConceptGraph()) as ConceptGraph;
    // The enriched healthcare plane ships all four headline relation types so
    // the captured graph demonstrates the shipped typed-edge rendering.
    const present = new Set(graph.edges.map((e) => e.relation_type));
    for (const t of ["is_a", "part_of", "supersedes", "contradicts"]) {
      expect(present.has(t), `healthcare graph missing relation ${t}`).toBe(true);
    }
    expect(graph.truncation).toBe("complete");
  });

  it("truncates the concept graph to its most-connected subgraph under a node cap", async () => {
    const api = buildShowcaseApi("healthcare") as Api;
    const full = JSON.parse(await api.substrate.getConceptGraph(null)) as ConceptGraph;
    // The densely-linked spine (the `INC-4471` incident hub) by connectivity.
    const hub = [...full.nodes].sort(
      (a, b) => b.connections_count - a.connections_count,
    )[0];

    const cap = 4;
    const capped = JSON.parse(
      await api.substrate.getConceptGraph(null, cap),
    ) as ConceptGraph;

    // Honors the cap and reports it; keeps the hub rather than the
    // enrichment-added category/claim nodes that are appended last.
    expect(capped.nodes).toHaveLength(cap);
    expect(capped.truncation).toBe("node_limit_reached");
    expect(capped.nodes.some((n) => n.id === hub.id)).toBe(true);
    // Every surviving edge still resolves to a kept node (no dangling lines).
    const keptIds = new Set(capped.nodes.map((n) => n.id));
    for (const e of capped.edges) {
      expect(keptIds.has(e.from) && keptIds.has(e.to)).toBe(true);
    }
  });
});

describe("buildShowcaseApi Proxy semantics", () => {
  it("returns a no-op unsubscribe for on* subscription methods", () => {
    const api = buildShowcaseApi("retail") as Api;
    const unsubscribe = api.runtime.onDownloadProgress();
    expect(typeof unsubscribe).toBe("function");
    expect(unsubscribe()).toBeUndefined();
  });

  it("resolves unknown methods to undefined instead of throwing", async () => {
    const api = buildShowcaseApi("retail") as Api;
    await expect(api.nope.missing()).resolves.toBeUndefined();
  });

  it("keeps namespaces non-thenable so `await api.<ns>` yields the proxy", async () => {
    const api = buildShowcaseApi("retail") as Api;
    // If a namespace were thenable, awaiting it would resolve to undefined.
    const awaited = (await (api.sources as unknown as Promise<typeof api.sources>)) as typeof api.sources;
    expect(typeof awaited.listSources).toBe("function");
  });

  it("guards symbol property access (e.g. DevTools' Symbol.toStringTag)", () => {
    const api = buildShowcaseApi("retail") as unknown as Record<symbol, unknown>;
    expect(Object.prototype.toString.call(api)).toBe("[object Object]");
    expect(api[Symbol.toStringTag]).toBeUndefined();
  });
});

// Structural view of a seeded artifact as the editors receive it.
type SeededArtifact = { id: string; artifactType: string; content: string };
type ArtifactApi = {
  artifacts: { list: () => Promise<SeededArtifact[]> };
};

async function seededArtifacts(persona: string): Promise<SeededArtifact[]> {
  const api = buildShowcaseApi(persona) as unknown as ArtifactApi;
  return api.artifacts.list();
}

/**
 * The seed data is only valuable if the SHIPPED editors can actually parse and
 * render it. These tests run each enriched artifact through the real editor
 * parsers / resolvers (the exact code the renderer uses) and assert the new
 * capabilities are present AND compute meaningful values — so a malformed seed
 * (a dangling cross-table link, a chart over a non-existent range, a slide with
 * no layout) fails loudly here instead of rendering broken in a screenshot.
 */
describe("seeded artifacts exercise the shipped editor capabilities", () => {
  it.each(["healthcare", "retail"] as const)(
    "%s base is a multi-table document with resolvable linked/lookup/rollup fields",
    async (persona) => {
      const arts = await seededArtifacts(persona);
      const base = arts.find((a) => a.artifactType === "base");
      expect(base, `${persona}: no base artifact`).toBeDefined();

      const doc = parseBaseDocument(base!.content);
      // Multi-table Airtable shape (a primary table + a derived linked table).
      expect(doc.tables.length).toBe(2);
      const resolver = (id: string) => doc.tables.find((t) => t.id === id);

      // Exactly one cross-table linked_record field, plus lookup + rollup that
      // traverse it — the Airtable-parity capability the blog claims.
      let sawLinked = false;
      let sawLookup = false;
      let sawRollup = false;

      for (const table of doc.tables) {
        for (const field of table.fields as BaseField[]) {
          if (field.type === "linked_record" && field.linkedTableId) {
            sawLinked = true;
            // Every link target id resolves to a real record in the target table.
            const target = resolver(field.linkedTableId);
            expect(target, `${persona}: link target ${field.linkedTableId} missing`).toBeDefined();
            const targetIds = new Set((target!.records as BaseRecord[]).map((r) => r.id));
            for (const rec of table.records as BaseRecord[]) {
              const ids = rec[field.name];
              if (Array.isArray(ids)) {
                for (const id of ids) {
                  expect(
                    targetIds.has(id as string),
                    `${persona}: ${table.name}.${field.name} links dangling id ${String(id)}`,
                  ).toBe(true);
                }
              }
            }
          }
          if (field.type === "lookup") sawLookup = true;
          if (field.type === "rollup") sawRollup = true;
        }
      }
      expect(sawLinked && sawLookup && sawRollup).toBe(true);

      // Compute every rollup / lookup the way BaseEditor does and assert they
      // resolve to a real value (never "#REF!" / "—") for at least one record.
      for (const table of doc.tables) {
        for (const field of table.fields as BaseField[]) {
          if (field.type !== "rollup" && field.type !== "lookup") continue;
          const linkedDef = (table.fields as BaseField[]).find(
            (f) => f.name === field.linkedField,
          );
          expect(linkedDef?.type, `${persona}: ${field.name} bad linkedField`).toBe(
            "linked_record",
          );
          const computed = (table.records as BaseRecord[]).map((rec) => {
            const linked = resolveLinkedRecords(
              rec[field.linkedField!],
              linkTargetRecords(linkedDef!, table.records as BaseRecord[], resolver),
            );
            const values = linked.map((r) => r[field.targetField!]);
            return field.type === "rollup"
              ? aggregateValues(values, field.aggregation ?? "SUM")
              : lookupValues(linked, field.targetField!);
          });
          expect(
            computed.some((v) => v !== "" && v !== "0"),
            `${persona}: ${table.name}.${field.name} computed empty for every record`,
          ).toBe(true);
        }
      }

      // Expand-record modal demo: at least one record carries a comments
      // timeline so the modal isn't empty in a capture.
      const hasComments = doc.tables.some((t) =>
        (t.records as BaseRecord[]).some(
          (r) => Array.isArray(r.__comments) && r.__comments.length > 0,
        ),
      );
      expect(hasComments, `${persona}: no record with a comments timeline`).toBe(true);
    },
  );

  it.each(["legal", "finance"] as const)(
    "%s sheet ships formulas + named ranges + (validation|chart) over the model's values",
    async (persona) => {
      const arts = await seededArtifacts(persona);
      const sheet = arts.find((a) => a.artifactType === "sheet");
      expect(sheet, `${persona}: no sheet artifact`).toBeDefined();

      const content = parseSheetContent(sheet!.content);
      const rowCount = content.rows.length;
      const colCount = content.columns.length;

      // At least one genuine formula cell, every reference in bounds-shaped A1.
      const formulaCells = content.rows
        .flat()
        .filter((c) => typeof c === "string" && c.startsWith("="));
      expect(formulaCells.length, `${persona}: no formula cells`).toBeGreaterThan(0);

      // Named ranges round-trip and every chart binds to a parseable A1 range.
      expect((content.namedRanges ?? []).length).toBeGreaterThan(0);
      for (const chart of content.charts ?? []) {
        const rect = parseA1Range(chart.range);
        expect(rect, `${persona}: chart ${chart.id} bad range ${chart.range}`).not.toBeNull();
        expect(rect!.r2).toBeLessThan(rowCount);
        expect(rect!.c2).toBeLessThan(colCount);
        if (chart.labelRange) {
          expect(parseA1Range(chart.labelRange)).not.toBeNull();
        }
      }

      // Each sheet shows at least one of the two interaction surfaces.
      const hasValidation =
        content.validations !== undefined &&
        Object.keys(content.validations).length > 0;
      const hasChart = (content.charts ?? []).length > 0;
      expect(
        hasValidation || hasChart,
        `${persona}: sheet has neither validation nor a chart`,
      ).toBe(true);

      // Validation lists never constrain away a value already in the column.
      for (const [colKey, rule] of Object.entries(content.validations ?? {})) {
        if (rule.kind !== "list") continue;
        const col = Number(colKey);
        const allowed = new Set(rule.values);
        for (const row of content.rows) {
          const v = row[col];
          if (typeof v === "string" && v !== "" && !v.startsWith("=")) {
            expect(
              allowed.has(v),
              `${persona}: column ${col} value ${v} not in its own dropdown`,
            ).toBe(true);
          }
        }
      }
    },
  );

  it.each(["healthcare", "legal", "finance", "nonprofit"] as const)(
    "%s document uses callout + toggle + table-of-contents blocks with a real outline",
    async (persona) => {
      const arts = await seededArtifacts(persona);
      const document = arts.find((a) => a.artifactType === "document");
      expect(document, `${persona}: no document artifact`).toBeDefined();
      const html = document!.content;

      expect(html).toContain('data-type="callout"');
      expect(html).toContain('data-type="toggle"');
      expect(html).toContain('data-type="table-of-contents"');

      // The scroll-tracked outline + reading-time footer derive from real
      // headings, so the doc must carry several and a non-trivial word count.
      const headings = html.match(/<h[1-3]\b/g) ?? [];
      expect(headings.length).toBeGreaterThanOrEqual(3);
      const words = html
        .replace(/<[^>]+>/g, " ")
        .trim()
        .split(/\s+/)
        .filter(Boolean).length;
      expect(estimateReadingTimeMinutes(words)).toBeGreaterThanOrEqual(1);
    },
  );

  it.each(["nonprofit", "retail"] as const)(
    "%s deck applies a real theme + per-slide layouts + speaker notes",
    async (persona) => {
      const arts = await seededArtifacts(persona);
      const deck = arts.find((a) => a.artifactType === "slides");
      expect(deck, `${persona}: no slides artifact`).toBeDefined();

      const parsed = parseSlideContent(deck!.content);
      expect(isKnownSlideThemeId(parsed.themeId)).toBe(true);
      expect(parsed.slides.length).toBeGreaterThan(0);

      const layoutIds = new Set(SLIDE_LAYOUTS.map((l) => l.id));
      let sawBullets = false;
      for (const slide of parsed.slides) {
        expect(
          layoutIds.has(slide.layout ?? "titleContent"),
          `${persona}: slide "${slide.title}" has unknown layout ${slide.layout}`,
        ).toBe(true);
        expect(
          (slide.notes ?? "").trim().length,
          `${persona}: slide "${slide.title}" has no speaker notes`,
        ).toBeGreaterThan(0);
        if (slide.blocks.some((b) => b.type === "bullets")) sawBullets = true;
      }
      // The opener divides the deck (section header) and at least one content
      // slide renders structured bullets.
      expect(parsed.slides[0].layout).toBe("sectionHeader");
      expect(sawBullets).toBe(true);
    },
  );
});

describe("installShowcaseBridge", () => {
  it("installs the mock bridge on window.tessera", () => {
    installShowcaseBridge("legal");
    const installed = (window as unknown as { tessera?: Api }).tessera;
    expect(installed).toBeDefined();
    expect(typeof installed?.artifacts.list).toBe("function");
  });
});
