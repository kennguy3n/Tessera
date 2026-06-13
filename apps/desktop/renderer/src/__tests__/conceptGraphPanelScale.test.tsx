import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import ConceptGraphPanel from "../components/ConceptGraphPanel";
import { CANVAS_RENDER_THRESHOLD } from "../utils/conceptGraphRenderer";
import type { SubstrateMemoryInfo } from "../types/ipc";

/**
 * Integration coverage for the concept-graph-at-scale features layered on
 * top of the SVG panel: the Canvas renderer switch, saved filter presets,
 * and the time-based decay overlay. The pure logic behind each lives in
 * `conceptGraphRenderer` / `conceptGraphPresets` / `conceptGraphDecay` with
 * its own unit tests; these assert the component wiring.
 */

const SMALL_GRAPH = JSON.stringify({
  nodes: [
    { id: "atlas", label: "Atlas", state: "canonical", scope_id: "scope-a", connections_count: 2 },
    { id: "project", label: "Project", state: "candidate", scope_id: "scope-a", connections_count: 1 },
    { id: "beacon", label: "Beacon", state: "candidate", scope_id: "scope-a", connections_count: 1 },
  ],
  edges: [
    { id: "e1", from: "atlas", to: "project", relation_type: "is_a", scope_id: "scope-a" },
    { id: "e2", from: "atlas", to: "beacon", relation_type: "part_of", scope_id: "scope-a" },
  ],
  scope_filter: [],
  depth: 2,
  truncation: "complete",
});

/** A graph with enough nodes to cross the Canvas threshold. */
function largeGraph(count: number): string {
  const nodes = Array.from({ length: count }, (_, i) => ({
    id: `n${i}`,
    label: `Concept ${i}`,
    state: i % 2 === 0 ? "canonical" : "candidate",
    scope_id: "scope-a",
    connections_count: 1,
  }));
  const edges = Array.from({ length: count - 1 }, (_, i) => ({
    id: `edge-${i}`,
    from: `n${i}`,
    to: `n${i + 1}`,
    relation_type: "is_a",
    scope_id: "scope-a",
  }));
  return JSON.stringify({
    nodes,
    edges,
    scope_filter: [],
    depth: 2,
    truncation: "complete",
  });
}

const DAY = 86_400;
const MEMORIES: SubstrateMemoryInfo[] = [
  {
    id: "mem-atlas",
    scopeId: "scope-a",
    observationType: "entity",
    content: "Atlas is the internal codename, accessed recently.",
    state: "canonical",
    retentionScore: 0.95,
    pinCount: 1,
    retrievalCount: 5,
    corroborationCount: 2,
    createdAt: 100 * DAY,
    lastAccessedAt: 200 * DAY,
    sourceId: "src-1",
  },
  {
    id: "mem-beacon",
    scopeId: "scope-a",
    observationType: "entity",
    content: "Beacon was an early idea, not touched since.",
    state: "candidate",
    retentionScore: 0.2,
    pinCount: 0,
    retrievalCount: 0,
    corroborationCount: 0,
    createdAt: 10 * DAY,
    lastAccessedAt: 20 * DAY,
    sourceId: "src-2",
  },
];

describe("ConceptGraphPanel — scale features", () => {
  beforeEach(() => {
    window.localStorage.clear();
    window.tessera.substrate.getConceptGraph = vi
      .fn()
      .mockResolvedValue(SMALL_GRAPH);
  });

  describe("saved filter presets", () => {
    it("saves, lists, applies a default, and deletes a preset", async () => {
      const { unmount } = render(
        <ConceptGraphPanel memories={MEMORIES} scope="scope-a" />,
      );
      await waitFor(() =>
        expect(screen.getByTestId("concept-graph-svg")).toBeInTheDocument(),
      );

      // Diverge from the baseline filter (toggle all labels on) and name+save.
      fireEvent.click(screen.getByLabelText("Toggle all labels"));
      fireEvent.change(screen.getByTestId("concept-graph-preset-name"), {
        target: { value: "Labelled view" },
      });
      fireEvent.click(screen.getByTestId("concept-graph-preset-save"));

      const select = screen.getByTestId(
        "concept-graph-preset-select",
      ) as HTMLSelectElement;
      await waitFor(() =>
        expect(
          within(select).getByText("Labelled view"),
        ).toBeInTheDocument(),
      );

      // The live filter matches the just-saved preset, so it is selected.
      expect(select.value).not.toBe("");
      const presetId = select.value;

      // Mark it the default and confirm it persists.
      fireEvent.click(screen.getByTestId("concept-graph-preset-default"));
      await waitFor(() => {
        const raw = window.localStorage.getItem(
          "tessera.conceptGraph.presets.scope-a",
        );
        expect(raw).toBeTruthy();
        expect(JSON.parse(raw as string).defaultPresetId).toBe(presetId);
      });
      unmount();

      // Re-mounting the same scope applies the default preset (labels on).
      render(<ConceptGraphPanel memories={MEMORIES} scope="scope-a" />);
      await waitFor(() =>
        expect(screen.getByTestId("concept-graph-svg")).toBeInTheDocument(),
      );
      await waitFor(() =>
        expect(screen.getByLabelText("Toggle all labels")).toHaveAttribute(
          "aria-pressed",
          "true",
        ),
      );

      // Delete it; the store empties.
      fireEvent.click(screen.getByTestId("concept-graph-preset-delete"));
      await waitFor(() => {
        const raw = window.localStorage.getItem(
          "tessera.conceptGraph.presets.scope-a",
        );
        expect(JSON.parse(raw as string).presets).toHaveLength(0);
      });
    });

    it("keeps presets isolated between scopes", async () => {
      const a = render(
        <ConceptGraphPanel memories={MEMORIES} scope="scope-1" />,
      );
      await waitFor(() =>
        expect(screen.getByTestId("concept-graph-svg")).toBeInTheDocument(),
      );
      fireEvent.change(screen.getByTestId("concept-graph-preset-name"), {
        target: { value: "Scope one view" },
      });
      fireEvent.click(screen.getByTestId("concept-graph-preset-save"));
      await waitFor(() =>
        expect(
          window.localStorage.getItem(
            "tessera.conceptGraph.presets.scope-1",
          ),
        ).toBeTruthy(),
      );
      a.unmount();
      expect(
        window.localStorage.getItem("tessera.conceptGraph.presets.scope-2"),
      ).toBeNull();
    });
  });

  describe("time-based decay overlay", () => {
    it("toggles the recency legend + scrubber and scrubs the as-of window", async () => {
      render(<ConceptGraphPanel memories={MEMORIES} scope="scope-a" />);
      await waitFor(() =>
        expect(screen.getByTestId("concept-graph-svg")).toBeInTheDocument(),
      );

      // Off by default.
      expect(
        screen.queryByTestId("concept-graph-decay-controls"),
      ).not.toBeInTheDocument();

      fireEvent.click(screen.getByTestId("concept-graph-decay-toggle"));
      expect(
        screen.getByTestId("concept-graph-decay-controls"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("concept-graph-decay-legend"),
      ).toBeInTheDocument();

      // Default is "now"; the Now reset button is hidden until we scrub back.
      expect(screen.getByTestId("concept-graph-decay-asof")).toHaveTextContent(
        "now",
      );
      expect(
        screen.queryByTestId("concept-graph-decay-now"),
      ).not.toBeInTheDocument();

      // Scrub to before Atlas's last access (200d) but after Beacon (20d):
      // Beacon stays, but a rewound scrubber surfaces the Now reset + as-of.
      const scrubber = screen.getByTestId(
        "concept-graph-decay-scrubber",
      ) as HTMLInputElement;
      fireEvent.change(scrubber, { target: { value: String(50 * DAY) } });
      expect(
        screen.getByTestId("concept-graph-decay-now"),
      ).toBeInTheDocument();
      expect(
        screen.getByTestId("concept-graph-decay-asof"),
      ).not.toHaveTextContent("now");

      // Resetting to "now" hides the reset button again.
      fireEvent.click(screen.getByTestId("concept-graph-decay-now"));
      expect(
        screen.queryByTestId("concept-graph-decay-now"),
      ).not.toBeInTheDocument();
    });
  });

  describe("Canvas renderer switch", () => {
    let getContextSpy: ReturnType<typeof vi.spyOn>;

    beforeEach(() => {
      // jsdom has no 2D canvas; hand back a no-op context so the renderer's
      // draw pass doesn't throw when it mounts.
      const ctxStub = new Proxy(
        {},
        { get: () => () => undefined },
      ) as unknown as CanvasRenderingContext2D;
      getContextSpy = vi
        .spyOn(HTMLCanvasElement.prototype, "getContext")
        .mockReturnValue(ctxStub);
    });

    afterEach(() => {
      getContextSpy.mockRestore();
    });

    it("uses SVG below the threshold and Canvas at/above it", async () => {
      const { unmount } = render(
        <ConceptGraphPanel memories={MEMORIES} scope="scope-a" maxNodes={50} />,
      );
      await waitFor(() =>
        expect(screen.getByTestId("concept-graph-svg")).toBeInTheDocument(),
      );
      expect(
        screen.queryByTestId("concept-graph-canvas"),
      ).not.toBeInTheDocument();
      unmount();

      window.tessera.substrate.getConceptGraph = vi
        .fn()
        .mockResolvedValue(largeGraph(CANVAS_RENDER_THRESHOLD + 10));
      render(
        <ConceptGraphPanel
          memories={MEMORIES}
          scope="scope-big"
          maxNodes={CANVAS_RENDER_THRESHOLD + 50}
        />,
      );
      await waitFor(() =>
        expect(
          screen.getByTestId("concept-graph-canvas"),
        ).toBeInTheDocument(),
      );
      expect(
        screen.queryByTestId("concept-graph-svg"),
      ).not.toBeInTheDocument();
    });
  });
});
