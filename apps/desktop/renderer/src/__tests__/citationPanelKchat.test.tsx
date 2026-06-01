/**
 * renderer-level coverage of the
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
    // enriched fields. Defaults
    // include realistic username + channel display name so the
    // baseline test renders the human-readable form; individual
    // tests override to `null` to exercise the raw-id fallback.
    senderUsername: "ken",
    channelDisplayName: "Eng - General",
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
  // clear call-count history on the
  // mutating citation methods so `toHaveBeenCalledTimes(1)`
  // assertions in individual tests start from a clean slate.
  // The shared `setup.ts` does not reset between tests, so call
  // counts accumulate across the whole suite by default.
  (window.tessera.citations.add as ReturnType<typeof vi.fn>).mockClear();
  (window.tessera.citations.remove as ReturnType<typeof vi.fn>).mockClear();
  (window.tessera.citations.replace as ReturnType<typeof vi.fn>).mockClear();
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

  it("renders the KChat badge, channel display name, username, and permalink anchor for KChat hits", async () => {
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
    // resolved sender username + channel
    // display name take precedence over the raw object ids. The
    // `@`/`#` sigils are part of the rendered string so the user
    // recognises the row as a KChat citation at a glance.
    expect(within(dialog).getByText("@ken")).toBeInTheDocument();
    expect(within(dialog).getByText("#Eng - General")).toBeInTheDocument();
    // The raw senderUserId / channelId should NOT appear in the
    // rendered output when display names are resolved — that's
    // the entire point of the enrichment pass.
    expect(within(dialog).queryByText("user-ken")).not.toBeInTheDocument();
    expect(
      within(dialog).queryByText("channel-xyz"),
    ).not.toBeInTheDocument();
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

  it("falls back to raw object ids when the IPC handler did not resolve names (offline / not visible)", async () => {
    (
      window.tessera.kchat.searchPosts as ReturnType<typeof vi.fn>
    ).mockResolvedValue([
      kchatHit({ senderUsername: null, channelDisplayName: null }),
    ]);

    const dialog = await openAddDialog();
    fireEvent.change(
      within(dialog).getByLabelText(/search sources for new citation/i),
      { target: { value: "Q3" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: /search/i }));

    await screen.findByText("KChat");
    // Fallback: raw ids are surfaced when the enrichment couldn't
    // resolve them. The row still renders so the user can pick a
    // citation candidate even on a flaky connection.
    expect(within(dialog).getByText("@user-ken")).toBeInTheDocument();
    expect(within(dialog).getByText("#channel-xyz")).toBeInTheDocument();
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
    // the saved sourceTitle prefers the
    // resolved channel display name so the stored citation reads
    // "Eng - General" in the artifact's saved citation list. The
    // sourceUri stays as the URN form (kchat://channel/<id>/post/<id>)
    // so retrieval remains anchored to the channel object id, not
    // its renameable display name.
    expect(arg).toMatchObject({
      artifactId: "artifact-1",
      sourceId: "src-kchat-1",
      sourceType: "kchat_post",
      sourceTitle: "Eng - General",
      sourceUri: "kchat://channel/channel-xyz/post/post-abc",
      chunkHash: "chathash",
    });
  });

  it("dispatches a kchat_post AddCitationRequest with channelId as title when channelDisplayName is null (offline fallback)", async () => {
    (
      window.tessera.kchat.searchPosts as ReturnType<typeof vi.fn>
    ).mockResolvedValue([
      kchatHit({ senderUsername: null, channelDisplayName: null }),
    ]);

    const dialog = await openAddDialog();
    fireEvent.change(
      within(dialog).getByLabelText(/search sources for new citation/i),
      { target: { value: "Q3" } },
    );
    fireEvent.click(within(dialog).getByRole("button", { name: /search/i }));

    const row = await screen.findByText("KChat");
    fireEvent.click(row.closest("button")!);

    await waitFor(() => {
      expect(window.tessera.citations.add).toHaveBeenCalledTimes(1);
    });
    const arg = (window.tessera.citations.add as ReturnType<typeof vi.fn>).mock
      .calls[0][0];
    // Fallback: when no display name was resolved, the stored
    // title falls back to the raw channel id. The citation is
    // still retrievable end-to-end because sourceUri carries the
    // canonical URN form.
    expect(arg).toMatchObject({
      sourceTitle: "channel-xyz",
      sourceUri: "kchat://channel/channel-xyz/post/post-abc",
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

  it("renders stored KChat-post citations with the KChat badge and channel title", async () => {
    // Mount the panel with a pre-existing kchat_post citation
    // and a pre-existing local_file citation. The kchat_post row
    // gets the KChat badge + `#`-prefixed title; the local_file
    // row keeps its existing rendering. This exercises the
    // post-vs-file branch in the stored-citation list (not the
    // search-hit picker).
    const kchatCitation: CitationInfo = {
      citationId: "cit-kchat-1",
      sourceId: "src-kchat-1",
      sourceType: "kchat_post",
      sourceTitle: "Eng - General",
      sourceUri: "kchat://channel/channel-xyz/post/post-abc",
      chunkHash: "chathash",
      page: null,
      confidence: 0.82,
      usedFor: "claim/q3",
      createdAt: "2024-09-12T15:30:00Z",
    };
    const fileCitation: CitationInfo = {
      citationId: "cit-file-1",
      sourceId: "src-file-1",
      sourceType: "local_file",
      sourceTitle: "q3-launch.md",
      sourceUri: "/repo/docs/q3-launch.md",
      chunkHash: "filehash",
      page: null,
      confidence: 0.55,
      usedFor: "claim/launch-date",
      createdAt: "2024-09-12T15:30:00Z",
    };
    (window.tessera.citations.list as ReturnType<typeof vi.fn>).mockResolvedValue(
      [kchatCitation, fileCitation],
    );

    render(
      <CitationPanel artifactId="artifact-1" isOpen={true} onClose={() => {}} />,
    );

    // Wait for the citation list to render.
    const kchatItem = await screen.findByText("#Eng - General");
    const li = kchatItem.closest("li")!;
    // The kchat_post item gets the modifier class and the
    // discriminator attribute the renderer wires from
    // `citation.sourceType`. Both are part of the stable API for
    // styling and for downstream test selectors.
    expect(li.className).toContain("citation-item-kchat");
    expect(li).toHaveAttribute("data-source-type", "kchat_post");
    // The badge renders once per kchat_post row (NOT per file row).
    expect(within(li).getByText("KChat")).toBeInTheDocument();
    // File item does NOT get the badge or the `#` sigil prefix.
    const fileItem = screen.getByText("q3-launch.md");
    const fileLi = fileItem.closest("li")!;
    expect(fileLi.className).not.toContain("citation-item-kchat");
    expect(fileLi).toHaveAttribute("data-source-type", "local_file");
    expect(within(fileLi).queryByText("KChat")).not.toBeInTheDocument();
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
