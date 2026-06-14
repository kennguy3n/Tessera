import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { createRef } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  SkillRunnerPanel,
  type SkillRunnerHandle,
} from "../components/SkillRunnerPanel";
import { DOCUMENT_DELIBERATE_DRAFT } from "../../skills/skillLibrary";
import type { GenerateChunk } from "../../types/ipc";
import { _resetActiveGenerationForTests } from "../../hooks/useActiveGeneration";

/**
 * Installs a model whose `generate` never streams a `done` chunk, so a
 * started skill stays in the running state until explicitly cancelled.
 */
function installPendingModel(): { cancelJob: ReturnType<typeof vi.fn> } {
  let subscriber: ((chunk: GenerateChunk) => void) | null = null;
  const onToken = vi.fn((cb: (chunk: GenerateChunk) => void) => {
    subscriber = cb;
    return () => {
      if (subscriber === cb) subscriber = null;
    };
  });
  const generate = vi.fn(async () => undefined);
  const cancelJob = vi.fn().mockResolvedValue(undefined);
  const api = window.tessera as unknown as { model: unknown };
  api.model = { status: vi.fn(), start: vi.fn(), stop: vi.fn(), generate, cancelJob, onToken };
  return { cancelJob };
}

/**
 * Installs a fake on-device model that streams one scripted token + a done
 * chunk per `generate` call, so the panel can drive a full skill run.
 */
function installModel(responses: string[]): void {
  let subscriber: ((chunk: GenerateChunk) => void) | null = null;
  let call = 0;

  const onToken = vi.fn((cb: (chunk: GenerateChunk) => void) => {
    subscriber = cb;
    return () => {
      if (subscriber === cb) subscriber = null;
    };
  });

  const generate = vi.fn(async () => {
    const text = responses[call] ?? "";
    call += 1;
    setTimeout(() => {
      subscriber?.({ token: text, done: false });
      subscriber?.({ token: "", done: true });
    }, 0);
    return undefined;
  });

  const api = window.tessera as unknown as { model: unknown };
  api.model = {
    status: vi.fn(),
    start: vi.fn(),
    stop: vi.fn(),
    generate,
    cancelJob: vi.fn().mockResolvedValue(undefined),
    onToken,
  };
}

describe("SkillRunnerPanel", () => {
  let originalModel: unknown;

  beforeEach(() => {
    _resetActiveGenerationForTests();
    originalModel = (window.tessera as unknown as { model: unknown }).model;
  });

  afterEach(() => {
    (window.tessera as unknown as { model: unknown }).model = originalModel;
    vi.useRealTimers();
  });

  it("renders the skill's inputs, description and step count", () => {
    const { container } = render(
      <SkillRunnerPanel skill={DOCUMENT_DELIBERATE_DRAFT} />,
    );

    expect(screen.getByTestId("skill-runner-panel")).toBeInTheDocument();
    expect(
      screen.getByText(DOCUMENT_DELIBERATE_DRAFT.description),
    ).toBeInTheDocument();
    // Every declared input is rendered as a field bound to its id.
    for (const input of DOCUMENT_DELIBERATE_DRAFT.inputs) {
      expect(
        container.querySelector(`#skill-input-${input.id}`),
      ).not.toBeNull();
    }
    expect(
      screen.getByText(`${DOCUMENT_DELIBERATE_DRAFT.steps.length} steps`),
    ).toBeInTheDocument();
    expect(screen.getByTestId("skill-run")).toBeEnabled();
  });

  it("flags missing required inputs instead of running", async () => {
    installModel(["x"]);
    const user = userEvent.setup();
    render(<SkillRunnerPanel skill={DOCUMENT_DELIBERATE_DRAFT} />);

    await user.click(screen.getByTestId("skill-run"));

    expect(await screen.findByTestId("skill-error")).toBeInTheDocument();
    const generate = (window.tessera as unknown as { model: { generate: ReturnType<typeof vi.fn> } })
      .model.generate;
    expect(generate).not.toHaveBeenCalled();
  });

  it("runs every step and applies the final output", async () => {
    installModel([
      "- outline a\n- outline b",
      "A solid first draft.",
      "NONE",
      "The polished final passage.",
    ]);
    const onApply = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <SkillRunnerPanel skill={DOCUMENT_DELIBERATE_DRAFT} onApply={onApply} />,
    );

    const topic = container.querySelector(
      "#skill-input-topic",
    ) as HTMLTextAreaElement;
    await user.type(topic, "Quarterly customer-support summary");

    await user.click(screen.getByTestId("skill-run"));

    // The final-output box appears once all steps complete.
    const final = await screen.findByTestId("skill-final");
    expect(final).toHaveTextContent("The polished final passage.");

    // Every step is rendered and marked done.
    for (const step of DOCUMENT_DELIBERATE_DRAFT.steps) {
      expect(screen.getByTestId(`skill-step-${step.id}`)).toBeInTheDocument();
    }

    await user.click(screen.getByTestId("skill-apply"));
    expect(onApply).toHaveBeenCalledWith("The polished final passage.");
  });

  it("exposes an imperative handle that runs and cancels the skill", async () => {
    const { cancelJob } = installPendingModel();
    const user = userEvent.setup();
    const ref = createRef<SkillRunnerHandle>();
    const { container } = render(
      <SkillRunnerPanel ref={ref} skill={DOCUMENT_DELIBERATE_DRAFT} />,
    );

    const topic = container.querySelector(
      "#skill-input-topic",
    ) as HTMLTextAreaElement;
    await user.type(topic, "Quarterly customer-support summary");

    // `submit()` runs the skill with the panel's current inputs.
    act(() => {
      ref.current?.submit();
    });
    const generate = (
      window.tessera as unknown as {
        model: { generate: ReturnType<typeof vi.fn> };
      }
    ).model.generate;
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(ref.current?.isRunning).toBe(true));

    // `cancel()` aborts the backend job and returns to a non-running state.
    act(() => {
      ref.current?.cancel();
    });
    expect(cancelJob).toHaveBeenCalled();
    await waitFor(() => expect(ref.current?.isRunning).toBe(false));
  });
});
