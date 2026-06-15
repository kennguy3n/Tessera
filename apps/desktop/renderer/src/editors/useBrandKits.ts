/**
 * `useBrandKits` — renderer access to the user's saved slide brand kits.
 *
 * A module-level store (mirroring `customSkillsStore` in
 * `skills/useCustomSkills.ts`) holds the single source of truth so a
 * create/edit/delete in one Slide editor's brand builder is reflected
 * immediately in every other open editor. The store is backed by
 * `localStorage` through the pure helpers in `slideBrandKit.ts` (lazily
 * loaded on first access, written through on every mutation).
 *
 * The hook also exposes a `brandKitById` accessor so the editor can
 * resolve a deck's persisted `brandKitId` to the active kit (degrading
 * to "no brand kit" when the id is unknown — e.g. a kit deleted on
 * another machine or a hand-edited deck).
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  buildBrandKit,
  findBrandKit,
  loadBrandKits,
  removeBrandKit,
  saveBrandKits,
  upsertBrandKit,
  type BrandKit,
  type BrandKitBuildResult,
  type BrandKitDraft,
} from "./slideBrandKit";

// ─────────────────────────────────────────────────────────────────────
// Module-level store
// ─────────────────────────────────────────────────────────────────────

const brandKitsStore = (() => {
  // `null` until first read; thereafter the cached snapshot. The
  // reference only changes on mutation, so `useSyncExternalStore` stays
  // stable across renders.
  let kits: BrandKit[] | null = null;
  const listeners = new Set<() => void>();

  function ensureLoaded(): BrandKit[] {
    if (kits === null) kits = loadBrandKits();
    return kits;
  }

  function emit(): void {
    for (const l of listeners) l();
  }

  function commit(next: BrandKit[]): BrandKit[] {
    kits = next;
    saveBrandKits(next);
    emit();
    return next;
  }

  return {
    getSnapshot(): BrandKit[] {
      return ensureLoaded();
    },
    subscribe(listener: () => void): () => void {
      ensureLoaded();
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    /** Build from a draft and upsert on success; returns the build result. */
    save(draft: BrandKitDraft): BrandKitBuildResult {
      const result = buildBrandKit(draft);
      if (result.ok) commit(upsertBrandKit(ensureLoaded(), result.brandKit));
      return result;
    },
    remove(id: string): void {
      const current = ensureLoaded();
      const next = removeBrandKit(current, id);
      if (next.length !== current.length) commit(next);
    },
    /** Test-only: reset listeners + force a reload from `localStorage`. */
    __resetForTests(): void {
      kits = null;
      listeners.clear();
    },
  };
})();

/** Test-only hook to reset the module store between cases. */
export function __resetBrandKitsStoreForTests(): void {
  brandKitsStore.__resetForTests();
}

// ─────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────

export interface UseBrandKitsResult {
  /** The user's saved brand kits (insertion order). */
  brandKits: ReadonlyArray<BrandKit>;
  /**
   * Build + persist a kit from a draft. With no `draft.id` this creates a
   * new kit; with a brand-namespaced `draft.id` it replaces that one in
   * place. Returns the {@link BrandKitBuildResult} so the builder can
   * surface validation errors without persisting.
   */
  saveBrandKit: (draft: BrandKitDraft) => BrandKitBuildResult;
  /** Delete a brand kit by id (no-op when absent). */
  deleteBrandKit: (id: string) => void;
  /** Resolve a (possibly unknown/absent) kit id to the kit, or `null`. */
  brandKitById: (id: string | undefined | null) => BrandKit | null;
}

export function useBrandKits(): UseBrandKitsResult {
  const brandKits = useSyncExternalStore(
    brandKitsStore.subscribe,
    brandKitsStore.getSnapshot,
    brandKitsStore.getSnapshot,
  );

  const saveBrandKit = useCallback(
    (draft: BrandKitDraft) => brandKitsStore.save(draft),
    [],
  );
  const deleteBrandKit = useCallback(
    (id: string) => brandKitsStore.remove(id),
    [],
  );

  const brandKitById = useCallback(
    (id: string | undefined | null): BrandKit | null =>
      findBrandKit(brandKits, id),
    [brandKits],
  );

  return useMemo(
    () => ({ brandKits, saveBrandKit, deleteBrandKit, brandKitById }),
    [brandKits, saveBrandKit, deleteBrandKit, brandKitById],
  );
}
