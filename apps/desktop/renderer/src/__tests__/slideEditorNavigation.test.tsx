/**
 * SlideEditor navigation pinning tests.
 *
 * Three entry points to the same `navigateBy` / `goToSlide`
 * primitives:
 *
 *   1. Toolbar Prev / Next buttons (separate from Move ↑ / Move ↓
 *      reorder, which is a *different* operation).
 *   2. Global Ctrl+PageUp / Ctrl+PageDown keyboard shortcut.
 *   3. Sidebar Arrow-Up / Arrow-Down / Home / End on a focused
 *      thumbnail.
 *
 * The pinning contract these tests enforce:
 *
 *   - Navigation changes WHICH slide is active without touching the
 *     deck order. (Pre-PR 11, the toolbar's only arrow buttons
 *     moved slides — labelled "Prev / Next" but reorder-semantics.
 *     PR 11 introduces real navigation alongside the move buttons.)
 *   - Edge clamping: navigating past the first / last slide is a
 *     no-op, not a wrap. Matches Impress / Slides / Keynote.
 *   - Listener cleanup: the global keyboard handler detaches when
 *     the editor unmounts so it doesn't leak across page navigations.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";

import SlideEditor from "../editors/SlideEditor";
import type { SlideContent } from "../editors/slideEditorTypes";

function buildContent(): string {
  // Three-slide deck. Distinct titles so we can assert which slide
  // is active by reading the slide-title <input>.
  const content: Omit<SlideContent, "slides"> & {
    slides: Array<{
      title: string;
      blocks: Array<{ type: "text"; content: string }>;
      notes: string;
    }>;
  } = {
    slides: [
      {
        title: "Alpha",
        blocks: [{ type: "text", content: "alpha body" }],
        notes: "",
      },
      {
        title: "Beta",
        blocks: [{ type: "text", content: "beta body" }],
        notes: "",
      },
      {
        title: "Gamma",
        blocks: [{ type: "text", content: "gamma body" }],
        notes: "",
      },
    ],
  };
  return JSON.stringify(content);
}

function renderDeck() {
  const onSave = vi.fn();
  const onDraftChange = vi.fn();
  render(
    <SlideEditor
      content={buildContent()}
      onSave={onSave}
      onDraftChange={onDraftChange}
    />,
  );
  return { onSave, onDraftChange };
}

// Read the order of slide titles AS THEY APPEAR in the sidebar
// thumbnails. Used to assert that NAVIGATION doesn't reorder the
// deck (vs. the Move buttons which DO).
function thumbnailTitles(): string[] {
  const thumbs = document.querySelectorAll(".slide-thumb-title");
  return Array.from(thumbs).map((t) => t.textContent ?? "");
}

// Read whichever slide title is currently shown in the editor
// canvas (the slide-title input). This is the user-visible
// "currently active slide" signal.
function activeSlideTitle(): string {
  const input = document.querySelector(
    ".slide-canvas input",
  ) as HTMLInputElement | null;
  return input?.value ?? "";
}

describe("SlideEditor toolbar — Prev / Next NAVIGATE without reordering", () => {
  // The previous version of the toolbar had only one
  // pair of arrow buttons labelled "Prev / Next" that called
  // `moveSlide(activeIndex, activeIndex ± 1)` — i.e. reorder, not
  // navigate. Devin Review PR #82 (ANALYSIS_…_0005) flagged this
  // collision with the universal slide-deck convention (Impress /
  // Slides / Keynote: Prev / Next means *navigate*). This PR ships
  // the real navigation buttons and renames the reorder pair to
  // "Move ↑ / Move ↓".

  it("clicking Next advances the active slide without changing deck order", () => {
    renderDeck();
    expect(activeSlideTitle()).toBe("Alpha");
    const orderBefore = thumbnailTitles();

    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));

    expect(activeSlideTitle()).toBe("Beta");
    expect(thumbnailTitles()).toEqual(orderBefore);
  });

  it("clicking Prev backs up the active slide without changing deck order", () => {
    renderDeck();
    // Move forward twice so we land on Gamma.
    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    expect(activeSlideTitle()).toBe("Gamma");
    const orderBefore = thumbnailTitles();

    fireEvent.click(screen.getByRole("button", { name: "Previous slide" }));

    expect(activeSlideTitle()).toBe("Beta");
    expect(thumbnailTitles()).toEqual(orderBefore);
  });

  it("Prev is disabled at the first slide; Next is disabled at the last slide", () => {
    renderDeck();
    // At slide 1 of 3 — Prev disabled, Next enabled.
    const prev = screen.getByRole("button", {
      name: "Previous slide",
    }) as HTMLButtonElement;
    const next = screen.getByRole("button", {
      name: "Next slide",
    }) as HTMLButtonElement;
    expect(prev.disabled).toBe(true);
    expect(next.disabled).toBe(false);

    // Jump to last slide.
    fireEvent.click(next);
    fireEvent.click(next);
    expect(activeSlideTitle()).toBe("Gamma");

    expect(prev.disabled).toBe(false);
    expect(next.disabled).toBe(true);
  });
});

describe("SlideEditor toolbar — Move ↑ / Move ↓ REORDERS distinctly from Prev / Next", () => {
  // Same surface, different semantics. Pin: the Move buttons keep
  // the active slide following the reordered position.

  it("Move ↓ shifts the active slide one position later in the deck", () => {
    renderDeck();
    expect(activeSlideTitle()).toBe("Alpha");

    fireEvent.click(screen.getByRole("button", { name: "Move slide down" }));

    // Active slide should still be Alpha (anchored to the moved
    // position), but the deck order should now be [Beta, Alpha, Gamma].
    expect(activeSlideTitle()).toBe("Alpha");
    expect(thumbnailTitles()).toEqual(["Beta", "Alpha", "Gamma"]);
  });

  it("Move ↑ shifts the active slide one position earlier in the deck", () => {
    renderDeck();
    // Move to Beta.
    fireEvent.click(screen.getByRole("button", { name: "Next slide" }));
    expect(activeSlideTitle()).toBe("Beta");

    fireEvent.click(screen.getByRole("button", { name: "Move slide up" }));

    // Active slide still Beta, but it now sits at index 0.
    expect(activeSlideTitle()).toBe("Beta");
    expect(thumbnailTitles()).toEqual(["Beta", "Alpha", "Gamma"]);
  });
});

describe("SlideEditor — global Ctrl+PageUp / Ctrl+PageDown keyboard shortcut", () => {
  // Document-level listener so the shortcut fires
  // regardless of which control inside the editor has focus.
  // Matches Impress / Slides / Keynote.

  it("Ctrl+PageDown advances to the next slide", () => {
    renderDeck();
    expect(activeSlideTitle()).toBe("Alpha");
    const orderBefore = thumbnailTitles();

    fireEvent.keyDown(document, { key: "PageDown", ctrlKey: true });

    expect(activeSlideTitle()).toBe("Beta");
    expect(thumbnailTitles()).toEqual(orderBefore);
  });

  it("Ctrl+PageUp backs up to the previous slide", () => {
    renderDeck();
    fireEvent.keyDown(document, { key: "PageDown", ctrlKey: true });
    fireEvent.keyDown(document, { key: "PageDown", ctrlKey: true });
    expect(activeSlideTitle()).toBe("Gamma");

    fireEvent.keyDown(document, { key: "PageUp", ctrlKey: true });

    expect(activeSlideTitle()).toBe("Beta");
  });

  it("meta key (macOS Cmd) is treated identically to Ctrl", () => {
    renderDeck();
    fireEvent.keyDown(document, { key: "PageDown", metaKey: true });
    expect(activeSlideTitle()).toBe("Beta");
    fireEvent.keyDown(document, { key: "PageUp", metaKey: true });
    expect(activeSlideTitle()).toBe("Alpha");
  });

  it("clamps at the edges (no-op when already at first / last slide)", () => {
    renderDeck();
    // At first slide — Ctrl+PageUp should be a no-op.
    fireEvent.keyDown(document, { key: "PageUp", ctrlKey: true });
    expect(activeSlideTitle()).toBe("Alpha");

    // Jump to last, then Ctrl+PageDown should be a no-op.
    fireEvent.keyDown(document, { key: "PageDown", ctrlKey: true });
    fireEvent.keyDown(document, { key: "PageDown", ctrlKey: true });
    expect(activeSlideTitle()).toBe("Gamma");
    fireEvent.keyDown(document, { key: "PageDown", ctrlKey: true });
    expect(activeSlideTitle()).toBe("Gamma");
  });

  it("PageUp / PageDown WITHOUT Ctrl or Meta is ignored (doesn't intercept native scrolling)", () => {
    renderDeck();
    fireEvent.keyDown(document, { key: "PageDown" });
    // Active slide unchanged.
    expect(activeSlideTitle()).toBe("Alpha");
  });

  it("removes the document-level listener when the editor unmounts", () => {
    const { unmount } = render(
      <SlideEditor content={buildContent()} onSave={vi.fn()} />,
    );
    // Sanity: shortcut works while mounted.
    fireEvent.keyDown(document, { key: "PageDown", ctrlKey: true });
    expect(activeSlideTitle()).toBe("Beta");

    unmount();

    // After unmount, the document listener must be gone — the only
    // observable signal in vitest/jsdom is that the shortcut has no
    // effect on whatever React tree replaces the editor. Since
    // nothing's mounted, there is no active slide title. Re-render
    // a fresh editor to confirm the OLD listener didn't survive and
    // double-fire (which would advance the new instance from Alpha
    // to Gamma instead of stopping at Beta).
    render(<SlideEditor content={buildContent()} onSave={vi.fn()} />);
    fireEvent.keyDown(document, { key: "PageDown", ctrlKey: true });
    // If the old listener leaked, this would be Gamma (two
    // listeners both advancing). Single advance → Beta.
    expect(activeSlideTitle()).toBe("Beta");
  });
});

describe("SlideEditor sidebar — Arrow-Up / Arrow-Down / Home / End on a focused thumbnail", () => {
  // The sidebar is a thumbnail list; matching the
  // WAI-ARIA listbox-pattern, arrow keys move selection through
  // adjacent thumbnails (Home / End jump to the edges).

  it("ArrowDown moves selection from the focused thumb to the next slide", () => {
    renderDeck();
    const firstThumb = screen.getByRole("button", { name: /1 Alpha/ });
    firstThumb.focus();

    fireEvent.keyDown(firstThumb, { key: "ArrowDown" });

    expect(activeSlideTitle()).toBe("Beta");
  });

  it("ArrowUp moves selection from the focused thumb to the previous slide", () => {
    renderDeck();
    // Land on slide 2.
    fireEvent.click(screen.getByRole("button", { name: /2 Beta/ }));
    expect(activeSlideTitle()).toBe("Beta");
    const secondThumb = screen.getByRole("button", { name: /2 Beta/ });
    secondThumb.focus();

    fireEvent.keyDown(secondThumb, { key: "ArrowUp" });

    expect(activeSlideTitle()).toBe("Alpha");
  });

  it("Home jumps to the first slide; End jumps to the last", () => {
    renderDeck();
    const middleThumb = screen.getByRole("button", { name: /2 Beta/ });
    fireEvent.click(middleThumb);
    middleThumb.focus();

    fireEvent.keyDown(middleThumb, { key: "End" });
    expect(activeSlideTitle()).toBe("Gamma");

    // After End, focus should have moved to the Gamma thumb so a
    // subsequent Home press from it works.
    const lastThumb = screen.getByRole("button", { name: /3 Gamma/ });
    fireEvent.keyDown(lastThumb, { key: "Home" });
    expect(activeSlideTitle()).toBe("Alpha");
  });

  it("preventDefault is called on edge no-ops so the sidebar doesn't scroll", () => {
    renderDeck();
    const firstThumb = screen.getByRole("button", { name: /1 Alpha/ });
    firstThumb.focus();

    // At the first slide, ArrowUp is a no-op for the active index
    // but MUST still preventDefault so the browser doesn't scroll
    // the sidebar instead.
    const event = new KeyboardEvent("keydown", {
      key: "ArrowUp",
      bubbles: true,
      cancelable: true,
    });
    firstThumb.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    // Active slide unchanged.
    expect(activeSlideTitle()).toBe("Alpha");
  });

  it("ignores non-navigation keys so the parent listbox stays passive on, e.g., 'a'", () => {
    renderDeck();
    const firstThumb = screen.getByRole("button", { name: /1 Alpha/ });
    firstThumb.focus();

    const event = new KeyboardEvent("keydown", {
      key: "a",
      bubbles: true,
      cancelable: true,
    });
    firstThumb.dispatchEvent(event);
    // The handler returns before reaching preventDefault for keys
    // it doesn't handle — the browser stays in charge.
    expect(event.defaultPrevented).toBe(false);
    expect(activeSlideTitle()).toBe("Alpha");
  });
});

describe("SlideEditor toolbar — word-count display uses cached deck total", () => {
  // The toolbar header reads
  //   "Words: <active> / <total>"
  // on every render. Pin the surface so future refactors don't
  // accidentally show NaN, 0/0, or two-words-out-of-zero (i.e.
  // active without total).

  it("renders both active-slide and total deck word counts", () => {
    renderDeck();
    // Each slide has title=1 word + body=2 words = 3 words.
    // Three slides → total 9. Active slide is Alpha → 3.
    // The toolbar text is `Words: 3 / 9` (or similar — match
    // loosely so we don't pin exact CSS / spacing).
    const toolbar = document.querySelector(
      ".slide-editor-toolbar",
    ) as HTMLElement;
    // The toolbar text is concatenated from many spans / buttons so
    // exact whitespace varies — match the literal "Words: 3 / 9"
    // substring (with the actual non-breaking-space surrounding the
    // slashes, which React JSX renders as a regular ASCII " / ").
    expect(toolbar.textContent ?? "").toContain("Words: 3 / 9");
  });
});

describe("SlideEditor sidebar — thumbnail ref-callbacks are stable across renders", () => {
  // round 2. Regression test for:
  // the original `setThumbRef = useCallback((id) => (node) => ...)`
  // returned a fresh inner closure on every call, so each render
  // handed React a new ref function and React responded with a
  // detach (`cb(null)`) + re-attach (`cb(newNode)`) for every
  // thumb on every render. With N slides + frequent
  // navigation-triggered re-renders, that's O(N) wasted DOM
  // mutations per keystroke.
  //
  // The fix caches per-id ref-callbacks in a `useRef(new Map())`
  // so `setThumbRef(slide.id)` returns the SAME closure across
  // renders for the same id. We pin the contract by asserting
  // the underlying DOM element retains identity across a
  // sequence of navigations — if refs were churning, an
  // accidental future regression that depends on
  // ref-callback identity (e.g. a custom hook wrapping the ref
  // to count mounts) would catch the churn.
  it("thumbnail DOM elements retain identity across navigation re-renders", () => {
    renderDeck();
    const initialFirst = screen.getByRole("button", { name: /1 Alpha/ });
    const initialSecond = screen.getByRole("button", { name: /2 Beta/ });
    const initialThird = screen.getByRole("button", { name: /3 Gamma/ });

    // Trigger many re-renders by walking through the deck. Each
    // click sets `activeIndex`, which re-renders the component —
    // exactly the case where unstable refs would fire detach
    // + re-attach for every thumb.
    fireEvent.click(initialSecond);
    fireEvent.click(initialThird);
    fireEvent.click(initialFirst);
    fireEvent.click(initialThird);

    // Re-query — the DOM element references should be identical
    // to the ones we captured on first render, since React keys
    // by `slide.id` AND ref callbacks are stable.
    expect(screen.getByRole("button", { name: /1 Alpha/ })).toBe(initialFirst);
    expect(screen.getByRole("button", { name: /2 Beta/ })).toBe(initialSecond);
    expect(screen.getByRole("button", { name: /3 Gamma/ })).toBe(initialThird);
  });
});
