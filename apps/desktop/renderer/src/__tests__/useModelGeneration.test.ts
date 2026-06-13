import { describe, it, expect, vi, afterEach } from "vitest";
import { renderHook, act } from "@testing-library/react";
import { useModelGeneration } from "../hooks/useModelGeneration";
import { _resetActiveGenerationForTests } from "../hooks/useActiveGeneration";
import type { GenerateChunk } from "../types/ipc";

type TokenCb = (chunk: GenerateChunk) => void;

afterEach(() => {
  vi.restoreAllMocks();
  _resetActiveGenerationForTests();
});

describe("useModelGeneration", () => {
  it("streams tokens, accumulates text and resolves completed", async () => {
    let tokenCb: TokenCb | null = null;
    const unsub = vi.fn();
    vi.spyOn(window.tessera.model, "onToken").mockImplementation((cb) => {
      tokenCb = cb;
      return unsub;
    });
    vi.spyOn(window.tessera.model, "generate").mockImplementation(async () => {
      tokenCb?.({ token: "Hello ", done: false });
      tokenCb?.({ token: "world", done: true });
      return undefined;
    });

    const { result } = renderHook(() => useModelGeneration());
    let res: Awaited<ReturnType<typeof result.current.run>> | undefined;
    await act(async () => {
      res = await result.current.run({ prompt: "x" });
    });

    expect(res).toEqual({ text: "Hello world", status: "completed" });
    expect(result.current.text).toBe("Hello world");
    expect(result.current.isStreaming).toBe(false);
    expect(unsub).toHaveBeenCalledTimes(1);
  });

  it("returns the battery_low sentinel without streaming", async () => {
    vi.spyOn(window.tessera.model, "onToken").mockReturnValue(() => undefined);
    vi.spyOn(window.tessera.model, "generate").mockResolvedValue({
      status: "battery_low",
    });

    const { result } = renderHook(() => useModelGeneration());
    let res: Awaited<ReturnType<typeof result.current.run>> | undefined;
    await act(async () => {
      res = await result.current.run({ prompt: "x" });
    });

    expect(res).toEqual({ text: "", status: "battery_low" });
  });

  it("reports unavailable when the model surface is missing", async () => {
    const original = window.tessera.model.generate;
    window.tessera.model.generate =
      undefined as unknown as typeof window.tessera.model.generate;
    try {
      const { result } = renderHook(() => useModelGeneration());
      let res: Awaited<ReturnType<typeof result.current.run>> | undefined;
      await act(async () => {
        res = await result.current.run({ prompt: "x" });
      });
      expect(res?.status).toBe("unavailable");
      expect(result.current.error).toBeTruthy();
    } finally {
      window.tessera.model.generate = original;
    }
  });

  it("maps a cancelled generation to status cancelled, keeping partial text", async () => {
    let tokenCb: TokenCb | null = null;
    let rejectFn: ((reason: unknown) => void) | null = null;
    vi.spyOn(window.tessera.model, "onToken").mockImplementation((cb) => {
      tokenCb = cb;
      return () => undefined;
    });
    vi.spyOn(window.tessera.model, "generate").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectFn = reject;
        }),
    );
    vi.spyOn(window.tessera.model, "cancelJob").mockResolvedValue(undefined);

    const { result } = renderHook(() => useModelGeneration());
    let res: Awaited<ReturnType<typeof result.current.run>> | undefined;
    await act(async () => {
      const p = result.current.run({ prompt: "x" });
      tokenCb?.({ token: "partial", done: false });
      result.current.cancel();
      rejectFn?.(new Error("aborted"));
      res = await p;
    });

    expect(window.tessera.model.cancelJob).toHaveBeenCalled();
    expect(res).toEqual({ text: "partial", status: "cancelled" });
  });

  it("surfaces a streamed error chunk as status error", async () => {
    let tokenCb: TokenCb | null = null;
    vi.spyOn(window.tessera.model, "onToken").mockImplementation((cb) => {
      tokenCb = cb;
      return () => undefined;
    });
    vi.spyOn(window.tessera.model, "generate").mockImplementation(async () => {
      tokenCb?.({ token: "", done: true, error: "boom" });
      return undefined;
    });

    const { result } = renderHook(() => useModelGeneration());
    let res: Awaited<ReturnType<typeof result.current.run>> | undefined;
    await act(async () => {
      res = await result.current.run({ prompt: "x" });
    });

    expect(res?.status).toBe("error");
    expect(res?.error).toBe("boom");
  });

  it("rejects a concurrent run while one is in flight", async () => {
    let rejectFn: ((reason: unknown) => void) | null = null;
    vi.spyOn(window.tessera.model, "onToken").mockReturnValue(() => undefined);
    vi.spyOn(window.tessera.model, "generate").mockImplementation(
      () =>
        new Promise((_resolve, reject) => {
          rejectFn = reject;
        }),
    );

    const { result } = renderHook(() => useModelGeneration());
    let second: Awaited<ReturnType<typeof result.current.run>> | undefined;
    await act(async () => {
      const first = result.current.run({ prompt: "a" });
      second = await result.current.run({ prompt: "b" });
      rejectFn?.(new Error("done"));
      await first;
    });

    expect(second?.status).toBe("error");
    expect(second?.error).toMatch(/already in progress/i);
  });
});
