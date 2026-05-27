/**
 * Block D Task 1 (Phase 14): renderer-level coverage of the
 * CitationPanel's KChat-post integration.
 *
 * Scope of these tests (a thin layer over the existing setup mock):
 *
 *   1. AddCitationDialog fan-outs the query into both
 *      `sources.searchSources` AND `kchat.searchPosts` and renders
 *      a single merged list ordered by relevance score.
 *   2. KChat-post rows render the KChat badge, sender, formatted
 *      timestamp, and the "Open in KChat" permalink anchor when
 *      the IPC handler composed one.
 *   3. When the user is disconnected, the IPC handler returns a
 *      `permalink: null` and the row does NOT render the anchor.
 *   4. Picking a KChat row dispatches the `kchat_post` source-type
 *      AddCitationRequest (with the kchat:// URN) rather than the
 *      `local_file` shape.
 *   5. A failure in `kchat.searchPosts` does NOT hide the file
 *      results (defense-in-depth: `Promise.allSettled` on both
 *      branches).
 *   6. The merged sort interleaves the two sources by relevance
 *      score, not by source kind.
 *
 * These exercise the renderer integration of the IPC contract;
 * the IPC handler itself is covered by
 * `electron/__tests__/kchatIpc.test.ts`.
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
  KchatPostSearchHit,
  SearchHit,
} from "../types/ipc";

function fileHit(over: Partial<SearchHit> = {}): SearchHit {
  return {
    sourcePath: "/repo/docs/q3-launch.md",
    sourceId: "src-file-1",
    chunkHash: "filehash",
    chunkContent: "Q3 launch is on Sept 15",
    relevanceScore: 0.4,
    excerpt: "Q3 launch is on Sept 15",
    ...over,
  };
}

function kchatHit(over: Partial<KchatPostSearchHit> = {}): KchatPostSearchHit {
  return {
    kind: "kchat_post",
    sourcePath: "/var/cache/tessera/kchat/channel-xyz",
    sourceId: "src-kchat-1",
    chunkHash: "chathash",
    chunkContent: "team agreed: push Q3 launch to Sept 15",
    relevanceScore: 0.8,
    excerpt: "team agreed: push Q3 launch to Sept 15",
    postId: "post-abc",
    channelId: "channel-xyz",
    rootId: null,
    senderUserId: "user-ken",
    createdAtMs: new Date("2024-09-12T15:30:00Z").getTime(),
    editedAtMs: 0,
    permalink:
      "https://kchat.example.com/_redirect/pl/post-abc",
    ...over,
  };
}

beforeEach(() => {
  // Reset the citations.list / freshness defaults so the panel
  // mounts in a known-empty state.
  (window.tessera.citations.list as ReturnType<typeof vi.fn>).mockResolvedValue(
    [] as CitationInfo[],
  );
  (
    window.tessera.citations.checkFreshness as ReturnType<typeof vi.fn>
  ).mockResolvedValue("fresh");
  (
    window.tessera.sources.searchSources as ReturnType<typeof vi.fn>
  ).mockResolvedValue([] as SearchHit[]);
  (
    window.tessera.kchat.searchPosts as ReturnType<typeof vi.fn>
  ).mockResolvedValue([] as KchatPostSearchHit[]);
});

async function openAddDialog() {
  render(
    <CitationPanel artifactId="artifact-1" isOpen={true} onClose={() => {}} />,
  );
  await waitFor(() =>
    expect(screen.queryByText("Loading…")).not.toBeInTheDocument(),
  );
  const addBtn = screen.getByRole("button", { name: /add a new citation/i });
  fireEvent.click(addBtn);
  return await screen.findByRole("dialog", { name: /add citation/i });
}

describe("CitationPanel + KChat post retrieval", () => {
  it("fan-outs the query into both file and KChat retrieval branches", async () => {
    (
      window.tessera.sources.searchSources as ReturnType<typeof vi.fn>
    ).mockResolvedValue([fileHit()]);
    (
      window.tessera.kchat.searchPosts as ReturnType<typeof vi.fn>
    ).mockResolvedValue([kchatHit()]);

    const dialog = await openAddDialog();
    fireEvent.change(
      within(dialog).getByLabelText(/search sources for new citation/i),
      { target: { value: "Q3 launch deadline" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: /search/i }));

    await waitFor(() => {
      expect(window.tessera.sources.searchSources).toHaveBeenCalledWith(
        "Q3 launch deadline",
        10,
      );
      expect(window.tessera.kchat.searchPosts).toHaveBeenCalledWith(
        "Q3 launch deadline",
        10,
      );
    });
  });

  it("renders the KChat badge, sender, and permalink anchor for KChat hits", async () => {
    (
      window.tessera.kchat.searchPosts as ReturnType<typeof vi.fn>
    ).mockResolvedValue([kchatHit()]);

    const dialog = await openAddDialog();
    fireEvent.change(
      within(dialog).getByLabelText(/search sources for new citation/i),
      { target: { value: "Q3" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: /search/i }));

    await screen.findByText("KChat");
    expect(within(dialog).getByText("user-ken")).toBeInTheDocument();
    // Permalink anchor — composed by the IPC handler, surfaced
    // here as an external-target anchor on the row.
    const permalink = within(dialog).getByRole("link", {
      name: /open post in kchat/i,
    });
    expect(permalink).toHaveAttribute(
      "href",
      "https://kchat.example.com/_redirect/pl/post-abc",
    );
    expect(permalink).toHaveAttribute("target", "_blank");
    expect(permalink).toHaveAttribute("rel", expect.stringContaining("noopener"));
  });

  it("hides the permalink anchor when the IPC handler returned permalink: null (disconnected)", async () => {
    (
      window.tessera.kchat.searchPosts as ReturnType<typeof vi.fn>
    ).mockResolvedValue([kchatHit({ permalink: null })]);

    const dialog = await openAddDialog();
    fireEvent.change(
      within(dialog).getByLabelText(/search sources for new citation/i),
      { target: { value: "Q3" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: /search/i }));

    await screen.findByText("KChat");
    expect(
      within(dialog).queryByRole("link", { name: /open post in kchat/i }),
    ).not.toBeInTheDocument();
  });

  it("dispatches a kchat_post AddCitationRequest with kchat:// URN when a KChat row is picked", async () => {
    (
      window.tessera.kchat.searchPosts as ReturnType<typeof vi.fn>
    ).mockResolvedValue([kchatHit()]);

    const dialog = await openAddDialog();
    fireEvent.change(
      within(dialog).getByLabelText(/search sources for new citation/i),
      { target: { value: "Q3" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: /search/i }));

    const row = await screen.findByText("KChat");
    // Click on the row container — the badge is inside the button.
    fireEvent.click(row.closest("button")!);

    await waitFor(() => {
      expect(window.tessera.citations.add).toHaveBeenCalledTimes(1);
    });
    const arg = (window.tessera.citations.add as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    expect(arg).toMatchObject({
      artifactId: "artifact-1",
      sourceId: "src-kchat-1",
      sourceType: "kchat_post",
      sourceTitle: "channel-xyz",
      sourceUri: "kchat://channel/channel-xyz/post/post-abc",
      chunkHash: "chathash",
    });
  });

  it("interleaves merged results by relevance score regardless of source kind", async () => {
    // Two file hits with lower relevance, one KChat hit with the
    // highest score: the KChat row should render first.
    (
      window.tessera.sources.searchSources as ReturnType<typeof vi.fn>
    ).mockResolvedValue([
      fileHit({ chunkHash: "fh-low", relevanceScore: 0.1 }),
      fileHit({ chunkHash: "fh-mid", relevanceScore: 0.5 }),
    ]);
    (
      window.tessera.kchat.searchPosts as ReturnType<typeof vi.fn>
    ).mockResolvedValue([
      kchatHit({ postId: "post-top", relevanceScore: 0.9 }),
    ]);

    const dialog = await openAddDialog();
    fireEvent.change(
      within(dialog).getByLabelText(/search sources for new citation/i),
      { target: { value: "Q3" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: /search/i }));

    const results = await within(dialog).findByRole("list");
    const buttons = within(results).getAllByRole("button");
    // First row is the KChat hit (highest relevance), then the
    // mid-relevance file hit, then the low-relevance file hit.
    expect(buttons[0]).toHaveAttribute("data-source-kind", "kchat_post");
    expect(buttons[1]).not.toHaveAttribute("data-source-kind", "kchat_post");
    expect(buttons[2]).not.toHaveAttribute("data-source-kind", "kchat_post");
  });

  it("renders file hits when KChat retrieval throws (defense-in-depth allSettled posture)", async () => {
    (
      window.tessera.sources.searchSources as ReturnType<typeof vi.fn>
    ).mockResolvedValue([fileHit()]);
    (
      window.tessera.kchat.searchPosts as ReturnType<typeof vi.fn>
    ).mockRejectedValue(new Error("rate limit exceeded"));

    const dialog = await openAddDialog();
    fireEvent.change(
      within(dialog).getByLabelText(/search sources for new citation/i),
      { target: { value: "Q3" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: /search/i }));

    // File hit still renders even though KChat branch threw.
    await within(dialog).findByText("/repo/docs/q3-launch.md");
    expect(within(dialog).queryByText("KChat")).not.toBeInTheDocument();
  });
});
