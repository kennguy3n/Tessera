/**
 * Tests for the `slides:startPresentation` IPC channel.
 *
 * Electron's `BrowserWindow` / `app` and the `node:fs` writes are
 * mocked because the real window + display + filesystem can't run in
 * the vitest sandbox. The tests cover:
 *
 *   1. Channel registration on `ipcMain` (name pinning so the
 *      preload bridge can't drift away from main).
 *   2. Schema validation rejecting a malformed payload.
 *   3. The two-window contract: a fullscreen audience window and a
 *      (non-fullscreen) presenter window, both on the dedicated
 *      presentation partition, loading the same generated file with
 *      `#audience` / `#presenter` hashes.
 *   4. The empty-deck short-circuit (`{ ok: false, slideCount: 0 }`,
 *      no windows).
 *   5. The pure helpers (`normalizePresentation`, `escapeJsonForScript`,
 *      `buildPresentationHtml`).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const {
  handleMock,
  removeHandlerMock,
  loadFileMock,
  onMock,
  isDestroyedMock,
  browserWindowCtor,
  writeFileSyncMock,
  mkdirSyncMock,
  unlinkSyncMock,
} = vi.hoisted(() => ({
  handleMock: vi.fn(),
  removeHandlerMock: vi.fn(),
  loadFileMock: vi.fn().mockResolvedValue(undefined),
  onMock: vi.fn(),
  isDestroyedMock: vi.fn().mockReturnValue(false),
  browserWindowCtor: vi.fn(),
  writeFileSyncMock: vi.fn(),
  mkdirSyncMock: vi.fn(),
  unlinkSyncMock: vi.fn(),
}));

vi.mock("electron", () => {
  class FakeBrowserWindow {
    public options: unknown;
    public loadFile = loadFileMock;
    public on = onMock;
    public close = vi.fn();
    public isDestroyed = isDestroyedMock;
    constructor(options: unknown) {
      this.options = options;
      browserWindowCtor(options);
    }
  }
  return {
    ipcMain: {
      handle: (...args: unknown[]) => handleMock(...args),
      removeHandler: (...args: unknown[]) => removeHandlerMock(...args),
    },
    app: {
      getPath: (name: string) => `/tmp/tessera-test-${name}`,
    },
    BrowserWindow: FakeBrowserWindow,
  };
});

vi.mock("node:fs", () => {
  const writeFileSync = (...args: unknown[]) => writeFileSyncMock(...args);
  const mkdirSync = (...args: unknown[]) => mkdirSyncMock(...args);
  const unlinkSync = (...args: unknown[]) => unlinkSyncMock(...args);
  return {
    writeFileSync,
    mkdirSync,
    unlinkSync,
    default: { writeFileSync, mkdirSync, unlinkSync },
  };
});

import {
  buildPresentationHtml,
  escapeJsonForScript,
  normalizePresentation,
  presentationIndexKey,
  registerSlidesHandlers,
  PRESENTATION_INDEX_KEY,
  PRESENTATION_PARTITION,
} from "../ipc/slides";

function getHandler(
  channel: string,
): (event: unknown, ...args: unknown[]) => Promise<unknown> {
  const call = handleMock.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`No handler registered for ${channel}`);
  return call[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>;
}

const SAMPLE = {
  slides: [
    { title: "Intro", lines: ["hello", "world"], notes: "say hi" },
    { title: "Next", lines: ["point"], notes: "" },
  ],
  startIndex: 0,
  deckTitle: "My Deck",
};

beforeEach(() => {
  handleMock.mockClear();
  removeHandlerMock.mockClear();
  loadFileMock.mockClear();
  onMock.mockClear();
  browserWindowCtor.mockClear();
  writeFileSyncMock.mockClear();
  mkdirSyncMock.mockClear();
  unlinkSyncMock.mockClear();
  isDestroyedMock.mockReturnValue(false);
});

describe("normalizePresentation", () => {
  it("clamps startIndex into range", () => {
    expect(normalizePresentation({ ...SAMPLE, startIndex: 99 }).startIndex).toBe(
      1,
    );
    expect(
      normalizePresentation({ ...SAMPLE, startIndex: 0 }).startIndex,
    ).toBe(0);
  });

  it("defaults a blank deck title", () => {
    expect(
      normalizePresentation({ ...SAMPLE, deckTitle: "   " }).deckTitle,
    ).toBe("Presentation");
    expect(
      normalizePresentation({ ...SAMPLE, deckTitle: undefined }).deckTitle,
    ).toBe("Presentation");
  });

  it("handles an empty deck without going negative", () => {
    expect(
      normalizePresentation({ slides: [], startIndex: 3 }).startIndex,
    ).toBe(0);
  });
});

describe("escapeJsonForScript", () => {
  it("neutralises script-closing and JS-illegal separators", () => {
    const out = escapeJsonForScript('{"x":"</script><b>&"}\u2028');
    expect(out).not.toContain("</script>");
    expect(out).toContain("\\u003c");
    expect(out).toContain("\\u0026");
    expect(out).toContain("\\u2028");
  });
});

describe("buildPresentationHtml", () => {
  it("embeds the deck JSON and renders via textContent only", () => {
    const deck = normalizePresentation({
      ...SAMPLE,
      slides: [
        { title: "Intro", lines: ["a <b> c", "x & y"], notes: "</script>" },
      ],
    });
    const html = buildPresentationHtml(deck);
    expect(html).toContain('id="deck-data"');
    expect(html).toContain("My Deck");
    // Deck strings live inside the JSON island, escaped — a literal `<`,
    // `&`, or `</script>` from the deck must never appear raw (which
    // could break out of the JSON <script> container).
    expect(html).toContain("\\u003c");
    expect(html).toContain("\\u0026");
    expect(html).not.toContain("a <b> c");
    // The page never assigns innerHTML — every deck string is rendered
    // with textContent, so deck content can't inject markup.
    expect(html).not.toContain("innerHTML");
    expect(html).toContain("textContent");
    // Hash-based role switch is present.
    expect(html).toContain("presenter");
    expect(html).toContain("audience");
  });

  it("embeds the provided per-presentation index key", () => {
    const deck = normalizePresentation(SAMPLE);
    const html = buildPresentationHtml(deck, presentationIndexKey("abc123"));
    // The runtime script must broadcast/listen on the unique key, not
    // the bare prefix, so concurrent presentations don't collide.
    expect(html).toContain(
      `var KEY = ${JSON.stringify("tessera:presentation:index:abc123")}`,
    );
  });

  it("escapes the index key so a hostile key cannot break out of the script", () => {
    // The key is exported API: a future caller could feed it
    // attacker-influenced input, so embedding it must be escaped too.
    const html = buildPresentationHtml(
      normalizePresentation(SAMPLE),
      'evil</script><script>alert(1)</script>',
    );
    expect(html).not.toContain("</script><script>alert(1)");
    expect(html).toContain("\\u003c/script\\u003e");
  });

  it("escapes a hostile title so it cannot break out of the doc", () => {
    const html = buildPresentationHtml(
      normalizePresentation({
        ...SAMPLE,
        deckTitle: '</title><script>alert(1)</script>',
      }),
    );
    expect(html).not.toContain("<script>alert(1)</script>");
    expect(html).toContain("&lt;script&gt;");
  });
});

describe("registerSlidesHandlers", () => {
  it("registers the slides:startPresentation channel", () => {
    registerSlidesHandlers();
    expect(
      handleMock.mock.calls.some((c) => c[0] === "slides:startPresentation"),
    ).toBe(true);
  });

  it("rejects a malformed payload (missing slides array)", async () => {
    registerSlidesHandlers();
    const handler = getHandler("slides:startPresentation");
    await expect(
      handler({}, { startIndex: 0 }),
    ).rejects.toBeTruthy();
  });

  it("opens a fullscreen audience window and a presenter window", async () => {
    registerSlidesHandlers();
    const handler = getHandler("slides:startPresentation");
    const result = await handler({}, SAMPLE);

    expect(result).toEqual({ ok: true, slideCount: 2 });
    expect(writeFileSyncMock).toHaveBeenCalledTimes(1);
    expect(browserWindowCtor).toHaveBeenCalledTimes(2);
    expect(loadFileMock).toHaveBeenCalledTimes(2);

    const [audienceOpts, presenterOpts] = browserWindowCtor.mock.calls.map(
      (c) => c[0] as { fullscreen?: boolean; webPreferences: { partition: string } },
    );
    expect(audienceOpts.fullscreen).toBe(true);
    expect(presenterOpts.fullscreen).toBeUndefined();
    expect(audienceOpts.webPreferences.partition).toBe(PRESENTATION_PARTITION);
    expect(presenterOpts.webPreferences.partition).toBe(PRESENTATION_PARTITION);

    const hashes = loadFileMock.mock.calls.map(
      (c) => (c[1] as { hash: string }).hash,
    );
    expect(hashes).toEqual(["audience", "presenter"]);
  });

  it("gives each presentation a distinct localStorage key (no cross-talk)", async () => {
    registerSlidesHandlers();
    const handler = getHandler("slides:startPresentation");
    await handler({}, SAMPLE);
    await handler({}, SAMPLE);

    // Both windows of ONE presentation share its file (and thus its
    // key), but the two presentations must embed DIFFERENT keys so the
    // shared persistent partition can't make them step on each other.
    const htmls = writeFileSyncMock.mock.calls.map((c) => c[1] as string);
    expect(htmls).toHaveLength(2);
    const keyOf = (html: string) =>
      /var KEY = "([^"]+)"/.exec(html)?.[1] ?? null;
    const [k1, k2] = htmls.map(keyOf);
    expect(k1).not.toBeNull();
    expect(k2).not.toBeNull();
    expect(k1).not.toBe(k2);
    // Each key is namespaced under the shared prefix.
    expect(k1?.startsWith(`${PRESENTATION_INDEX_KEY}:`)).toBe(true);
    expect(k2?.startsWith(`${PRESENTATION_INDEX_KEY}:`)).toBe(true);
  });

  it("removes the generated temp file only once both windows have closed", async () => {
    registerSlidesHandlers();
    const handler = getHandler("slides:startPresentation");
    await handler({}, SAMPLE);

    const writtenFile = writeFileSyncMock.mock.calls[0][0] as string;
    const closedHandlers = onMock.mock.calls
      .filter((c) => c[0] === "closed")
      .map((c) => c[1] as () => void);
    expect(closedHandlers).toHaveLength(2);

    // First window closes: the file is still needed by the second.
    closedHandlers[0]();
    expect(unlinkSyncMock).not.toHaveBeenCalled();

    // Second window closes: now the temp file is cleaned up exactly once.
    closedHandlers[1]();
    expect(unlinkSyncMock).toHaveBeenCalledTimes(1);
    expect(unlinkSyncMock).toHaveBeenCalledWith(writtenFile);
  });

  it("short-circuits on an empty deck without opening windows", async () => {
    registerSlidesHandlers();
    const handler = getHandler("slides:startPresentation");
    const result = await handler({}, { slides: [], startIndex: 0 });
    expect(result).toEqual({ ok: false, slideCount: 0 });
    expect(browserWindowCtor).not.toHaveBeenCalled();
    expect(writeFileSyncMock).not.toHaveBeenCalled();
  });
});
