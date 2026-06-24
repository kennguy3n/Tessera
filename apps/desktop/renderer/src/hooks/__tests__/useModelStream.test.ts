/**
 * Coverage for the streaming-generation hook: token accumulation,
 * completion resolution, error + battery-gating surfacing, and the
 * single-run-in-flight guard.
 */
import { act, renderHook } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { useModelStream } from "../useModelStream";

type TokenCb = (chunk: {
  token: string;
  done: boolean;
  error?: string;
}) => void;

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
      // The first run stays in-flight; attach a catch so the
      // cancel-on-unmount cleanup's rejection is handled.
      void result.current.run("first").catch(() => undefined);
    });
    await expect(result.current.run("second")).rejects.toThrow(/in progress/i);
  });

  it("ignores a late generate() rejection after a successful completion", async () => {
    // `generate` stays pending until we reject it manually, AFTER the
    // token stream has already terminated with `done: true`.
    let rejectGen!: (e: Error) => void;
    const generate = vi.fn().mockReturnValue(
      new Promise((_resolve, reject) => {
        rejectGen = reject;
      }),
    );
    const { emit } = installModel(generate);
    const { result } = renderHook(() => useModelStream());

    let runPromise!: Promise<string>;
    act(() => {
      runPromise = result.current.run("p");
    });
    await act(async () => {
      emit({ token: "ok", done: true });
      await runPromise;
    });
    expect(result.current.output).toBe("ok");
    expect(result.current.error).toBeNull();

    // The late rejection must NOT clobber the resolved state.
    await act(async () => {
      rejectGen(new Error("late failure"));
      await Promise.resolve();
    });
    expect(result.current.error).toBeNull();
    expect(result.current.output).toBe("ok");
  });

  it("cancels the in-flight job when the consumer unmounts", () => {
    const generate = vi.fn().mockResolvedValue(undefined);
    const { cancelJob } = installModel(generate);
    const { result, unmount } = renderHook(() => useModelStream());

    act(() => {
      void result.current.run("x").catch(() => undefined);
    });
    act(() => {
      unmount();
    });
    expect(cancelJob).toHaveBeenCalled();
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
