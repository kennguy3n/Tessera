import { afterEach, describe, expect, it } from "vitest";

import {
  buildShowcaseApi,
  installShowcaseBridge,
  showcasePersonaFromQuery,
} from "../showcase";

/**
 * The showcase harness is a DEV-only mock `window.tessera` bridge used to
 * capture data-rich product screenshots. These tests pin the mock's API shape
 * and its Proxy semantics so regressions surface if it drifts from the real
 * `TesseraApi` (the editors call the mock exactly as they call the real bridge).
 */

const PERSONAS = ["healthcare", "legal", "finance", "nonprofit", "retail"] as const;

// Minimal structural view of the mock bridge for assertions.
type Api = {
  settings: { get: () => Promise<{ onboardingCompleted: boolean }> };
  artifacts: { list: () => Promise<Array<{ id: string; version: number; artifactType: string }>> };
  sources: { listSources: () => Promise<Array<{ id: string }>> };
  citations: { list: (artifactId: string) => Promise<Array<{ citationId: string }>> };
  runtime: { onDownloadProgress: () => () => void };
  // Namespace/method that is not implemented in `real`.
  nope: { missing: () => Promise<unknown> };
};

// The test harness installs a global mock on `window.tessera` (writable but
// non-configurable). Capture it once and restore by assignment after each test
// so `installShowcaseBridge` doesn't leak its persona-specific bridge.
const ORIGINAL_TESSERA = (window as unknown as { tessera: unknown }).tessera;

afterEach(() => {
  window.history.replaceState({}, "", "/");
  (window as unknown as { tessera: unknown }).tessera = ORIGINAL_TESSERA;
});

describe("showcasePersonaFromQuery", () => {
  it("resolves a known persona from the query string", () => {
    window.history.replaceState({}, "", "/?showcase=healthcare");
    expect(showcasePersonaFromQuery()).toBe("healthcare");
  });

  it("returns null for an unknown persona value", () => {
    window.history.replaceState({}, "", "/?showcase=does-not-exist");
    expect(showcasePersonaFromQuery()).toBeNull();
  });

  it("returns null when the param is absent", () => {
    window.history.replaceState({}, "", "/");
    expect(showcasePersonaFromQuery()).toBeNull();
  });
});

describe("buildShowcaseApi", () => {
  it("throws on an unknown persona", () => {
    expect(() => buildShowcaseApi("nope")).toThrow(/Unknown showcase persona/);
  });

  it.each(PERSONAS)("exposes a working mock surface for %s", async (persona) => {
    const api = buildShowcaseApi(persona) as Api;

    const settings = await api.settings.get();
    expect(settings.onboardingCompleted).toBe(true);

    const sources = await api.sources.listSources();
    expect(sources).toHaveLength(1);

    const artifacts = await api.artifacts.list();
    expect(artifacts.length).toBeGreaterThan(0);
    // Each artifact is an independent entity at its first revision.
    expect(artifacts.every((a) => a.version === 1)).toBe(true);

    // Citations are surfaced for a real artifact so the provenance panel is
    // never empty in a capture.
    const citations = await api.citations.list(artifacts[0].id);
    expect(citations.length).toBeGreaterThan(0);
  });
});

describe("buildShowcaseApi Proxy semantics", () => {
  it("returns a no-op unsubscribe for on* subscription methods", () => {
    const api = buildShowcaseApi("retail") as Api;
    const unsubscribe = api.runtime.onDownloadProgress();
    expect(typeof unsubscribe).toBe("function");
    expect(unsubscribe()).toBeUndefined();
  });

  it("resolves unknown methods to undefined instead of throwing", async () => {
    const api = buildShowcaseApi("retail") as Api;
    await expect(api.nope.missing()).resolves.toBeUndefined();
  });

  it("keeps namespaces non-thenable so `await api.<ns>` yields the proxy", async () => {
    const api = buildShowcaseApi("retail") as Api;
    // If a namespace were thenable, awaiting it would resolve to undefined.
    const awaited = (await (api.sources as unknown as Promise<typeof api.sources>)) as typeof api.sources;
    expect(typeof awaited.listSources).toBe("function");
  });

  it("guards symbol property access (e.g. DevTools' Symbol.toStringTag)", () => {
    const api = buildShowcaseApi("retail") as unknown as Record<symbol, unknown>;
    expect(Object.prototype.toString.call(api)).toBe("[object Object]");
    expect(api[Symbol.toStringTag]).toBeUndefined();
  });
});

describe("installShowcaseBridge", () => {
  it("installs the mock bridge on window.tessera", () => {
    installShowcaseBridge("legal");
    const installed = (window as unknown as { tessera?: Api }).tessera;
    expect(installed).toBeDefined();
    expect(typeof installed?.artifacts.list).toBe("function");
  });
});
