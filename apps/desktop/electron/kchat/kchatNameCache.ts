/**
 * Bounded LRU cache that resolves KChat object ids (user /
 * channel) to their human-readable display strings (username /
 * channel display name).
 *
 * Originally lived inline in `apps/desktop/electron/ipc/kchat.ts`
 * (Phase 13 Theme 2 Task 9). Devin Review pass 4 on PR #52
 * (ANALYSIS_0003) and pass 4 on PR #53 (ANALYSIS_0003) flagged
 * that exporting the test-only `_resetKchatNameCachesForTest`
 * from production-IPC code was a structural smell — the LRU
 * contract was mixed with IPC + status-listener concerns and
 * could not be unit-tested independently of `registerKchatHandlers`.
 *
 * This module extracts the class so:
 *   1. The LRU contract (touch-on-read, FIFO-eviction-at-bound,
 *      empty-string rejection, bounded-size guarantee) is
 *      independently unit-testable.
 *   2. `apps/desktop/electron/ipc/kchat.ts` shrinks by ~80
 *      lines and no longer carries the LRU implementation.
 *   3. Future callers (e.g. a different IPC layer, a stand-alone
 *      sync agent) can re-use the same bounded cache without
 *      depending on the IPC barrel.
 *
 * The module-scoped singletons (`KCHAT_USERNAME_CACHE`,
 * `KCHAT_CHANNEL_NAME_CACHE`), the `KchatAuthService.onStatusChange`
 * wiring that clears them on disconnect, and the
 * `_resetKchatNameCachesForTest` helper that detaches the
 * listener intentionally stay in `kchat.ts` — those are coupled
 * to IPC lifecycle, not to the bounded-cache contract.
 *
 * The cache is populated lazily by `kchat:searchPosts` as a
 * side-effect of building citation rows — `Map` iteration order
 * is insertion order, so deleting + re-inserting a key on every
 * read gives us LRU semantics with `O(1)` operations.
 *
 * Bound is per-cache; the user cache and channel cache each get
 * their own quota so a long session with many channels doesn't
 * starve user-name lookups (or vice versa). A miss returns
 * `null`; the renderer falls back to displaying the raw object
 * id in that case so the row still renders.
 */
export class KchatNameCache {
  private readonly entries = new Map<string, string>();
  constructor(private readonly maxEntries: number) {
    if (maxEntries <= 0) {
      throw new Error("KchatNameCache: maxEntries must be > 0");
    }
  }

  get(id: string): string | null {
    const v = this.entries.get(id);
    if (v === undefined) return null;
    // LRU touch: move to end of insertion order.
    this.entries.delete(id);
    this.entries.set(id, v);
    return v;
  }

  set(id: string, name: string): void {
    // ANALYSIS_0004 (Devin Review pass 1 on fafc5f6, PR #52):
    // reject empty-string display names at the boundary. The
    // renderer uses nullish coalescing (`?? rawId`) for fallback;
    // an empty string would be cached as a positive value and
    // surface as `#` / `@` with no text. Mattermost server-side
    // validation already requires a non-empty `display_name` /
    // `username` for the channel + user kinds we cache, so this
    // is defence-in-depth against a future protocol drift or a
    // maliciously crafted response. The caller side already
    // trims to a single field per id; we do not need to trim
    // whitespace here.
    if (name === "") {
      return;
    }
    // If already present, refresh and move to end.
    if (this.entries.has(id)) {
      this.entries.delete(id);
    } else if (this.entries.size >= this.maxEntries) {
      // Evict the least-recently-used (first inserted).
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
    this.entries.set(id, name);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Test-only accessor. */
  size(): number {
    return this.entries.size;
  }
}
