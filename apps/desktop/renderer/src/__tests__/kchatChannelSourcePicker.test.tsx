import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import KchatChannelSourcePicker from "../components/KchatChannelSourcePicker";
import { ToastProvider } from "../components/Toast";

function makeApi(overrides: Partial<typeof window.tessera.kchat> = {}) {
  return {
    isAvailable: vi.fn().mockResolvedValue(true),
    status: vi.fn().mockResolvedValue({ state: "connected" }),
    connect: vi.fn(),
    disconnect: vi.fn(),
    listTeams: vi
      .fn()
      .mockResolvedValue([
        { id: "team-1", name: "t1", display_name: "T1", type: "O" },
      ]),
    listChannels: vi.fn().mockResolvedValue([
      {
        id: "chan-1",
        team_id: "team-1",
        name: "general",
        display_name: "General",
        type: "O",
      },
    ]),
    listMembers: vi.fn(),
    listChannelFiles: vi.fn().mockResolvedValue([
      {
        id: "f-1",
        user_id: "uid01234567890123456789aaaa",
        name: "spec.pdf",
        extension: "pdf",
        mime_type: "application/pdf",
        size: 2048,
        create_at: 1700000000000,
        uploaderUsername: "alice",
      },
    ]),
    shareArtifact: vi.fn(),
    addChannelSource: vi.fn().mockResolvedValue({
      sourceId: "src-kchat-1",
      cacheDir: "/cache/kchat/chan-1",
    }),
    onStatusChange: vi.fn().mockReturnValue(() => {}),
    onEvent: vi.fn().mockReturnValue(() => {}),
    ...overrides,
  } as unknown as typeof window.tessera.kchat;
}

function wrap(node: React.ReactNode) {
  return render(<ToastProvider>{node}</ToastProvider>);
}

beforeEach(() => {
  window.localStorage.clear();
});

describe("KchatChannelSourcePicker", () => {
  it("renders teams, channels, and a file preview", async () => {
    const api = makeApi();
    wrap(<KchatChannelSourcePicker isOpen onClose={() => {}} api={api} />);
    expect(await screen.findByTestId("kchat-source-team")).toBeInTheDocument();
    await waitFor(() =>
      expect(api.listChannels).toHaveBeenCalledWith("team-1"),
    );
    await waitFor(() =>
      expect(api.listChannelFiles).toHaveBeenCalledWith("chan-1", 0, 50),
    );
    const list = await screen.findByTestId("kchat-source-file-list");
    expect(list).toHaveTextContent("spec.pdf");
  });

  it("calls addChannelSource and onAdded when Add is clicked", async () => {
    const api = makeApi();
    const onAdded = vi.fn();
    wrap(
      <KchatChannelSourcePicker
        isOpen
        onClose={() => {}}
        onAdded={onAdded}
        api={api}
      />,
    );
    await screen.findByTestId("kchat-source-add");
    // Wait for the full settle chain to converge before clicking. The
    // picker has three sequential effects:
    //   1. `useEffect[isOpen, kchat]` → `listTeams` → `setSelectedTeam`
    //   2. `useEffect[isOpen, kchat, selectedTeam]` → `listChannels` →
    //      `setSelectedChannel`
    //   3. `useEffect[isOpen, kchat, selectedChannel]` →
    //      `listChannelFiles` → `setFiles`
    // The Add button is `disabled={busy || !selectedChannel}`, so
    // clicking before step 2's `setSelectedChannel` commit re-renders
    // makes the click a no-op (the browser drops events on disabled
    // buttons, and `fireEvent.click` honours that). Waiting only for
    // `listChannels` to have been *called* satisfies the spy assertion
    // before the resulting state commit lands, racing the click under
    // CI's parallel-suite CPU pressure. Wait for the file-list render
    // — that's a guaranteed-after-step-3 signal that the entire chain
    // has settled and the button is enabled. Devin Review on PR #43
    // flagged this race pattern in earlier Block A passes; the same
    // architectural fix applies here.
    await waitFor(() =>
      expect(api.listChannelFiles).toHaveBeenCalledWith("chan-1", 0, 50),
    );
    await screen.findByText("spec.pdf");
    fireEvent.click(screen.getByTestId("kchat-source-add"));
    await waitFor(() =>
      expect(api.addChannelSource).toHaveBeenCalledWith("chan-1", "General"),
    );
    await waitFor(() => expect(onAdded).toHaveBeenCalledWith("src-kchat-1"));
  });

  it("surfaces an add-source error inline", async () => {
    const api = makeApi({
      addChannelSource: vi.fn().mockRejectedValue(new Error("network error")),
    });
    wrap(<KchatChannelSourcePicker isOpen onClose={() => {}} api={api} />);
    await screen.findByTestId("kchat-source-add");
    // Same settle-chain wait as the success-path test above — the
    // Add button is disabled until `selectedChannel` commits, and a
    // racy click before that commit silently no-ops.
    await waitFor(() =>
      expect(api.listChannelFiles).toHaveBeenCalledWith("chan-1", 0, 50),
    );
    await screen.findByText("spec.pdf");
    fireEvent.click(screen.getByTestId("kchat-source-add"));
    expect(await screen.findByTestId("kchat-source-error")).toHaveTextContent(
      /network error/,
    );
  });

  // ------------------------------------------------------------------
  // file preview metadata.
  //
  // The picker previously showed just `name (mime · size)`. The
  // task wires the IPC-enriched `uploaderUsername` + the existing
  // `create_at` epoch ms through to a second metadata line:
  //
  //   <icon>  spec.pdf
  //           PDF · 2.0 KB · Uploaded by @alice on May 1, 2024
  //
  // These tests assert the new wire-shape + render contract:
  //   1.  `uploaderUsername` lands on the row when non-null.
  //   2.  `user_id` falls back when `uploaderUsername` is null.
  //   3.  Icon glyph reflects the mime/extension family.
  //   4.  A zero / negative `create_at` renders an "unknown date"
  //       fallback instead of `Jan 1, 1970`.
  // ------------------------------------------------------------------
  describe("file preview metadata", () => {
    it("renders enriched uploaderUsername on the meta row", async () => {
      const api = makeApi();
      wrap(<KchatChannelSourcePicker isOpen onClose={() => {}} api={api} />);
      await screen.findByText("spec.pdf");
      const meta = await screen.findByTestId("kchat-source-file-f-1-meta");
      // Type label is uppercased extension (preferred over mime
      // for visual fit) — `pdf` → `PDF`.
      expect(meta).toHaveTextContent("PDF");
      // Size renders via `formatBytes(2048)` → `2.0 KB`.
      expect(meta).toHaveTextContent("2.0 KB");
      // Enriched uploader.
      expect(meta).toHaveTextContent("Uploaded by @alice");
      // Date format is locale-aware (`Intl.DateTimeFormat`) so we
      // only assert the year — the picker uses `Nov 14, 2023` in
      // en-US, but other CI locales may format the day differently.
      // The year is stable across all sensible locales because it
      // is unambiguous (numeric).
      expect(meta).toHaveTextContent("2023");
    });

    it("falls back to a truncated raw user id when uploaderUsername is null", async () => {
      const api = makeApi({
        listChannelFiles: vi.fn().mockResolvedValue([
          {
            id: "f-2",
            user_id: "missingxxx0123456789abcdef",
            name: "doc.txt",
            extension: "txt",
            mime_type: "text/plain",
            size: 512,
            create_at: 1700000000000,
            uploaderUsername: null,
          },
        ]),
      });
      wrap(<KchatChannelSourcePicker isOpen onClose={() => {}} api={api} />);
      const meta = await screen.findByTestId("kchat-source-file-f-2-meta");
      // Raw-id fallback prefixed with `@` and truncated to 8 chars
      // + an ellipsis. The full 26-char id stays on the wire (in
      // `f.user_id`); only the rendered string is shortened.
      expect(meta).toHaveTextContent("@missingx…");
    });

    it("picks the file icon based on mime family", async () => {
      const api = makeApi({
        listChannelFiles: vi.fn().mockResolvedValue([
          {
            id: "img-1",
            user_id: "uid01234567890123456789aaaa",
            name: "photo.png",
            extension: "png",
            mime_type: "image/png",
            size: 4096,
            create_at: 1700000000000,
            uploaderUsername: "alice",
          },
          {
            id: "vid-1",
            user_id: "uid01234567890123456789aaaa",
            name: "clip.mp4",
            extension: "mp4",
            mime_type: "video/mp4",
            size: 8192,
            create_at: 1700000000000,
            uploaderUsername: "alice",
          },
          {
            id: "zip-1",
            user_id: "uid01234567890123456789aaaa",
            name: "bundle.zip",
            extension: "zip",
            mime_type: "application/zip",
            size: 16384,
            create_at: 1700000000000,
            uploaderUsername: "alice",
          },
          {
            id: "default-1",
            user_id: "uid01234567890123456789aaaa",
            name: "unknown.blob",
            extension: "",
            mime_type: "",
            size: 32,
            create_at: 1700000000000,
            uploaderUsername: "alice",
          },
        ]),
      });
      wrap(<KchatChannelSourcePicker isOpen onClose={() => {}} api={api} />);
      // The icons live on a `data-testid` per file so we can
      // assert each row's chosen glyph without coupling to the
      // exact emoji codepoint (which varies by Node/JSDOM
      // version). We assert the rendered text node is non-empty
      // and matches the expected family-defining character.
      expect(
        (await screen.findByTestId("kchat-source-file-img-1-icon")).textContent,
      ).toContain("🖼");
      expect(
        screen.getByTestId("kchat-source-file-vid-1-icon").textContent,
      ).toContain("🎬");
      expect(
        screen.getByTestId("kchat-source-file-zip-1-icon").textContent,
      ).toContain("🗜");
      // The default glyph is a paperclip for unknown file types.
      expect(
        screen.getByTestId("kchat-source-file-default-1-icon").textContent,
      ).toContain("📎");
    });

    it("renders 'unknown date' for a non-positive create_at", async () => {
      const api = makeApi({
        listChannelFiles: vi.fn().mockResolvedValue([
          {
            id: "f-zero",
            user_id: "uid01234567890123456789aaaa",
            name: "ghost.txt",
            extension: "txt",
            mime_type: "text/plain",
            size: 0,
            create_at: 0,
            uploaderUsername: "alice",
          },
        ]),
      });
      wrap(<KchatChannelSourcePicker isOpen onClose={() => {}} api={api} />);
      const meta = await screen.findByTestId("kchat-source-file-f-zero-meta");
      expect(meta).toHaveTextContent("unknown date");
      // The `Jan 1, 1970` epoch artefact must NOT leak through —
      // assert by exclusion since some locales format the epoch
      // slightly differently but always include `1970`.
      expect(meta.textContent ?? "").not.toMatch(/1970/);
    });
  });
});
