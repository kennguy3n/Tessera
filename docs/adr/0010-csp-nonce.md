# 10. Per-session CSP nonce for the renderer

## Status

Accepted.

## Context

The renderer is an untrusted web context inside Electron
([ADR-0002](0002-electron.md)). To defend against XSS and injected
scripts we apply a strict Content-Security-Policy. The friction is
styling: React emits `<style>` elements at runtime (CSS-in-JS, injected
stylesheets), which a naive strict policy would block — and the usual
escape hatch, `'unsafe-inline'` in `style-src`, would also re-open the
script/style injection hole we are trying to close.

## Decision

Generate a **per-session CSP nonce** and thread it through both the CSP
header and the renderer, so inline `<style>` elements are allowed by
nonce rather than by `'unsafe-inline'`
(`apps/desktop/electron/csp.ts`):

- `generateCspNonce()` produces 128 bits of URL-safe base64 entropy once
  per session.
- The nonce is passed into the renderer via `webPreferences.additionalArguments`
  so every React-emitted `<style>` can carry a matching `nonce="…"`.
- `buildCsp({ isDev, nonce, imageSources, assetScheme })` builds the
  header with `script-src 'self' 'nonce-X'` and
  `style-src-elem 'self' 'nonce-X' https://fonts.googleapis.com` — **no**
  `'unsafe-inline'` and **no** `'unsafe-eval'` in `script-src`. `main.ts`
  applies the header via `webRequest.onHeadersReceived`.
- The remaining directives lock the surface down: `connect-src 'self'`
  (all network goes through main-process IPC), `object-src 'none'`,
  `base-uri 'self'`, `form-action 'none'`, `frame-ancestors 'none'`. The
  only widened directive is `img-src`, whose connector-CDN allow-list
  lives in `cspImageSources.ts` (explicit hosts, never a `https:`
  wildcard).
- `buildCsp` is a pure function so the vitest suite can assert
  structural invariants (no `'unsafe-inline'`/`'unsafe-eval'`, required
  directives present) without launching a `BrowserWindow`.

## Consequences

- The renderer runs under a strict CSP that permits React's runtime
  styles by nonce while keeping `script-src` free of `'unsafe-inline'`
  and `'unsafe-eval'`, closing the main XSS execution vectors.
- The nonce must be generated before the window loads and propagated
  consistently to both the header and `additionalArguments`; a mismatch
  silently breaks styling, so this ordering is part of startup.
- `style-src-attr 'unsafe-inline'` is deliberately retained so React's
  `style={{…}}` prop keeps working; this is judged safe because the app
  renders no untrusted HTML.
- Adding a connector that serves images from a new host requires
  explicitly extending the `cspImageSources.ts` allow-list — a small,
  auditable, intentional change rather than a blanket relaxation.
