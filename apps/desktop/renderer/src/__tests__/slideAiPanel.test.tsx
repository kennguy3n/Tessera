import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { SlideAiActions, SlideDeckGenerator } from "../editors/SlideAiPanel";
import { _resetActiveGenerationForTests } from "../hooks/useActiveGeneration";
import { buildBlock } from "../editors/slideEditorHelpers";
import type { GenerateChunk } from "../types/ipc";
import type { Slide } from "../editors/slideEditorTypes";

type TokenCb = (chunk: GenerateChunk) => void;

function mockModelAvailable() {
  vi.spyOn(window.tessera.model, "status").mockResolvedValue({
    available: true,
    modelName: "test-model",
    status: "ready",
  });
  // The per-slide actions probe imagegen availability on mount; keep it
  // off so these tests exercise the text path deterministically.
  vi.spyOn(window.tessera.imagegen, "isAvailable").mockResolvedValue(false);
}

function mockGenerate(text: string): void {
  let tokenCb: TokenCb | null = null;
  vi.spyOn(window.tessera.model, "onToken").mockImplementation((cb) => {
    tokenCb = cb;
    return () => undefined;
  });
  vi.spyOn(window.tessera.model, "generate").mockImplementation(async () => {
    tokenCb?.({ token: text, done: true });
    return undefined;
  });
}

afterEach(() => {
  vi.restoreAllMocks();
  _resetActiveGenerationForTests();
});

describe("SlideDeckGenerator", () => {
  it("shows the unavailable hint when no model is running", async () => {
    vi.spyOn(window.tessera.model, "status").mockResolvedValue({
      available: false,
      modelName: null,
      status: "not_configured",
    });
    render(
      <SlideDeckGenerator
        open
        onClose={() => undefined}
        onApply={() => undefined}
      />,
    );
    expect(await screen.findByText(/Start a local model/i)).toBeInTheDocument();
  });

  it("generates, previews and applies a parsed deck", async () => {
    mockModelAvailable();
    mockGenerate("TITLE: My Deck\n## One\n- a\n- b\n## Two\n- c\n");
    const onApply = vi.fn();
    render(
      <SlideDeckGenerator open onClose={() => undefined} onApply={onApply} />,
    );

    const topic = await screen.findByPlaceholderText(/quarterly sales review/i);
    fireEvent.change(topic, { target: { value: "My topic" } });
    fireEvent.click(screen.getByText("Generate"));

    const applyBtn = await screen.findByText(/Apply 2 slides/i);
    fireEvent.click(applyBtn);

    expect(onApply).toHaveBeenCalledTimes(1);
    const slides: Slide[] = onApply.mock.calls[0][0];
    expect(slides).toHaveLength(2);
    expect(slides[0].title).toBe("My Deck");
    expect(slides[0].blocks[0].content).toBe("a\nb");
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <SlideDeckGenerator
        open={false}
        onClose={() => undefined}
        onApply={() => undefined}
      />,
    );
    expect(container).toBeEmptyDOMElement();
  });
});

describe("SlideAiActions", () => {
  const slide: Slide = {
    id: "s1",
    title: "Topic",
    blocks: [buildBlock({ type: "bullets", content: "old one\nold two" })],
    notes: "",
  };

  it("applies condensed bullets back to the slide", async () => {
    mockModelAvailable();
    mockGenerate("- short one\n- short two");
    const onApplyBullets = vi.fn();
    render(
      <SlideAiActions
        slide={slide}
        onApplyBullets={onApplyBullets}
        onApplyNotes={() => undefined}
      />,
    );

    fireEvent.click(screen.getByText("Condense"));
    await waitFor(() =>
      expect(onApplyBullets).toHaveBeenCalledWith(["short one", "short two"]),
    );
  });

  it("applies generated speaker notes", async () => {
    mockModelAvailable();
    mockGenerate("Open with the headline number, then walk the chart.");
    const onApplyNotes = vi.fn();
    render(
      <SlideAiActions
        slide={slide}
        onApplyBullets={() => undefined}
        onApplyNotes={onApplyNotes}
      />,
    );

    fireEvent.click(screen.getByText("Speaker notes"));
    await waitFor(() =>
      expect(onApplyNotes).toHaveBeenCalledWith(
        "Open with the headline number, then walk the chart.",
      ),
    );
  });

  it("hides actions and shows a hint when no model is available", async () => {
    vi.spyOn(window.tessera.model, "status").mockResolvedValue({
      available: false,
      modelName: null,
      status: "not_configured",
    });
    vi.spyOn(window.tessera.imagegen, "isAvailable").mockResolvedValue(false);
    render(
      <SlideAiActions
        slide={slide}
        onApplyBullets={() => undefined}
        onApplyNotes={() => undefined}
      />,
    );
    expect(await screen.findByText(/Start a local model/i)).toBeInTheDocument();
    expect(screen.queryByText("Condense")).not.toBeInTheDocument();
  });
});
