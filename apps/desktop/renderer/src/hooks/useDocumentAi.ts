/**
 * Streaming runner for the DocumentEditor AI writing assistant.
 *
 * Wraps the on-device `window.tessera.model.generate` surface into a
 * small React state machine the Ask AI panel and selection toolbar
 * consume:
 *
 *   const ai = useDocumentAi();
 *   ai.run(buildAiPrompt({ ... }));   // start streaming
 *   ai.output                          // live, cleaned-as-you-go text
 *   ai.status                          // "streaming" | "done" | ...
 *   ai.cancel();                       // stop early (model:cancelJob)
 *   ai.reset();                        // clear for the next run
 *
 * The hook is the FIRST production caller of the streaming surface, so
 * it follows the contract documented in `useActiveGeneration.ts`:
 * call `notifyGenerationStarted()` synchronously before invoking
 * `generate(...)` so the global Stop button (and any
 * `useActiveGeneration` consumer) lights up before the first token.
 *
 * PRIVACY: the prompt is built from the user's own document text by
 * `documentAiHelpers.buildAiPrompt`. This hook never logs or persists
 * prompt/response content.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GenerateChunk } from "../types/ipc";
import {
  notifyGenerationStarted,
  useActiveGeneration,
} from "./useActiveGeneration";
import type { DocumentAiRunStatus } from "../editors/ai/documentAiTypes";

export interface UseDocumentAiResult {
  /** Lifecycle of the current/last run. */
  status: DocumentAiRunStatus;
  /** Raw accumulated completion text (caller cleans before applying). */
  output: string;
  /** Error message when `status === "error"`, else null. */
  error: string | null;
  /** True while a generation is in flight (mirrors status === "streaming"). */
  isStreaming: boolean;
  /** Start a new run with the given fully-built prompt. */
  run: (prompt: string) => void;
  /** Cancel the in-flight run (no-op when idle). */
  cancel: () => void;
  /** Reset to idle and clear output/error for the next run. */
  reset: () => void;
}

export function useDocumentAi(): UseDocumentAiResult {
  const [status, setStatus] = useState<DocumentAiRunStatus>("idle");
  const [output, setOutput] = useState("");
  const [error, setError] = useState<string | null>(null);
  const { cancel: cancelGeneration } = useActiveGeneration();

  // Live unsubscribe handle for the current run's token subscription.
  const unsubscribeRef = useRef<(() => void) | null>(null);
  // Guards against state updates after unmount.
  const mountedRef = useRef(true);
  // Monotonic run id so a late token from an aborted run can't write
  // into the state of a newer run.
  const runIdRef = useRef(0);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
    };
  }, []);

  const teardownSubscription = useCallback(() => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
  }, []);

  const run = useCallback(
    (prompt: string) => {
      const api = typeof window !== "undefined" ? window.tessera : undefined;
      if (!api?.model?.generate || !api.model.onToken) {
        setStatus("error");
        setError("The on-device model is unavailable in this context.");
        return;
      }

      // Tear down any previous subscription before starting a new run.
      teardownSubscription();
      const runId = ++runIdRef.current;

      setOutput("");
      setError(null);
      setStatus("streaming");

      // Make the global Stop button visible BEFORE the first token —
      // see useActiveGeneration's contract docs.
      notifyGenerationStarted();

      const onChunk = (chunk: GenerateChunk) => {
        if (runId !== runIdRef.current || !mountedRef.current) return;
        if (chunk.error) {
          setError(chunk.error);
          setStatus("error");
          teardownSubscription();
          return;
        }
        if (chunk.token) {
          setOutput((prev) => prev + chunk.token);
        }
        if (chunk.done) {
          setStatus((prev) => (prev === "streaming" ? "done" : prev));
          teardownSubscription();
        }
      };

      unsubscribeRef.current = api.model.onToken(onChunk);

      void api.model
        .generate({ prompt })
        .then((result) => {
          if (runId !== runIdRef.current || !mountedRef.current) return;
          // The local sidecar returns a battery-low sentinel instead of
          // streaming when the device is low on battery.
          if (result && typeof result === "object" && "status" in result) {
            setStatus("battery_low");
            teardownSubscription();
          }
        })
        .catch((err: unknown) => {
          if (runId !== runIdRef.current || !mountedRef.current) return;
          setError(err instanceof Error ? err.message : String(err));
          setStatus("error");
          teardownSubscription();
        });
    },
    [teardownSubscription],
  );

  const cancel = useCallback(() => {
    // Invalidate the current run so trailing tokens are ignored.
    runIdRef.current++;
    teardownSubscription();
    void cancelGeneration();
    if (mountedRef.current) {
      setStatus((prev) => (prev === "streaming" ? "cancelled" : prev));
    }
  }, [cancelGeneration, teardownSubscription]);

  const reset = useCallback(() => {
    runIdRef.current++;
    teardownSubscription();
    setStatus("idle");
    setOutput("");
    setError(null);
  }, [teardownSubscription]);

  // Memoise the result so consumers get a stable object identity across
  // renders (the callbacks are already stable via useCallback). This keeps
  // downstream `useCallback`/`useEffect` deps that close over the hook
  // result from re-firing on every parent render.
  return useMemo(
    () => ({
      status,
      output,
      error,
      isStreaming: status === "streaming",
      run,
      cancel,
      reset,
    }),
    [status, output, error, run, cancel, reset],
  );
}
