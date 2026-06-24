/**
 * Content-Security-Policy generator.
 *
 * Centralises the CSP string construction so the policy can be:
 *
 *   1. Generated with a per-session nonce that is also threaded into
 *      `additionalArguments` of the renderer's `webPreferences`, so
 *      every `<style>` element React emits can carry a matching
 *      `nonce="…"` attribute without us having to whitelist
 *      `'unsafe-inline'` for `style-src-elem`.
 *   2. Audited declaratively by tests — the pure function shape
 *      (`buildCsp({ isDev, nonce })` → string) lets the vitest suite
 *      assert structural invariants (no `'unsafe-inline'` in
 *      `script-src`, every directive set we care about is present,
 *      no `'unsafe-eval'`) without spinning up a real BrowserWindow.
 *   3. Diffed against a snapshot when a connector adds a new image
 *      host (the `img-src` allow-list is the only mutable surface).
 *
 * The exported `buildCsp` is the only public entry point: `main.ts`
 * calls it once with the per-session nonce, hands the resulting
 * string to `webRequest.onHeadersReceived`, and discards everything
 * but the return value. Tests import the same function directly.
 *
 * NOTE: `tessera-asset:` is a privileged scheme registered before
 * `app.whenReady` fires — see `assetProtocol.ts`. It is whitelisted
 * here in `img-src` and nowhere else.
 */
import { randomBytes } from "crypto";

/**
 * Per-session base64-encoded random nonce. 128 bits of entropy is
 * comfortably above the OWASP "≥ 64 bits" guideline and matches the
 * length recommended by Chromium's `strict-dynamic` source-list
 * primer. We use URL-safe base64 (no `+`, `/`, `=`) so the value can
 * be passed through `additionalArguments` as a `--flag=value` token
 * without further escaping.
 */
export function generateCspNonce(): string {
  return randomBytes(16)
    .toString("base64")
    .replace(/\+/g, "-")
    .replace(/\//g, "_")
    .replace(/=+$/, "");
}

interface BuildCspOptions {
  /** True when running against the Vite dev server (`!app.isPackaged`). */
  isDev: boolean;
  /** Per-session nonce — same string returned by `generateCspNonce()`. */
  nonce: string;
  /**
   * `img-src` allow-list — connector image CDNs. Imported from
   * `cspImageSources.ts` by the caller and threaded through here so
   * the build function stays free of internal-module coupling.
   */
  imageSources: readonly string[];
  /** Custom protocol scheme for the generated-images sandbox. */
  assetScheme: string;
}

/**
 * Build the Content-Security-Policy header value.
 *
 * Directive choices (per Task 25):
 *
 *   - `default-src 'self'` — start from a strict baseline.
 *   - `script-src 'self' 'nonce-X'` — NO `'unsafe-inline'`, NO
 *     `'unsafe-eval'`. The nonce is included for forward-compat with
 *     future inline scripts but the renderer bundle currently has
 *     zero inline `<script>` elements, so the `'self'` source alone
 *     is what carries the load today.
 *   - `style-src-elem 'self' 'nonce-X' https://fonts.googleapis.com`
 *     — every `<style>` element React emits must carry the same
 *     nonce or load from `'self'` (the built CSS bundle) or the
 *     Google Fonts stylesheet. No `'unsafe-inline'`.
 *   - `style-src-attr 'unsafe-inline'` — React's idiomatic
 *     `style={{…}}` attribute syntax is preserved. Inline `style`
 *     attributes accept JS values (objects) and are not a vector for
 *     external-attacker injection in our threat model (no untrusted
 *     HTML is rendered).
 *   - `connect-src 'self'` (+ dev `ws://localhost:5173` for HMR) —
 *     no outbound HTTP from the renderer is needed; every network
 *     call goes through main-process IPC.
 *   - `img-src 'self' data: tessera-asset: <connector CDNs>` — the
 *     connector-image whitelist lives in `cspImageSources.ts` and is
 *     widened explicitly per connector, not via a `https:` wildcard.
 *   - `font-src 'self' https://fonts.gstatic.com` — Google Fonts CDN
 *     (the actual woff2 host) is the only off-bundle font source.
 *   - `object-src 'none'` — no `<object>` / `<embed>` / `<applet>`.
 *   - `base-uri 'self'` — no `<base href="…">` injection.
 *   - `form-action 'none'` — no form submissions anywhere; we never
 *     POST a `<form>` in this app (every mutation goes through IPC).
 *   - `frame-ancestors 'none'` — defense-in-depth; the renderer
 *     cannot be framed (Electron does not embed us in another page,
 *     but the directive shuts the door on a future regression).
 *   - `frame-src 'none'` — the renderer embeds zero `<iframe>`s (the
 *     document sanitiser in `documentEditorHelpers.ts` strips any
 *     `<iframe>` before render), so we forbid frame loading outright
 *     rather than inheriting the `'self'` that `default-src` would
 *     otherwise grant. Strictly tighter than the fallback.
 *   - `media-src 'none'` — no `<audio>`/`<video>` elements exist in
 *     the renderer (the only `URL.createObjectURL` call sites build
 *     download anchors, not media elements), so media loading is
 *     forbidden. Again tighter than the `default-src 'self'` fallback.
 *   - `worker-src 'self' blob:` — `blob:` is required for the
 *     dynamic-import Vite chunk splitting and for any future Web
 *     Worker that loads its source via `URL.createObjectURL`.
 *
 * No directive uses a bare `*`, `https:`, or `http:` wildcard origin.
 * The only host wildcards anywhere in the policy are the leftmost-
 * subdomain forms (`https://*.host`) in the `img-src` connector
 * allow-list (see `cspImageSources.ts`), which are host-scoped per
 * the CSP3 grammar — not open-ended scheme wildcards. The
 * `no-wildcard-origin` regression test in `csp.test.ts` locks this.
 */
export function buildCsp(opts: BuildCspOptions): string {
  const { isDev, nonce, imageSources, assetScheme } = opts;

  const directives: string[] = [
    "default-src 'self'",
    isDev
      ? `script-src 'self' 'unsafe-inline' http://localhost:5173`
      : `script-src 'self' 'nonce-${nonce}'`,
    `style-src-elem 'self' 'nonce-${nonce}' https://fonts.googleapis.com`,
    "style-src-attr 'unsafe-inline'",
    "font-src 'self' https://fonts.gstatic.com",
    `img-src 'self' data: ${assetScheme}: ${imageSources.join(" ")}`,
    isDev
      ? "connect-src 'self' ws://localhost:5173 http://localhost:5173"
      : "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'self'",
    "form-action 'none'",
    "frame-ancestors 'none'",
    "frame-src 'none'",
    "media-src 'none'",
    "worker-src 'self' blob:",
  ];

  return directives.join("; ");
}
