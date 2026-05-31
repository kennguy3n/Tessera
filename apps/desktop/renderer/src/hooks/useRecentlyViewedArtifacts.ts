/**
 * Phase 18 Task 17: recently-viewed artifact tracking.
 *
 * Records the IDs of artifacts the user has opened in the editor,
 * in view-recency order (most recent first). Distinct from
 * `useRecentArtifacts` (which sorts by `updatedAt` and shows
 * recently *edited* artifacts) — a user often wants to re-open
 * something they just looked at, even if they didn't touch its
 * content.
 *
 * Persistence: the list lives in `SettingsData.recentArtifactIds`
 * with a hard cap of {@link MAX_RECENT_ARTIFACTS} entries. Both
 * the IPC schema and the on-disk config schema enforce the cap
 * server-side; the renderer trims defensively to the same bound
 * so a runaway tracker can't exceed it.
 *
 * Why settings (not localStorage)?
 *
 *   - The audit hook on `settings:update` captures pin and
 *     view-tracking events into the existing audit log in a
 *     single channel.
 *   - The settings payload is already read on every app mount, so
 *     joining the recents against the live artifact list does not
 *     require a second IPC round-trip.
 *   - localStorage's 5-10 MB quota and renderer-only scope mean a
 *     full reset of the renderer's IndexedDB / cache (e.g. dev
 *     tools "Clear site data") would silently lose the list,
 *     which surprises the user.
 */

import { useCallback, useEffect, useMemo, useRef } from "react";
import { MAX_RECENT_ARTIFACTS } from "../types/ipc";
import { useSettings, useUpdateSetting } from "./useSettings";

export interface UseRecentlyViewedArtifactsResult {
  /** The current view-history IDs in most-recent-first order. */
  recentIds: ReadonlyArray<string>;
  /** True when the underlying settings IPC has not loaded yet. */
  loading: boolean;
  /** Last error from a tracking IPC call, or null. */
  error: string | null;
  /**
   * Record that `id` was viewed. Promotes `id` to the front of the
   * list, deduplicating any previous occurrence and trimming the
   * tail to the cap. No-op if `id` is already at index 0 (so a
   * remount of the same editor does not generate a write storm).
   */
  trackView: (id: string) => Promise<ReadonlyArray<string>>;
  /**
   * Drop every id in `idsToRemove` from the recents list. Called
   * lazily by the renderer when joining recents against the live
   * artifact list finds stale entries.
   */
  pruneRecents: (idsToRemove: ReadonlySet<string>) => Promise<void>;
}

export function useRecentlyViewedArtifacts(): UseRecentlyViewedArtifactsResult {
  const { settings, loading } = useSettings();
  const { update, error } = useUpdateSetting();
  const recentIds = settings.recentArtifactIds;

  // Latest-value ref so `trackView` / `pruneRecents` can read the
  // current list without listing `recentIds` in their dep arrays.
  // Without this, every tracked view invalidated `trackView`, which
  // re-ran `useTrackArtifactView`'s effect with the same `id` (a
  // no-op short-circuit on `current[0] === id`) wasting a render
  // pass per artifact open. PR #87 Devin Review ANALYSIS_0002.
  const recentIdsRef = useRef(recentIds);
  recentIdsRef.current = recentIds;

  const writeRecents = useCallback(
    async (next: string[]): Promise<ReadonlyArray<string>> => {
      const trimmed =
        next.length > MAX_RECENT_ARTIFACTS
          ? next.slice(0, MAX_RECENT_ARTIFACTS)
          : next;
      const result = await update({ recentArtifactIds: trimmed });
      // `useUpdateSetting.update` already broadcasts the post-write
      // snapshot to every `useSettings()` subscriber via the
      // module-level `settingsStore.setSettings(result)` call at
      // `useSettings.ts:219`. A follow-up `refresh()` would fire a
      // redundant `settings:get` IPC for no benefit. Mirrors the
      // `usePinnedArtifacts.writePinned` fix. PR #87 Devin Review
      // ANALYSIS_0001 round 3.
      return result.recentArtifactIds;
    },
    [update],
  );

  const trackView = useCallback(
    async (id: string) => {
      const current = recentIdsRef.current;
      if (current[0] === id) return current;
      const filtered = current.filter((x) => x !== id);
      const next = [id, ...filtered];
      return writeRecents(next);
    },
    [writeRecents],
  );

  const pruneRecents = useCallback(
    async (idsToRemove: ReadonlySet<string>) => {
      if (idsToRemove.size === 0) return;
      const current = recentIdsRef.current;
      const next = current.filter((x) => !idsToRemove.has(x));
      if (next.length === current.length) return;
      await writeRecents(next);
    },
    [writeRecents],
  );

  return useMemo(
    () => ({ recentIds, loading, error, trackView, pruneRecents }),
    [recentIds, loading, error, trackView, pruneRecents],
  );
}

/**
 * Convenience hook for the artifact editor page: tracks the
 * current artifact's view as soon as it mounts (or when `id`
 * changes). Designed to run regardless of the artifact-fetch
 * result — even a failed load still constitutes a "view attempt"
 * worth recording, so the user can re-try via the palette.
 *
 * Pass `null` / `undefined` to skip tracking (used when the route
 * has no `id` param).
 */
export function useTrackArtifactView(id: string | null | undefined): void {
  const { trackView, loading } = useRecentlyViewedArtifacts();
  useEffect(() => {
    if (!id) return;
    // Gate on `!loading` so the very first `trackView` call after
    // app launch happens AFTER the initial `settings:get` IPC
    // resolves. Without this gate the effect would race the IPC:
    //
    //   1. Component mounts; `useSettings()` returns the empty
    //      placeholder snapshot `{ recentArtifactIds: [] }`.
    //   2. The store's `refresh()` IPC starts but hasn't resolved.
    //   3. This effect reads `recentIdsRef.current` (still `[]`)
    //      and writes `[id]` back — silently erasing the user's
    //      view-history every time the editor mounts on a cold
    //      load.
    //
    // The shared-store refactor (PR #87 Devin Review ANALYSIS_0001)
    // means a second editor mount in the same session would not
    // race because the store already has the loaded snapshot, but
    // the FIRST mount on app launch still hits the race window
    // unless we gate explicitly on `loading`. PR #87 Devin Review
    // BUG_0001.
    if (loading) return;
    void trackView(id);
  }, [id, trackView, loading]);
}
