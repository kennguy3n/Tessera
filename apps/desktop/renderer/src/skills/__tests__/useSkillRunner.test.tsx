import { act, renderHook, waitFor } from "@testing-library/react";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type Mock,
} from "vitest";
import { useSkillRunner } from "../useSkillRunner";
import { DOCUMENT_DELIBERATE_DRAFT } from "../skillLibrary";
import { _resetActiveGenerationForTests } from "../../hooks/useActiveGeneration";
import type { GenerateChunk } from "../../types/ipc";
import type { Skill, SkillStepCheck } from "../skillTypes";

/** A one-step skill carrying a deterministic `check`, for repair tests. */
function syntheticCheckedSkill(check: SkillStepCheck): Skill {
  return {
    id: "synthetic-checked",
    name: "Synthetic checked skill",
    description: "Single step with a deterministic check.",
    surfaces: ["document"],
    inputs: [{ id: "intent", label: "Intent", required: true }],
    steps: [
      {
        id: "only",
        title: "Only step",
        kind: "extract",
        instruction: "Do {{intent}}",
        output: "result",
        check,
      },
    ],
  };
}

/**
 * A controllable fake of the on-device model surface. `onToken`
 * registers the current subscriber (the runner re-subscribes per step);
 * `generate` looks up a scripted response for the call and streams it as
 * one token + a done chunk on the next tick. Prompts are recorded so we
 * can assert that one step's output is threaded into the next step's
 * prompt.
 */
interface GenerateReq {
  prompt: string;
  maxTokens?: number;
  temperature?: number;
}

interface Harness {
  generate: Mock<
    [req: GenerateReq],
    Promise<{ status: "battery_low" } | undefined>
  >;
  onToken: Mock<[cb: (chunk: GenerateChunk) => void], () => void>;
  cancelJob: ReturnType<typeof vi.fn>;
  prompts: string[];
}

function installModel(
  responder: (prompt: string, callIndex: number) => string,
  opts: { autoComplete?: boolean; batteryLow?: boolean } = {},
): Harness {
  const { autoComplete = true, batteryLow = false } = opts;
  let subscriber: ((chunk: GenerateChunk) => void) | null = null;
  const prompts: string[] = [];

  const onToken = vi.fn((cb: (chunk: GenerateChunk) => void) => {
    subscriber = cb;
    return () => {
      if (subscriber === cb) subscriber = null;
    };
  });

  const generate = vi.fn(async (req: GenerateReq) => {
    const callIndex = prompts.length;
    prompts.push(req.prompt);
    if (batteryLow) {
      return { status: "battery_low" as const };
    }
    if (autoComplete) {
      const text = responder(req.prompt, callIndex);
      setTimeout(() => {
        subscriber?.({ token: text, done: false });
        subscriber?.({ token: "", done: true });
      }, 0);
    }
    return undefined;
  });

  const cancelJob = vi.fn().mockResolvedValue(undefined);

  const api = window.tessera as unknown as { model: unknown };
  api.model = {
    status: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    generate,
    cancelJob,
    onToken,
  };

  return { generate, onToken, cancelJob, prompts };
}

const STEP_RESPONSES = [
  "- point one\n- point two",
  "Draft body about the topic.",
  "NONE",
  "Final revised text.",
];

describe("useSkillRunner", () => {
  let originalModel: unknown;

  beforeEach(() => {
    _resetActiveGenerationForTests();
    originalModel = (window.tessera as unknown as { model: unknown }).model;
  });

  afterEach(() => {
    (window.tessera as unknown as { model: unknown }).model = originalModel;
    vi.useRealTimers();
  });

  it("runs all steps sequentially and threads outputs into context", async () => {
    const harness = installModel((_p, i) => STEP_RESPONSES[i] ?? "");
    const { result } = renderHook(() =>
      useSkillRunner(DOCUMENT_DELIBERATE_DRAFT),
    );

    act(() => {
      result.current.run({
        topic: "Our refund policy",
        context: "30 day window.",
      });
    });

    await waitFor(() => expect(result.current.status).toBe("done"));

    // Four steps, in order, with cleaned outputs.
    expect(result.current.steps.map((s) => s.id)).toEqual([
      "plan",
      "draft",
      "critique",
      "revise",
    ]);
    expect(result.current.steps.map((s) => s.output)).toEqual(STEP_RESPONSES);

    // The final output is the last step's cleaned text.
    expect(result.current.finalOutput).toBe("Final revised text.");

    // Context threads every step output under its declared variable.
    expect(result.current.contextVars.outline).toBe("- point one\n- point two");
    expect(result.current.contextVars.draft_text).toBe(
      "Draft body about the topic.",
    );
    expect(result.current.contextVars.critique).toBe("NONE");
    expect(result.current.contextVars.final_text).toBe("Final revised text.");

    // One generate call per step.
    expect(harness.generate).toHaveBeenCalledTimes(4);

    // Threading: the draft step's prompt embeds the plan's output, and the
    // revise step's prompt embeds both the draft and the critique.
    expect(harness.prompts[1]).toContain("- point one");
    expect(harness.prompts[3]).toContain("Draft body about the topic.");
    expect(harness.prompts[3]).toContain("NONE");

    // Each step's resolved sampling params are forwarded.
    const firstReq = harness.generate.mock.calls[0][0];
    expect(firstReq.maxTokens ?? 0).toBeGreaterThan(0);
    expect(firstReq.temperature ?? 0).toBeGreaterThanOrEqual(0);
  });

  it("blocks the run when a required input is missing", () => {
    const harness = installModel(() => "x");
    const { result } = renderHook(() =>
      useSkillRunner(DOCUMENT_DELIBERATE_DRAFT),
    );

    act(() => {
      result.current.run({ topic: "   " });
    });

    expect(result.current.status).toBe("error");
    expect(result.current.missingInputs).toContain("topic");
    expect(harness.generate).not.toHaveBeenCalled();
  });

  it("surfaces the battery-low sentinel and stops", async () => {
    installModel(() => "x", { batteryLow: true });
    const { result } = renderHook(() =>
      useSkillRunner(DOCUMENT_DELIBERATE_DRAFT),
    );

    act(() => {
      result.current.run({ topic: "anything" });
    });

    await waitFor(() => expect(result.current.status).toBe("battery_low"));
    expect(result.current.steps).toHaveLength(0);
  });

  it("cancels an in-flight chain", async () => {
    // autoComplete=false: the first step streams nothing, so it stays in
    // flight until we cancel.
    const harness = installModel(() => "x", { autoComplete: false });
    const { result } = renderHook(() =>
      useSkillRunner(DOCUMENT_DELIBERATE_DRAFT),
    );

    act(() => {
      result.current.run({ topic: "anything" });
    });

    await waitFor(() => expect(result.current.status).toBe("running"));

    act(() => {
      result.current.cancel();
    });

    expect(result.current.status).toBe("cancelled");
    expect(harness.cancelJob).toHaveBeenCalled();
  });

  it("cancels the backend model job when unmounted mid-run", async () => {
    // autoComplete=false keeps the first step in flight, so unmount happens
    // while the on-device model is still "generating".
    const harness = installModel(() => "x", { autoComplete: false });
    const { result, unmount } = renderHook(() =>
      useSkillRunner(DOCUMENT_DELIBERATE_DRAFT),
    );

    act(() => {
      result.current.run({ topic: "anything" });
    });
    await waitFor(() => expect(result.current.status).toBe("running"));

    act(() => {
      unmount();
    });

    // The cleanup must abort the in-flight generation rather than orphaning
    // it (otherwise the model keeps producing tokens no listener consumes).
    expect(harness.cancelJob).toHaveBeenCalled();
  });

  it("cancels the backend model job when reset mid-run", async () => {
    // autoComplete=false keeps the first step in flight while we reset.
    const harness = installModel(() => "x", { autoComplete: false });
    const { result } = renderHook(() =>
      useSkillRunner(DOCUMENT_DELIBERATE_DRAFT),
    );

    act(() => {
      result.current.run({ topic: "anything" });
    });
    await waitFor(() => expect(result.current.status).toBe("running"));

    act(() => {
      result.current.reset();
    });

    // reset() must abort the in-flight generation (like cancel) rather than
    // discarding the reject ref and orphaning the backend job.
    expect(harness.cancelJob).toHaveBeenCalled();
    expect(result.current.status).toBe("idle");
  });

  it("reports an error when the model surface is unavailable", async () => {
    (window.tessera as unknown as { model: unknown }).model = {
      status: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      generate: undefined,
      cancelJob: vi.fn(),
      onToken: undefined,
    };
    const { result } = renderHook(() =>
      useSkillRunner(DOCUMENT_DELIBERATE_DRAFT),
    );

    act(() => {
      result.current.run({ topic: "anything" });
    });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toMatch(/unavailable/i);
  });

  it("resets to idle and clears state", async () => {
    installModel((_p, i) => STEP_RESPONSES[i] ?? "");
    const { result } = renderHook(() =>
      useSkillRunner(DOCUMENT_DELIBERATE_DRAFT),
    );

    act(() => {
      result.current.run({ topic: "Our refund policy" });
    });
    await waitFor(() => expect(result.current.status).toBe("done"));

    act(() => {
      result.current.reset();
    });

    expect(result.current.status).toBe("idle");
    expect(result.current.steps).toHaveLength(0);
    expect(result.current.finalOutput).toBe("");
    expect(result.current.currentStepIndex).toBe(-1);
  });

  it("repairs a step whose first output fails its deterministic check", async () => {
    // First attempt drops the required "=" prefix; the repair re-prompt
    // supplies a compliant formula.
    const harness = installModel((_p, i) =>
      i === 0 ? "SUM(A1:A2)" : "=SUM(A1:A2)",
    );
    const skill = syntheticCheckedSkill({ nonEmpty: true, mustStartWith: "=" });
    const { result } = renderHook(() => useSkillRunner(skill));

    act(() => {
      result.current.run({ intent: "sum column A" });
    });
    await waitFor(() => expect(result.current.status).toBe("done"));

    // One original call + exactly one repair call.
    expect(harness.generate).toHaveBeenCalledTimes(2);
    // The kept output is the repaired (compliant) one.
    expect(result.current.steps).toHaveLength(1);
    expect(result.current.steps[0].output).toBe("=SUM(A1:A2)");
    expect(result.current.steps[0].repaired).toBe(true);
    expect(result.current.steps[0].checkFailures).toBeUndefined();
    expect(result.current.finalOutput).toBe("=SUM(A1:A2)");
    expect(result.current.isRepairing).toBe(false);

    // The repair prompt echoes the rejected attempt and the failure.
    expect(harness.prompts[1]).toContain("YOUR PREVIOUS ANSWER");
    expect(harness.prompts[1]).toContain("SUM(A1:A2)");
    expect(harness.prompts[1]).toContain('The output must start with "=".');
  });

  it("does not re-prompt when the first output already passes the check", async () => {
    const harness = installModel(() => "=A1+A2");
    const skill = syntheticCheckedSkill({ nonEmpty: true, mustStartWith: "=" });
    const { result } = renderHook(() => useSkillRunner(skill));

    act(() => {
      result.current.run({ intent: "add A1 and A2" });
    });
    await waitFor(() => expect(result.current.status).toBe("done"));

    expect(harness.generate).toHaveBeenCalledTimes(1);
    expect(result.current.steps[0].repaired).toBeUndefined();
    expect(result.current.steps[0].checkFailures).toBeUndefined();
  });

  it("proceeds with the best output and records residual failures after the budget", async () => {
    // Both attempts fail; the chain must still finish and surface the
    // unmet check rather than looping or erroring.
    const harness = installModel(() => "SUM(A1:A2)");
    const skill = syntheticCheckedSkill({ mustStartWith: "=" });
    const { result } = renderHook(() => useSkillRunner(skill));

    act(() => {
      result.current.run({ intent: "sum column A" });
    });
    await waitFor(() => expect(result.current.status).toBe("done"));

    // Original + exactly one repair (budget = 1), then it gives up.
    expect(harness.generate).toHaveBeenCalledTimes(2);
    expect(result.current.steps[0].output).toBe("SUM(A1:A2)");
    expect(result.current.steps[0].repaired).toBeUndefined();
    expect(result.current.steps[0].checkFailures).toEqual([
      'The output must start with "=".',
    ]);
  });

  it("exposes isRepairing while a step is being re-prompted", async () => {
    // First attempt fails the check and completes; the repair attempt is
    // left hanging so we can observe the transient `isRepairing` flag.
    let subscriber: ((chunk: GenerateChunk) => void) | null = null;
    let calls = 0;
    const generate = vi.fn(async () => {
      const callIndex = calls++;
      if (callIndex === 0) {
        const cb = subscriber;
        setTimeout(() => {
          cb?.({ token: "SUM(A1:A2)", done: false });
          cb?.({ token: "", done: true });
        }, 0);
      }
      // The repair attempt (callIndex 1) never streams `done`.
      return undefined;
    });
    const onToken = vi.fn((cb: (chunk: GenerateChunk) => void) => {
      subscriber = cb;
      return () => {
        if (subscriber === cb) subscriber = null;
      };
    });
    const cancelJob = vi.fn().mockResolvedValue(undefined);
    (window.tessera as unknown as { model: unknown }).model = {
      status: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      generate,
      cancelJob,
      onToken,
    };

    const skill = syntheticCheckedSkill({ mustStartWith: "=" });
    const { result } = renderHook(() => useSkillRunner(skill));

    act(() => {
      result.current.run({ intent: "sum column A" });
    });

    await waitFor(() => expect(result.current.isRepairing).toBe(true));
    expect(result.current.status).toBe("running");
    expect(generate).toHaveBeenCalledTimes(2);

    act(() => {
      result.current.cancel();
    });
    expect(result.current.isRepairing).toBe(false);
    expect(result.current.status).toBe("cancelled");
  });

  it("clears isRepairing when the repair attempt errors", async () => {
    // First attempt fails the check and completes; the repair attempt then
    // errors out. The thrown error must surface as status "error" without
    // leaving `isRepairing` stuck true (the in-loop reset is skipped when
    // the await throws).
    let subscriber: ((chunk: GenerateChunk) => void) | null = null;
    let calls = 0;
    const generate = vi.fn(async () => {
      const callIndex = calls++;
      const cb = subscriber;
      if (callIndex === 0) {
        setTimeout(() => {
          cb?.({ token: "SUM(A1:A2)", done: false });
          cb?.({ token: "", done: true });
        }, 0);
      } else {
        // The repair attempt fails with a model error chunk.
        setTimeout(() => {
          cb?.({ token: "", done: false, error: "model crashed" });
        }, 0);
      }
      return undefined;
    });
    const onToken = vi.fn((cb: (chunk: GenerateChunk) => void) => {
      subscriber = cb;
      return () => {
        if (subscriber === cb) subscriber = null;
      };
    });
    const cancelJob = vi.fn().mockResolvedValue(undefined);
    (window.tessera as unknown as { model: unknown }).model = {
      status: vi.fn(),
      start: vi.fn(),
      stop: vi.fn(),
      generate,
      cancelJob,
      onToken,
    };

    const skill = syntheticCheckedSkill({ mustStartWith: "=" });
    const { result } = renderHook(() => useSkillRunner(skill));

    act(() => {
      result.current.run({ intent: "sum column A" });
    });

    await waitFor(() => expect(result.current.status).toBe("error"));
    expect(result.current.error).toMatch(/model crashed/);
    expect(result.current.isRepairing).toBe(false);
    // Original attempt + exactly one repair attempt (which threw).
    expect(generate).toHaveBeenCalledTimes(2);
  });
});
