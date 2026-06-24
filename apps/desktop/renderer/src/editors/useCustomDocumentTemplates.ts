/**
 * `useCustomDocumentTemplates` — renderer access to the user's saved
 * document templates.
 *
 * A module-level store (mirroring `customSlideTemplatesStore` in
 * `useCustomSlideTemplates.ts` and `customSkillsStore` in
 * `skills/useCustomSkills.ts`) holds the single source of truth so a save
 * / edit / delete in one Document editor is reflected immediately in
 * every other open editor. The store is backed by `localStorage` through
 * the pure helpers in `customDocumentTemplates.ts` (lazily loaded on
 * first access, written through on every mutation) and exposed via
 * `useSyncExternalStore` so React subscribes without prop-drilling.
 *
 * The hook exposes the gallery's full lifecycle: `saveTemplate` (create
 * or edit-in-place), `deleteTemplate`, `duplicateTemplate` (clone with a
 * fresh id), and a `templateById` accessor so the editor can resolve a
 * live template by id without holding a stale snapshot.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  buildCustomDocumentTemplate,
  duplicateDocumentTemplateDraft,
  findCustomDocumentTemplate,
  loadCustomDocumentTemplates,
  removeCustomDocumentTemplate,
  saveCustomDocumentTemplates,
  upsertCustomDocumentTemplate,
  type CustomDocumentTemplate,
  type CustomDocumentTemplateBuildResult,
  type CustomDocumentTemplateDraft,
} from "./customDocumentTemplates";

// ─────────────────────────────────────────────────────────────────────
// Module-level store
// ─────────────────────────────────────────────────────────────────────

const customDocumentTemplatesStore = (() => {
  // `null` until first read; thereafter the cached snapshot. The
  // reference only changes on mutation, so `useSyncExternalStore` stays
  // stable across renders.
  let templates: CustomDocumentTemplate[] | null = null;
  const listeners = new Set<() => void>();

  function ensureLoaded(): CustomDocumentTemplate[] {
    if (templates === null) templates = loadCustomDocumentTemplates();
    return templates;
  }

  function emit(): void {
    for (const l of listeners) l();
  }

  function commit(next: CustomDocumentTemplate[]): CustomDocumentTemplate[] {
    templates = next;
    saveCustomDocumentTemplates(next);
    emit();
    return next;
  }

  return {
    getSnapshot(): CustomDocumentTemplate[] {
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
    save(
      draft: CustomDocumentTemplateDraft,
    ): CustomDocumentTemplateBuildResult {
      const result = buildCustomDocumentTemplate(draft);
      if (result.ok) {
        commit(upsertCustomDocumentTemplate(ensureLoaded(), result.template));
      }
      return result;
    },
    remove(id: string): void {
      const current = ensureLoaded();
      const next = removeCustomDocumentTemplate(current, id);
      if (next.length !== current.length) commit(next);
    },
    /**
     * Clone an existing template under a fresh id (label suffixed with
     * "(copy)") and persist it. Returns the build result, or `null` when
     * `id` matches no template.
     */
    duplicate(id: string): CustomDocumentTemplateBuildResult | null {
      const source = findCustomDocumentTemplate(ensureLoaded(), id);
      if (!source) return null;
      const result = buildCustomDocumentTemplate(
        duplicateDocumentTemplateDraft(source),
      );
      if (result.ok) {
        commit(upsertCustomDocumentTemplate(ensureLoaded(), result.template));
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
export function __resetCustomDocumentTemplatesStoreForTests(): void {
  customDocumentTemplatesStore.__resetForTests();
}

// ─────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────

export interface UseCustomDocumentTemplatesResult {
  /** The user's saved templates (insertion order). */
  customTemplates: ReadonlyArray<CustomDocumentTemplate>;
  /**
   * Build + persist a template from a draft. With no `draft.id` (or a
   * foreign id) this creates a new template; with a custom-namespaced
   * `draft.id` it replaces that one in place. Returns the
   * {@link CustomDocumentTemplateBuildResult} so the modal can surface
   * validation errors without persisting.
   */
  saveTemplate: (
    draft: CustomDocumentTemplateDraft,
  ) => CustomDocumentTemplateBuildResult;
  /** Delete a template by id (no-op when absent). */
  deleteTemplate: (id: string) => void;
  /**
   * Clone a template under a fresh id (label suffixed "(copy)") and
   * persist it. Returns the build result, or `null` when `id` is unknown.
   */
  duplicateTemplate: (id: string) => CustomDocumentTemplateBuildResult | null;
  /** Resolve a (possibly unknown/absent) template id, or `null`. */
  templateById: (
    id: string | undefined | null,
  ) => CustomDocumentTemplate | null;
}

export function useCustomDocumentTemplates(): UseCustomDocumentTemplatesResult {
  const customTemplates = useSyncExternalStore(
    customDocumentTemplatesStore.subscribe,
    customDocumentTemplatesStore.getSnapshot,
    customDocumentTemplatesStore.getSnapshot,
  );

  const saveTemplate = useCallback(
    (draft: CustomDocumentTemplateDraft) =>
      customDocumentTemplatesStore.save(draft),
    [],
  );
  const deleteTemplate = useCallback(
    (id: string) => customDocumentTemplatesStore.remove(id),
    [],
  );
  const duplicateTemplate = useCallback(
    (id: string) => customDocumentTemplatesStore.duplicate(id),
    [],
  );
  const templateById = useCallback(
    (id: string | undefined | null): CustomDocumentTemplate | null =>
      findCustomDocumentTemplate(customTemplates, id),
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
