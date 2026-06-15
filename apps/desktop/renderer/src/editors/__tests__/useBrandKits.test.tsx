import { act, renderHook } from "@testing-library/react";
import { beforeEach, describe, expect, it } from "vitest";
import { __resetBrandKitsStoreForTests, useBrandKits } from "../useBrandKits";
import { BRAND_KITS_STORAGE_KEY, type BrandKitDraft } from "../slideBrandKit";

function draft(overrides: Partial<BrandKitDraft> = {}): BrandKitDraft {
  return {
    name: "Acme Corp",
    baseThemeId: "aurora",
    colors: {
      accent: "#7c3aed",
      surface: "#ffffff",
      text: "#1e1b2e",
      heading: "",
      muted: "",
    },
    headingFont: "",
    bodyFont: "",
    logoDataUrl: "",
    logoAlt: "",
    logoPlacement: "tl",
    bgStyle: "",
    ...overrides,
  };
}

beforeEach(() => {
  window.localStorage.clear();
  __resetBrandKitsStoreForTests();
});

describe("useBrandKits", () => {
  it("starts empty and persists a saved kit across a fresh mount", () => {
    const { result, unmount } = renderHook(() => useBrandKits());
    expect(result.current.brandKits).toEqual([]);

    let saved: { ok: boolean } = { ok: false };
    act(() => {
      saved = result.current.saveBrandKit(draft());
    });
    expect(saved.ok).toBe(true);
    expect(result.current.brandKits).toHaveLength(1);
    expect(window.localStorage.getItem(BRAND_KITS_STORAGE_KEY)).toContain(
      "Acme Corp",
    );

    unmount();
    __resetBrandKitsStoreForTests();
    const second = renderHook(() => useBrandKits());
    expect(second.result.current.brandKits).toHaveLength(1);
    expect(second.result.current.brandKits[0].name).toBe("Acme Corp");
  });

  it("returns build errors without persisting an invalid draft", () => {
    const { result } = renderHook(() => useBrandKits());
    let res: ReturnType<typeof result.current.saveBrandKit> = {
      ok: false,
      errors: [],
    };
    act(() => {
      res = result.current.saveBrandKit(draft({ name: "" }));
    });
    expect(res.ok).toBe(false);
    expect(result.current.brandKits).toEqual([]);
    expect(window.localStorage.getItem(BRAND_KITS_STORAGE_KEY)).toBeNull();
  });

  it("syncs create/delete across two independent hook consumers", () => {
    const a = renderHook(() => useBrandKits());
    const b = renderHook(() => useBrandKits());

    let id = "";
    act(() => {
      const res = a.result.current.saveBrandKit(draft());
      if (res.ok) id = res.brandKit.id;
    });
    expect(b.result.current.brandKits.map((k) => k.id)).toEqual([id]);

    act(() => {
      b.result.current.deleteBrandKit(id);
    });
    expect(a.result.current.brandKits).toEqual([]);
  });

  it("editing an existing kit replaces it in place rather than appending", () => {
    const { result } = renderHook(() => useBrandKits());
    let id = "";
    act(() => {
      const res = result.current.saveBrandKit(draft());
      if (res.ok) id = res.brandKit.id;
    });
    act(() => {
      result.current.saveBrandKit(draft({ id, name: "Acme Rebrand" }));
    });
    expect(result.current.brandKits).toHaveLength(1);
    expect(result.current.brandKits[0].name).toBe("Acme Rebrand");
    expect(result.current.brandKits[0].id).toBe(id);
  });

  it("resolves a kit by id and degrades unknown/absent ids to null", () => {
    const { result } = renderHook(() => useBrandKits());
    let id = "";
    act(() => {
      const res = result.current.saveBrandKit(draft());
      if (res.ok) id = res.brandKit.id;
    });
    expect(result.current.brandKitById(id)?.id).toBe(id);
    expect(result.current.brandKitById("brand-missing")).toBeNull();
    expect(result.current.brandKitById(undefined)).toBeNull();
  });
});
