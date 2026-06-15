/**
 * `useCustomSlideTemplates` — renderer access to the user's saved slide
 * templates.
 *
 * A module-level store (mirroring `brandKitsStore` in `useBrandKits.ts`
 * and `customSkillsStore` in `skills/useCustomSkills.ts`) holds the
 * single source of truth so a save / edit / delete in one Slide editor
 * is reflected immediately in every other open editor. The store is
 * backed by `localStorage` through the pure helpers in
 * `customSlideTemplates.ts` (lazily loaded on first access, written
 * through on every mutation) and exposed via `useSyncExternalStore` so
 * React subscribes without prop-drilling.
 *
 * The hook exposes the gallery's full lifecycle: `saveTemplate` (create
 * or edit-in-place), `deleteTemplate`, `duplicateTemplate` (clone with a
 * fresh id), and a `templateById` accessor so the editor can resolve a
 * live template by id without holding a stale snapshot.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  buildCustomSlideTemplate,
  duplicateSlideTemplateDraft,
  findCustomSlideTemplate,
  loadCustomSlideTemplates,
  removeCustomSlideTemplate,
  saveCustomSlideTemplates,
  upsertCustomSlideTemplate,
  type CustomSlideTemplate,
  type CustomSlideTemplateBuildResult,
  type CustomSlideTemplateDraft,
} from "./customSlideTemplates";

// ─────────────────────────────────────────────────────────────────────
// Module-level store
// ─────────────────────────────────────────────────────────────────────

const customSlideTemplatesStore = (() => {
  // `null` until first read; thereafter the cached snapshot. The
  // reference only changes on mutation, so `useSyncExternalStore` stays
  // stable across renders.
  let templates: CustomSlideTemplate[] | null = null;
  const listeners = new Set<() => void>();

  function ensureLoaded(): CustomSlideTemplate[] {
    if (templates === null) templates = loadCustomSlideTemplates();
    return templates;
  }

  function emit(): void {
    for (const l of listeners) l();
  }

  function commit(next: CustomSlideTemplate[]): CustomSlideTemplate[] {
    templates = next;
    saveCustomSlideTemplates(next);
    emit();
    return next;
  }

  return {
    getSnapshot(): CustomSlideTemplate[] {
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
    save(draft: CustomSlideTemplateDraft): CustomSlideTemplateBuildResult {
      const result = buildCustomSlideTemplate(draft);
      if (result.ok) {
        commit(upsertCustomSlideTemplate(ensureLoaded(), result.template));
      }
      return result;
    },
    remove(id: string): void {
      const current = ensureLoaded();
      const next = removeCustomSlideTemplate(current, id);
      if (next.length !== current.length) commit(next);
    },
    /**
     * Clone an existing template under a fresh id (label suffixed with
     * "(copy)") and persist it. Returns the build result, or `null` when
     * `id` matches no template.
     */
    duplicate(id: string): CustomSlideTemplateBuildResult | null {
      const source = findCustomSlideTemplate(ensureLoaded(), id);
      if (!source) return null;
      const result = buildCustomSlideTemplate(
        duplicateSlideTemplateDraft(source),
      );
      if (result.ok) {
        commit(upsertCustomSlideTemplate(ensureLoaded(), result.template));
      }
      return result;
    },
    /** Test-only: reset listeners + force a reload from `localStorage`. */
    __resetForTests(): void {
      templates = null;
      listeners.clear();
    },
  };
})();

/** Test-only hook to reset the module store between cases. */
export function __resetCustomSlideTemplatesStoreForTests(): void {
  customSlideTemplatesStore.__resetForTests();
}

// ─────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────

export interface UseCustomSlideTemplatesResult {
  /** The user's saved templates (insertion order). */
  customTemplates: ReadonlyArray<CustomSlideTemplate>;
  /**
   * Build + persist a template from a draft. With no `draft.id` (or a
   * foreign id) this creates a new template; with a custom-namespaced
   * `draft.id` it replaces that one in place. Returns the
   * {@link CustomSlideTemplateBuildResult} so the modal can surface
   * validation errors without persisting.
   */
  saveTemplate: (
    draft: CustomSlideTemplateDraft,
  ) => CustomSlideTemplateBuildResult;
  /** Delete a template by id (no-op when absent). */
  deleteTemplate: (id: string) => void;
  /**
   * Clone a template under a fresh id (label suffixed "(copy)") and
   * persist it. Returns the build result, or `null` when `id` is
   * unknown.
   */
  duplicateTemplate: (id: string) => CustomSlideTemplateBuildResult | null;
  /** Resolve a (possibly unknown/absent) template id, or `null`. */
  templateById: (id: string | undefined | null) => CustomSlideTemplate | null;
}

export function useCustomSlideTemplates(): UseCustomSlideTemplatesResult {
  const customTemplates = useSyncExternalStore(
    customSlideTemplatesStore.subscribe,
    customSlideTemplatesStore.getSnapshot,
    customSlideTemplatesStore.getSnapshot,
  );

  const saveTemplate = useCallback(
    (draft: CustomSlideTemplateDraft) => customSlideTemplatesStore.save(draft),
    [],
  );
  const deleteTemplate = useCallback(
    (id: string) => customSlideTemplatesStore.remove(id),
    [],
  );
  const duplicateTemplate = useCallback(
    (id: string) => customSlideTemplatesStore.duplicate(id),
    [],
  );
  const templateById = useCallback(
    (id: string | undefined | null): CustomSlideTemplate | null =>
      findCustomSlideTemplate(customTemplates, id),
    [customTemplates],
  );

  return useMemo(
    () => ({
      customTemplates,
      saveTemplate,
      deleteTemplate,
      duplicateTemplate,
      templateById,
    }),
    [
      customTemplates,
      saveTemplate,
      deleteTemplate,
      duplicateTemplate,
      templateById,
    ],
  );
}
