/**
 * OAuth scope governance unit tests.
 *
 * Covers `parseScopeString`, `computeMissingScopes`,
 * `assertScopesGranted`, `MissingScopeError`, and `compareScopes`.
 * All exercise the real production code path; no mocks.
 */
import { describe, it, expect } from "vitest";

import {
  MissingScopeError,
  assertScopesGranted,
  compareScopes,
  computeMissingScopes,
  parseScopeString,
} from "../oauthScope";

describe("parseScopeString", () => {
  it("returns [] for null / undefined / empty", () => {
    expect(parseScopeString(null)).toEqual([]);
    expect(parseScopeString(undefined)).toEqual([]);
    expect(parseScopeString("")).toEqual([]);
  });

  it("splits on whitespace per RFC 6749 §3.3", () => {
    expect(parseScopeString("read write admin")).toEqual([
      "read",
      "write",
      "admin",
    ]);
  });

  it("splits on commas for Figma-style delimited values", () => {
    expect(parseScopeString("file_read,file_write")).toEqual([
      "file_read",
      "file_write",
    ]);
  });

  it("splits on mixed whitespace + comma + newline + tab", () => {
    expect(parseScopeString("a b,c\nd\te")).toEqual([
      "a",
      "b",
      "c",
      "d",
      "e",
    ]);
  });

  it("drops empty fragments from consecutive delimiters", () => {
    expect(parseScopeString("a   b,,c")).toEqual(["a", "b", "c"]);
  });

  it("preserves scope ordering (callers may rely on it for display)", () => {
    expect(parseScopeString("z y x")).toEqual(["z", "y", "x"]);
  });
});

describe("computeMissingScopes", () => {
  it("returns [] when requested is empty", () => {
    expect(computeMissingScopes([], ["read"])).toEqual([]);
  });

  it("returns [] when granted is a superset of requested", () => {
    expect(computeMissingScopes(["read"], ["read", "write"])).toEqual([]);
  });

  it("returns the missing subset of requested", () => {
    expect(computeMissingScopes(["read", "write"], ["read"])).toEqual([
      "write",
    ]);
  });

  it("returns all of requested when granted is empty", () => {
    expect(computeMissingScopes(["read", "write"], [])).toEqual([
      "read",
      "write",
    ]);
  });

  it("is case-sensitive per RFC 6749 §3.3", () => {
    expect(computeMissingScopes(["Read"], ["read"])).toEqual(["Read"]);
  });

  it("ignores granted-but-not-requested scopes", () => {
    expect(computeMissingScopes(["read"], ["read", "extra"])).toEqual([]);
  });
});

describe("assertScopesGranted", () => {
  it("does not throw when all required scopes are granted", () => {
    expect(() =>
      assertScopesGranted("drive", ["read"], ["read", "write"]),
    ).not.toThrow();
  });

  it("does not throw when required is empty", () => {
    expect(() => assertScopesGranted("drive", [], [])).not.toThrow();
  });

  it("throws MissingScopeError with the precise diff", () => {
    let err: unknown = null;
    try {
      assertScopesGranted("drive", ["read", "write", "admin"], ["read"]);
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MissingScopeError);
    const me = err as MissingScopeError;
    expect(me.provider).toBe("drive");
    expect(me.missing).toEqual(["write", "admin"]);
    expect(me.granted).toEqual(["read"]);
  });

  it("error message names every missing scope", () => {
    let err: unknown = null;
    try {
      assertScopesGranted("notion", ["a", "b", "c"], []);
    } catch (e) {
      err = e;
    }
    const me = err as MissingScopeError;
    expect(me.message).toContain("notion");
    expect(me.message).toContain("a, b, c");
    expect(me.message).toContain("(none)");
  });

  it("preserves the prototype chain so instanceof works", () => {
    try {
      assertScopesGranted("p", ["x"], []);
    } catch (e) {
      expect(e instanceof MissingScopeError).toBe(true);
      expect(e instanceof Error).toBe(true);
    }
  });
});

describe("compareScopes", () => {
  it("returns fullyGranted = true when nothing is missing", () => {
    const r = compareScopes("drive", ["a", "b"], ["a", "b", "c"]);
    expect(r.fullyGranted).toBe(true);
    expect(r.missing).toEqual([]);
  });

  it("returns fullyGranted = false and lists missing scopes", () => {
    const r = compareScopes("drive", ["a", "b", "c"], ["a"]);
    expect(r.fullyGranted).toBe(false);
    expect(r.missing).toEqual(["b", "c"]);
  });

  it("returns immutable copies of the input arrays", () => {
    const requested = ["a"];
    const granted = ["b"];
    const r = compareScopes("p", requested, granted);
    expect(r.requested).not.toBe(requested);
    expect(r.granted).not.toBe(granted);
  });
});

describe("OAuth meta-scopes (offline_access et al.)", () => {
  // Regression coverage for the Atlassian/Microsoft false-positive
  // problem: the token response often omits `offline_access` from
  // its echoed `scope` field even when the refresh token was
  // actually issued. Treating it as a required API scope would
  // surface a permanent MissingScopeError on every Jira /
  // Confluence / OneDrive sync.
  it("assertScopesGranted ignores offline_access when only the API scopes were echoed back", () => {
    expect(() =>
      assertScopesGranted(
        "jira",
        ["read:jira-work", "read:jira-user", "offline_access"],
        ["read:jira-work", "read:jira-user"],
      ),
    ).not.toThrow();
  });

  it("assertScopesGranted still throws for a real missing API scope even when offline_access is filtered", () => {
    let err: unknown = null;
    try {
      assertScopesGranted(
        "jira",
        ["read:jira-work", "read:jira-user", "offline_access"],
        ["read:jira-work"],
      );
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(MissingScopeError);
    const me = err as MissingScopeError;
    expect(me.missing).toEqual(["read:jira-user"]);
    // offline_access must never appear in the missing list because
    // it is a meta-scope, not an API permission.
    expect(me.missing).not.toContain("offline_access");
  });

  it("assertScopesGranted does not throw when offline_access is the ONLY requested-but-missing scope", () => {
    // Pathological: a config that only asks for offline_access
    // (no API scopes) should never throw at scope-assertion time —
    // refresh failure is a separate concern surfaced by the refresh
    // call itself.
    expect(() =>
      assertScopesGranted("onedrive", ["offline_access"], []),
    ).not.toThrow();
  });

  it("compareScopes filters offline_access from missing but preserves it in the requested record", () => {
    const r = compareScopes(
      "confluence",
      [
        "read:confluence-content.summary",
        "read:confluence-content.all",
        "offline_access",
      ],
      ["read:confluence-content.summary", "read:confluence-content.all"],
    );
    expect(r.fullyGranted).toBe(true);
    expect(r.missing).toEqual([]);
    // The renderer should still see the full requested list — we
    // only filter from the missing-diff computation.
    expect(r.requested).toContain("offline_access");
  });

  // Devin Review round 4 — the auth-time scope-narrowing
  // warning in `ipc/connectors/handlers.ts` historically used an
  // inline `.filter()` that did NOT strip meta-scopes, producing a
  // false-positive "connector scopes narrowed by user" log on every
  // successful Jira / Confluence / OneDrive auth. The fix delegates
  // to `compareScopes`, so this regression test pins the canonical
  // helper's behaviour for the exact provider-shaped inputs that
  // produced the false positive in the field.
  it("compareScopes returns missing=[] for a real Jira token that omits offline_access from the echoed scope set", () => {
    // Jira always echoes only the `read:*` / `write:*` API scopes,
    // never `offline_access`, regardless of whether the refresh
    // token was issued.
    const r = compareScopes(
      "jira",
      ["read:jira-work", "read:jira-user", "offline_access"],
      ["read:jira-work", "read:jira-user"],
    );
    expect(r.missing).toEqual([]);
    expect(r.fullyGranted).toBe(true);
  });

  it("compareScopes returns missing=[] for a real OneDrive token that omits offline_access from the echoed scope set", () => {
    // Microsoft Graph behaves the same way — `offline_access` is
    // consumed for refresh-token issuance but does not appear in
    // the response's `scope` field.
    const r = compareScopes(
      "onedrive",
      ["Files.ReadWrite", "offline_access"],
      ["Files.ReadWrite"],
    );
    expect(r.missing).toEqual([]);
    expect(r.fullyGranted).toBe(true);
  });
});
