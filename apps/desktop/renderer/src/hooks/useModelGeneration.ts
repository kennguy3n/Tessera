/**
 * `useModelGeneration` — a thin, cancellable streaming wrapper around
 * the on-device model surface (`window.tessera.model`).
 *
 * It is the renderer-side counterpart to the main-process
 * `model:generate` handler: subscribe to `model:token`, fire the
 * `model:generate` IPC, accumulate the streamed tokens into live
 * `text`, and resolve with the final completion when the stream ends.
 *
 * Why a dedicated hook (vs. inlining in the editor)
 * -------------------------------------------------
 * Every AI affordance in the Slide editor (deck generation, per-slide
 * rewrite, speaker-notes, image-prompt suggestion) needs the EXACT
 * same lifecycle: reset → subscribe → notify the shared
 * generation-state store so `StopGenerationButton` lights up → invoke
 * → accumulate → settle → unsubscribe. Centralising it here means one
 * tested implementation of the subtle bits (battery-gated sentinel,
 * cancel-vs-error disambiguation, ordering of the final token vs. the
 * invoke resolution) instead of four hand-rolled copies that would
 * inevitably drift.
 *
 * Relationship to `useActiveGeneration`
 * -------------------------------------
 * `useActiveGeneration` is the GLOBAL, module-scoped store that drives
 * the always-mounted `StopGenerationButton` in the editor header. This
 * hook is LOCAL per-call state (the streamed text + in-flight flag for
 * the specific panel). They cooperate: `run()` calls
 * `notifyGenerationStarted()` so the global Stop button appears
 * immediately (before the first token), and `cancel()` issues the same
 * `model:cancelJob` IPC the Stop button does — so cancelling from
 * either surface aborts the one in-flight generation.
 *
 * Privacy: this hook only ever talks to the LOCAL model IPC. It never
 * logs prompt or completion content.
 */
import { useCallback, useEffect, useRef, useState } from "react";
import { notifyGenerationStarted } from "./useActiveGeneration";
import type { GenerateRequest } from "../types/ipc";

export type ModelGenerationStatus =
  | "completed"
  | "cancelled"
  | "battery_low"
  | "unavailable"
  | "error";

export interface ModelGenerationResult {
  /** Accumulated completion text (may be partial on cancel / error). */
  text: string;
  status: ModelGenerationStatus;
  /** Present iff `status === "error"`. */
  error?: string;
}

export interface UseModelGeneration {
  /** True while a generation is in flight. */
  isStreaming: boolean;
  /** Live-updating accumulated completion text for streaming preview. */
  text: string;
  /** Last error message, or null. Cleared at the start of each `run`. */
  error: string | null;
  /**
   * Fire a generation and stream it. Resolves once with the terminal
   * result. Only one generation runs at a time per hook instance: a
   * `run` issued while another is in flight resolves immediately with
   * `status: "error"` rather than racing the shared IPC controller.
   */
  run: (request: GenerateRequest) => Promise<ModelGenerationResult>;
  /** Request cancellation of the in-flight generation (no-op if idle). */
  cancel: () => void;
  /** Clear `text` / `error` between runs without firing a generation. */
  reset: () => void;
}

export function useModelGeneration(): UseModelGeneration {
  const [isStreaming, setIsStreaming] = useState(false);
  const [text, setText] = useState("");
  const [error, setError] = useState<string | null>(null);

  // In-flight bookkeeping kept in refs so the async `run` closure and
  // the synchronous `cancel` always read the live value, not a stale
  // capture.
  const inFlightRef = useRef(false);
  const cancelledRef = useRef(false);
  const unsubscribeRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Tear down a dangling token subscription if the component
      // unmounts mid-stream so the broadcast listener can't fire into
      // an unmounted tree.
      unsubscribeRef.current?.();
      unsubscribeRef.current = null;
    };
  }, []);

  const cancel = useCallback(() => {
    if (!inFlightRef.current) return;
    cancelledRef.current = true;
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    // Best-effort: the main-process `model:cancelJob` aborts the
    // shared controller; the resulting stream teardown resolves /
    // rejects the in-flight `generate` which `run` maps to a
    // "cancelled" result.
    void api?.model?.cancelJob?.().catch(() => {
      // swallow — cancelling a job that already finished is fine
    });
  }, []);

  const reset = useCallback(() => {
    setText("");
    setError(null);
  }, []);

  const run = useCallback(
    async (request: GenerateRequest): Promise<ModelGenerationResult> => {
      if (inFlightRef.current) {
        return {
          text: "",
          status: "error",
          error: "A generation is already in progress",
        };
      }
      const api = typeof window !== "undefined" ? window.tessera : undefined;
      if (!api?.model?.generate || !api.model.onToken) {
        const msg = "The on-device model is unavailable";
        if (mountedRef.current) setError(msg);
        return { text: "", status: "unavailable", error: msg };
      }

      inFlightRef.current = true;
      cancelledRef.current = false;
      if (mountedRef.current) {
        setText("");
        setError(null);
        setIsStreaming(true);
      }

      let acc = "";
      let streamError: string | null = null;

      // Subscribe BEFORE invoking so the very first token can't race the
      // subscription. `model:token` is a broadcast; because the IPC
      // layer aborts any prior generation before starting a new one,
      // there is exactly one in-flight stream feeding this channel.
      const unsubscribe = api.model.onToken((chunk) => {
        if (chunk.error) {
          streamError = chunk.error;
        }
        if (chunk.token) {
          acc += chunk.token;
          if (mountedRef.current) setText(acc);
        }
      });
      unsubscribeRef.current = unsubscribe;

      // Make the global Stop button visible immediately (pre-first-token).
      notifyGenerationStarted();

      try {
        const result = await api.model.generate(request);
        // Battery-gated sentinel: no stream was started.
        if (
          result &&
          typeof result === "object" &&
          "status" in result &&
          result.status === "battery_low"
        ) {
          return { text: "", status: "battery_low" };
        }
        // `generate` resolves only after the main process has sent every
        // token (including the terminal `done`) ahead of the invoke
        // reply, so `acc` is complete here. An error chunk delivered
        // mid-stream is surfaced over a partial success.
        if (streamError) {
          if (mountedRef.current) setError(streamError);
          return { text: acc, status: "error", error: streamError };
        }
        return { text: acc, status: "completed" };
      } catch (e: unknown) {
        // A cancel aborts the controller, which rejects the in-flight
        // `generate`. Disambiguate from a genuine failure via the flag
        // we set in `cancel()`.
        if (cancelledRef.current) {
          return { text: acc, status: "cancelled" };
        }
        const msg = e instanceof Error ? e.message : String(e);
        if (mountedRef.current) setError(msg);
        return { text: acc, status: "error", error: msg };
      } finally {
        unsubscribe();
        unsubscribeRef.current = null;
        inFlightRef.current = false;
        if (mountedRef.current) setIsStreaming(false);
      }
    },
    [],
  );

  return { isStreaming, text, error, run, cancel, reset };
}
