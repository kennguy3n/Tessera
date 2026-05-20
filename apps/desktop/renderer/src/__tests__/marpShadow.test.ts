import { describe, it, expect } from "vitest";
import { applyMarpToShadow } from "../editors/SlideEditor";

function makeShadow(): ShadowRoot {
  const host = document.createElement("div");
  return host.attachShadow({ mode: "open" });
}

describe("applyMarpToShadow", () => {
  it("renders the slide HTML inside a .marp-preview-deck container", () => {
    const shadow = makeShadow();
    applyMarpToShadow(shadow, "<section>Slide 1</section>", "body{color:red}");
    const deck = shadow.querySelector(".marp-preview-deck");
    expect(deck).not.toBeNull();
    expect(deck!.innerHTML).toContain("Slide 1");
  });

  it(
    "does not allow a `</style>` substring in user CSS to break out of the " +
      "stylesheet and inject live HTML into the shadow root",
    () => {
      const shadow = makeShadow();
      // Worst-case payload: a `</style>` literal followed by an HTML element
      // and a script — if the CSS were dropped into a `<style>` tag via
      // innerHTML, the HTML parser would close the stylesheet early and
      // parse `<img src=x onerror=... >` and `<script>` as live nodes.
      const maliciousCss =
        ".x::after { content: '</style><img src=x onerror=window.__pwned=1><script>window.__pwned2=1</script>'; }";
      applyMarpToShadow(shadow, "<section>Body</section>", maliciousCss);

      // The injected `<img>` and `<script>` must NOT appear as real elements
      // anywhere inside the shadow tree.
      expect(shadow.querySelector("img")).toBeNull();
      expect(shadow.querySelector("script")).toBeNull();

      // And the fallback `<style>` element (if used) must not contain a raw
      // `</style` substring that a future innerHTML round-trip could
      // re-enable.
      const styleEl = shadow.querySelector("style[data-marp-fallback]");
      if (styleEl) {
        expect(styleEl.textContent).not.toMatch(/<\/style/i);
      }

      // The slide body must still render.
      const deck = shadow.querySelector(".marp-preview-deck");
      expect(deck?.textContent).toContain("Body");
    },
  );

  it("is idempotent across repeated calls (re-uses the same deck element)", () => {
    const shadow = makeShadow();
    applyMarpToShadow(shadow, "<section>First</section>", "body{color:red}");
    const firstDeck = shadow.querySelector(".marp-preview-deck");
    expect(firstDeck?.textContent).toContain("First");

    applyMarpToShadow(shadow, "<section>Second</section>", "body{color:blue}");
    const secondDeck = shadow.querySelector(".marp-preview-deck");
    expect(secondDeck).toBe(firstDeck);
    expect(secondDeck?.textContent).toContain("Second");
    expect(secondDeck?.textContent).not.toContain("First");

    // Exactly one deck node — we never duplicate.
    expect(shadow.querySelectorAll(".marp-preview-deck")).toHaveLength(1);
  });
});
