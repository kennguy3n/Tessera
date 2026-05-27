/**
 * Direct unit tests for the `KchatNameCache` LRU class.
 *
 * Originally exercised indirectly through `kchatIpc.test.ts`
 * (which goes through `registerKchatHandlers` + the
 * `_resetKchatNameCachesForTest` helper). Devin Review pass 4 on
 * PRs #52 + #53 flagged that the class should be testable
 * independently of IPC wiring so the LRU contract (touch-on-read,
 * FIFO-eviction-at-bound, empty-string rejection, bounded-size
 * guarantee) has its own pin.
 *
 * The class lives in `electron/kchat/kchatNameCache.ts`; this
 * suite imports it directly with no IPC, no status listener,
 * and no module-scoped singleton.
 */
import { describe, it, expect } from "vitest";

import { KchatNameCache } from "../kchat/kchatNameCache";

describe("KchatNameCache", () => {
  describe("constructor guard", () => {
    it("rejects maxEntries === 0", () => {
      expect(() => new KchatNameCache(0)).toThrow(
        "KchatNameCache: maxEntries must be > 0",
      );
    });

    it("rejects negative maxEntries", () => {
      expect(() => new KchatNameCache(-1)).toThrow(
        "KchatNameCache: maxEntries must be > 0",
      );
      expect(() => new KchatNameCache(-100)).toThrow(
        "KchatNameCache: maxEntries must be > 0",
      );
    });

    it("accepts maxEntries === 1 (smallest legal bound)", () => {
      // Pin the boundary explicitly so a future refactor that
      // tightens the guard to `> 1` would surface immediately.
      const c = new KchatNameCache(1);
      c.set("a", "alpha");
      expect(c.get("a")).toBe("alpha");
      expect(c.size()).toBe(1);
    });
  });

  describe("get / set basics", () => {
    it("returns null for a miss", () => {
      const c = new KchatNameCache(10);
      expect(c.get("missing")).toBeNull();
    });

    it("returns the stored name for a hit", () => {
      const c = new KchatNameCache(10);
      c.set("user-1", "alice");
      expect(c.get("user-1")).toBe("alice");
    });

    it("overwrites the stored name on repeated set with the same id", () => {
      // A user-rename or channel-rename surfaces through the
      // enrichment path as a `set` with the new display name on
      // the same id. The cache must surface the latest value,
      // not the original.
      const c = new KchatNameCache(10);
      c.set("user-1", "alice");
      c.set("user-1", "alice-renamed");
      expect(c.get("user-1")).toBe("alice-renamed");
      expect(c.size()).toBe(1);
    });
  });

  describe("LRU touch on get", () => {
    it("moves the touched entry to the most-recently-used position", () => {
      // With maxEntries === 3 and three entries (a, b, c), a
      // `get("a")` should move `a` to the end of insertion
      // order. The next eviction-triggering set should therefore
      // remove `b` (now oldest), NOT `a`.
      const c = new KchatNameCache(3);
      c.set("a", "alpha");
      c.set("b", "beta");
      c.set("c", "gamma");
      // Touch `a`.
      expect(c.get("a")).toBe("alpha");
      // Insert a 4th entry to trigger eviction.
      c.set("d", "delta");
      // `b` was the LRU after the touch — it should be evicted,
      // `a` should still be present.
      expect(c.get("a")).toBe("alpha");
      expect(c.get("b")).toBeNull();
      expect(c.get("c")).toBe("gamma");
      expect(c.get("d")).toBe("delta");
    });

    it("does NOT touch order on miss", () => {
      // A `get` for a missing id must not influence the eviction
      // queue at all — otherwise a probe for a non-existent id
      // could mask the eviction shape and confuse callers
      // monitoring cache pressure.
      const c = new KchatNameCache(2);
      c.set("a", "alpha");
      c.set("b", "beta");
      expect(c.get("missing")).toBeNull();
      // Trigger eviction.
      c.set("d", "delta");
      // `a` was oldest, still evicted.
      expect(c.get("a")).toBeNull();
      expect(c.get("b")).toBe("beta");
      expect(c.get("d")).toBe("delta");
    });
  });

  describe("FIFO eviction at bound", () => {
    it("evicts the oldest entry when set exceeds maxEntries", () => {
      const c = new KchatNameCache(2);
      c.set("a", "alpha");
      c.set("b", "beta");
      c.set("c", "gamma");
      expect(c.get("a")).toBeNull();
      expect(c.get("b")).toBe("beta");
      expect(c.get("c")).toBe("gamma");
      expect(c.size()).toBe(2);
    });

    it("repeated set on existing id does not trigger eviction", () => {
      // Overwriting an existing key is NOT a size-increasing
      // operation; it should not evict a sibling. This guards
      // against a regression where the eviction path stops
      // checking `entries.has(id)` first.
      const c = new KchatNameCache(2);
      c.set("a", "alpha");
      c.set("b", "beta");
      // Overwrite `a` — should not evict `b`.
      c.set("a", "alpha-renamed");
      expect(c.get("a")).toBe("alpha-renamed");
      expect(c.get("b")).toBe("beta");
      expect(c.size()).toBe(2);
    });

    it("each set on existing key refreshes its LRU position", () => {
      // A `set` on an existing key should behave like
      // `get` + overwrite from an LRU standpoint — the entry
      // jumps to the most-recently-used position. Future
      // eviction should not pick it.
      const c = new KchatNameCache(2);
      c.set("a", "alpha");
      c.set("b", "beta");
      // Refresh `a` via overwrite.
      c.set("a", "alpha");
      // `b` is now oldest. Next insertion evicts `b`.
      c.set("c", "gamma");
      expect(c.get("a")).toBe("alpha");
      expect(c.get("b")).toBeNull();
      expect(c.get("c")).toBe("gamma");
    });
  });

  describe("empty-string rejection at boundary", () => {
    it("set('id', '') is a no-op (does not store an empty positive value)", () => {
      // The renderer falls back to the raw id on null, so an
      // empty-string positive value would silently surface as
      // `#` / `@` with no text. Pin the boundary defence.
      const c = new KchatNameCache(10);
      c.set("user-1", "");
      expect(c.get("user-1")).toBeNull();
      expect(c.size()).toBe(0);
    });

    it("set with empty string does NOT evict siblings", () => {
      // Defence-in-depth: a rejected set must NOT count toward
      // the size guard's eviction logic. Otherwise a flood of
      // empty-string responses (malicious or buggy server) could
      // wipe legitimate cache entries.
      const c = new KchatNameCache(1);
      c.set("a", "alpha");
      c.set("b", ""); // rejected — must not evict `a`.
      expect(c.get("a")).toBe("alpha");
      expect(c.size()).toBe(1);
    });

    it("set with empty string does NOT overwrite an existing entry", () => {
      // A later empty-string set must NOT wipe an earlier
      // legitimate value. The renderer would see null and
      // surface raw-id fallback even though we had a good name
      // earlier in the session.
      const c = new KchatNameCache(10);
      c.set("user-1", "alice");
      c.set("user-1", "");
      expect(c.get("user-1")).toBe("alice");
    });
  });

  describe("clear", () => {
    it("empties the map", () => {
      const c = new KchatNameCache(10);
      c.set("a", "alpha");
      c.set("b", "beta");
      c.set("c", "gamma");
      c.clear();
      expect(c.size()).toBe(0);
      expect(c.get("a")).toBeNull();
      expect(c.get("b")).toBeNull();
      expect(c.get("c")).toBeNull();
    });

    it("resets size and lets the next set evict from a clean state", () => {
      // After clear() the eviction queue must start empty —
      // the next bound-many sets must all succeed without
      // immediately evicting one of them.
      const c = new KchatNameCache(2);
      c.set("a", "alpha");
      c.set("b", "beta");
      c.clear();
      c.set("c", "gamma");
      c.set("d", "delta");
      expect(c.size()).toBe(2);
      expect(c.get("c")).toBe("gamma");
      expect(c.get("d")).toBe("delta");
    });
  });

  describe("size", () => {
    it("reflects insertions and overwrites", () => {
      const c = new KchatNameCache(10);
      expect(c.size()).toBe(0);
      c.set("a", "alpha");
      expect(c.size()).toBe(1);
      c.set("a", "alpha-renamed");
      expect(c.size()).toBe(1);
      c.set("b", "beta");
      expect(c.size()).toBe(2);
    });

    it("never exceeds maxEntries", () => {
      // Stress-pin the invariant: a flood of distinct sets
      // must never produce a size > maxEntries.
      const c = new KchatNameCache(5);
      for (let i = 0; i < 100; i++) {
        c.set(`id-${i}`, `name-${i}`);
        expect(c.size()).toBeLessThanOrEqual(5);
      }
      expect(c.size()).toBe(5);
    });
  });

  describe("isolation between instances", () => {
    it("two caches with the same maxEntries do not share state", () => {
      // The IPC layer creates two separate instances (one for
      // users, one for channels). A regression where the class
      // accidentally used a static map would cause cross-cache
      // contamination — pin against that here.
      const users = new KchatNameCache(10);
      const channels = new KchatNameCache(10);
      users.set("u-1", "alice");
      channels.set("c-1", "general");
      expect(users.get("u-1")).toBe("alice");
      expect(users.get("c-1")).toBeNull();
      expect(channels.get("c-1")).toBe("general");
      expect(channels.get("u-1")).toBeNull();
    });
  });
});
