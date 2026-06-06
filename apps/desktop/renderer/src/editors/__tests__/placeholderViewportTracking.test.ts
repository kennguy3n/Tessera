/**
 * Regression test for the Windows-only jsdom crash
 * "document.elementFromPoint is not a function".
 *
 * TipTap's `@tiptap/extension-placeholder` registers a ProseMirror
 * plugin whose `view()` lifecycle synchronously computes the visible
 * viewport boundary on mount. That computation calls
 * `EditorView.posAtCoords`, which in turn calls
 * `document.elementFromPoint` — a layout hit-testing API jsdom does
 * not implement.
 *
 * It only reaches that call when the editor's bounding rect has a
 * positive height that overlaps the viewport; with jsdom's default
 * all-zero rects `getViewportBoundaryPositions` early-returns, which
 * is why the crash surfaced intermittently (and platform-dependently)
 * rather than on every run. Here we *force* the non-early-return path
 * by stubbing the editor's rect to a positive height, proving that the
 * `document.elementFromPoint` jsdom stub in `setup.ts` lets the
 * placeholder plugin mount without throwing.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { Editor } from "@tiptap/core";
import StarterKit from "@tiptap/starter-kit";
import Placeholder from "@tiptap/extension-placeholder";

const liveEditors: Editor[] = [];

afterEach(() => {
  while (liveEditors.length > 0) {
    liveEditors.pop()?.destroy();
  }
  vi.restoreAllMocks();
});

describe("placeholder extension viewport tracking under jsdom", () => {
  it("mounts without throwing when posAtCoords hit-tests on mount", () => {
    // Force `getViewportBoundaryPositions` past its zero-rect early
    // return so it actually calls `view.posAtCoords` (the path that
    // hit `document.elementFromPoint`). A positive-height rect that
    // overlaps the default jsdom `window.innerHeight` (768) is enough.
    const rectSpy = vi
      .spyOn(HTMLElement.prototype, "getBoundingClientRect")
      .mockReturnValue({
        x: 0,
        y: 0,
        top: 0,
        left: 0,
        right: 800,
        bottom: 600,
        width: 800,
        height: 600,
        toJSON: () => ({}),
      } as DOMRect);

    // Spy through to the `setup.ts` stub so we can assert the hit-test
    // path was genuinely exercised (not silently skipped).
    const efpSpy = vi.spyOn(document, "elementFromPoint");

    const host = document.createElement("div");
    document.body.appendChild(host);

    let editor: Editor | undefined;
    expect(() => {
      editor = new Editor({
        element: host,
        extensions: [
          StarterKit,
          Placeholder.configure({ placeholder: "Start writing…" }),
        ],
        content: "<p>Hello</p>",
      });
    }).not.toThrow();

    if (editor) liveEditors.push(editor);

    // The viewport computation ran and reached the DOM hit-test, so the
    // jsdom stub (not a real `elementFromPoint`) is what kept it alive.
    expect(efpSpy).toHaveBeenCalled();
    expect(editor?.getText()).toContain("Hello");

    rectSpy.mockRestore();
    document.body.removeChild(host);
  });
});
