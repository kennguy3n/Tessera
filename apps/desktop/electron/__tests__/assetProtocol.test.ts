/**
 * Regression tests for the `tessera-asset://` custom protocol — the
 * security-sensitive surface that maps renderer URL requests to on-disk
 * files under `<userData>/generated-images/`.
 *
 * Why this test exists
 * --------------------
 * `apps/desktop/electron/assetProtocol.ts` introduces:
 *
 *   1. A custom protocol handler installed against the default Electron
 *      session via `protocol.handle("tessera-asset", ...)`. This handler
 *      is a write-path-restricted file-server: every URL the renderer
 *      requests is decoded and tested against an absolute-prefix
 *      containment check before its bytes are streamed back.
 *   2. `pathToAssetUrl(absolutePath, userDataDir)` — a main-process
 *      helper that maps an on-disk path returned by `imagegen:generate`
 *      to a `tessera-asset://` URL the renderer can drop into
 *      `<img src>`. This helper is what the IPC handler uses to mint
 *      the `assetUrl` field on every successful generation.
 *
 * Both are listed in `CONTRIBUTING.md` as security-sensitive boundaries
 * (custom protocol handler registration + path-resolution guard +
 * CSP-widening scheme), so the project's contract requires a regression
 * test that pins the traversal invariant. The module's own doc-comment
 * at `assetProtocol.ts:31` explicitly names this test file as the pin.
 *
 * What is pinned
 * --------------
 *   A. `pathToAssetUrl` returns `null` for every input outside
 *      `<userData>/generated-images/`:
 *        - `..`-based traversal escapes
 *        - sibling-prefix attack (`generated-images-backup/...` — the
 *          attack the `+ path.sep` suffix is designed to defeat)
 *        - completely unrelated absolute paths
 *        - the allow-list root directory itself (semantic asymmetry
 *          with the handler's 403 was fixed by the pass-1 advisory).
 *   B. `pathToAssetUrl` returns the correct `tessera-asset://` URL for
 *      valid paths, including paths with spaces / unicode that must be
 *      percent-encoded per segment so they survive the round-trip
 *      through `decodeURIComponent` on the handler side.
 *   C. `registerAssetProtocolHandler`'s installed handler rejects:
 *        - any request whose `URL.host` is not `generated-images` (403)
 *        - any decoded path that resolves outside `allowedRoot` (403)
 *        - the bare directory root with no filename (403, no listing)
 *      and serves a `Response` from `net.fetch` for paths within the
 *      allow-list.
 *
 * Test shape
 * ----------
 * The handler tests do NOT run a real Electron app. Instead we mock
 * `electron`'s `protocol.handle` + `net.fetch` + `app.getPath`, capture
 * the request-handler function registered at module load, and invoke
 * it with synthetic `Request` objects (Node 18+ has a global `Request`
 * constructor we can use directly).
 *
 * The on-disk fixtures are written into a fresh `os.tmpdir()`-based
 * directory per test so symlinks, real paths, and the
 * `os.realpath`-based normalisation done by `path.resolve` all behave
 * identically to production. This pattern matches the existing
 * `imagegenIpc.test.ts` setup.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as os from "os";
import * as path from "path";

// --- electron mock ----------------------------------------------------
//
// `protocol.handle` is captured into `capturedHandler` so each test can
// invoke the handler directly with a synthetic `Request` instead of
// having to spin up a real Electron session. `net.fetch` is mocked to
// return a marker `Response` whose body is the resolved `file://` URL
// the handler asked us to fetch — that lets the success-path tests
// assert which on-disk path the handler resolved without actually
// reading the file (and without making the test dependent on the
// real `net.fetch` plumbing, which isn't available in vitest).
let capturedHandler:
  | ((request: Request) => Promise<Response> | Response)
  | null = null;
const registerSchemesMock = vi.fn();
const protocolHandleMock = vi.fn((_scheme: string, handler: typeof capturedHandler) => {
  capturedHandler = handler;
});
const netFetchMock = vi.fn(async (url: string, _opts?: unknown) => {
  return new Response(`fetched:${url}`, {
    status: 200,
    headers: { "x-test-url": url },
  });
});
const appGetPathMock = vi.fn((which: string) => {
  if (which === "userData") {
    throw new Error("userData should be supplied explicitly in tests");
  }
  throw new Error(`unexpected getPath: ${which}`);
});

vi.mock("electron", () => ({
  app: {
    getPath: (which: string) => appGetPathMock(which),
  },
  protocol: {
    registerSchemesAsPrivileged: (...args: unknown[]) =>
      registerSchemesMock(...args),
    handle: (scheme: string, handler: typeof capturedHandler) =>
      protocolHandleMock(scheme, handler),
  },
  net: {
    fetch: (url: string, opts?: unknown) => netFetchMock(url, opts),
  },
}));

// Imported AFTER the mock so the module picks up the stubbed electron.
import {
  pathToAssetUrl,
  registerAssetProtocolHandler,
  registerAssetProtocolScheme,
  TESSERA_ASSET_SCHEME,
} from "../assetProtocol";

let workdir = "";
let allowedRoot = "";

beforeEach(async () => {
  // Realpath the tmpdir prefix — on macOS `os.tmpdir()` returns
  // `/var/folders/...` which is a symlink to `/private/var/folders/...`.
  // `path.resolve` does not follow symlinks but `fs.realpathSync` does,
  // and our production code is also `path.resolve`-only. Using
  // `realpathSync.native` on the tmpdir base aligns the test against
  // however the host's filesystem actually presents the path so the
  // `allowedRoot + path.sep` startsWith check works identically on
  // macOS, Linux, and Windows.
  const tmpBase = fs.realpathSync.native(os.tmpdir());
  workdir = await fsp.mkdtemp(path.join(tmpBase, "asset-protocol-test-"));
  allowedRoot = path.join(workdir, "generated-images");
  await fsp.mkdir(allowedRoot, { recursive: true });
  capturedHandler = null;
  protocolHandleMock.mockClear();
  registerSchemesMock.mockClear();
  netFetchMock.mockClear();
});

afterEach(async () => {
  try {
    await fsp.rm(workdir, { recursive: true, force: true });
  } catch {
    // Best-effort cleanup — Windows occasionally holds locks on
    // freshly-written files for a few ms after the test finishes.
  }
});

// ---------------------------------------------------------------------
// pathToAssetUrl
// ---------------------------------------------------------------------

describe("pathToAssetUrl", () => {
  it("returns a correctly-shaped tessera-asset:// URL for a valid file under generated-images/", () => {
    const file = path.join(allowedRoot, "art-001", "image-0.png");
    const url = pathToAssetUrl(file, workdir);
    expect(url).toBe(
      `${TESSERA_ASSET_SCHEME}://generated-images/art-001/image-0.png`,
    );
  });

  it("percent-encodes filename segments that contain spaces", () => {
    const file = path.join(allowedRoot, "art-001", "My Image.png");
    const url = pathToAssetUrl(file, workdir);
    expect(url).toBe(
      `${TESSERA_ASSET_SCHEME}://generated-images/art-001/My%20Image.png`,
    );
  });

  it("percent-encodes filename segments that contain unicode", () => {
    const file = path.join(allowedRoot, "art-001", "café-é.png");
    const url = pathToAssetUrl(file, workdir);
    // `encodeURIComponent("café-é.png")` produces this exact form.
    expect(url).toBe(
      `${TESSERA_ASSET_SCHEME}://generated-images/art-001/${encodeURIComponent(
        "café-é.png",
      )}`,
    );
  });

  it("returns null for a path that escapes generated-images/ via .. segments", () => {
    // `<workdir>/generated-images/../secrets/dek.bin` resolves to
    // `<workdir>/secrets/dek.bin`, which is outside the allow-list.
    const escape = path.join(allowedRoot, "..", "secrets", "dek.bin");
    expect(pathToAssetUrl(escape, workdir)).toBeNull();
  });

  it("returns null for a sibling directory that shares the allow-list prefix (generated-images-backup attack)", () => {
    // Without the `+ path.sep` suffix in the startsWith check, a
    // sibling directory whose name starts with `generated-images`
    // (e.g. `generated-images-backup/...`) would falsely pass the
    // prefix test. Pin the defence directly.
    const sibling = path.join(
      workdir,
      "generated-images-backup",
      "art-001",
      "leak.png",
    );
    expect(pathToAssetUrl(sibling, workdir)).toBeNull();
  });

  it("returns null for an unrelated absolute path outside userData entirely", () => {
    // A path the IPC handler should NEVER produce, but pin the
    // helper's contract directly in case a future regression makes
    // the IPC return a stale `outPath` from a different
    // `userData`.
    const stranger = path.join(os.tmpdir(), "elsewhere", "stranger.png");
    expect(pathToAssetUrl(stranger, workdir)).toBeNull();
  });

  it("returns null for the generated-images/ root directory itself (no directory listing URL)", () => {
    // Pass-1 advisory `ANALYSIS_..._0001` flagged that
    // `pathToAssetUrl(allowedRoot)` used to return
    // `tessera-asset://generated-images/`, a URL the protocol
    // handler rejects with 403. The helper now refuses to mint
    // that URL in the first place so renderer + handler stay
    // semantically aligned.
    expect(pathToAssetUrl(allowedRoot, workdir)).toBeNull();
  });
});

// ---------------------------------------------------------------------
// registerAssetProtocolHandler — request-handler behaviour
// ---------------------------------------------------------------------

describe("registerAssetProtocolHandler", () => {
  it("registers a handler for the tessera-asset scheme against the default session", () => {
    registerAssetProtocolHandler(workdir);
    expect(protocolHandleMock).toHaveBeenCalledTimes(1);
    expect(protocolHandleMock.mock.calls[0][0]).toBe(TESSERA_ASSET_SCHEME);
    expect(typeof capturedHandler).toBe("function");
  });

  /**
   * Helper: invoke the handler with a synthetic `Request` whose URL
   * uses the `tessera-asset://` scheme. Node 18+ provides a global
   * `Request` constructor which accepts custom schemes for the
   * pathname-only portion we need to test.
   */
  async function invoke(url: string): Promise<Response> {
    registerAssetProtocolHandler(workdir);
    if (capturedHandler === null) {
      throw new Error("handler was not captured");
    }
    return await capturedHandler(new Request(url));
  }

  it("rejects requests with a host other than generated-images with 403", async () => {
    const res = await invoke(`${TESSERA_ASSET_SCHEME}://elsewhere/x.png`);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/Forbidden host/);
    // Must not even attempt the inner fetch.
    expect(netFetchMock).not.toHaveBeenCalled();
  });

  it("rejects URLs that traverse out of the allow-list with 403", async () => {
    // The WHATWG URL parser collapses literal `..` and `%2E%2E`
    // segments before they reach `pathname`, so the only way to
    // surface a traversal payload to the handler is to encode the
    // path SEPARATOR (`%2F`). `tessera-asset://generated-images/..%2F..%2Fsecrets/dek.bin`
    // parses to `pathname="/..%2F..%2Fsecrets/dek.bin"`, which
    // `decodeURIComponent` un-escapes to `/../../secrets/dek.bin`
    // — the actual attack vector the handler's containment check
    // must reject. Without the `+ path.sep` startsWith guard, a
    // future refactor that drops the strict prefix check would
    // silently start serving files from outside `generated-
    // images/`.
    const traversal = `${TESSERA_ASSET_SCHEME}://generated-images/..%2F..%2Fsecrets/dek.bin`;
    const res = await invoke(traversal);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/Forbidden path/);
    expect(netFetchMock).not.toHaveBeenCalled();
  });

  it("rejects the generated-images/ root URL itself with 403 (no directory listing)", async () => {
    const res = await invoke(`${TESSERA_ASSET_SCHEME}://generated-images/`);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/directory listing not allowed/);
    expect(netFetchMock).not.toHaveBeenCalled();
  });

  it("rejects a sibling-prefix attack (generated-images-backup/...) with 403", async () => {
    // Same `..%2F` trick — encode the slash so WHATWG URL
    // doesn't collapse the `..` segment before the handler sees
    // it. The decoded path resolves to
    // `<workdir>/generated-images-backup/x.png`, which shares
    // the `generated-images` PREFIX but is a sibling directory.
    // Without the `+ path.sep` startsWith suffix the handler
    // would falsely accept this.
    const sibling = `${TESSERA_ASSET_SCHEME}://generated-images/..%2Fgenerated-images-backup/x.png`;
    const res = await invoke(sibling);
    expect(res.status).toBe(403);
    expect(await res.text()).toMatch(/Forbidden path/);
  });

  it("serves a valid file inside the allow-list via net.fetch with a bypassed handler-recursion flag", async () => {
    // Place a real file on disk so the assertion that we actually
    // tried to fetch the right `file://` URL has something to
    // anchor on. We don't care about the file's bytes — the mock
    // returns a synthetic Response.
    const artifactDir = path.join(allowedRoot, "art-001");
    await fsp.mkdir(artifactDir, { recursive: true });
    const filePath = path.join(artifactDir, "image-0.png");
    await fsp.writeFile(filePath, Buffer.from([0x89, 0x50]));

    const res = await invoke(
      `${TESSERA_ASSET_SCHEME}://generated-images/art-001/image-0.png`,
    );
    expect(res.status).toBe(200);
    // Handler must have invoked the inner net.fetch with a
    // `file://` URL pointing at the resolved path, and with the
    // `bypassCustomProtocolHandlers: true` flag so the inner
    // fetch doesn't recurse back into the same handler.
    expect(netFetchMock).toHaveBeenCalledTimes(1);
    const [fetchedUrl, fetchOpts] = netFetchMock.mock.calls[0] as [
      string,
      { bypassCustomProtocolHandlers?: boolean } | undefined,
    ];
    expect(fetchedUrl.startsWith("file://")).toBe(true);
    expect(decodeURIComponent(fetchedUrl)).toContain(filePath);
    expect(fetchOpts?.bypassCustomProtocolHandlers).toBe(true);
  });

  it("decodes percent-encoded filename segments before composing the on-disk path", async () => {
    // Renderer requests `My%20Image.png` for a file named
    // `My Image.png` on disk. The handler must decode the
    // percent-encoding before joining with `allowedRoot` so the
    // resulting `file://` URL points at the real file.
    const artifactDir = path.join(allowedRoot, "art-001");
    await fsp.mkdir(artifactDir, { recursive: true });
    const filePath = path.join(artifactDir, "My Image.png");
    await fsp.writeFile(filePath, Buffer.from([0x89, 0x50]));

    const res = await invoke(
      `${TESSERA_ASSET_SCHEME}://generated-images/art-001/My%20Image.png`,
    );
    expect(res.status).toBe(200);
    const [fetchedUrl] = netFetchMock.mock.calls[0] as [string, unknown];
    expect(decodeURIComponent(fetchedUrl)).toContain(filePath);
  });
});

// ---------------------------------------------------------------------
// registerAssetProtocolScheme — privileged registration before whenReady
// ---------------------------------------------------------------------

describe("registerAssetProtocolScheme", () => {
  it("declares tessera-asset with the documented privilege flags", () => {
    registerAssetProtocolScheme();
    expect(registerSchemesMock).toHaveBeenCalledTimes(1);
    const [schemes] = registerSchemesMock.mock.calls[0] as [
      Array<{
        scheme: string;
        privileges: {
          standard?: boolean;
          secure?: boolean;
          supportFetchAPI?: boolean;
          corsEnabled?: boolean;
          stream?: boolean;
        };
      }>,
    ];
    expect(schemes).toHaveLength(1);
    expect(schemes[0].scheme).toBe(TESSERA_ASSET_SCHEME);
    // Each flag is load-bearing for a specific renderer behaviour;
    // pin them so a future "trim the privilege flags" refactor
    // can't quietly downgrade the scheme.
    expect(schemes[0].privileges.standard).toBe(true);
    expect(schemes[0].privileges.secure).toBe(true);
    expect(schemes[0].privileges.supportFetchAPI).toBe(true);
    expect(schemes[0].privileges.corsEnabled).toBe(true);
    expect(schemes[0].privileges.stream).toBe(true);
  });
});
