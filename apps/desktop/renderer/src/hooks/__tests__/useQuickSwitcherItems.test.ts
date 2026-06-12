/**
 * Wiring tests for the quick-switch aggregation hook: it must pull
 * from every live `window.tessera.*` list and always include the
 * synthetic page rows derived from SIDEBAR_ITEMS, and surface
 * loading / error / bridge state correctly.
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useQuickSwitcherItems } from "../useQuickSwitcherItems";
import { SIDEBAR_ITEMS } from "../../navigation";

type TesseraWindow = typeof window & {
  tessera?: Record<string, unknown>;
};

function bridge() {
  return (window as TesseraWindow).tessera as unknown as {
    artifacts: { list: ReturnType<typeof vi.fn> };
    sources: { listSources: ReturnType<typeof vi.fn> };
    templates: { list: ReturnType<typeof vi.fn> };
    automations: { list: ReturnType<typeof vi.fn> };
    tasks: { list: ReturnType<typeof vi.fn> };
  };
}

const savedTessera = (window as TesseraWindow).tessera;

/** Assign `window.tessera` past its non-optional global type for tests. */
function setTessera(value: unknown): void {
  (window as unknown as { tessera?: unknown }).tessera = value;
}

afterEach(() => {
  // Only restore the bridge reference. The shared setup mocks are
  // created once at module load, so `vi.restoreAllMocks()` here would
  // strip their implementations for every later test in the file.
  setTessera(savedTessera);
});

describe("useQuickSwitcherItems", () => {
  it("always includes a page row for every sidebar item", async () => {
    const { result } = renderHook(() => useQuickSwitcherItems());
    await waitFor(() => expect(result.current.loading).toBe(false));
    const pages = result.current.items.filter((i) => i.kind === "page");
    expect(pages).toHaveLength(SIDEBAR_ITEMS.length);
    for (const nav of SIDEBAR_ITEMS) {
      expect(pages.some((p) => p.to === nav.to)).toBe(true);
    }
  });

  it("maps live artifacts into artifact rows with a recency key", async () => {
    bridge().artifacts.list.mockResolvedValueOnce([
      {
        id: "art-1",
        title: "Quarterly Roadmap",
        artifactType: "document",
        templateId: null,
        content: "",
        citationCount: 0,
        createdAt: "",
        updatedAt: "",
        version: 1,
      },
    ]);
    const { result } = renderHook(() => useQuickSwitcherItems());
    await waitFor(() =>
      expect(result.current.items.some((i) => i.kind === "artifact")).toBe(
        true,
      ),
    );
    const art = result.current.items.find((i) => i.kind === "artifact");
    expect(art?.title).toBe("Quarterly Roadmap");
    expect(art?.to).toBe("/artifacts/art-1/edit");
    expect(art?.recentKey).toBe("art-1");
  });

  it("reports hasBridge true when window.tessera is present", async () => {
    const { result } = renderHook(() => useQuickSwitcherItems());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasBridge).toBe(true);
  });

  it("still yields pages and reports no bridge when window.tessera is absent", async () => {
    setTessera(undefined);
    const { result } = renderHook(() => useQuickSwitcherItems());
    await waitFor(() => expect(result.current.loading).toBe(false));
    expect(result.current.hasBridge).toBe(false);
    expect(result.current.items.filter((i) => i.kind === "page")).toHaveLength(
      SIDEBAR_ITEMS.length,
    );
  });

  it("surfaces an error string when a list fetch rejects", async () => {
    bridge().artifacts.list.mockRejectedValueOnce(new Error("boom"));
    const { result } = renderHook(() => useQuickSwitcherItems());
    await waitFor(() => expect(result.current.error).toBe("boom"));
  });
});
