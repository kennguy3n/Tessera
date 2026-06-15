/**
 * `useCustomSheetTemplates` — renderer access to the user's saved sheet
 * templates.
 *
 * A module-level store (mirroring `customSlideTemplatesStore`) holds the
 * single source of truth so a save / edit / delete in one Sheet editor is
 * reflected immediately in every other open editor. The store is backed
 * by `localStorage` through the pure helpers in `customSheetTemplates.ts`
 * (lazily loaded on first access, written through on every mutation) and
 * exposed via `useSyncExternalStore` so React subscribes without
 * prop-drilling.
 *
 * The hook exposes the gallery's full lifecycle: `saveTemplate` (create
 * or edit-in-place), `deleteTemplate`, `duplicateTemplate` (clone with a
 * fresh id), and a `templateById` accessor so the editor can resolve a
 * live template by id without holding a stale snapshot.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  buildCustomSheetTemplate,
  duplicateSheetTemplateDraft,
  findCustomSheetTemplate,
  loadCustomSheetTemplates,
  removeCustomSheetTemplate,
  saveCustomSheetTemplates,
  upsertCustomSheetTemplate,
  type CustomSheetTemplate,
  type CustomSheetTemplateBuildResult,
  type CustomSheetTemplateDraft,
} from "./customSheetTemplates";

// ─────────────────────────────────────────────────────────────────────
// Module-level store
// ─────────────────────────────────────────────────────────────────────

const customSheetTemplatesStore = (() => {
  // `null` until first read; thereafter the cached snapshot. The
  // reference only changes on mutation, so `useSyncExternalStore` stays
  // stable across renders.
  let templates: CustomSheetTemplate[] | null = null;
  const listeners = new Set<() => void>();

  function ensureLoaded(): CustomSheetTemplate[] {
    if (templates === null) templates = loadCustomSheetTemplates();
    return templates;
  }

  function emit(): void {
    for (const l of listeners) l();
  }

  function commit(next: CustomSheetTemplate[]): CustomSheetTemplate[] {
    templates = next;
    saveCustomSheetTemplates(next);
    emit();
    return next;
  }

  return {
    getSnapshot(): CustomSheetTemplate[] {
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
    save(draft: CustomSheetTemplateDraft): CustomSheetTemplateBuildResult {
      const result = buildCustomSheetTemplate(draft);
      if (result.ok) {
        commit(upsertCustomSheetTemplate(ensureLoaded(), result.template));
      }
      return result;
    },
    remove(id: string): void {
      const current = ensureLoaded();
      const next = removeCustomSheetTemplate(current, id);
      if (next.length !== current.length) commit(next);
    },
    /**
     * Clone an existing template under a fresh id (label suffixed with
     * "(copy)") and persist it. Returns the build result, or `null` when
     * `id` matches no template.
     */
    duplicate(id: string): CustomSheetTemplateBuildResult | null {
      const source = findCustomSheetTemplate(ensureLoaded(), id);
      if (!source) return null;
      const result = buildCustomSheetTemplate(
        duplicateSheetTemplateDraft(source),
      );
      if (result.ok) {
        commit(upsertCustomSheetTemplate(ensureLoaded(), result.template));
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
export function __resetCustomSheetTemplatesStoreForTests(): void {
  customSheetTemplatesStore.__resetForTests();
}

// ─────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────

export interface UseCustomSheetTemplatesResult {
  /** The user's saved templates (insertion order). */
  customTemplates: ReadonlyArray<CustomSheetTemplate>;
  /**
   * Build + persist a template from a draft. With no `draft.id` (or a
   * foreign id) this creates a new template; with a custom-namespaced
   * `draft.id` it replaces that one in place. Returns the
   * {@link CustomSheetTemplateBuildResult} so the modal can surface
   * validation errors without persisting.
   */
  saveTemplate: (
    draft: CustomSheetTemplateDraft,
  ) => CustomSheetTemplateBuildResult;
  /** Delete a template by id (no-op when absent). */
  deleteTemplate: (id: string) => void;
  /**
   * Clone a template under a fresh id (label suffixed "(copy)") and
   * persist it. Returns the build result, or `null` when `id` is unknown.
   */
  duplicateTemplate: (id: string) => CustomSheetTemplateBuildResult | null;
  /** Resolve a (possibly unknown/absent) template id, or `null`. */
  templateById: (id: string | undefined | null) => CustomSheetTemplate | null;
}

export function useCustomSheetTemplates(): UseCustomSheetTemplatesResult {
  const customTemplates = useSyncExternalStore(
    customSheetTemplatesStore.subscribe,
    customSheetTemplatesStore.getSnapshot,
    customSheetTemplatesStore.getSnapshot,
  );

  const saveTemplate = useCallback(
    (draft: CustomSheetTemplateDraft) => customSheetTemplatesStore.save(draft),
    [],
  );
  const deleteTemplate = useCallback(
    (id: string) => customSheetTemplatesStore.remove(id),
    [],
  );
  const duplicateTemplate = useCallback(
    (id: string) => customSheetTemplatesStore.duplicate(id),
    [],
  );
  const templateById = useCallback(
    (id: string | undefined | null): CustomSheetTemplate | null =>
      findCustomSheetTemplate(customTemplates, id),
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
