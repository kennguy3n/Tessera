import React from "react";
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import ConceptGraphPanel from "../components/ConceptGraphPanel";
import {
  makePreset,
  presetStorageKey,
  serializePresetStore,
} from "../utils/conceptGraphPresets";
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

    it("moves the roving tab stop off a node the scrubber hides", async () => {
      // Regression: the roving target was computed against the full node set,
      // so scrubbing out the focused node left the keyboard tab stop pointing
      // at a node that's no longer painted — stalling arrow navigation.
      const { container } = render(
        <ConceptGraphPanel memories={MEMORIES} scope="scope-a" />,
      );
      await waitFor(() =>
        expect(screen.getByTestId("concept-graph-svg")).toBeInTheDocument(),
      );

      // Focus Atlas (created at 100d) — it owns the roving tab stop.
      fireEvent.click(screen.getByRole("button", { name: /^Atlas/ }));
      const atlasTabStop = container.querySelector(
        'g.cg-node[tabindex="0"]',
      );
      expect(atlasTabStop?.getAttribute("aria-label")).toMatch(/^Atlas/);

      // Enable decay and rewind before Atlas exists (but after Beacon@10d).
      fireEvent.click(screen.getByTestId("concept-graph-decay-toggle"));
      const scrubber = screen.getByTestId(
        "concept-graph-decay-scrubber",
      ) as HTMLInputElement;
      fireEvent.change(scrubber, { target: { value: String(50 * DAY) } });

      // Atlas is no longer painted...
      await waitFor(() =>
        expect(
          screen.queryByRole("button", { name: /^Atlas/ }),
        ).not.toBeInTheDocument(),
      );
      // ...and exactly one *visible* node holds the roving tab stop.
      const tabStops = container.querySelectorAll('g.cg-node[tabindex="0"]');
      expect(tabStops).toHaveLength(1);
      expect(tabStops[0].getAttribute("aria-label")).not.toMatch(/^Atlas/);
    });
  });

  describe("scope changes", () => {
    it("applies the new scope's default preset when the scope prop changes", async () => {
      // Seed scope-b with a default preset that turns all labels on. The
      // scope-change effect must apply it from the freshly-loaded store, not
      // the previous scope's (the regression this guards against).
      const preset = makePreset("Labelled", {
        disabledRelations: [],
        disabledStates: [],
        scopeFilter: "all",
        localMode: false,
        localHops: 1,
        labelsAll: true,
        decayMode: false,
      });
      window.localStorage.setItem(
        presetStorageKey("scope-b"),
        serializePresetStore({ presets: [preset], defaultPresetId: preset.id }),
      );

      const { rerender } = render(
        <ConceptGraphPanel memories={MEMORIES} scope="scope-a" />,
      );
      await waitFor(() =>
        expect(screen.getByTestId("concept-graph-svg")).toBeInTheDocument(),
      );
      // scope-a has no default → labels stay at the off baseline.
      expect(screen.getByLabelText("Toggle all labels")).toHaveAttribute(
        "aria-pressed",
        "false",
      );

      rerender(<ConceptGraphPanel memories={MEMORIES} scope="scope-b" />);
      await waitFor(() =>
        expect(screen.getByLabelText("Toggle all labels")).toHaveAttribute(
          "aria-pressed",
          "true",
        ),
      );
    });

    it("resets the decay overlay when the scope changes", async () => {
      const { rerender } = render(
        <ConceptGraphPanel memories={MEMORIES} scope="scope-a" />,
      );
      await waitFor(() =>
        expect(screen.getByTestId("concept-graph-svg")).toBeInTheDocument(),
      );
      fireEvent.click(screen.getByTestId("concept-graph-decay-toggle"));
      expect(
        screen.getByTestId("concept-graph-decay-controls"),
      ).toBeInTheDocument();

      rerender(<ConceptGraphPanel memories={MEMORIES} scope="scope-c" />);
      await waitFor(() =>
        expect(
          screen.queryByTestId("concept-graph-decay-controls"),
        ).not.toBeInTheDocument(),
      );
    });
  });

  describe("Canvas renderer switch", () => {
    // Only `mockRestore` is used; typing the handle structurally avoids the
    // generic-erased `ReturnType<typeof vi.spyOn>` mismatch with the specific
    // overloaded `getContext` spy.
    let getContextSpy: { mockRestore: () => void };

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

    it("re-draws after a StrictMode mount/unmount/remount cycle", async () => {
      // Regression: the rAF cleanup cancelled the queued frame but left
      // `rafRef.current` non-null, so after StrictMode's dev-only
      // mount→unmount→remount the remount's `scheduleDraw` early-returned
      // forever and the canvas never painted (it stayed at jsdom's 300×150
      // default backing store). `main.tsx` wraps the app in StrictMode, so
      // this regressed the real renderer. A successful draw sizes the
      // backing store to the CSS width (720).
      window.tessera.substrate.getConceptGraph = vi
        .fn()
        .mockResolvedValue(largeGraph(CANVAS_RENDER_THRESHOLD + 10));
      render(
        <React.StrictMode>
          <ConceptGraphPanel
            memories={MEMORIES}
            scope="scope-strict"
            maxNodes={CANVAS_RENDER_THRESHOLD + 50}
          />
        </React.StrictMode>,
      );
      const canvas = (await screen.findByTestId(
        "concept-graph-canvas",
      )) as HTMLCanvasElement;
      await waitFor(() => expect(canvas.width).not.toBe(300));
    });
  });
});
