import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import {
  __resetCustomSheetTemplatesStoreForTests,
  useCustomSheetTemplates,
} from "../useCustomSheetTemplates";
import {
  CUSTOM_SHEET_TEMPLATES_STORAGE_KEY,
  type CustomSheetTemplateDraft,
} from "../customSheetTemplates";
import type { SheetTemplateContent } from "../sheetTemplates";

function sheet(
  overrides: Partial<SheetTemplateContent> = {},
): SheetTemplateContent {
  return {
    columns: ["Item", "Amount"],
    rows: [["Rent", "1200"]],
    ...overrides,
  };
}

function draft(
  overrides: Partial<CustomSheetTemplateDraft> = {},
): CustomSheetTemplateDraft {
  return {
    label: "My budget",
    description: "",
    category: "",
    content: sheet(),
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  __resetCustomSheetTemplatesStoreForTests();
});

describe("useCustomSheetTemplates", () => {
  it("starts empty and persists a saved template across a fresh mount", () => {
    const { result, unmount } = renderHook(() => useCustomSheetTemplates());
    expect(result.current.customTemplates).toEqual([]);

    let ok = false;
    act(() => {
      ok = result.current.saveTemplate(draft()).ok;
    });
    expect(ok).toBe(true);
    expect(result.current.customTemplates).toHaveLength(1);
    expect(
      window.localStorage.getItem(CUSTOM_SHEET_TEMPLATES_STORAGE_KEY),
    ).toContain("My budget");

    unmount();
    __resetCustomSheetTemplatesStoreForTests();
    const second = renderHook(() => useCustomSheetTemplates());
    expect(second.result.current.customTemplates).toHaveLength(1);
    expect(second.result.current.customTemplates[0].label).toBe("My budget");
  });

  it("returns build errors without persisting an invalid draft", () => {
    const { result } = renderHook(() => useCustomSheetTemplates());
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
      window.localStorage.getItem(CUSTOM_SHEET_TEMPLATES_STORAGE_KEY),
    ).toBeNull();
  });

  it("syncs create / delete across two independent consumers", () => {
    const a = renderHook(() => useCustomSheetTemplates());
    const b = renderHook(() => useCustomSheetTemplates());

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
    const { result } = renderHook(() => useCustomSheetTemplates());
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
    const { result } = renderHook(() => useCustomSheetTemplates());
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
    const { result } = renderHook(() => useCustomSheetTemplates());
    let res: ReturnType<typeof result.current.duplicateTemplate> = null;
    act(() => {
      res = result.current.duplicateTemplate("stpl-missing");
    });
    expect(res).toBeNull();
    expect(result.current.customTemplates).toEqual([]);
  });

  it("resolves a template by id and degrades unknown / absent ids to null", () => {
    const { result } = renderHook(() => useCustomSheetTemplates());
    let id = "";
    act(() => {
      const res = result.current.saveTemplate(draft());
      if (res.ok) id = res.template.id;
    });
    expect(result.current.templateById(id)?.id).toBe(id);
    expect(result.current.templateById("stpl-missing")).toBeNull();
    expect(result.current.templateById(undefined)).toBeNull();
  });
});
