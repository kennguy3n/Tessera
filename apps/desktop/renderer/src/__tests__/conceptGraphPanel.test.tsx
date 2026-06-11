import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within } from "@testing-library/react";
import ConceptGraphPanel from "../components/ConceptGraphPanel";
import type { SubstrateMemoryInfo } from "../types/ipc";

/**
 * Component coverage for the lightweight SVG concept-graph panel:
 * IPC-backed render of nodes/edges, the empty state, node selection
 * revealing relationships + source evidence, and the scope filter.
 */

const GRAPH_JSON = JSON.stringify({
  nodes: [
    { id: "atlas", label: "Atlas", state: "Canonical", scope_id: "scope-a", connections_count: 2 },
    { id: "project", label: "Project", state: "candidate", scope_id: "scope-a", connections_count: 1 },
    { id: "beacon", label: "Beacon", state: "candidate", scope_id: "scope-b", connections_count: 1 },
  ],
  edges: [
    { id: "e1", from: "atlas", to: "project", relation_type: "is_a", scope_id: "scope-a" },
    { id: "e2", from: "atlas", to: "beacon", relation_type: "part_of", scope_id: "scope-b" },
  ],
  scope_filter: [],
  depth: 2,
  truncation: "complete",
});

const EVIDENCE: SubstrateMemoryInfo[] = [
  {
    id: "mem-1",
    scopeId: "scope-a",
    observationType: "entity",
    content: "Atlas is the internal codename for the project",
    state: "canonical",
    retentionScore: 0.9,
    pinCount: 1,
    retrievalCount: 3,
    corroborationCount: 2,
    createdAt: 0,
    lastAccessedAt: 0,
    sourceId: "src-123456",
  },
];

describe("ConceptGraphPanel", () => {
  beforeEach(() => {
    window.tessera.substrate.getConceptGraph = vi
      .fn()
      .mockResolvedValue(GRAPH_JSON);
  });

  it("renders an SVG node for each concept and the relationship legend", async () => {
    render(<ConceptGraphPanel memories={EVIDENCE} />);
    await waitFor(() =>
      expect(screen.getByTestId("concept-graph-svg")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("concept-node-atlas")).toBeInTheDocument();
    expect(screen.getByTestId("concept-node-project")).toBeInTheDocument();
    // Legend lists the relation types present.
    const legend = screen.getByTestId("concept-graph-legend");
    expect(within(legend).getByText("is a")).toBeInTheDocument();
    expect(within(legend).getByText("part of")).toBeInTheDocument();
  });

  it("shows an empty state when the graph has no nodes", async () => {
    window.tessera.substrate.getConceptGraph = vi
      .fn()
      .mockResolvedValue('{"nodes":[],"edges":[]}');
    render(<ConceptGraphPanel />);
    await waitFor(() =>
      expect(screen.getByTestId("concept-graph-empty")).toBeInTheDocument(),
    );
  });

  it("reveals relationships and source evidence on node selection", async () => {
    render(<ConceptGraphPanel memories={EVIDENCE} />);
    await waitFor(() =>
      expect(screen.getByTestId("concept-node-atlas")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("concept-node-atlas"));
    const detail = await screen.findByTestId("concept-detail");
    // Relationship to the other concept is summarized.
    expect(within(detail).getByText("Project")).toBeInTheDocument();
    // Source evidence correlated by label mention, with citation.
    expect(
      within(detail).getByText(/Atlas is the internal codename/),
    ).toBeInTheDocument();
    expect(within(detail).getByText(/Source src-1234/)).toBeInTheDocument();
  });

  it("prompts to select a concept before any node is chosen", async () => {
    render(<ConceptGraphPanel memories={EVIDENCE} />);
    await waitFor(() =>
      expect(screen.getByTestId("concept-detail-empty")).toBeInTheDocument(),
    );
  });

  it("offers a scope filter when multiple scopes are present", async () => {
    render(<ConceptGraphPanel memories={EVIDENCE} />);
    await waitFor(() =>
      expect(screen.getByTestId("concept-graph-svg")).toBeInTheDocument(),
    );
    const select = screen.getByLabelText("Filter concept graph by scope");
    expect(select).toBeInTheDocument();
    // Filtering to scope-b drops the scope-a-only "project" node.
    fireEvent.change(select, { target: { value: "scope-b" } });
    await waitFor(() =>
      expect(screen.queryByTestId("concept-node-project")).not.toBeInTheDocument(),
    );
    expect(screen.getByTestId("concept-node-beacon")).toBeInTheDocument();
  });

  it("resets a stale scope filter when a refresh drops the selected scope", async () => {
    // First load has scope-a + scope-b; the refreshed graph has only scope-a.
    window.tessera.substrate.getConceptGraph = vi
      .fn()
      .mockResolvedValueOnce(GRAPH_JSON)
      .mockResolvedValue(
        JSON.stringify({
          nodes: [
            {
              id: "atlas",
              label: "Atlas",
              state: "canonical",
              scope_id: "scope-a",
              connections_count: 0,
            },
          ],
          edges: [],
          scope_filter: [],
          depth: 2,
          truncation: "complete",
        }),
      );
    render(<ConceptGraphPanel memories={EVIDENCE} />);
    await waitFor(() =>
      expect(screen.getByTestId("concept-graph-svg")).toBeInTheDocument(),
    );
    // Narrow to scope-b (only "beacon" remains in view).
    fireEvent.change(screen.getByLabelText("Filter concept graph by scope"), {
      target: { value: "scope-b" },
    });
    await waitFor(() =>
      expect(screen.getByTestId("concept-node-beacon")).toBeInTheDocument(),
    );
    // Refresh: scope-b is gone from the new graph. The stale filter must
    // fall back to "all" rather than stranding the user on an empty graph.
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    await waitFor(() =>
      expect(screen.getByTestId("concept-node-atlas")).toBeInTheDocument(),
    );
    expect(screen.queryByTestId("concept-graph-empty")).not.toBeInTheDocument();
    // Only one scope remains, so the scope <select> is no longer rendered.
    expect(
      screen.queryByLabelText("Filter concept graph by scope"),
    ).not.toBeInTheDocument();
  });

  it("correlates evidence on word boundaries, not mid-word substrings", async () => {
    const memories: SubstrateMemoryInfo[] = [
      {
        ...EVIDENCE[0],
        id: "mem-midword",
        content: "Atlassian ships Jira and Confluence to teams.",
      },
    ];
    render(<ConceptGraphPanel memories={memories} />);
    await waitFor(() =>
      expect(screen.getByTestId("concept-node-atlas")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("concept-node-atlas"));
    const detail = await screen.findByTestId("concept-detail");
    // "Atlassian" must NOT be surfaced as evidence for the concept "Atlas".
    expect(
      within(detail).queryByText(/Atlassian ships Jira/),
    ).not.toBeInTheDocument();
    expect(
      within(detail).getByText("No source evidence found for this concept."),
    ).toBeInTheDocument();
  });
});
