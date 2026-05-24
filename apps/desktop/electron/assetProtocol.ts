/**
 * `tessera-asset://` custom protocol — serves files that live under
 * `<userData>/` to the sandboxed renderer.
 *
 * Why a custom protocol (and not `file://` or a data: URL)
 * -------------------------------------------------------
 * The renderer runs under `webSecurity: true` + `sandbox: true` and
 * the Content-Security-Policy (`installContentSecurityPolicy` in
 * `main.ts`) enumerates `img-src` explicitly. Two alternatives were
 * considered and rejected:
 *
 *   1. `file://<userData>/…` URLs in `<img src>`. Blocked by the
 *      `webSecurity` cross-origin policy: the renderer's origin is
 *      `http://localhost:5173` in dev (Vite) or `file://` for the
 *      packaged renderer, neither of which is allowed to load
 *      arbitrary `file://` resources by default. Adding `file:` to
 *      `img-src` would open every absolute path on disk to the
 *      renderer — a clear path-traversal risk.
 *   2. `data:` URLs containing base64-encoded bytes returned via IPC.
 *      Works for tiny icons but blows up the editor's JSON state
 *      with multi-megabyte string payloads (a 1024×1024 PNG is
 *      ~1–2 MB → ~1.5–3 MB base64). Persisting that into the
 *      artifact body and re-parsing it on every render is wasteful;
 *      streaming via a protocol handler is the right shape.
 *
 * The protocol allow-lists exactly one subdirectory:
 * `<userData>/generated-images/` — i.e. the destination directory
 * the `imagegen:generate` IPC handler writes to. Any URL pointing
 * outside this directory (via `..` segments, absolute paths, or
 * mismatched roots) is rejected with HTTP 403. This invariant is
 * pinned by `assetProtocol.test.ts` so a future refactor can't
 * widen the allow-list by accident.
 *
 * Registration shape
 * ------------------
 * `tessera-asset` is declared as a "privileged" scheme via
 * `protocol.registerSchemesAsPrivileged` BEFORE `app.whenReady`
 * fires. Without that, the modern `protocol.handle()` handler is
 * still invoked but the renderer treats `tessera-asset://` as a
 * non-standard scheme and bypasses fetch/img caching, blocks
 * top-level navigation, and refuses to load the response as an
 * image in some Electron versions. The privileged flags
 * (`standard: true`, `secure: true`, `supportFetchAPI: true`,
 * `corsEnabled: true`) make it behave like `https://` from the
 * renderer's perspective.
 *
 * Threat model — what this guard does NOT defend against
 * ------------------------------------------------------
 * The path-traversal containment check uses
 * `path.resolve(allowedRoot, "." + decoded).startsWith(allowedRoot
 * + path.sep)`. `path.resolve` collapses `..` segments but does
 * NOT resolve symlinks. A user (or process running with the
 * user's filesystem privileges) who can write to
 * `<userData>/generated-images/` could create a symlink there
 * pointing outside the directory — e.g.
 * `ln -s /etc/passwd <userData>/generated-images/evil` — and the
 * renderer would then fetch the link target via
 * `tessera-asset://generated-images/evil`. Devin Review PR #38
 * pass-4 correctly flagged this.
 *
 * The fix would be to either (a) `fs.realpath` every request and
 * re-check containment, or (b) open the file with `O_NOFOLLOW` on
 * POSIX / `FILE_FLAG_OPEN_REPARSE_POINT` on Windows. We deliberately
 * do NEITHER, for two reasons:
 *
 *   1. **Threat model.** Tessera's threat model assumes the local
 *      filesystem under `<userData>/` is trusted — exploitation of
 *      this gap requires the attacker to already have write access
 *      to the user's data directory, at which point they can read
 *      `/etc/passwd` directly without going through the renderer.
 *      We are not a multi-tenant service; there is no privilege
 *      boundary inside `<userData>/`.
 *
 *   2. **Cost.** The protocol handler fires on every `<img src>`
 *      hydration. Adding an async stat per request would add disk
 *      latency to renderer scroll-through of artifacts that carry
 *      hero images, and the realpath approach still has a TOCTOU
 *      window between resolve and read that only `O_NOFOLLOW`
 *      closes.
 *
 * If the threat model later expands (e.g. shared Tessera install,
 * untrusted plugin sandbox writing into `generated-images/`), the
 * correct layered fix is to swap the prefix check for an
 * `O_NOFOLLOW` / `FILE_FLAG_OPEN_REPARSE_POINT` file open rather
 * than chase the `realpath` race. Until then, the prefix check +
 * the host allow-list + the renderer-side `sanitizeHeroImage`
 * mirror of the host allow-list are the layered defenses.
 */
import { app, protocol, net } from "electron";
import * as path from "path";
import { pathToFileURL } from "url";

const SCHEME = "tessera-asset";
const ALLOWED_SUBDIR = "generated-images";

/**
 * Resolve the absolute allow-list root for `tessera-asset://`
 * requests. Both the protocol handler (registered once at
 * `app.whenReady`) and the renderer-side `pathToAssetUrl` helper
 * (called per `imagegen.generate` result) MUST derive the same
 * root from the same `userDataDir`, otherwise the handler could
 * 403 a URL `pathToAssetUrl` minted (or vice versa) and the
 * renderer-side `<img src>` would silently fail.
 *
 * Centralising the join here pins the invariant that both call
 * sites see byte-identical absolute paths. A future refactor that
 * needs to change the subdirectory layout (e.g. nesting under
 * `assets/generated-images/`) only has to touch this one helper.
 *
 * Devin Review PR #38 pass-6 📝 finding: `pathToAssetUrl` and
 * `registerAssetProtocolHandler` previously computed `allowedRoot`
 * independently via two separate `path.resolve` calls. Both
 * inputs always came from `app.getPath("userData")` so the
 * result was identical — but the duplication was a maintainability
 * trap.
 */
export function resolveAssetAllowedRoot(userDataDir: string): string {
  return path.resolve(userDataDir, ALLOWED_SUBDIR);
}

/**
 * Declare `tessera-asset://` as a privileged scheme. Must be called
 * synchronously at module load time — Electron's
 * `protocol.registerSchemesAsPrivileged` only honours its argument
 * BEFORE `app.whenReady()` resolves; calling it later throws.
 *
 * Importing this module from `main.ts` (which itself runs before
 * `app.whenReady`) is sufficient to satisfy the ordering. Exposed
 * as a no-op function so `main.ts` can put the call at the top of
 * its imports and the registration is structurally visible at the
 * call site rather than hidden in a top-level import side-effect.
 */
export function registerAssetProtocolScheme(): void {
  protocol.registerSchemesAsPrivileged([
    {
      scheme: SCHEME,
      privileges: {
        standard: true,
        secure: true,
        supportFetchAPI: true,
        corsEnabled: true,
        // stream: true so large files (PNGs > a few hundred KB) are
        // streamed instead of buffered in memory by the renderer's
        // image decoder. `protocol.handle()` returns a `Response`
        // whose body is already a streaming `ReadableStream` via
        // `net.fetch`, so this flag is the renderer-side complement.
        stream: true,
      },
    },
  ]);
}

/**
 * Install the `tessera-asset://` request handler against the
 * application's default session. Must be called AFTER
 * `app.whenReady()` resolves — `protocol.handle()` requires the
 * `app` ready state.
 *
 * `assetsRoot` is the directory the renderer is allowed to read
 * from — in production it's `app.getPath("userData")`. Tests pass a
 * `tmpdir`-based value to verify the traversal guard without
 * touching real user state.
 */
export function registerAssetProtocolHandler(assetsRoot: string): void {
  // Resolve the allow-list root ONCE at registration time. The
  // handler then compares each incoming request against this
  // pre-resolved absolute path, so a later `process.chdir()` or
  // symlink change can't shift the allow-list out from under us.
  const allowedRoot = resolveAssetAllowedRoot(assetsRoot);

  protocol.handle(SCHEME, async (request) => {
    try {
      const url = new URL(request.url);
      // `URL` parses `tessera-asset://generated-images/foo/bar.png`
      // into `host=generated-images`, `pathname=/foo/bar.png`.
      // We compose the on-disk path as
      // `<assetsRoot>/<host>/<decodeURI(pathname)>` and then
      // require the result to be under `<allowedRoot>`.
      if (url.host !== ALLOWED_SUBDIR) {
        return new Response(`Forbidden host: ${url.host}`, { status: 403 });
      }
      // `decodeURIComponent` on the pathname is required because a
      // filename containing spaces ("My Image.png") arrives
      // percent-encoded ("/My%20Image.png"). The `path.join` below
      // would otherwise mis-resolve against the literal `%20`.
      //
      // A malformed percent-encoding (e.g. `%ZZ`, a bare `%`, or
      // `%E0` with no continuation byte) makes `decodeURIComponent`
      // throw `URIError`. Surface that as a 400 (Bad Request) rather
      // than letting it fall through to the catch-all 500: the
      // failure is unambiguously the caller's fault, not an internal
      // bug, and the distinction makes debugging the renderer-side
      // URL builder easier. Devin Review PR #38 pass-3 📝 finding.
      let decoded: string;
      try {
        decoded = decodeURIComponent(url.pathname);
      } catch (err) {
        if (err instanceof URIError) {
          return new Response(
            `Bad Request: malformed percent-encoding in path: ${url.pathname}`,
            { status: 400 },
          );
        }
        throw err;
      }
      const resolved = path.resolve(allowedRoot, "." + decoded);
      // Path-traversal guard: the resolved path must be strictly
      // INSIDE `allowedRoot`. The `+ path.sep` suffix prevents a
      // prefix-only match where `allowedRoot = /a/b` would
      // mistakenly accept `/a/bbb/c` — a real risk because
      // `<userData>/generated-images-backup/...` is a plausible
      // sibling directory name.
      if (
        resolved !== allowedRoot &&
        !resolved.startsWith(allowedRoot + path.sep)
      ) {
        return new Response(
          `Forbidden path: resolved outside ${ALLOWED_SUBDIR}/`,
          { status: 403 },
        );
      }
      // Forbid the directory root itself — there's nothing to serve
      // at `tessera-asset://generated-images/`, only at
      // `tessera-asset://generated-images/<artifactId>/<file>`.
      if (resolved === allowedRoot) {
        return new Response("Forbidden: directory listing not allowed", {
          status: 403,
        });
      }
      // Use `net.fetch` against the resolved `file://` URL so
      // Electron handles streaming, MIME-sniffing, and Range
      // requests for us. This is the recommended pattern in the
      // Electron 31 protocol.handle docs.
      return await net.fetch(pathToFileURL(resolved).toString(), {
        // `bypassCustomProtocolHandlers: true` ensures the inner
        // fetch goes straight to the OS file system rather than
        // recursing back into a `tessera-asset://` handler.
        bypassCustomProtocolHandlers: true,
      });
    } catch (err) {
      return new Response(`Internal error: ${(err as Error).message}`, {
        status: 500,
      });
    }
  });
}

/**
 * Map an absolute path returned by `imagegen:generate` to a
 * `tessera-asset://` URL the renderer can drop into `<img src>`.
 *
 * Returns `null` if the path is not under
 * `<userDataDir>/generated-images/` — in that case the renderer
 * SHOULD fall back to showing "image unavailable" rather than
 * leaking the absolute path into the DOM.
 *
 * Lives in the main process because only the main process knows
 * `userDataDir`. The IPC handler calls this helper to compute the
 * `assetUrl` field on the `imagegen.generate` response so the
 * renderer never has to do path arithmetic.
 */
export function pathToAssetUrl(
  absolutePath: string,
  userDataDir: string = app.getPath("userData"),
): string | null {
  const allowedRoot = resolveAssetAllowedRoot(userDataDir);
  const resolved = path.resolve(absolutePath);
  // The path must be STRICTLY inside `allowedRoot` — i.e. nested
  // at least one segment under `generated-images/`. The
  // protocol handler at line 139 already rejects
  // `tessera-asset://generated-images/` (the directory root)
  // with 403; we now refuse to mint that URL in the first place
  // so the renderer never sees an `assetUrl` that the handler
  // would refuse to serve. Without this guard a caller passing
  // the bare `generated-images/` directory would get back
  // `tessera-asset://generated-images/` (a URL the handler
  // would 403), which is a confusing semantic asymmetry. Devin
  // Review pass-1 finding on
  // `apps/desktop/electron/assetProtocol.ts:182-186`.
  if (
    resolved === allowedRoot ||
    !resolved.startsWith(allowedRoot + path.sep)
  ) {
    return null;
  }
  // Compute the relative path under `generated-images/` and
  // percent-encode each segment so spaces / unicode survive the
  // round-trip through the URL parser.
  const rel = path.relative(allowedRoot, resolved);
  const segments = rel.split(path.sep).map((s) => encodeURIComponent(s));
  return `${SCHEME}://${ALLOWED_SUBDIR}/${segments.join("/")}`;
}

export const TESSERA_ASSET_SCHEME = SCHEME;
