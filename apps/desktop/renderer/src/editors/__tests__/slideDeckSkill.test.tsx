/**
 * Wiring coverage for the Slides "Skill" tab: switching the deck
 * generator to skills mode runs the multi-step deck skill, and applying
 * its final deck markdown flows through the SAME parse → slides path as
 * the quick generator before calling `onApply` and closing the panel.
 */
import { act, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SlideDeckGenerator } from "../SlideAiPanel";
import { _resetActiveGenerationForTests } from "../../hooks/useActiveGeneration";
import type { GenerateChunk } from "../../types/ipc";

/**
 * Installs a fake on-device model that streams one scripted token + a
 * done chunk per `generate` call, so the panel can drive a full skill
 * run (one response per step, in order).
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
    status: vi.fn().mockResolvedValue({ available: true }),
    start: vi.fn(),
    stop: vi.fn(),
    generate,
    cancelJob: vi.fn().mockResolvedValue(undefined),
    onToken,
  };
}

/**
 * Installs a fake model whose `generate` returns a promise that stays
 * pending until the test resolves it, so a quick deck generation stays
 * in the streaming state (the `useModelGeneration` hook ties
 * `isStreaming` to the generate promise). Exposes the `cancelJob` spy
 * and a resolver to settle the run.
 */
function installPendingModel(): {
  cancelJob: ReturnType<typeof vi.fn>;
  resolve: () => void;
} {
  let subscriber: ((chunk: GenerateChunk) => void) | null = null;
  let resolveGenerate: (() => void) | null = null;

  const onToken = vi.fn((cb: (chunk: GenerateChunk) => void) => {
    subscriber = cb;
    return () => {
      if (subscriber === cb) subscriber = null;
    };
  });
  const cancelJob = vi.fn().mockResolvedValue(undefined);
  const generate = vi.fn(
    () =>
      new Promise<undefined>((res) => {
        resolveGenerate = () => res(undefined);
      }),
  );

  const api = window.tessera as unknown as { model: unknown };
  api.model = {
    status: vi.fn().mockResolvedValue({ available: true }),
    start: vi.fn(),
    stop: vi.fn(),
    generate,
    cancelJob,
    onToken,
  };
  return { cancelJob, resolve: () => resolveGenerate?.() };
}

describe("SlideDeckGenerator skills mode", () => {
  let originalModel: unknown;

  beforeEach(() => {
    _resetActiveGenerationForTests();
    originalModel = (window.tessera as unknown as { model: unknown }).model;
  });

  afterEach(() => {
    (window.tessera as unknown as { model: unknown }).model = originalModel;
    vi.clearAllMocks();
  });

  it("runs the deck skill and applies the parsed slides", async () => {
    installModel([
      "## Draft\n- a\n- b",
      "## Draft\n- expanded a\n- expanded b",
      [
        "## Market overview",
        "- TAM growing 20% YoY",
        "- Competitors slow to ship",
        "## Our wedge",
        "- Local-first beats cloud latency",
        "- Privacy as a default",
        "## The ask",
        "- Close 3 design partners",
        "- Hire 2 engineers",
      ].join("\n"),
    ]);
    const onApply = vi.fn();
    const onClose = vi.fn();
    const user = userEvent.setup();
    render(<SlideDeckGenerator open onApply={onApply} onClose={onClose} />);

    await user.click(screen.getByTestId("slide-ai-mode-skills"));
    await user.type(screen.getByLabelText(/Deck topic/i), "Q3 GTM plan");
    await user.click(screen.getByTestId("skill-run"));

    await user.click(await screen.findByTestId("skill-apply"));

    expect(onApply).toHaveBeenCalledTimes(1);
    const slides = onApply.mock.calls[0][0] as Array<{ title: string }>;
    expect(slides).toHaveLength(3);
    expect(slides[0].title).toBe("Market overview");
    expect(onClose).toHaveBeenCalled();
  });

  it("starts in quick mode and only shows the skill runner after switching", async () => {
    installModel([]);
    const user = userEvent.setup();
    render(<SlideDeckGenerator open onApply={vi.fn()} onClose={vi.fn()} />);

    expect(screen.queryByTestId("skill-runner-panel")).toBeNull();
    expect(screen.getByTestId("slide-ai-mode-quick")).toHaveAttribute(
      "aria-pressed",
      "true",
    );

    await user.click(screen.getByTestId("slide-ai-mode-skills"));
    expect(screen.getByTestId("skill-runner-panel")).toBeInTheDocument();
  });

  it("disables the mode-switch buttons while a quick generation streams", async () => {
    const { resolve } = installPendingModel();
    const user = userEvent.setup();
    render(<SlideDeckGenerator open onApply={vi.fn()} onClose={vi.fn()} />);

    await user.type(screen.getByLabelText(/Topic or brief/i), "Q3 GTM plan");
    await user.click(screen.getByRole("button", { name: "Generate" }));

    // Streaming hides the Stop button behind the disabled mode buttons so
    // the user can't silently abandon a stream by switching tabs.
    await waitFor(() =>
      expect(screen.getByTestId("slide-ai-mode-skills")).toBeDisabled(),
    );
    expect(screen.getByTestId("slide-ai-mode-quick")).toBeDisabled();

    await act(async () => {
      resolve();
    });
  });

  it("clears a stale quick 'no usable deck' notice when toggling modes", async () => {
    // An empty completion yields zero parseable slides -> the quick
    // "no usable outline" notice. It must not linger after a mode toggle.
    installModel([""]);
    const user = userEvent.setup();
    render(<SlideDeckGenerator open onApply={vi.fn()} onClose={vi.fn()} />);

    await user.type(screen.getByLabelText(/Topic or brief/i), "vague topic");
    await user.click(screen.getByRole("button", { name: "Generate" }));
    expect(
      await screen.findByText(/return a usable outline/i),
    ).toBeInTheDocument();

    await user.click(screen.getByTestId("slide-ai-mode-skills"));
    await user.click(screen.getByTestId("slide-ai-mode-quick"));
    expect(screen.queryByText(/return a usable outline/i)).toBeNull();
  });
});
