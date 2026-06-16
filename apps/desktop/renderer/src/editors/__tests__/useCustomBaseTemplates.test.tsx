import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetCustomBaseTemplatesStoreForTests,
  useCustomBaseTemplates,
} from "../useCustomBaseTemplates";
import {
  CUSTOM_BASE_TEMPLATES_STORAGE_KEY,
  type CustomBaseTemplateDraft,
} from "../customBaseTemplates";
import { parseBaseDocument } from "../baseDocumentHelpers";
import type { BaseDocument } from "../baseEditorTypes";

function baseDoc(name = "Ada"): BaseDocument {
  return parseBaseDocument(
    JSON.stringify({
      fields: [{ name: "Name", type: "text" }],
      records: [{ id: "r1", Name: name }],
    }),
  );
}

function draft(
  overrides: Partial<CustomBaseTemplateDraft> = {},
): CustomBaseTemplateDraft {
  return {
    label: "My base",
    description: "",
    category: "",
    content: baseDoc(),
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  __resetCustomBaseTemplatesStoreForTests();
});

describe("useCustomBaseTemplates", () => {
  it("starts empty and persists a saved template across a fresh mount", () => {
    const { result, unmount } = renderHook(() => useCustomBaseTemplates());
    expect(result.current.customTemplates).toEqual([]);

    let ok = false;
    act(() => {
      ok = result.current.saveTemplate(draft()).ok;
    });
    expect(ok).toBe(true);
    expect(result.current.customTemplates).toHaveLength(1);
    expect(
      window.localStorage.getItem(CUSTOM_BASE_TEMPLATES_STORAGE_KEY),
    ).toContain("My base");

    unmount();
    __resetCustomBaseTemplatesStoreForTests();
    const second = renderHook(() => useCustomBaseTemplates());
    expect(second.result.current.customTemplates).toHaveLength(1);
    expect(second.result.current.customTemplates[0].label).toBe("My base");
  });

  it("returns build errors without persisting an invalid draft", () => {
    const { result } = renderHook(() => useCustomBaseTemplates());
    let res: ReturnType<typeof result.current.saveTemplate> = {
      ok: false,
      errors: [],
    };
    act(() => {
      res = result.current.saveTemplate(draft({ label: "" }));
    });
    expect(res.ok).toBe(false);
    expect(result.current.customTemplates).toEqual([]);
    expect(
      window.localStorage.getItem(CUSTOM_BASE_TEMPLATES_STORAGE_KEY),
    ).toBeNull();
  });

  it("syncs create / delete across two independent consumers", () => {
    const a = renderHook(() => useCustomBaseTemplates());
    const b = renderHook(() => useCustomBaseTemplates());

    let id = "";
    act(() => {
      const res = a.result.current.saveTemplate(draft());
      if (res.ok) id = res.template.id;
    });
    expect(b.result.current.customTemplates.map((t) => t.id)).toEqual([id]);

    act(() => {
      b.result.current.deleteTemplate(id);
    });
    expect(a.result.current.customTemplates).toEqual([]);
  });

  it("edits an existing template in place rather than appending", () => {
    const { result } = renderHook(() => useCustomBaseTemplates());
    let id = "";
    act(() => {
      const res = result.current.saveTemplate(draft());
      if (res.ok) id = res.template.id;
    });
    act(() => {
      result.current.saveTemplate(draft({ id, label: "Renamed" }));
    });
    expect(result.current.customTemplates).toHaveLength(1);
    expect(result.current.customTemplates[0].label).toBe("Renamed");
    expect(result.current.customTemplates[0].id).toBe(id);
  });

  it("duplicates a template into a new id with a (copy) label", () => {
    const { result } = renderHook(() => useCustomBaseTemplates());
    let id = "";
    act(() => {
      const res = result.current.saveTemplate(draft({ label: "Original" }));
      if (res.ok) id = res.template.id;
    });

    let dupId = "";
    act(() => {
      const res = result.current.duplicateTemplate(id);
      if (res && res.ok) dupId = res.template.id;
    });
    expect(result.current.customTemplates).toHaveLength(2);
    expect(dupId).not.toBe(id);
    const dup = result.current.templateById(dupId);
    expect(dup?.label).toBe("Original (copy)");
  });

  it("duplicate of an unknown id is a null no-op", () => {
    const { result } = renderHook(() => useCustomBaseTemplates());
    let res: ReturnType<typeof result.current.duplicateTemplate> = null;
    act(() => {
      res = result.current.duplicateTemplate("basetpl-missing");
    });
    expect(res).toBeNull();
    expect(result.current.customTemplates).toEqual([]);
  });

  it("resolves a template by id and degrades unknown / absent ids to null", () => {
    const { result } = renderHook(() => useCustomBaseTemplates());
    let id = "";
    act(() => {
      const res = result.current.saveTemplate(draft());
      if (res.ok) id = res.template.id;
    });
    expect(result.current.templateById(id)?.id).toBe(id);
    expect(result.current.templateById("basetpl-missing")).toBeNull();
    expect(result.current.templateById(undefined)).toBeNull();
  });
});
