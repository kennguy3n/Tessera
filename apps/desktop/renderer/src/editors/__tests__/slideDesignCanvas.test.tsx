/**
 * Integration tests for the Slide editor's WYSIWYG "Design view"
 * (`SlideDesignCanvas`).
 *
 * These mount the real component and prove the React wiring: that the
 * chromeless prose fields edit through the same `onChangeBlock*` /
 * `onMoveBlock` / `onRemoveBlock` / `onAppendBlock` callbacks the
 * structured Outline canvas uses, and that the caret-aware bullet
 * transforms from `slideWysiwyg.ts` fire on Enter / Backspace / Delete.
 * The transforms themselves are unit-tested in `slideWysiwyg.test.ts`;
 * here we only assert they are reachable from the UI with the right
 * arguments and produce the right `content` string.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { SlideDesignCanvas } from "../components/SlideDesignCanvas";
import type { Slide } from "../slideEditorTypes";

function makeSlide(blocks: Slide["blocks"]): Slide {
  return { id: "s1", title: "Intro", notes: "", blocks };
}

function renderCanvas(slide: Slide) {
  const handlers = {
    onChangeBlockContent: vi.fn(),
    onChangeBlockAlt: vi.fn(),
    onImageFile: vi.fn(),
    onMoveBlock: vi.fn(),
    onRemoveBlock: vi.fn(),
    onAppendBlock: vi.fn(),
  };
  const utils = render(<SlideDesignCanvas slide={slide} {...handlers} />);
  return { ...handlers, ...utils };
}

describe("SlideDesignCanvas — text block", () => {
  it("edits text through onChangeBlockContent at the block index", () => {
    const slide = makeSlide([
      { id: "b0", type: "text", content: "hello" },
      { id: "b1", type: "text", content: "world" },
    ]);
    const { onChangeBlockContent } = renderCanvas(slide);
    const fields = screen.getAllByLabelText("Text content");
    fireEvent.change(fields[1], { target: { value: "WORLD" } });
    expect(onChangeBlockContent).toHaveBeenCalledWith(1, "WORLD");
  });
});

describe("SlideDesignCanvas — bullets block", () => {
  it("splits a bullet on Enter at the caret", () => {
    const slide = makeSlide([
      { id: "b0", type: "bullets", content: "alpha\nbeta" },
    ]);
    const { onChangeBlockContent } = renderCanvas(slide);
    const bullet = screen.getByLabelText("Bullet 1") as HTMLTextAreaElement;
    // Caret after "al".
    bullet.setSelectionRange(2, 2);
    fireEvent.keyDown(bullet, { key: "Enter" });
    expect(onChangeBlockContent).toHaveBeenCalledWith(0, "al\npha\nbeta");
  });

  it("merges into the previous bullet on Backspace at the start", () => {
    const slide = makeSlide([
      { id: "b0", type: "bullets", content: "one\ntwo" },
    ]);
    const { onChangeBlockContent } = renderCanvas(slide);
    const second = screen.getByLabelText("Bullet 2") as HTMLTextAreaElement;
    second.setSelectionRange(0, 0);
    fireEvent.keyDown(second, { key: "Backspace" });
    expect(onChangeBlockContent).toHaveBeenCalledWith(0, "onetwo");
  });

  it("does not merge backward on the first bullet (no-op)", () => {
    const slide = makeSlide([
      { id: "b0", type: "bullets", content: "one\ntwo" },
    ]);
    const { onChangeBlockContent } = renderCanvas(slide);
    const first = screen.getByLabelText("Bullet 1") as HTMLTextAreaElement;
    first.setSelectionRange(0, 0);
    fireEvent.keyDown(first, { key: "Backspace" });
    expect(onChangeBlockContent).not.toHaveBeenCalled();
  });

  it("pulls the next bullet up on Delete at the end", () => {
    const slide = makeSlide([
      { id: "b0", type: "bullets", content: "one\ntwo" },
    ]);
    const { onChangeBlockContent } = renderCanvas(slide);
    const first = screen.getByLabelText("Bullet 1") as HTMLTextAreaElement;
    first.setSelectionRange(3, 3); // end of "one"
    fireEvent.keyDown(first, { key: "Delete" });
    expect(onChangeBlockContent).toHaveBeenCalledWith(0, "onetwo");
  });

  it("edits a single bullet line in place", () => {
    const slide = makeSlide([
      { id: "b0", type: "bullets", content: "one\ntwo" },
    ]);
    const { onChangeBlockContent } = renderCanvas(slide);
    const second = screen.getByLabelText("Bullet 2") as HTMLTextAreaElement;
    fireEvent.change(second, { target: { value: "TWO" } });
    expect(onChangeBlockContent).toHaveBeenCalledWith(0, "one\nTWO");
  });
});

describe("SlideDesignCanvas — block controls", () => {
  it("moves, removes and appends through the shared callbacks", () => {
    const slide = makeSlide([
      { id: "b0", type: "text", content: "a" },
      { id: "b1", type: "text", content: "b" },
    ]);
    const { onMoveBlock, onRemoveBlock, onAppendBlock } = renderCanvas(slide);

    // First block can move down but not up.
    const ups = screen.getAllByLabelText("Move block up");
    const downs = screen.getAllByLabelText("Move block down");
    expect((ups[0] as HTMLButtonElement).disabled).toBe(true);
    expect((downs[1] as HTMLButtonElement).disabled).toBe(true);

    fireEvent.click(downs[0]);
    expect(onMoveBlock).toHaveBeenCalledWith(0, 1);

    fireEvent.click(screen.getAllByLabelText("Delete block")[1]);
    expect(onRemoveBlock).toHaveBeenCalledWith(1);

    fireEvent.click(screen.getByLabelText("Add a block to this slide"));
    expect(onAppendBlock).toHaveBeenCalled();
  });
});

describe("SlideDesignCanvas — image block", () => {
  it("routes a picked file and edits alt text", () => {
    const slide = makeSlide([{ id: "b0", type: "image", content: "", alt: "" }]);
    const { onImageFile, onChangeBlockAlt, container } = renderCanvas(slide);

    const file = new File(["x"], "pic.png", { type: "image/png" });
    const input = container.querySelector(
      ".slide-wys-image-file",
    ) as HTMLInputElement;
    fireEvent.change(input, { target: { files: [file] } });
    expect(onImageFile).toHaveBeenCalledWith(0, file);

    fireEvent.change(screen.getByLabelText("Image alt text"), {
      target: { value: "A photo" },
    });
    expect(onChangeBlockAlt).toHaveBeenCalledWith(0, "A photo");
  });
});

describe("SlideDesignCanvas — DSL blocks", () => {
  it("reveals a source editor for a table block and edits it", () => {
    const slide = makeSlide([
      { id: "b0", type: "table", content: "| A | B |" },
    ]);
    const { onChangeBlockContent } = renderCanvas(slide);
    fireEvent.click(screen.getByText(/Edit Table/i));
    const source = screen.getByLabelText(
      /Table \(Markdown\) source/i,
    ) as HTMLTextAreaElement;
    fireEvent.change(source, { target: { value: "| A | B |\n| 1 | 2 |" } });
    expect(onChangeBlockContent).toHaveBeenCalledWith(0, "| A | B |\n| 1 | 2 |");
  });
});
