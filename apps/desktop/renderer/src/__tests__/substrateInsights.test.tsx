import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, within } from "@testing-library/react";
import { MemoryRouter, Routes, Route } from "react-router-dom";
import HomePage from "../pages/HomePage";
import SourceDetailPage from "../pages/SourceDetailPage";
import {
  deriveKnowledgeInsights,
  isActiveMemoryState,
  observationTypeLabel,
  parseConceptNodes,
  type ConceptNode,
} from "../hooks/useSubstrateInsights";
import type { SubstrateMemoryInfo } from "../types/ipc";

function memory(overrides: Partial<SubstrateMemoryInfo>): SubstrateMemoryInfo {
  return {
    id: "00000000-0000-4000-8000-000000000000",
    scopeId: "00000000-0000-4000-8000-0000000000ff",
    observationType: "fact",
    content: "A fact",
    state: "reinforced",
    retentionScore: 0.5,
    pinCount: 0,
    retrievalCount: 0,
    corroborationCount: 0,
    createdAt: 0,
    lastAccessedAt: 0,
    sourceId: null,
    ...overrides,
  };
}

describe("useSubstrateInsights pure helpers", () => {
  describe("isActiveMemoryState", () => {
    it("treats working-set states as active and retired states as inactive", () => {
      for (const s of ["candidate", "reinforced", "consolidated", "canonical"]) {
        expect(isActiveMemoryState(s)).toBe(true);
        expect(isActiveMemoryState(s.toUpperCase())).toBe(true);
      }
      for (const s of ["superseded", "archived", "deleted"]) {
        expect(isActiveMemoryState(s)).toBe(false);
      }
    });
  });

  describe("observationTypeLabel", () => {
    it("maps known observation types and capitalizes unknowns", () => {
      expect(observationTypeLabel("task")).toBe("Task");
      expect(observationTypeLabel("DECISION")).toBe("Decision");
      expect(observationTypeLabel("hypothesis")).toBe("Hypothesis");
      expect(observationTypeLabel("")).toBe("Observation");
    });
  });

  describe("parseConceptNodes", () => {
    it("parses the verified GraphView wire shape and camelCases the count", () => {
      const json = JSON.stringify({
        nodes: [
          {
            id: "n1",
            label: "Atlas",
            state: "Canonical",
            scope_id: "s1",
            connections_count: 3,
          },
        ],
        edges: [],
      });
      const nodes = parseConceptNodes(json);
      expect(nodes).toEqual([
        { id: "n1", label: "Atlas", state: "canonical", connectionsCount: 3 },
      ]);
    });

    it("returns [] for malformed / non-graph payloads and drops id-less nodes", () => {
      expect(parseConceptNodes("not json")).toEqual([]);
      expect(parseConceptNodes("{}")).toEqual([]);
      expect(parseConceptNodes("[]")).toEqual([]);
      expect(
        parseConceptNodes(
          JSON.stringify({ nodes: [{ label: "no id" }, { id: "ok" }] }),
        ),
      ).toEqual([
        { id: "ok", label: "", state: "", connectionsCount: 0 },
      ]);
    });
  });

  describe("deriveKnowledgeInsights", () => {
    it("counts active memories and ranks reinforced + connected", () => {
      const memories = [
        memory({ id: "m1", state: "archived", retentionScore: 0.9 }),
        memory({ id: "m2", state: "reinforced", retentionScore: 0.4 }),
        memory({ id: "m3", state: "canonical", retentionScore: 0.8 }),
        memory({ id: "m4", state: "deleted", retentionScore: 0.99 }),
      ];
      const concepts: ConceptNode[] = [
        { id: "c1", label: "Beta", state: "canonical", connectionsCount: 1 },
        { id: "c2", label: "Alpha", state: "canonical", connectionsCount: 5 },
      ];
      const insights = deriveKnowledgeInsights(memories, concepts, 5);
      expect(insights.totalMemories).toBe(4);
      expect(insights.activeMemories).toBe(2);
      expect(insights.conceptCount).toBe(2);
      // Active only, strongest retention first.
      expect(insights.topReinforced.map((m) => m.id)).toEqual(["m3", "m2"]);
      // Most-connected first.
      expect(insights.topConcepts.map((c) => c.id)).toEqual(["c2", "c1"]);
    });

    it("respects the topN cap", () => {
      const memories = Array.from({ length: 10 }, (_, i) =>
        memory({ id: `m${i}`, retentionScore: i / 10 }),
      );
      const insights = deriveKnowledgeInsights(memories, [], 3);
      expect(insights.topReinforced).toHaveLength(3);
      expect(insights.topReinforced[0].id).toBe("m9");
    });
  });
});

describe("HomePage knowledge insights section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    // One source so the page renders its populated layout (not the
    // fresh-install welcome state that early-returns before insights).
    window.tessera.sources.listSources = vi.fn().mockResolvedValue([
      {
        id: "s1",
        sourceType: "local_folder",
        path: "/home/docs",
        status: "indexed",
        createdAt: new Date().toISOString(),
        lastIndexed: new Date().toISOString(),
        fileCount: 4,
      },
    ]);
    window.tessera.substrate.getMemories = vi.fn().mockResolvedValue([]);
    window.tessera.substrate.getConceptGraph = vi.fn().mockResolvedValue("{}");
  });

  function renderHome() {
    return render(
      <MemoryRouter>
        <HomePage />
      </MemoryRouter>,
    );
  }

  it("shows the empty state when the substrate has no memories or concepts", async () => {
    renderHome();
    expect(
      await screen.findByTestId("knowledge-insights-empty"),
    ).toBeInTheDocument();
  });

  it("renders metrics, top memories and concepts when the substrate is populated", async () => {
    window.tessera.substrate.getMemories = vi.fn().mockResolvedValue([
      memory({
        id: "m1",
        observationType: "decision",
        content: "Adopt RRF fusion",
        state: "canonical",
        retentionScore: 0.92,
      }),
      memory({
        id: "m2",
        observationType: "task",
        content: "Reindex legal corpus",
        state: "reinforced",
        retentionScore: 0.4,
      }),
      memory({ id: "m3", state: "archived", retentionScore: 0.99 }),
    ]);
    window.tessera.substrate.getConceptGraph = vi.fn().mockResolvedValue(
      JSON.stringify({
        nodes: [
          {
            id: "c1",
            label: "Retrieval",
            state: "canonical",
            connections_count: 7,
          },
        ],
        edges: [],
      }),
    );

    renderHome();

    const insights = await screen.findByTestId("knowledge-insights");
    // Active memories = 2 (m1, m2); archived m3 excluded.
    expect(
      within(insights).getByTestId("knowledge-metric-Active memories"),
    ).toHaveTextContent("2");
    expect(
      within(insights).getByTestId("knowledge-metric-Concepts"),
    ).toHaveTextContent("1");
    expect(
      within(insights).getByTestId("knowledge-metric-Total memories"),
    ).toHaveTextContent("3");

    const memList = within(insights).getByTestId("knowledge-top-memories");
    expect(memList).toHaveTextContent("Adopt RRF fusion");
    expect(memList).toHaveTextContent("Reindex legal corpus");
    // Strongest retention first.
    expect(memList.textContent?.indexOf("Adopt RRF fusion")).toBeLessThan(
      memList.textContent?.indexOf("Reindex legal corpus") ?? -1,
    );

    const conceptList = within(insights).getByTestId("knowledge-top-concepts");
    expect(conceptList).toHaveTextContent("Retrieval");
    expect(conceptList).toHaveTextContent("7 links");
  });

  it("shows a graceful message when the substrate read rejects", async () => {
    window.tessera.substrate.getMemories = vi
      .fn()
      .mockRejectedValue(new Error("substrate offline"));
    renderHome();
    expect(
      await screen.findByTestId("knowledge-insights-error"),
    ).toBeInTheDocument();
  });
});

describe("SourceDetailPage knowledge section", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    window.tessera.sources.getDetail = vi.fn().mockResolvedValue({
      source: {
        id: "src-1",
        sourceType: "local_folder",
        path: "/mock/folder",
        status: "indexed",
        createdAt: new Date().toISOString(),
        lastIndexed: new Date().toISOString(),
        fileCount: 3,
      },
      files: [],
    });
    window.tessera.substrate.getMemories = vi.fn().mockResolvedValue([]);
  });

  function renderDetail() {
    return render(
      <MemoryRouter initialEntries={["/sources/src-1"]}>
        <Routes>
          <Route path="/sources/:id" element={<SourceDetailPage />} />
        </Routes>
      </MemoryRouter>,
    );
  }

  it("shows the empty state when no memories are tied to the source", async () => {
    renderDetail();
    expect(
      await screen.findByTestId("source-knowledge-empty"),
    ).toBeInTheDocument();
  });

  it("lists only memories whose sourceId matches this source", async () => {
    window.tessera.substrate.getMemories = vi.fn().mockResolvedValue([
      memory({
        id: "m1",
        sourceId: "src-1",
        observationType: "fact",
        content: "Contract renews annually",
        state: "canonical",
        retentionScore: 0.7,
      }),
      memory({
        id: "m2",
        sourceId: "other-src",
        content: "Belongs to a different source",
      }),
    ]);

    renderDetail();

    const list = await screen.findByTestId("source-knowledge-list");
    expect(list).toHaveTextContent("Contract renews annually");
    expect(list).not.toHaveTextContent("Belongs to a different source");
    expect(within(list).getAllByTestId("source-knowledge-item")).toHaveLength(1);
  });

  it("shows a graceful error when the substrate read rejects", async () => {
    window.tessera.substrate.getMemories = vi
      .fn()
      .mockRejectedValue(new Error("substrate offline"));
    renderDetail();
    expect(
      await screen.findByTestId("source-knowledge-error"),
    ).toBeInTheDocument();
  });
});
