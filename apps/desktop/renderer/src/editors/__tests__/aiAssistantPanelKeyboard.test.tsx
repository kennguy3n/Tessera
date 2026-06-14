/**
 * Regression test for the AI panel's keyboard shortcuts in *skills* mode.
 *
 * A running skill is driven by `useSkillRunner`, not `useDocumentAi`, so the
 * panel's `onKeyDown` must consult the skill panel (not `ai.isStreaming`):
 *   - Cmd/Ctrl+Enter runs the SKILL, not the quick action.
 *   - Escape cancels the running skill (and keeps the panel open) instead of
 *     closing the panel and orphaning the on-device generation.
 */
import { fireEvent, render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import { act } from "react";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { AiAssistantPanel } from "../components/AiAssistantPanel";
import type { GenerateChunk } from "../../types/ipc";
import { _resetActiveGenerationForTests } from "../../hooks/useActiveGeneration";

/** A model whose `generate` never streams `done`, so a run stays in flight. */
function installPendingModel() {
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
  return { generate, cancelJob };
}

const liveEditors: Editor[] = [];

function makeEditor(): Editor {
  const editor = new Editor({
    extensions: [StarterKit.configure({ horizontalRule: false })],
    content: "<p>Hello world</p>",
  });
  liveEditors.push(editor);
  return editor;
}

describe("AiAssistantPanel — skills-mode keyboard handling", () => {
  let originalModel: unknown;

  beforeEach(() => {
    _resetActiveGenerationForTests();
    originalModel = (window.tessera as unknown as { model: unknown }).model;
  });

  afterEach(() => {
    (window.tessera as unknown as { model: unknown }).model = originalModel;
    while (liveEditors.length > 0) liveEditors.pop()?.destroy();
    vi.useRealTimers();
  });

  it("Cmd/Ctrl+Enter runs the skill and Escape cancels it instead of closing", async () => {
    const { generate, cancelJob } = installPendingModel();
    const onClose = vi.fn();
    const user = userEvent.setup();
    const { container } = render(
      <AiAssistantPanel
        editor={makeEditor()}
        context={{ selection: "", precedingText: "", range: null }}
        onClose={onClose}
      />,
    );

    await user.click(screen.getByTestId("ai-mode-skills"));

    const topic = container.querySelector(
      "#skill-input-topic",
    ) as HTMLTextAreaElement;
    await user.type(topic, "Quarterly customer-support summary");

    const panel = screen.getByTestId("ai-assistant-panel");

    // Ctrl+Enter in skills mode runs the skill, not the quick action.
    fireEvent.keyDown(panel, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    expect(onClose).not.toHaveBeenCalled();

    // The skill is now running (Stop control is visible).
    await screen.findByTestId("skill-stop");

    // First Escape cancels the running skill and keeps the panel open.
    act(() => {
      fireEvent.keyDown(panel, { key: "Escape" });
    });
    expect(cancelJob).toHaveBeenCalled();
    expect(onClose).not.toHaveBeenCalled();
    await screen.findByText("Skill stopped.");

    // Second Escape (nothing running) closes the panel.
    fireEvent.keyDown(panel, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("ignores Cmd/Ctrl+Enter while a skill is already running", async () => {
    const { generate } = installPendingModel();
    const user = userEvent.setup();
    const { container } = render(
      <AiAssistantPanel
        editor={makeEditor()}
        context={{ selection: "", precedingText: "", range: null }}
        onClose={vi.fn()}
      />,
    );

    await user.click(screen.getByTestId("ai-mode-skills"));
    const topic = container.querySelector(
      "#skill-input-topic",
    ) as HTMLTextAreaElement;
    await user.type(topic, "Quarterly customer-support summary");

    const panel = screen.getByTestId("ai-assistant-panel");
    fireEvent.keyDown(panel, { key: "Enter", ctrlKey: true });
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await screen.findByTestId("skill-stop");

    // A second shortcut while running must NOT start a concurrent chain.
    fireEvent.keyDown(panel, { key: "Enter", ctrlKey: true });
    fireEvent.keyDown(panel, { key: "Enter", ctrlKey: true });
    expect(generate).toHaveBeenCalledTimes(1);
  });
});
