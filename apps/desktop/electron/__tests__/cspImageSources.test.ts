/**
 * Regression tests for the CSP `img-src` allow-list in
 * `electron/cspImageSources.ts`. The point of these tests is to make
 * a regression — accidentally re-introducing the `https:` wildcard or
 * dropping a connector's CDN — show up as a red CI rather than as a
 * post-merge bug report.
 */

import { describe, expect, it } from "vitest";
import { cspImageSources } from "../cspImageSources";

describe("cspImageSources", () => {
  it("is frozen so a downstream caller can't mutate the allow-list", () => {
    expect(Object.isFrozen(cspImageSources)).toBe(true);
  });

  it("never contains the bare `https:` wildcard that the previous policy used", () => {
    // The whole point of WS10's CSP tightening: `https:` lets any
    // HTTPS host load images, including trackers. If a future
    // refactor re-introduces it, this test fails.
    for (const src of cspImageSources) {
      expect(src).not.toBe("https:");
      expect(src).not.toBe("https://*");
      expect(src).not.toMatch(/^https:\/\/?$/);
    }
  });

  it("never contains plain http://", () => {
    for (const src of cspImageSources) {
      expect(src.startsWith("http://")).toBe(false);
    }
  });

  it("never contains the `data:` keyword (kept separate in main.ts)", () => {
    expect(cspImageSources).not.toContain("data:");
  });

  it("never contains `unsafe-inline` or `unsafe-eval`", () => {
    expect(cspImageSources).not.toContain("'unsafe-inline'");
    expect(cspImageSources).not.toContain("'unsafe-eval'");
  });

  it("uses CSP-grammar-valid origins (scheme + host, no path)", () => {
    // CSP 3 §6.7: each source-expression is `scheme-source` or
    // `host-source` (https://host). Paths and query strings are
    // ignored by the parser, but including them is a smell.
    for (const src of cspImageSources) {
      expect(src).toMatch(/^https:\/\/[a-zA-Z0-9.*-]+$/);
    }
  });

  it("only uses wildcards at the leftmost subdomain position", () => {
    // Per CSP 3 §6.7.2.5, `*.example.com` is valid but `*.*.example.com`
    // and `example.*.com` are not.
    for (const src of cspImageSources) {
      const host = src.replace(/^https:\/\//, "");
      const wildcardCount = (host.match(/\*/g) ?? []).length;
      if (wildcardCount > 0) {
        expect(wildcardCount).toBe(1);
        expect(host.startsWith("*.")).toBe(true);
      }
    }
  });

  it("covers each first-class connector documented in ConnectorsList.tsx", () => {
    // If we add a new connector to ConnectorsList we should also
    // widen this allow-list. The string-match form keeps the
    // assertion readable and matches both bare hosts and wildcards.
    const requiredCdnSubstrings = [
      "googleapis",
      "googleusercontent",
      "graph.microsoft",
      "sharepoint",
      "notion.so",
      "notion-static",
      "atlassian.net",
      "atlassian.com",
      "figma.com",
    ];
    for (const needle of requiredCdnSubstrings) {
      expect(cspImageSources.some((src) => src.includes(needle))).toBe(true);
    }
  });
});
