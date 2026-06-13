/**
 * Coverage for the streaming-generation hook: token accumulation,
 * completion resolution, error + battery-gating surfacing, and the
 * single-run-in-flight guard.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useModelStream } from "../useModelStream";

type TokenCb = (chunk: { token: string; done: boolean; error?: string }) => void;

function installModel(generate: ReturnType<typeof vi.fn>) {
  const cbs: TokenCb[] = [];
  const onToken = vi.fn((cb: TokenCb) => {
    cbs.push(cb);
    return () => {
      const i = cbs.indexOf(cb);
      if (i >= 0) cbs.splice(i, 1);
    };
  });
  const cancelJob = vi.fn().mockResolvedValue(undefined);
  window.tessera.model.generate =
    generate as unknown as typeof window.tessera.model.generate;
  window.tessera.model.onToken = onToken;
  window.tessera.model.cancelJob = cancelJob;
  const emit = (chunk: { token: string; done: boolean; error?: string }) => {
    for (const cb of [...cbs]) cb(chunk);
  };
  return { onToken, cancelJob, emit };
}

const originalModel = { ...window.tessera.model };

afterEach(() => {
  window.tessera.model = { ...originalModel };
  vi.clearAllMocks();
});

describe("useModelStream", () => {
  it("accumulates tokens and resolves on done", async () => {
    const generate = vi.fn().mockResolvedValue(undefined);
    const { emit } = installModel(generate);
    const { result } = renderHook(() => useModelStream());

    let runPromise!: Promise<string>;
    act(() => {
      runPromise = result.current.run("prompt");
    });
    expect(result.current.isStreaming).toBe(true);
    expect(generate).toHaveBeenCalledWith({
      prompt: "prompt",
      maxTokens: undefined,
      temperature: undefined,
    });

    act(() => emit({ token: "=SUM(", done: false }));
    act(() => emit({ token: "A1:A3)", done: false }));
    expect(result.current.output).toBe("=SUM(A1:A3)");

    await act(async () => {
      emit({ token: "", done: true });
      await runPromise;
    });
    expect(result.current.isStreaming).toBe(false);
    expect(result.current.output).toBe("=SUM(A1:A3)");
  });

  it("surfaces an error chunk", async () => {
    const generate = vi.fn().mockResolvedValue(undefined);
    const { emit } = installModel(generate);
    const { result } = renderHook(() => useModelStream());

    let p!: Promise<string>;
    act(() => {
      p = result.current.run("x").catch(() => "rejected");
    });
    await act(async () => {
      emit({ token: "", done: false, error: "model exploded" });
      await p;
    });
    expect(result.current.error).toBe("model exploded");
    expect(result.current.isStreaming).toBe(false);
  });

  it("surfaces the battery-gated sentinel", async () => {
    const generate = vi.fn().mockResolvedValue({ status: "battery_low" });
    installModel(generate);
    const { result } = renderHook(() => useModelStream());

    await act(async () => {
      await result.current.run("x").catch(() => undefined);
    });
    expect(result.current.error).toMatch(/battery/i);
  });

  it("rejects a second concurrent run", async () => {
    const generate = vi.fn().mockResolvedValue(undefined);
    installModel(generate);
    const { result } = renderHook(() => useModelStream());

    act(() => {
      void result.current.run("first");
    });
    await expect(result.current.run("second")).rejects.toThrow(/in progress/i);
  });

  it("cancel issues cancelJob and rejects the run", async () => {
    const generate = vi.fn().mockResolvedValue(undefined);
    const { cancelJob } = installModel(generate);
    const { result } = renderHook(() => useModelStream());

    let p!: Promise<string>;
    act(() => {
      p = result.current.run("x").catch((e: Error) => e.message);
    });
    await act(async () => {
      result.current.cancel();
      await p;
    });
    expect(cancelJob).toHaveBeenCalled();
    expect(result.current.error).toMatch(/cancel/i);
  });
});
