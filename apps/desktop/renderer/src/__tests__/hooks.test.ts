import { describe, it, expect, vi } from "vitest";
import { renderHook, waitFor } from "@testing-library/react";
import { useSourceList } from "../hooks/useSources";
import { useSettings } from "../hooks/useSettings";

describe("useSourceList", () => {
  it("fetches sources on mount", async () => {
    const mockSources = [
      {
        id: "s1",
        sourceType: "local_folder",
        path: "/test",
        status: "connected",
        createdAt: new Date().toISOString(),
        lastIndexed: null,
        fileCount: 5,
      },
    ];
    window.tessera.sources.listSources = vi
      .fn()
      .mockResolvedValue(mockSources);

    const { result } = renderHook(() => useSourceList());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.sources).toEqual(mockSources);
    expect(result.current.error).toBeNull();

    window.tessera.sources.listSources = vi.fn().mockResolvedValue([]);
  });

  it("handles errors", async () => {
    window.tessera.sources.listSources = vi
      .fn()
      .mockRejectedValue(new Error("Network error"));

    const { result } = renderHook(() => useSourceList());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.error).toBe("Network error");

    window.tessera.sources.listSources = vi.fn().mockResolvedValue([]);
  });
});

describe("useSettings", () => {
  it("fetches settings on mount", async () => {
    const { result } = renderHook(() => useSettings());

    await waitFor(() => {
      expect(result.current.loading).toBe(false);
    });

    expect(result.current.settings.theme).toBe("light");
    expect(result.current.settings.defaultExportFormat).toBe("markdown");
  });
});
