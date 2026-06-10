/**
 * renderer coverage of the Session 6 "Knowledge" tab in CitationPanel.
 *
 * The Add/Replace citation dialogs now fan a query out to BOTH the
 * existing evidence search (chunk hits → "Sources" tab) AND the
 * observation-enriched search (`sources.searchEnriched` → "Knowledge"
 * tab). These tests assert:
 *
 *   1. After a search, both tabs render with accurate counts:
 *      "Sources (N)" from the chunk hits and "Knowledge (M)" from
 *      entities + facts + concepts (memories are intentionally not
 *      counted to avoid double-counting).
 *   2. Switching to the Knowledge tab renders the entity / fact /
 *      concept sections with their decay state and (for concepts) the
 *      co-occurring source count.
 *   3. The enriched search runs in PARALLEL with the evidence search
 *      and a rejection of `searchEnriched` degrades gracefully: the
 *      Sources tab still shows chunk hits and the Knowledge tab shows
 *      its empty-state copy rather than crashing the dialog.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  waitFor,
  within,
} from "@testing-library/react";
import CitationPanel from "../components/CitationPanel";
import type {
  CitationInfo,
  EnrichedSearchResult,
  KchatPostSearchHit,
  SearchHit,
  SubstrateConceptInfo,
  SubstrateMemoryInfo,
} from "../types/ipc";

function fileHit(over: Partial<SearchHit> = {}): SearchHit {
  return {
    sourcePath: "/repo/docs/acme.md",
    sourceId: "11111111-1111-4111-8111-111111111111",
    chunkHash: "filehash",
    chunkContent: "Acme Corp signed the Q3 contract",
    relevanceScore: 0.7,
    excerpt: "Acme Corp signed the Q3 contract",
    ...over,
  };
}

function memory(over: Partial<SubstrateMemoryInfo> = {}): SubstrateMemoryInfo {
  return {
    id: "22222222-2222-4222-8222-222222222222",
    scopeId: "33333333-3333-4333-8333-333333333333",
    observationType: "entity",
    content: "Acme Corp",
    state: "reinforced",
    retentionScore: 0.62,
    pinCount: 0,
    retrievalCount: 2,
    corroborationCount: 1,
    createdAt: 1_700_000_000,
    lastAccessedAt: 1_700_000_500,
    sourceId: "11111111-1111-4111-8111-111111111111",
    ...over,
  };
}

function concept(over: Partial<SubstrateConceptInfo> = {}): SubstrateConceptInfo {
  return {
    id: "44444444-4444-4444-8444-444444444444",
    label: "Acme Corp",
    definition: "concept node",
    state: "canonical",
    relatedSourceIds: ["11111111-1111-4111-8111-111111111111"],
    ...over,
  };
}

function enriched(over: Partial<EnrichedSearchResult> = {}): EnrichedSearchResult {
  return {
    hits: [],
    entities: [memory({ content: "Acme Corp", observationType: "entity" })],
    facts: [
      memory({
        id: "55555555-5555-4555-8555-555555555555",
        content: "Acme ships in Q4",
        observationType: "fact",
        state: "consolidated",
        retentionScore: 0.81,
      }),
    ],
    concepts: [concept()],
    memories: [],
    ...over,
  };
}

beforeEach(() => {
  (window.tessera.citations.list as ReturnType<typeof vi.fn>).mockResolvedValue(
    [] as CitationInfo[],
  );
  (
    window.tessera.citations.checkFreshness as ReturnType<typeof vi.fn>
  ).mockResolvedValue("fresh");
  (
    window.tessera.sources.searchSources as ReturnType<typeof vi.fn>
  ).mockResolvedValue([fileHit()] as SearchHit[]);
  (
    window.tessera.kchat.searchPosts as ReturnType<typeof vi.fn>
  ).mockResolvedValue([] as KchatPostSearchHit[]);
  (
    window.tessera.sources.searchEnriched as ReturnType<typeof vi.fn>
  ).mockResolvedValue(enriched());
});

async function openAddDialogAndSearch() {
  render(
    <CitationPanel artifactId="artifact-1" isOpen={true} onClose={() => {}} />,
  );
  await waitFor(() =>
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument(),
  );
  fireEvent.click(screen.getByRole("button", { name: /add a new citation/i }));
  const dialog = await screen.findByRole("dialog", { name: /add citation/i });
  const input = within(dialog).getByLabelText(/search sources/i);
  fireEvent.change(input, { target: { value: "acme" } });
  fireEvent.click(within(dialog).getByRole("button", { name: /^search$/i }));
  return dialog;
}

describe("CitationPanel + Knowledge tab", () => {
  it("renders both tabs with accurate counts after a search", async () => {
    const dialog = await openAddDialogAndSearch();

    // Sources tab: one file hit.
    const sourcesTab = await within(dialog).findByRole("tab", {
      name: /sources \(1\)/i,
    });
    expect(sourcesTab).toHaveAttribute("aria-selected", "true");

    // Knowledge tab: 1 entity + 1 fact + 1 concept = 3 (memories excluded).
    expect(
      within(dialog).getByRole("tab", { name: /knowledge \(3\)/i }),
    ).toBeInTheDocument();

    // The enriched search ran with the same query and a limit.
    expect(window.tessera.sources.searchEnriched).toHaveBeenCalledWith(
      "acme",
      10,
    );
  });

  it("shows entities, facts and concepts when the Knowledge tab is active", async () => {
    const dialog = await openAddDialogAndSearch();
    const knowledgeTab = await within(dialog).findByRole("tab", {
      name: /knowledge \(3\)/i,
    });
    fireEvent.click(knowledgeTab);

    // Section headings with their counts.
    expect(within(dialog).getByText(/Entities \(1\)/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Facts \(1\)/)).toBeInTheDocument();
    expect(within(dialog).getByText(/Concepts \(1\)/)).toBeInTheDocument();

    // A fact surface and its retention badge (0.81 -> 81%).
    expect(within(dialog).getByText("Acme ships in Q4")).toBeInTheDocument();
    expect(within(dialog).getByText("81%")).toBeInTheDocument();

    // The concept shows its co-occurring source count.
    expect(within(dialog).getByText(/1 source$/)).toBeInTheDocument();
  });

  it("degrades gracefully when the enriched search rejects", async () => {
    (
      window.tessera.sources.searchEnriched as ReturnType<typeof vi.fn>
    ).mockRejectedValueOnce(new Error("substrate offline"));

    const dialog = await openAddDialogAndSearch();

    // Sources tab still shows the chunk hit.
    await within(dialog).findByRole("tab", { name: /sources \(1\)/i });
    expect(
      within(dialog).getByText("Acme Corp signed the Q3 contract"),
    ).toBeInTheDocument();

    // Knowledge tab collapses to (0) and shows the empty-state copy.
    const knowledgeTab = within(dialog).getByRole("tab", {
      name: /knowledge \(0\)/i,
    });
    fireEvent.click(knowledgeTab);
    expect(
      within(dialog).getByText(/No entities, facts, or concepts found/i),
    ).toBeInTheDocument();
  });
});
