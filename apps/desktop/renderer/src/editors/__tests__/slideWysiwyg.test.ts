import { describe, it, expect } from "vitest";
import {
  contentToBulletLines,
  bulletLinesToContent,
  splitBulletAt,
  mergeBulletBackward,
  mergeBulletForward,
} from "../slideWysiwyg";

describe("slideWysiwyg — content ↔ bullet lines", () => {
  it("treats an empty block as a single empty bullet", () => {
    expect(contentToBulletLines("")).toEqual([""]);
  });

  it("splits on newlines, preserving interior blank bullets", () => {
    expect(contentToBulletLines("a\n\nb")).toEqual(["a", "", "b"]);
  });

  it("round-trips lines → content → lines", () => {
    const lines = ["First", "Second", "Third"];
    expect(contentToBulletLines(bulletLinesToContent(lines))).toEqual(lines);
  });

  it("joins lines with newlines", () => {
    expect(bulletLinesToContent(["a", "b"])).toBe("a\nb");
  });
});

describe("slideWysiwyg — splitBulletAt (Enter)", () => {
  it("splits a bullet at the caret and focuses the new row at offset 0", () => {
    const r = splitBulletAt(["Hello world"], 0, 5);
    expect(r.lines).toEqual(["Hello", " world"]);
    expect(r.focusIndex).toBe(1);
    expect(r.focusCaret).toBe(0);
  });

  it("Enter at the end appends an empty bullet below", () => {
    const r = splitBulletAt(["one", "two"], 1, 3);
    expect(r.lines).toEqual(["one", "two", ""]);
    expect(r.focusIndex).toBe(2);
  });

  it("Enter at the start pushes the text down into a new bullet", () => {
    const r = splitBulletAt(["text"], 0, 0);
    expect(r.lines).toEqual(["", "text"]);
    expect(r.focusIndex).toBe(1);
    expect(r.focusCaret).toBe(0);
  });

  it("clamps an out-of-range caret to the bullet length", () => {
    const r = splitBulletAt(["abc"], 0, 99);
    expect(r.lines).toEqual(["abc", ""]);
  });
});

describe("slideWysiwyg — mergeBulletBackward (Backspace at start)", () => {
  it("merges into the previous bullet with the caret at the seam", () => {
    const r = mergeBulletBackward(["one", "two"], 1);
    expect(r).not.toBeNull();
    expect(r!.lines).toEqual(["onetwo"]);
    expect(r!.focusIndex).toBe(0);
    expect(r!.focusCaret).toBe(3);
  });

  it("returns null for the first bullet (nothing to merge into)", () => {
    expect(mergeBulletBackward(["only"], 0)).toBeNull();
  });

  it("merging an empty bullet just deletes the row, caret at prev end", () => {
    const r = mergeBulletBackward(["a", "", "b"], 1);
    expect(r!.lines).toEqual(["a", "b"]);
    expect(r!.focusIndex).toBe(0);
    expect(r!.focusCaret).toBe(1);
  });
});

describe("slideWysiwyg — mergeBulletForward (Delete at end)", () => {
  it("pulls the next bullet up with the caret staying at the seam", () => {
    const r = mergeBulletForward(["one", "two"], 0);
    expect(r!.lines).toEqual(["onetwo"]);
    expect(r!.focusIndex).toBe(0);
    expect(r!.focusCaret).toBe(3);
  });

  it("returns null for the last bullet (nothing to pull up)", () => {
    expect(mergeBulletForward(["a", "b"], 1)).toBeNull();
  });
});
