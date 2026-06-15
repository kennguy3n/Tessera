/**
 * `useCustomBaseTemplates` — renderer access to the user's saved Base
 * templates.
 *
 * A module-level store (mirroring `customSlideTemplatesStore`) holds the
 * single source of truth so a save / delete / duplicate in one Base
 * editor is reflected immediately in every other open editor. The store
 * is backed by `localStorage` through the pure helpers in
 * `customBaseTemplates.ts` (lazily loaded on first access, written
 * through on every mutation) and exposed via `useSyncExternalStore` so
 * React subscribes without prop-drilling.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  buildCustomBaseTemplate,
  duplicateBaseTemplateDraft,
  findCustomBaseTemplate,
  loadCustomBaseTemplates,
  removeCustomBaseTemplate,
  saveCustomBaseTemplates,
  upsertCustomBaseTemplate,
  type CustomBaseTemplate,
  type CustomBaseTemplateBuildResult,
  type CustomBaseTemplateDraft,
} from "./customBaseTemplates";

// ─────────────────────────────────────────────────────────────────────
// Module-level store
// ─────────────────────────────────────────────────────────────────────

const customBaseTemplatesStore = (() => {
  // `null` until first read; thereafter the cached snapshot. The
  // reference only changes on mutation, so `useSyncExternalStore` stays
  // stable across renders.
  let templates: CustomBaseTemplate[] | null = null;
  const listeners = new Set<() => void>();

  function ensureLoaded(): CustomBaseTemplate[] {
    if (templates === null) templates = loadCustomBaseTemplates();
    return templates;
  }

  function emit(): void {
    for (const l of listeners) l();
  }

  function commit(next: CustomBaseTemplate[]): CustomBaseTemplate[] {
    templates = next;
    saveCustomBaseTemplates(next);
    emit();
    return next;
  }

  return {
    getSnapshot(): CustomBaseTemplate[] {
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
    save(draft: CustomBaseTemplateDraft): CustomBaseTemplateBuildResult {
      const result = buildCustomBaseTemplate(draft);
      if (result.ok) {
        commit(upsertCustomBaseTemplate(ensureLoaded(), result.template));
      }
      return result;
    },
    remove(id: string): void {
      const current = ensureLoaded();
      const next = removeCustomBaseTemplate(current, id);
      if (next.length !== current.length) commit(next);
    },
    /**
     * Clone an existing template under a fresh id (label suffixed with
     * "(copy)") and persist it. Returns the build result, or `null` when
     * `id` matches no template.
     */
    duplicate(id: string): CustomBaseTemplateBuildResult | null {
      const source = findCustomBaseTemplate(ensureLoaded(), id);
      if (!source) return null;
      const result = buildCustomBaseTemplate(
        duplicateBaseTemplateDraft(source),
      );
      if (result.ok) {
        commit(upsertCustomBaseTemplate(ensureLoaded(), result.template));
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
export function __resetCustomBaseTemplatesStoreForTests(): void {
  customBaseTemplatesStore.__resetForTests();
}

// ─────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────

export interface UseCustomBaseTemplatesResult {
  /** The user's saved templates (insertion order). */
  customTemplates: ReadonlyArray<CustomBaseTemplate>;
  /**
   * Build + persist a template from a draft. With no `draft.id` (or a
   * foreign id) this creates a new template; with a custom-namespaced
   * `draft.id` it replaces that one in place. Returns the
   * {@link CustomBaseTemplateBuildResult} so the UI can surface
   * validation errors without persisting.
   */
  saveTemplate: (
    draft: CustomBaseTemplateDraft,
  ) => CustomBaseTemplateBuildResult;
  /** Delete a template by id (no-op when absent). */
  deleteTemplate: (id: string) => void;
  /**
   * Clone a template under a fresh id (label suffixed "(copy)") and
   * persist it. Returns the build result, or `null` when `id` is unknown.
   */
  duplicateTemplate: (id: string) => CustomBaseTemplateBuildResult | null;
  /** Resolve a (possibly unknown/absent) template id, or `null`. */
  templateById: (id: string | undefined | null) => CustomBaseTemplate | null;
}

export function useCustomBaseTemplates(): UseCustomBaseTemplatesResult {
  const customTemplates = useSyncExternalStore(
    customBaseTemplatesStore.subscribe,
    customBaseTemplatesStore.getSnapshot,
    customBaseTemplatesStore.getSnapshot,
  );

  const saveTemplate = useCallback(
    (draft: CustomBaseTemplateDraft) => customBaseTemplatesStore.save(draft),
    [],
  );
  const deleteTemplate = useCallback(
    (id: string) => customBaseTemplatesStore.remove(id),
    [],
  );
  const duplicateTemplate = useCallback(
    (id: string) => customBaseTemplatesStore.duplicate(id),
    [],
  );
  const templateById = useCallback(
    (id: string | undefined | null): CustomBaseTemplate | null =>
      findCustomBaseTemplate(customTemplates, id),
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
