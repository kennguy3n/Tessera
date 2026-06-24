/**
 * Integration tests for the `dialog:*` IPC channels.
 *
 * The Electron `dialog` module is mocked because the real native
 * dialog cannot run in the vitest sandbox (no display, no Cocoa /
 * GTK / Win32 process to host the picker). The tests exercise:
 *
 *   1. Handler registration on `ipcMain` (channel name pinning so
 *      the renderer's preload bridge can't drift away from main).
 *   2. Schema validation on the payload (`OpenImageDialogSchema`
 *      strict mode rejects unknown keys; the handler propagates the
 *      zod error so a bad renderer call is loud).
 *   3. The exact options shape passed to `dialog.showOpenDialog` —
 *      `properties: ["openFile", "dontAddToRecent"]` (no multi-
 *      select, no directories, no recent-files leakage),
 *      `filters[0].extensions === PICK_IMAGE_EXTENSIONS` (the
 *      filter is locked main-side; a hostile renderer can't widen
 *      it to `["*"]`).
 *   4. The return-shape contract:
 *      - cancelled: `{ canceled: true, filePath: null }`
 *      - chosen:    `{ canceled: false, filePath: "<abs path>" }`
 *      The renderer branches on the boolean rather than checking
 *      `filePath` for falsiness so the result must always carry
 *      both fields.
 *   5. The `title` default ("Choose an image") when the renderer
 *      omits it.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const handleMock = vi.fn();
const removeHandlerMock = vi.fn();
const showOpenDialogMock = vi.fn();
const showSaveDialogMock = vi.fn();
const browserWindowFromWebContentsMock = vi.fn();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (...args: unknown[]) => handleMock(...args),
    removeHandler: (...args: unknown[]) => removeHandlerMock(...args),
  },
  dialog: {
    showOpenDialog: (...args: unknown[]) => showOpenDialogMock(...args),
    showSaveDialog: (...args: unknown[]) => showSaveDialogMock(...args),
  },
  BrowserWindow: {
    fromWebContents: (...args: unknown[]) =>
      browserWindowFromWebContentsMock(...args),
  },
}));

import { PICK_IMAGE_EXTENSIONS, registerDialogHandlers } from "../ipc/dialog";

function getHandler(
  channel: string,
): (event: unknown, ...args: unknown[]) => Promise<unknown> {
  const call = handleMock.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`No handler registered for ${channel}`);
  return call[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>;
}

const FAKE_EVENT = { sender: { id: 1 } as unknown };

describe("PICK_IMAGE_EXTENSIONS", () => {
  it("matches the documented image-format allow-list", () => {
    // Pinned so a future refactor that adds (say) ".heic" without
    // updating the CSP / the vision sidecar / the renderer preview
    // fails this test instead of silently widening the picker.
    expect(PICK_IMAGE_EXTENSIONS).toEqual([
      "jpg",
      "jpeg",
      "png",
      "webp",
      "gif",
      "bmp",
    ]);
  });

  it("is a readonly array (frozen-ish at the type level)", () => {
    // Smoke check: the const should be usable as input to other
    // arrays without TS complaining about mutation. The runtime
    // check just makes sure the export survived bundling.
    expect(Array.isArray(PICK_IMAGE_EXTENSIONS)).toBe(true);
    expect(PICK_IMAGE_EXTENSIONS.length).toBeGreaterThan(0);
  });
});

describe("registerDialogHandlers", () => {
  beforeEach(() => {
    handleMock.mockReset();
    removeHandlerMock.mockReset();
    showOpenDialogMock.mockReset();
    showSaveDialogMock.mockReset();
    browserWindowFromWebContentsMock.mockReset();
    // Default: the picker returns a real path (override per-test
    // for the cancellation case).
    showOpenDialogMock.mockResolvedValue({
      canceled: false,
      filePaths: ["/tmp/whiteboard.png"],
    });
    // Default: no BrowserWindow for the sender (matches the test-
    // harness sender stub). The handler falls back to the
    // window-less `showOpenDialog(options)` overload.
    browserWindowFromWebContentsMock.mockReturnValue(null);
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("registers both dialog:showSaveDialog and dialog:pickImage", () => {
    registerDialogHandlers();
    const channels = handleMock.mock.calls.map((c) => c[0] as string);
    expect(channels).toEqual(
      expect.arrayContaining(["dialog:showSaveDialog", "dialog:pickImage"]),
    );
  });
});

describe("dialog:pickImage handler", () => {
  beforeEach(() => {
    handleMock.mockReset();
    removeHandlerMock.mockReset();
    showOpenDialogMock.mockReset();
    browserWindowFromWebContentsMock.mockReset();
    showOpenDialogMock.mockResolvedValue({
      canceled: false,
      filePaths: ["/tmp/whiteboard.png"],
    });
    browserWindowFromWebContentsMock.mockReturnValue(null);
    registerDialogHandlers();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("opens an OS file picker with the locked image-extensions filter", async () => {
    const handler = getHandler("dialog:pickImage");
    const result = await handler(FAKE_EVENT, {});
    expect(showOpenDialogMock).toHaveBeenCalledTimes(1);
    const passedOptions = showOpenDialogMock.mock.calls[0][0] as {
      title: string;
      properties: string[];
      filters: Array<{ name: string; extensions: string[] }>;
    };
    expect(passedOptions.title).toBe("Choose an image");
    expect(passedOptions.properties).toEqual(["openFile", "dontAddToRecent"]);
    expect(passedOptions.filters).toHaveLength(1);
    expect(passedOptions.filters[0]?.extensions).toEqual([
      "jpg",
      "jpeg",
      "png",
      "webp",
      "gif",
      "bmp",
    ]);
    expect(result).toEqual({
      canceled: false,
      filePath: "/tmp/whiteboard.png",
    });
  });

  it("honours a custom title from the renderer", async () => {
    const handler = getHandler("dialog:pickImage");
    await handler(FAKE_EVENT, { title: "Pick a whiteboard photo" });
    const passedOptions = showOpenDialogMock.mock.calls[0][0] as {
      title: string;
    };
    expect(passedOptions.title).toBe("Pick a whiteboard photo");
  });

  it("returns { canceled: true, filePath: null } when the user dismisses", async () => {
    showOpenDialogMock.mockResolvedValueOnce({
      canceled: true,
      filePaths: [],
    });
    const handler = getHandler("dialog:pickImage");
    const result = await handler(FAKE_EVENT, {});
    expect(result).toEqual({ canceled: true, filePath: null });
  });

  it("returns { canceled: true, filePath: null } when the picker returns an empty path array", async () => {
    // Some Electron/GTK builds report `canceled: false` but an
    // empty `filePaths` array on certain failure modes (broken
    // symlink target, etc.). The handler must not blow up trying
    // to index [0] in that case.
    showOpenDialogMock.mockResolvedValueOnce({
      canceled: false,
      filePaths: [],
    });
    const handler = getHandler("dialog:pickImage");
    const result = await handler(FAKE_EVENT, {});
    expect(result).toEqual({ canceled: true, filePath: null });
  });

  it("returns only the first path even if showOpenDialog returns multiple", async () => {
    // Defensive: the handler passes `properties: ["openFile"]`
    // (singular, no multi-select), so Electron should only ever
    // return one path — but if a future refactor or a buggy
    // platform layer hands back two, the handler must collapse
    // to the first to keep the renderer's `filePath: string |
    // null` contract.
    showOpenDialogMock.mockResolvedValueOnce({
      canceled: false,
      filePaths: ["/tmp/first.png", "/tmp/second.png"],
    });
    const handler = getHandler("dialog:pickImage");
    const result = await handler(FAKE_EVENT, {});
    expect(result).toEqual({
      canceled: false,
      filePath: "/tmp/first.png",
    });
  });

  it("uses the parent BrowserWindow overload when one is available", async () => {
    const fakeWindow = { id: 99 } as unknown;
    browserWindowFromWebContentsMock.mockReturnValueOnce(fakeWindow);
    const handler = getHandler("dialog:pickImage");
    await handler(FAKE_EVENT, {});
    // First positional argument is the BrowserWindow handle.
    expect(showOpenDialogMock.mock.calls[0][0]).toBe(fakeWindow);
    expect(showOpenDialogMock.mock.calls[0][1]).toEqual(
      expect.objectContaining({
        properties: ["openFile", "dontAddToRecent"],
      }),
    );
  });

  it("falls back to the windowless overload when fromWebContents returns null", async () => {
    browserWindowFromWebContentsMock.mockReturnValueOnce(null);
    const handler = getHandler("dialog:pickImage");
    await handler(FAKE_EVENT, {});
    // No BrowserWindow argument — just the options object.
    expect(showOpenDialogMock.mock.calls[0][0]).toEqual(
      expect.objectContaining({
        properties: ["openFile", "dontAddToRecent"],
      }),
    );
    expect(showOpenDialogMock.mock.calls[0][1]).toBeUndefined();
  });

  it("rejects a payload with unknown keys (strict-mode schema)", async () => {
    const handler = getHandler("dialog:pickImage");
    await expect(
      handler(FAKE_EVENT, { title: "ok", properties: ["openFile"] }),
    ).rejects.toThrow();
    await expect(handler(FAKE_EVENT, { filters: [] })).rejects.toThrow();
    // The native dialog must NOT have been invoked when validation
    // fails — the renderer's bad call is caught at the schema
    // boundary.
    expect(showOpenDialogMock).not.toHaveBeenCalled();
  });

  it("rejects a payload with a title exceeding 512 chars", async () => {
    const handler = getHandler("dialog:pickImage");
    await expect(
      handler(FAKE_EVENT, { title: "x".repeat(513) }),
    ).rejects.toThrow();
    expect(showOpenDialogMock).not.toHaveBeenCalled();
  });

  it("treats null and undefined input as an empty options object", async () => {
    const handler = getHandler("dialog:pickImage");
    // The renderer's preload bridge calls
    // `ipcRenderer.invoke("dialog:pickImage", options ?? {})`, so
    // `null` should never reach here — but the handler should be
    // defensive in case a future caller passes one through.
    await expect(handler(FAKE_EVENT, undefined)).resolves.toEqual({
      canceled: false,
      filePath: "/tmp/whiteboard.png",
    });
    await expect(handler(FAKE_EVENT, null)).resolves.toEqual({
      canceled: false,
      filePath: "/tmp/whiteboard.png",
    });
  });
});
