import { useCallback, useEffect, useRef, useState } from "react";

import { notifyGenerationStarted } from "./useActiveGeneration";

/**
 * Drive a single streaming generation against the on-device model
 * (`window.tessera.model`). This is the renderer-side counterpart to
 * the `model:generate` / `model:token` / `model:cancelJob` IPC channels
 * that, until now, had no production caller (see the long note in
 * `useActiveGeneration.ts`). It:
 *
 *   - subscribes to `onToken` for the duration of one run,
 *   - accumulates streamed tokens into `output`,
 *   - calls `notifyGenerationStarted()` immediately before invoking
 *     `generate` so the shared Stop button appears during the
 *     pre-first-token window,
 *   - resolves `run()` with the full text on the terminating
 *     (`done: true`) chunk, and
 *   - surfaces battery-gating and error chunks as `error`.
 *
 * Only one run may be in flight per hook instance; calling `run()` while
 * a previous run is active rejects immediately. The model itself is a
 * single-job surface (one global `cancelJob`), so this matches the
 * backend contract.
 *
 * Privacy: this hook is local-model-only. It never touches the network
 * directly — it just forwards the caller's prompt to the on-device
 * model bridge.
 */
export interface UseModelStream {
  /** Accumulated tokens for the current / most recent run. */
  output: string;
  /** True from `run()` invocation until the terminating chunk. */
  isStreaming: boolean;
  /** Human-readable error (model error chunk, battery gate, or throw). */
  error: string | null;
  /** Whether the on-device model bridge is present in this renderer. */
  available: boolean;
  /**
   * Start a generation. Resolves with the full accumulated text on
   * completion; rejects if a run is already in flight or the bridge is
   * unavailable.
   */
  run: (
    prompt: string,
    opts?: { maxTokens?: number; temperature?: number },
  ) => Promise<string>;
  /** Cancel the in-flight run (no-op when idle). */
  cancel: () => void;
  /** Clear `output` / `error` (only allowed while idle). */
  reset: () => void;
}

export function useModelStream(): UseModelStream {
  const [output, setOutput] = useState("");
  const [isStreaming, setIsStreaming] = useState(false);
  const [error, setError] = useState<string | null>(null);

  // Per-run mutable state, kept in refs so the broadcast token handler
  // always sees the live values rather than a stale render closure.
  const accRef = useRef("");
  const unsubRef = useRef<(() => void) | null>(null);
  const settleRef = useRef<{
    resolve: (text: string) => void;
    reject: (err: Error) => void;
  } | null>(null);

  const available =
    typeof window !== "undefined" && !!window.tessera?.model?.generate;

  const teardown = useCallback(() => {
    if (unsubRef.current) {
      unsubRef.current();
      unsubRef.current = null;
    }
  }, []);

  const finish = useCallback(
    (outcome: { ok: true; text: string } | { ok: false; message: string }) => {
      teardown();
      const settle = settleRef.current;
      // Ignore duplicate calls. A run can terminate exactly once: e.g. a
      // successful `done: true` chunk settles and clears `settleRef`,
      // then a late `generate()` resolve/reject must NOT overwrite the
      // resolved state with a spurious error.
      if (!settle) return;
      settleRef.current = null;
      setIsStreaming(false);
      if (outcome.ok) {
        settle.resolve(outcome.text);
      } else {
        setError(outcome.message);
        settle.reject(new Error(outcome.message));
      }
    },
    [teardown],
  );

  const run = useCallback(
    (
      prompt: string,
      opts: { maxTokens?: number; temperature?: number } = {},
    ): Promise<string> => {
      if (settleRef.current) {
        return Promise.reject(new Error("A generation is already in progress."));
      }
      const model =
        typeof window !== "undefined" ? window.tessera?.model : undefined;
      if (!model?.generate || !model?.onToken) {
        return Promise.reject(
          new Error("The on-device model is not available."),
        );
      }

      accRef.current = "";
      setOutput("");
      setError(null);
      setIsStreaming(true);

      const promise = new Promise<string>((resolve, reject) => {
        settleRef.current = { resolve, reject };
      });

      unsubRef.current = model.onToken((chunk) => {
        if (chunk.error) {
          finish({ ok: false, message: chunk.error });
          return;
        }
        if (chunk.token) {
          accRef.current += chunk.token;
          setOutput(accRef.current);
        }
        if (chunk.done) {
          finish({ ok: true, text: accRef.current });
        }
      });

      notifyGenerationStarted();
      void model
        .generate({
          prompt,
          maxTokens: opts.maxTokens,
          temperature: opts.temperature,
        })
        .then((result) => {
          // The battery-gating sentinel resolves INSTEAD of streaming,
          // so no token will ever arrive — settle now.
          if (result && "status" in result && result.status === "battery_low") {
            finish({
              ok: false,
              message: "Generation paused — battery below 20%.",
            });
          }
        })
        .catch((err: unknown) => {
          finish({
            ok: false,
            message: err instanceof Error ? err.message : "Generation failed.",
          });
        });

      return promise;
    },
    [finish],
  );

  const cancel = useCallback(() => {
    const model =
      typeof window !== "undefined" ? window.tessera?.model : undefined;
    if (model?.cancelJob) void model.cancelJob();
    if (settleRef.current) {
      finish({ ok: false, message: "Generation cancelled." });
    }
  }, [finish]);

  const reset = useCallback(() => {
    if (settleRef.current) return;
    accRef.current = "";
    setOutput("");
    setError(null);
  }, []);

  // Cancel a still-running generation when the consumer unmounts. A
  // bare `teardown()` would only unsubscribe from `onToken`, leaving the
  // on-device model churning out tokens nobody reads — wasted CPU and
  // battery on a laptop. `cancel()` issues `cancelJob()` and settles the
  // pending promise (a no-op when idle). Held in a ref so this stays an
  // unmount-only effect rather than re-running whenever `cancel`'s
  // identity changes mid-run.
  const cancelRef = useRef(cancel);
  cancelRef.current = cancel;
  useEffect(() => () => cancelRef.current(), []);

  return { output, isStreaming, error, available, run, cancel, reset };
}
