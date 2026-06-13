import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import {
  SlideAiActions,
  SlideDeckGenerator,
  SlideDeckRestyler,
} from "../editors/SlideAiPanel";
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

describe("SlideDeckRestyler", () => {
  const deck: Slide[] = [
    {
      id: "s0",
      title: "Intro",
      blocks: [
        buildBlock({ type: "text", content: "Welcome", slot: "subtitle" }),
      ],
      notes: "",
    },
    {
      id: "s1",
      title: "Detail",
      layout: "imageRight",
      blocks: [
        buildBlock({ type: "bullets", content: "old a\nold b" }),
        buildBlock({ type: "image", content: "asset://i.png", alt: "pic" }),
      ],
      notes: "keep me",
    },
  ];

  it("restyles the current deck and applies the reconciled result", async () => {
    mockModelAvailable();
    mockGenerate(
      "TITLE: Intro\n## Intro\n- Welcome\n## [titleContent] Detail\n- new a\n- new b\n",
    );
    const onApply = vi.fn();
    render(
      <SlideDeckRestyler
        open
        onClose={() => undefined}
        slides={deck}
        onApply={onApply}
      />,
    );

    fireEvent.click(await screen.findByText("Restyle"));
    fireEvent.click(await screen.findByText(/Apply 2 slides/i));

    expect(onApply).toHaveBeenCalledTimes(1);
    const out: Slide[] = onApply.mock.calls[0][0];
    expect(out).toHaveLength(2);
    // Original ids preserved by index (navigator stability).
    expect(out.map((s) => s.id)).toEqual(["s0", "s1"]);
    // Image re-attached + original image layout preserved.
    expect(out[1].blocks.some((b) => b.type === "image")).toBe(true);
    expect(out[1].layout).toBe("imageRight");
    // Original notes kept when the model omitted them.
    expect(out[1].notes).toBe("keep me");
  });

  it("renders nothing when closed", () => {
    const { container } = render(
      <SlideDeckRestyler
        open={false}
        onClose={() => undefined}
        slides={deck}
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

  it("regenerates the slide with a fresh title + bullets", async () => {
    mockModelAvailable();
    mockGenerate("## Sharper title\n- fresh one\n- fresh two");
    const onApplyRegenerated = vi.fn();
    render(
      <SlideAiActions
        slide={slide}
        onApplyBullets={() => undefined}
        onApplyNotes={() => undefined}
        onApplyRegenerated={onApplyRegenerated}
      />,
    );

    fireEvent.click(await screen.findByText("Regenerate"));
    await waitFor(() =>
      expect(onApplyRegenerated).toHaveBeenCalledWith({
        title: "Sharper title",
        bullets: ["fresh one", "fresh two"],
      }),
    );
  });

  it("omits the Regenerate button when onApplyRegenerated is not provided", async () => {
    mockModelAvailable();
    render(
      <SlideAiActions
        slide={slide}
        onApplyBullets={() => undefined}
        onApplyNotes={() => undefined}
      />,
    );
    expect(await screen.findByText("Condense")).toBeInTheDocument();
    expect(screen.queryByText("Regenerate")).not.toBeInTheDocument();
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

  it("applies an AI-suggested layout to the slide", async () => {
    mockModelAvailable();
    mockGenerate("twoColumn");
    const onApplyLayout = vi.fn();
    render(
      <SlideAiActions
        slide={slide}
        onApplyBullets={() => undefined}
        onApplyNotes={() => undefined}
        onApplyLayout={onApplyLayout}
      />,
    );

    fireEvent.click(screen.getByText("Suggest layout"));
    await waitFor(() =>
      expect(onApplyLayout).toHaveBeenCalledWith("twoColumn"),
    );
    expect(await screen.findByText(/Applied/i)).toBeInTheDocument();
  });

  it("shows a notice when the model returns no usable layout", async () => {
    mockModelAvailable();
    mockGenerate("I really cannot decide");
    const onApplyLayout = vi.fn();
    render(
      <SlideAiActions
        slide={slide}
        onApplyBullets={() => undefined}
        onApplyNotes={() => undefined}
        onApplyLayout={onApplyLayout}
      />,
    );

    fireEvent.click(screen.getByText("Suggest layout"));
    expect(
      await screen.findByText(/didn’t suggest a usable layout/i),
    ).toBeInTheDocument();
    expect(onApplyLayout).not.toHaveBeenCalled();
  });

  it("omits the Suggest layout button when onApplyLayout is not provided", async () => {
    mockModelAvailable();
    render(
      <SlideAiActions
        slide={slide}
        onApplyBullets={() => undefined}
        onApplyNotes={() => undefined}
      />,
    );
    // Wait for the action row to settle (model status probe resolves).
    expect(await screen.findByText("Condense")).toBeInTheDocument();
    expect(screen.queryByText("Suggest layout")).not.toBeInTheDocument();
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
