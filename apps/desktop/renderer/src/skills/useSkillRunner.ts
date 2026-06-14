/**
 * Sequential, multi-step runner for the Skills / Instruction-Template
 * engine.
 *
 * This is the thin, impure layer: it drives the pure compiler in
 * `skillEngine.ts` over the on-device `window.tessera.model.generate`
 * surface, one step at a time, threading each cleaned step output into
 * the context the next step compiles against. It mirrors the streaming
 * contract established by `useDocumentAi` (subscribe to `model:token`,
 * call `notifyGenerationStarted()` before `generate(...)`, guard against
 * late tokens with a monotonic run id, settle the battery-low sentinel),
 * but loops that contract across a skill's steps.
 *
 *   const runner = useSkillRunner(skill);
 *   runner.run({ topic: "…" });   // kicks off step 1 → 2 → 3 → …
 *   runner.currentStepTitle;       // which step is in flight
 *   runner.liveOutput;             // streaming text of the current step
 *   runner.steps;                  // cleaned results of finished steps
 *   runner.finalOutput;            // last step's cleaned output
 *   runner.cancel();               // stop the chain (model:cancelJob)
 *
 * PRIVACY: prompts are built only from the user's typed inputs and the
 * model's own prior outputs. Nothing here logs or persists content.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { GenerateChunk } from "../types/ipc";
import {
  notifyGenerationStarted,
  useActiveGeneration,
} from "../hooks/useActiveGeneration";
import {
  cleanStepOutput,
  compileStep,
  foldStepOutput,
  initialContext,
  missingRequiredInputs,
} from "./skillEngine";
import type {
  Skill,
  SkillContext,
  SkillRunStatus,
  SkillStepResult,
} from "./skillTypes";

export interface UseSkillRunnerResult {
  /** Lifecycle of the current/last run. */
  status: SkillRunStatus;
  /** Cleaned results of every step that has finished, in order. */
  steps: SkillStepResult[];
  /** 0-based index of the in-flight (or last) step; -1 when idle. */
  currentStepIndex: number;
  /** Title of the in-flight (or last) step; null when idle. */
  currentStepTitle: string | null;
  /** Live, accumulating raw text of the in-flight step. */
  liveOutput: string;
  /** Cleaned output bound to the skill's final step (its `output` var). */
  finalOutput: string;
  /** The fully threaded context after the run (var name → value). */
  contextVars: SkillContext;
  /** Error message when `status === "error"`, else null. */
  error: string | null;
  /** True while any step is in flight. */
  isRunning: boolean;
  /** Names of required inputs missing on the last `run` attempt. */
  missingInputs: string[];
  /** Start a run with the user-supplied input values. */
  run: (inputs: Record<string, string>) => void;
  /** Cancel the in-flight chain (no-op when idle). */
  cancel: () => void;
  /** Reset to idle and clear all run state. */
  reset: () => void;
}

/** Internal rejection reason used to settle an in-flight step on cancel. */
const CANCELLED = Symbol("cancelled");

/** Resolution of a single streamed step. */
interface StepOutcome {
  kind: "done" | "battery_low";
  text: string;
}

export function useSkillRunner(skill: Skill): UseSkillRunnerResult {
  const [status, setStatus] = useState<SkillRunStatus>("idle");
  const [steps, setSteps] = useState<SkillStepResult[]>([]);
  const [currentStepIndex, setCurrentStepIndex] = useState(-1);
  const [currentStepTitle, setCurrentStepTitle] = useState<string | null>(null);
  const [liveOutput, setLiveOutput] = useState("");
  const [finalOutput, setFinalOutput] = useState("");
  const [contextVars, setContextVars] = useState<SkillContext>({});
  const [error, setError] = useState<string | null>(null);
  const [missingInputs, setMissingInputs] = useState<string[]>([]);
  const { cancel: cancelGeneration } = useActiveGeneration();

  const unsubscribeRef = useRef<(() => void) | null>(null);
  const mountedRef = useRef(true);
  const runIdRef = useRef(0);
  // Lets `cancel()` settle the promise of the step currently streaming.
  const rejectCurrentRef = useRef<((reason: unknown) => void) | null>(null);
  // Mirror the latest `cancelGeneration` so the []-deps unmount effect can
  // abort the backend job without re-subscribing on every render.
  const cancelGenerationRef = useRef(cancelGeneration);
  cancelGenerationRef.current = cancelGeneration;

  useEffect(() => {
    mountedRef.current = true;
    return () => {
      mountedRef.current = false;
      // Invalidate the chain so any late async callbacks no-op.
      runIdRef.current += 1;
      if (unsubscribeRef.current) {
        unsubscribeRef.current();
        unsubscribeRef.current = null;
      }
      // Settle the in-flight step's promise so its `runChain` stops awaiting.
      if (rejectCurrentRef.current) {
        const reject = rejectCurrentRef.current;
        rejectCurrentRef.current = null;
        reject(CANCELLED);
      }
      // Abort the backend generation so the on-device model does not keep
      // producing tokens for an orphaned step after the panel unmounts.
      void cancelGenerationRef.current();
    };
  }, []);

  const teardownSubscription = useCallback(() => {
    if (unsubscribeRef.current) {
      unsubscribeRef.current();
      unsubscribeRef.current = null;
    }
  }, []);

  // Stream a single compiled step to completion. Resolves with the raw
  // accumulated text on `done`, or a battery-low sentinel; rejects on a
  // model error or when `cancel()` invalidates the run.
  const streamStep = useCallback(
    (
      runId: number,
      prompt: string,
      maxTokens: number,
      temperature: number,
    ): Promise<StepOutcome> => {
      return new Promise<StepOutcome>((resolve, reject) => {
        const api = typeof window !== "undefined" ? window.tessera : undefined;
        if (!api?.model?.generate || !api.model.onToken) {
          reject(new Error("The on-device model is unavailable in this context."));
          return;
        }

        teardownSubscription();
        rejectCurrentRef.current = reject;
        let buffer = "";

        const onChunk = (chunk: GenerateChunk) => {
          if (runId !== runIdRef.current || !mountedRef.current) return;
          if (chunk.error) {
            teardownSubscription();
            rejectCurrentRef.current = null;
            reject(new Error(chunk.error));
            return;
          }
          if (chunk.token) {
            buffer += chunk.token;
            setLiveOutput(buffer);
          }
          if (chunk.done) {
            teardownSubscription();
            rejectCurrentRef.current = null;
            resolve({ kind: "done", text: buffer });
          }
        };

        unsubscribeRef.current = api.model.onToken(onChunk);
        notifyGenerationStarted();

        void api.model
          .generate({ prompt, maxTokens, temperature })
          .then((result) => {
            if (runId !== runIdRef.current || !mountedRef.current) return;
            // The local sidecar returns this sentinel instead of streaming
            // when the device battery is low.
            if (result && typeof result === "object" && "status" in result) {
              teardownSubscription();
              rejectCurrentRef.current = null;
              resolve({ kind: "battery_low", text: buffer });
            }
          })
          .catch((err: unknown) => {
            if (runId !== runIdRef.current || !mountedRef.current) return;
            teardownSubscription();
            rejectCurrentRef.current = null;
            reject(err instanceof Error ? err : new Error(String(err)));
          });
      });
    },
    [teardownSubscription],
  );

  const run = useCallback(
    (inputs: Record<string, string>) => {
      const missing = missingRequiredInputs(skill, inputs);
      if (missing.length > 0) {
        setMissingInputs(missing.map((m) => m.id));
        setStatus("error");
        setError(
          `Missing required input${missing.length > 1 ? "s" : ""}: ${missing
            .map((m) => m.label)
            .join(", ")}`,
        );
        return;
      }
      setMissingInputs([]);

      const runId = ++runIdRef.current;
      let ctx = initialContext(skill, inputs);

      setSteps([]);
      setLiveOutput("");
      setFinalOutput("");
      setContextVars(ctx);
      setError(null);
      setCurrentStepIndex(-1);
      setCurrentStepTitle(null);
      setStatus("running");

      const runChain = async () => {
        for (let i = 0; i < skill.steps.length; i++) {
          if (runId !== runIdRef.current) return;
          const step = skill.steps[i];
          const compiled = compileStep(step, ctx);

          if (mountedRef.current) {
            setCurrentStepIndex(i);
            setCurrentStepTitle(step.title);
            setLiveOutput("");
          }

          const outcome = await streamStep(
            runId,
            compiled.prompt,
            compiled.maxTokens,
            compiled.temperature,
          );
          if (runId !== runIdRef.current) return;

          if (outcome.kind === "battery_low") {
            if (mountedRef.current) setStatus("battery_low");
            return;
          }

          const cleaned = cleanStepOutput(outcome.text);
          ctx = foldStepOutput(ctx, step, cleaned);

          if (mountedRef.current) {
            setSteps((prev) => [
              ...prev,
              { id: step.id, title: step.title, output: cleaned },
            ]);
            setContextVars(ctx);
            setFinalOutput(cleaned);
          }
        }

        if (runId === runIdRef.current && mountedRef.current) {
          setStatus("done");
        }
      };

      void runChain().catch((err: unknown) => {
        if (err === CANCELLED || runId !== runIdRef.current) return;
        if (!mountedRef.current) return;
        setError(err instanceof Error ? err.message : String(err));
        setStatus("error");
      });
    },
    [skill, streamStep],
  );

  const cancel = useCallback(() => {
    runIdRef.current++;
    teardownSubscription();
    if (rejectCurrentRef.current) {
      const reject = rejectCurrentRef.current;
      rejectCurrentRef.current = null;
      reject(CANCELLED);
    }
    void cancelGeneration();
    if (mountedRef.current) {
      setStatus((prev) => (prev === "running" ? "cancelled" : prev));
    }
  }, [cancelGeneration, teardownSubscription]);

  const reset = useCallback(() => {
    runIdRef.current++;
    teardownSubscription();
    // Settle any in-flight step's promise so its `runChain` stops awaiting,
    // and abort the backend job — mirroring `cancel()` — so resetting mid-run
    // never leaves an orphaned generation or a hung chain.
    if (rejectCurrentRef.current) {
      const reject = rejectCurrentRef.current;
      rejectCurrentRef.current = null;
      reject(CANCELLED);
    }
    void cancelGeneration();
    setStatus("idle");
    setSteps([]);
    setCurrentStepIndex(-1);
    setCurrentStepTitle(null);
    setLiveOutput("");
    setFinalOutput("");
    setContextVars({});
    setError(null);
    setMissingInputs([]);
  }, [cancelGeneration, teardownSubscription]);

  return useMemo(
    () => ({
      status,
      steps,
      currentStepIndex,
      currentStepTitle,
      liveOutput,
      finalOutput,
      contextVars,
      error,
      isRunning: status === "running",
      missingInputs,
      run,
      cancel,
      reset,
    }),
    [
      status,
      steps,
      currentStepIndex,
      currentStepTitle,
      liveOutput,
      finalOutput,
      contextVars,
      error,
      missingInputs,
      run,
      cancel,
      reset,
    ],
  );
}
