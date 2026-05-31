/**
 * Phase 18 Task 16: hooks for reading and mutating the pinned-
 * artifact ("favorite") list stored in `SettingsData.pinnedArtifactIds`.
 *
 * Why settings (not localStorage)?
 *
 *   - The list travels with the user's persisted config, so a
 *     fresh install on the same machine (or a reset of the
 *     renderer's IndexedDB) does not silently drop their pins.
 *   - Audit hooks already exist for `settings:update`, so pin /
 *     unpin events appear in the existing audit log without a
 *     parallel persistence path.
 *   - Reading is already debounced through the existing
 *     `useSettings()` hook so a hot path that only needs to know
 *     "is this artifact pinned?" reuses the cached settings
 *     payload instead of issuing a fresh IPC roundtrip.
 *
 * The toggle path is **lossless**: we always send the full new
 * list to the IPC layer rather than `{ added, removed }` deltas,
 * because the on-disk config is a single JSON blob and a partial
 * update racing against a parallel toggle would be reorderable.
 * The cap of 256 entries is enforced by both the IPC schema and
 * the on-disk config schema; the renderer trims defensively to
 * the same bound so a misbehaving caller can't trigger a server-
 * side reject (which would surface as a console error and a
 * confusing "nothing happened" UX).
 */

import { useCallback, useMemo, useRef } from "react";
import { MAX_PINNED_ARTIFACTS } from "../types/ipc";
import { useSettings, useUpdateSetting } from "./useSettings";

/**
 * Re-export so existing consumers of this hook keep working. The
 * canonical declaration lives in `shared/types.ts`
 * ({@link MAX_PINNED_ARTIFACTS}) and is shared with both the IPC
 * `SettingsUpdateSchema` and the on-disk `AppConfigSchema`. PR #87
 * Devin Review ANALYSIS_0007: removed the previous "three-way
 * literal `256` duplicate" and made the renderer hook import the
 * cap from the same source the schemas use.
 */
export { MAX_PINNED_ARTIFACTS };

export interface UsePinnedArtifactsResult {
  /** The current pinned IDs, in the order the user pinned them
   *  (most recently pinned first). */
  pinnedIds: ReadonlyArray<string>;
  /** True when the underlying settings IPC has not loaded yet. */
  loading: boolean;
  /** Last error from a `togglePin` / `setPinned` IPC call, or null. */
  error: string | null;
  /** O(1) lookup against the in-memory snapshot. */
  isPinned: (id: string) => boolean;
  /**
   * Flip the pinned state for `id`. If `id` is already pinned it
   * is removed; otherwise it is prepended to the front of the
   * list (most-recently-pinned first) and any over-cap tail is
   * trimmed. Returns the new pinned list after the write resolves.
   */
  togglePin: (id: string) => Promise<ReadonlyArray<string>>;
  /**
   * Force the pinned state for `id` to `pinned`. Used by the
   * context-menu Pin / Unpin entries which know the desired
   * end state regardless of the current one.
   */
  setPinned: (id: string, pinned: boolean) => Promise<ReadonlyArray<string>>;
  /**
   * Drop every id in `idsToRemove` from the pinned list. Called
   * lazily by the renderer when joining `pinnedIds` against the
   * live artifact list finds stale entries (artifact deleted
   * elsewhere). No-op if no entries match.
   */
  prunePinned: (idsToRemove: ReadonlySet<string>) => Promise<void>;
}

export function usePinnedArtifacts(): UsePinnedArtifactsResult {
  const { settings, loading, refresh } = useSettings();
  const { update, error } = useUpdateSetting();
  const pinnedIds = settings.pinnedArtifactIds;

  // Latest-value ref so `togglePin` / `setPinned` / `prunePinned`
  // can read the current list without listing `pinnedIds` in their
  // dep arrays. Mirrors the pattern in `useRecentlyViewedArtifacts`
  // — keeps the callbacks stable across writes so child effects
  // don't re-run every pin/unpin. PR #87 Devin Review ANALYSIS_0002
  // companion fix.
  const pinnedIdsRef = useRef(pinnedIds);
  pinnedIdsRef.current = pinnedIds;

  // Set-backed O(1) membership lookup for `isPinned`. The previous
  // `pinnedIds.includes(id)` was O(n) per call which contradicted
  // the documented "O(1) lookup" contract — palette + sidebar +
  // editor + recent-cards each call `isPinned()` once per render
  // for every pinned candidate, so an O(n) check would scale
  // poorly on a 256-entry pinned list. PR #87 Devin Review
  // ANALYSIS_0002.
  const pinnedSet = useMemo(() => new Set(pinnedIds), [pinnedIds]);
  const isPinned = useCallback(
    (id: string) => pinnedSet.has(id),
    [pinnedSet],
  );

  const writePinned = useCallback(
    async (next: string[]): Promise<ReadonlyArray<string>> => {
      const trimmed =
        next.length > MAX_PINNED_ARTIFACTS
          ? next.slice(0, MAX_PINNED_ARTIFACTS)
          : next;
      const result = await update({ pinnedArtifactIds: trimmed });
      // Broadcast to every live consumer via the shared store.
      // Since the `useSettings()` refactor moved to a module-level
      // store (see hooks/useSettings.ts header comment for the
      // architectural rationale), a single refresh notifies the
      // sidebar, palette, and editor pin button at once. Before
      // the refactor each consumer held its own snapshot and the
      // sidebar would lag behind palette pin toggles until remount.
      await refresh();
      return result.pinnedArtifactIds;
    },
    [update, refresh],
  );

  const togglePin = useCallback(
    async (id: string) => {
      const current = pinnedIdsRef.current;
      const next = current.includes(id)
        ? current.filter((x) => x !== id)
        : [id, ...current];
      return writePinned(next);
    },
    [writePinned],
  );

  const setPinned = useCallback(
    async (id: string, pinned: boolean) => {
      const current = pinnedIdsRef.current;
      const has = current.includes(id);
      if (pinned === has) return current;
      const next = pinned ? [id, ...current] : current.filter((x) => x !== id);
      return writePinned(next);
    },
    [writePinned],
  );

  const prunePinned = useCallback(
    async (idsToRemove: ReadonlySet<string>) => {
      if (idsToRemove.size === 0) return;
      const current = pinnedIdsRef.current;
      const next = current.filter((x) => !idsToRemove.has(x));
      if (next.length === current.length) return;
      await writePinned(next);
    },
    [writePinned],
  );

  return useMemo(
    () => ({
      pinnedIds,
      loading,
      error,
      isPinned,
      togglePin,
      setPinned,
      prunePinned,
    }),
    [pinnedIds, loading, error, isPinned, togglePin, setPinned, prunePinned],
  );
}
