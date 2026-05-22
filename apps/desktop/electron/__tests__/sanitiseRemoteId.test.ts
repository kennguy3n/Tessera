/**
 * Regression tests for `sanitiseRemoteId` collision-resistance.
 *
 * The bug this guards against: ids that differ only in *unsafe*
 * characters (e.g. `page:123` vs. `page/123`) used to collide to the
 * same local filename — both became `page_123.md` — causing the
 * second sync to silently overwrite the first in the manifest and on
 * disk. The fix appends a content-addressed suffix derived from the
 * ORIGINAL id whenever the substitution actually changed the input.
 * For ids that contain only `[A-Za-z0-9._-]` (every shipping
 * provider's ids today) the suffix is NOT appended, so existing users
 * don't see a file-rename / re-sync storm on upgrade.
 */

import { describe, it, expect } from "vitest";

import { sanitiseRemoteId } from "../ipc/connectors/syncDir";

describe("sanitiseRemoteId", () => {
  it("is a no-op for UUID-style ids (Notion)", () => {
    const id = "8b3c5d9e-1234-4567-89ab-cdef01234567";
    expect(sanitiseRemoteId(id)).toBe(id);
  });

  it("is a no-op for Jira-style hyphenated keys (ABC-123)", () => {
    expect(sanitiseRemoteId("PROJ-42")).toBe("PROJ-42");
    expect(sanitiseRemoteId("ABC.XYZ-100")).toBe("ABC.XYZ-100");
  });

  it("is a no-op for purely numeric ids (Confluence)", () => {
    expect(sanitiseRemoteId("123456789")).toBe("123456789");
  });

  it("is a no-op for opaque base-62 file keys (Figma / Drive)", () => {
    expect(sanitiseRemoteId("aBcDeF0123_xyz-456")).toBe(
      "aBcDeF0123_xyz-456",
    );
  });

  it("disambiguates ids that differ ONLY by an unsafe character", () => {
    // The pre-fix behaviour mapped both of these to `page_123`,
    // silently clobbering one with the other. They must now map to
    // distinct filenames.
    const a = sanitiseRemoteId("page:123");
    const b = sanitiseRemoteId("page/123");
    expect(a).not.toBe(b);
    expect(a.startsWith("page_123_")).toBe(true);
    expect(b.startsWith("page_123_")).toBe(true);
  });

  it("uses a stable hash — same input always sanitises to same output", () => {
    expect(sanitiseRemoteId("page:123")).toBe(sanitiseRemoteId("page:123"));
  });

  it("caps the output length at 200 characters even with the hash suffix", () => {
    const longId = `${"a".repeat(500)}/x`;
    const sanitised = sanitiseRemoteId(longId);
    expect(sanitised.length).toBeLessThanOrEqual(200);
    // The 8-char hash suffix must still be present at the end so
    // collision-resistance survives truncation.
    expect(sanitised).toMatch(/_[0-9a-f]{8}$/);
  });

  it("caps the output length at 200 characters for a NO-OP id too", () => {
    const longId = "a".repeat(500);
    const sanitised = sanitiseRemoteId(longId);
    expect(sanitised.length).toBe(200);
    // No hash suffix when sanitisation was a no-op.
    expect(sanitised).toMatch(/^a{200}$/);
  });

  it("handles real-world id shapes that contain `:` (Atlassian content-link)", () => {
    // Atlassian "share" ids occasionally surface as
    // `<workspace>:<spacekey>:<pageid>` in legacy export payloads.
    const id = "acme:DOCS:42";
    const sanitised = sanitiseRemoteId(id);
    expect(sanitised.startsWith("acme_DOCS_42_")).toBe(true);
    expect(sanitised).toMatch(/_[0-9a-f]{8}$/);
  });

  it("never produces a forward slash, colon, or other unsafe char", () => {
    const ids = [
      "page:123",
      "page/123",
      "weird id with spaces",
      "%%hash%%",
      "中文/path",
      "🔥",
    ];
    for (const id of ids) {
      expect(sanitiseRemoteId(id)).toMatch(/^[A-Za-z0-9._-]+$/);
    }
  });
});
