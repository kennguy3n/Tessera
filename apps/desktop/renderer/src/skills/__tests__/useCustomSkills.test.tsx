import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetCustomSkillsStoreForTests,
  useCustomSkills,
} from "../useCustomSkills";
import { CUSTOM_SKILLS_STORAGE_KEY } from "../customSkills";
import { getSkillsForSurface } from "../skillLibrary";
import type { CustomSkillDraft } from "../customSkills";

function draft(overrides: Partial<CustomSkillDraft> = {}): CustomSkillDraft {
  return {
    name: "Doc helper",
    description: "",
    surfaces: ["document"],
    inputs: [{ id: "topic", label: "Topic", required: true, multiline: false }],
    steps: [
      {
        title: "Draft",
        kind: "draft",
        instruction: "Write about {{topic}}.",
        output: "result",
        inputsFrom: [],
        outputContract: "",
      },
    ],
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  __resetCustomSkillsStoreForTests();
});

describe("useCustomSkills", () => {
  it("starts empty and persists a saved skill across a fresh mount", () => {
    const { result, unmount } = renderHook(() => useCustomSkills());
    expect(result.current.customSkills).toEqual([]);

    let saved: { ok: boolean } = { ok: false };
    act(() => {
      saved = result.current.saveSkill(draft());
    });
    expect(saved.ok).toBe(true);
    expect(result.current.customSkills).toHaveLength(1);
    expect(window.localStorage.getItem(CUSTOM_SKILLS_STORAGE_KEY)).toContain(
      "Doc helper",
    );

    // A fresh store + mount should reload the persisted skill from storage.
    unmount();
    __resetCustomSkillsStoreForTests();
    const second = renderHook(() => useCustomSkills());
    expect(second.result.current.customSkills).toHaveLength(1);
    expect(second.result.current.customSkills[0].name).toBe("Doc helper");
  });

  it("returns build errors without persisting an invalid draft", () => {
    const { result } = renderHook(() => useCustomSkills());
    let res: ReturnType<typeof result.current.saveSkill> = {
      ok: false,
      errors: [],
    };
    act(() => {
      res = result.current.saveSkill(draft({ name: "" }));
    });
    expect(res.ok).toBe(false);
    expect(result.current.customSkills).toEqual([]);
    expect(window.localStorage.getItem(CUSTOM_SKILLS_STORAGE_KEY)).toBeNull();
  });

  it("syncs create/delete across two independent hook consumers", () => {
    const a = renderHook(() => useCustomSkills());
    const b = renderHook(() => useCustomSkills());

    let id = "";
    act(() => {
      const res = a.result.current.saveSkill(draft());
      if (res.ok) id = res.skill.id;
    });
    // The second consumer reflects the write immediately (shared store).
    expect(b.result.current.customSkills.map((s) => s.id)).toEqual([id]);

    act(() => {
      b.result.current.deleteSkill(id);
    });
    expect(a.result.current.customSkills).toEqual([]);
  });

  it("editing an existing skill replaces it in place rather than appending", () => {
    const { result } = renderHook(() => useCustomSkills());
    let id = "";
    act(() => {
      const res = result.current.saveSkill(draft());
      if (res.ok) id = res.skill.id;
    });
    act(() => {
      result.current.saveSkill(draft({ id, name: "Renamed" }));
    });
    expect(result.current.customSkills).toHaveLength(1);
    expect(result.current.customSkills[0].name).toBe("Renamed");
    expect(result.current.customSkills[0].id).toBe(id);
  });

  it("merges built-ins with custom skills per surface and resolves ids", () => {
    const { result } = renderHook(() => useCustomSkills());
    const builtinDocCount = getSkillsForSurface("document").length;

    let id = "";
    act(() => {
      const res = result.current.saveSkill(
        draft({ surfaces: ["document", "slide"] }),
      );
      if (res.ok) id = res.skill.id;
    });

    const docSkills = result.current.skillsForSurface("document");
    expect(docSkills).toHaveLength(builtinDocCount + 1);
    // Built-ins come first; the custom skill is appended.
    expect(docSkills[docSkills.length - 1].id).toBe(id);
    expect(result.current.skillsForSurface("slide").map((s) => s.id)).toContain(
      id,
    );
    // Surface it does NOT declare excludes it.
    expect(
      result.current.skillsForSurface("base").map((s) => s.id),
    ).not.toContain(id);

    // skillById resolves both built-ins and custom skills.
    expect(result.current.skillById(id)?.id).toBe(id);
    expect(result.current.skillById("document-deliberate-draft")).toBeDefined();
    expect(result.current.skillById("missing")).toBeUndefined();
  });
});
