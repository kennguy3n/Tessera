/**
 * `useCustomSkills` — renderer access to the user's saved custom skills.
 *
 * A module-level store (mirroring `settingsStore` in `useSettings.ts`) holds
 * the single source of truth so a create/edit/delete in one editor's Skills
 * panel is reflected immediately in every other open panel. The store is
 * backed by `localStorage` through the pure helpers in `customSkills.ts`
 * (lazy-loaded on first access, written through on every mutation).
 *
 * The hook also exposes *merged* accessors (`skillsForSurface`, `skillById`)
 * that fold the built-in skills together with the user's custom ones, which
 * is exactly what each AI panel's picker needs.
 */

import { useCallback, useMemo, useSyncExternalStore } from "react";
import {
  buildCustomSkill,
  loadCustomSkills,
  removeCustomSkill,
  saveCustomSkills,
  upsertCustomSkill,
  type BuildResult,
  type CustomSkillDraft,
} from "./customSkills";
import {
  BUILTIN_SKILLS,
  getSkillById,
  getSkillsForSurface,
} from "./skillLibrary";
import type { Skill, SkillSurface } from "./skillTypes";

// ─────────────────────────────────────────────────────────────────────
// Module-level store
// ─────────────────────────────────────────────────────────────────────

const customSkillsStore = (() => {
  // `null` until first read; thereafter the cached snapshot. The reference
  // only changes on mutation, so `useSyncExternalStore` stays stable.
  let skills: Skill[] | null = null;
  const listeners = new Set<() => void>();

  function ensureLoaded(): Skill[] {
    if (skills === null) skills = loadCustomSkills();
    return skills;
  }

  function emit(): void {
    for (const l of listeners) l();
  }

  function commit(next: Skill[]): Skill[] {
    skills = next;
    saveCustomSkills(next);
    emit();
    return next;
  }

  return {
    getSnapshot(): Skill[] {
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
    save(draft: CustomSkillDraft): BuildResult {
      const result = buildCustomSkill(draft);
      if (result.ok) commit(upsertCustomSkill(ensureLoaded(), result.skill));
      return result;
    },
    remove(id: string): void {
      const current = ensureLoaded();
      const next = removeCustomSkill(current, id);
      if (next.length !== current.length) commit(next);
    },
    /** Test-only: reset listeners + force a reload from `localStorage`. */
    __resetForTests(): void {
      skills = null;
      listeners.clear();
    },
  };
})();

/** Test-only hook to reset the module store between cases. */
export function __resetCustomSkillsStoreForTests(): void {
  customSkillsStore.__resetForTests();
}

// ─────────────────────────────────────────────────────────────────────
// Hook
// ─────────────────────────────────────────────────────────────────────

export interface UseCustomSkillsResult {
  /** The user's saved custom skills (insertion order). */
  customSkills: ReadonlyArray<Skill>;
  /**
   * Build + persist a skill from a draft. With no `draft.id` this creates a
   * new skill; with a custom `draft.id` it replaces that one in place.
   * Returns the {@link BuildResult} so the editor can surface validation
   * errors without persisting.
   */
  saveSkill: (draft: CustomSkillDraft) => BuildResult;
  /** Delete a custom skill by id (no-op when absent). */
  deleteSkill: (id: string) => void;
  /** Built-in + custom skills offered on `surface` (built-ins first). */
  skillsForSurface: (surface: SkillSurface) => Skill[];
  /** Resolve a skill id across built-ins and custom skills. */
  skillById: (id: string) => Skill | undefined;
}

export function useCustomSkills(): UseCustomSkillsResult {
  const customSkills = useSyncExternalStore(
    customSkillsStore.subscribe,
    customSkillsStore.getSnapshot,
    customSkillsStore.getSnapshot,
  );

  const saveSkill = useCallback(
    (draft: CustomSkillDraft) => customSkillsStore.save(draft),
    [],
  );
  const deleteSkill = useCallback(
    (id: string) => customSkillsStore.remove(id),
    [],
  );

  const skillsForSurface = useCallback(
    (surface: SkillSurface): Skill[] => [
      ...getSkillsForSurface(surface),
      ...customSkills.filter((s) => s.surfaces.includes(surface)),
    ],
    [customSkills],
  );

  const skillById = useCallback(
    (id: string): Skill | undefined =>
      getSkillById(id) ?? customSkills.find((s) => s.id === id),
    [customSkills],
  );

  return useMemo(
    () => ({
      customSkills,
      saveSkill,
      deleteSkill,
      skillsForSurface,
      skillById,
    }),
    [customSkills, saveSkill, deleteSkill, skillsForSurface, skillById],
  );
}

/** Re-export for callers that only need the built-in list (e.g. fallbacks). */
export { BUILTIN_SKILLS };
