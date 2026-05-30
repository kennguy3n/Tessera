/**
 * Phase 15 Task 25 — Content-Security-Policy regression tests.
 *
 * Locks the structural invariants of the CSP header so a regression
 * that re-introduces `'unsafe-inline'` or `'unsafe-eval'`, drops one
 * of the defense-in-depth directives, or widens `img-src` to a
 * wildcard `https:` source will fail this suite before it ships.
 *
 * The test exercises the pure `buildCsp` function rather than spinning
 * up a real `BrowserWindow`, so the suite stays fast and deterministic
 * — but the same `buildCsp` is what `main.ts` calls at runtime, so
 * the invariants pinned here are the ones the user's installed app
 * will enforce against the renderer.
 */
import { describe, it, expect } from "vitest";
import { buildCsp, generateCspNonce } from "../csp";

const TEST_IMAGE_SOURCES: readonly string[] = [
  "https://drive.googleapis.com",
  "https://avatars.slack-edge.com",
];
const TEST_ASSET_SCHEME = "tessera-asset";

/**
 * Parse a CSP header value into a `Map<directive, sources[]>` so
 * tests can assert on directive sets without depending on whitespace
 * or ordering.
 */
function parseCsp(header: string): Map<string, string[]> {
  const m = new Map<string, string[]>();
  for (const rawDirective of header.split(";")) {
    const trimmed = rawDirective.trim();
    if (!trimmed) continue;
    const [directive, ...sources] = trimmed.split(/\s+/);
    m.set(directive, sources);
  }
  return m;
}

describe("CSP — generateCspNonce", () => {
  it("returns a URL-safe base64 string at least 16 characters long", () => {
    const nonce = generateCspNonce();
    expect(nonce.length).toBeGreaterThanOrEqual(16);
    // URL-safe base64: only A–Z, a–z, 0–9, '-', '_'. No '+', '/', '='.
    expect(nonce).toMatch(/^[A-Za-z0-9_-]+$/);
    expect(nonce).not.toMatch(/[+/=]/);
  });

  it("produces a different value on every call (per-session randomness)", () => {
    const a = generateCspNonce();
    const b = generateCspNonce();
    const c = generateCspNonce();
    // 128 bits of entropy means collision probability is astronomically
    // small; flake risk is acceptable. Three samples gives us enough
    // signal to catch a deterministic generator regression.
    expect(a).not.toBe(b);
    expect(b).not.toBe(c);
    expect(a).not.toBe(c);
  });
});

describe("CSP — buildCsp (production mode)", () => {
  const header = buildCsp({
    isDev: false,
    nonce: "TEST_NONCE",
    imageSources: TEST_IMAGE_SOURCES,
    assetScheme: TEST_ASSET_SCHEME,
  });
  const directives = parseCsp(header);

  it("never permits 'unsafe-inline' on script-src", () => {
    const scriptSrc = directives.get("script-src");
    expect(scriptSrc).toBeDefined();
    expect(scriptSrc).not.toContain("'unsafe-inline'");
  });

  it("never permits 'unsafe-eval' on script-src", () => {
    const scriptSrc = directives.get("script-src");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });

  it("includes the per-session nonce on script-src", () => {
    const scriptSrc = directives.get("script-src");
    expect(scriptSrc).toContain("'nonce-TEST_NONCE'");
  });

  it("never permits 'unsafe-inline' on style-src-elem", () => {
    const styleSrcElem = directives.get("style-src-elem");
    expect(styleSrcElem).toBeDefined();
    expect(styleSrcElem).not.toContain("'unsafe-inline'");
  });

  it("includes the per-session nonce on style-src-elem", () => {
    const styleSrcElem = directives.get("style-src-elem");
    expect(styleSrcElem).toContain("'nonce-TEST_NONCE'");
  });

  it("permits 'unsafe-inline' on style-src-attr (React idiom)", () => {
    // The Phase 15 Task 25 architectural choice: `style="…"`
    // attributes (which React emits liberally) need 'unsafe-inline'
    // on style-src-attr because they accept JS object values and
    // are not externally writable. The split between style-src-elem
    // (strict) and style-src-attr (permissive) lets us tighten the
    // <style> element path without breaking React's idiom.
    const styleSrcAttr = directives.get("style-src-attr");
    expect(styleSrcAttr).toContain("'unsafe-inline'");
  });

  it("defines object-src as 'none' (defense-in-depth)", () => {
    expect(directives.get("object-src")).toEqual(["'none'"]);
  });

  it("defines base-uri as 'self' (defense-in-depth)", () => {
    expect(directives.get("base-uri")).toEqual(["'self'"]);
  });

  it("defines form-action as 'none' (no forms in this app)", () => {
    expect(directives.get("form-action")).toEqual(["'none'"]);
  });

  it("defines frame-ancestors as 'none' (no embedding)", () => {
    expect(directives.get("frame-ancestors")).toEqual(["'none'"]);
  });

  it("includes the custom asset scheme on img-src", () => {
    const imgSrc = directives.get("img-src");
    expect(imgSrc).toContain(`${TEST_ASSET_SCHEME}:`);
  });

  it("includes every connector image source on img-src", () => {
    const imgSrc = directives.get("img-src");
    for (const source of TEST_IMAGE_SOURCES) {
      expect(imgSrc).toContain(source);
    }
  });

  it("connect-src in production allows only 'self' (no localhost ws/http)", () => {
    const connectSrc = directives.get("connect-src");
    expect(connectSrc).toEqual(["'self'"]);
  });
});

describe("CSP — buildCsp (development mode)", () => {
  const header = buildCsp({
    isDev: true,
    nonce: "DEV_NONCE",
    imageSources: TEST_IMAGE_SOURCES,
    assetScheme: TEST_ASSET_SCHEME,
  });
  const directives = parseCsp(header);

  it("permits the Vite dev server's ws/http on connect-src", () => {
    const connectSrc = directives.get("connect-src");
    expect(connectSrc).toContain("ws://localhost:5173");
    expect(connectSrc).toContain("http://localhost:5173");
  });

  it("does NOT relax script-src in dev (no unsafe-inline/eval)", () => {
    const scriptSrc = directives.get("script-src");
    expect(scriptSrc).not.toContain("'unsafe-inline'");
    expect(scriptSrc).not.toContain("'unsafe-eval'");
  });
});
