/**
 * IPC handlers for the `slides:*` channels (presenter mode).
 *
 * `slides:startPresentation` opens two frameless-ish windows from a
 * single self-contained HTML document written to a temp file:
 *
 *   - an **audience** window (fullscreen) showing the current slide, and
 *   - a **presenter** window showing the current slide, the next slide,
 *     a slide counter, and the speaker notes.
 *
 * Both windows load the *same* file (differing only by URL hash —
 * `#audience` vs `#presenter`) under a dedicated session partition.
 * Sharing an origin + partition lets them stay in sync purely through
 * `localStorage` + the `storage` event: advancing the slide in either
 * window writes the new index, and the other window's `storage`
 * listener re-renders. No further IPC is needed once the windows exist,
 * which keeps the main-process surface to this single channel.
 *
 * Each `startPresentation` call mints a *unique* `localStorage` key
 * (embedded in its generated file) so two presentations open at the
 * same time — which share the persistent partition — never cross-talk:
 * a window only reads/writes, and only reacts to `storage` events for,
 * its own key.
 *
 * The deck content is *plain text*. The generated page renders every
 * user string through `textContent`, never `innerHTML`, so a slide can
 * never inject markup or script into the presentation windows. The
 * embedded deck JSON is additionally `<`/`&`-escaped so it cannot break
 * out of its `<script type="application/json">` container.
 *
 * The presentation windows deliberately run on their own session
 * partition (`PRESENTATION_PARTITION`) so they do NOT inherit the main
 * window's preload bridge — they are inert, self-contained viewers with
 * no access to `window.tessera` or Node.
 */
import { app, BrowserWindow } from "electron";
import { mkdirSync, unlinkSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { idempotentHandle } from "./register";
import { StartPresentationSchema } from "./schemas";
import type { StartPresentationInput } from "./schemas";

/**
 * Dedicated session partition for the presentation windows. Persistent
 * (no `temp:` prefix) so the two windows opened by one call share a
 * `localStorage` namespace and can sync via `storage` events.
 */
export const PRESENTATION_PARTITION = "persist:tessera-presentation";

/**
 * Prefix for the `localStorage` key the two windows use to broadcast
 * the live index. The actual key is per-presentation
 * (`presentationIndexKey`) so concurrent presentations stay isolated.
 */
export const PRESENTATION_INDEX_KEY = "tessera:presentation:index";

/**
 * Per-presentation `localStorage` key. The two windows of ONE
 * presentation load the same generated file and therefore share this
 * key, but every `startPresentation` call passes a fresh token so two
 * presentations open at once (same partition) never cross-talk — each
 * window only reads/writes, and only reacts to `storage` events for,
 * its own key.
 */
export function presentationIndexKey(token: string): string {
  return `${PRESENTATION_INDEX_KEY}:${token}`;
}

/**
 * Escape a JSON string for safe inlining inside a `<script>` element.
 * Prevents `</script>` (and the U+2028/U+2029 line separators that are
 * legal in JSON but illegal in JS string literals) from terminating or
 * corrupting the surrounding script context.
 */
export function escapeJsonForScript(json: string): string {
  return json
    .replace(/</g, "\\u003c")
    .replace(/>/g, "\\u003e")
    .replace(/&/g, "\\u0026")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/** Normalised, range-checked payload used to build the HTML document. */
export interface NormalizedPresentation {
  slides: StartPresentationInput["slides"];
  startIndex: number;
  deckTitle: string;
}

/**
 * Clamp/validate the parsed payload into the shape the HTML builder
 * expects: a non-negative start index inside `[0, slides.length - 1]`
 * and a non-empty deck title.
 */
export function normalizePresentation(
  input: StartPresentationInput,
): NormalizedPresentation {
  const slideCount = input.slides.length;
  const startIndex =
    slideCount === 0 ? 0 : Math.min(input.startIndex, slideCount - 1);
  return {
    slides: input.slides,
    startIndex,
    deckTitle: input.deckTitle?.trim() ? input.deckTitle.trim() : "Presentation",
  };
}

/**
 * Build the self-contained presentation HTML document. Pure (no
 * Electron / filesystem access) so it can be unit-tested directly.
 */
export function buildPresentationHtml(
  deck: NormalizedPresentation,
  indexKey: string = PRESENTATION_INDEX_KEY,
): string {
  const data = escapeJsonForScript(
    JSON.stringify({
      slides: deck.slides,
      startIndex: deck.startIndex,
      deckTitle: deck.deckTitle,
    }),
  );
  // The runtime script is kept dependency-free and uses textContent
  // exclusively so no embedded deck string is ever parsed as HTML.
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8" />
<meta name="viewport" content="width=device-width, initial-scale=1" />
<title>${escapeHtml(deck.deckTitle)}</title>
<style>
  :root { color-scheme: dark; }
  * { box-sizing: border-box; }
  html, body { margin: 0; height: 100%; }
  body {
    font-family: system-ui, -apple-system, "Segoe UI", Roboto, sans-serif;
    background: #0b0b0d; color: #f5f5f7;
  }
  .stage { display: flex; flex-direction: column; height: 100vh; }
  .audience .notes-pane, .audience .next-pane, .audience .bar { display: none; }
  .slide {
    flex: 1; display: flex; flex-direction: column; justify-content: center;
    padding: 6vmin; gap: 3vmin; overflow: hidden;
  }
  .slide h1 { font-size: 6vmin; margin: 0; line-height: 1.1; }
  .slide ul { font-size: 3.4vmin; margin: 0; padding-left: 1.2em; line-height: 1.5; }
  .slide li { margin: 0.3em 0; }
  .bar {
    display: flex; align-items: center; gap: 1rem; padding: 0.75rem 1.25rem;
    background: #16161a; border-top: 1px solid #2a2a30; font-size: 0.9rem;
  }
  .bar .counter { font-variant-numeric: tabular-nums; }
  .bar .clock { margin-left: auto; font-variant-numeric: tabular-nums; }
  .next-pane, .notes-pane {
    padding: 1rem 1.25rem; border-top: 1px solid #2a2a30; background: #101014;
  }
  .pane-label {
    text-transform: uppercase; letter-spacing: 0.08em; font-size: 0.7rem;
    color: #9a9aa2; margin: 0 0 0.4rem;
  }
  .next-pane h2 { font-size: 1.1rem; margin: 0 0 0.25rem; }
  .next-pane ul { margin: 0; padding-left: 1.2em; color: #c7c7cf; font-size: 0.9rem; }
  .notes-pane .notes { white-space: pre-wrap; font-size: 1rem; line-height: 1.5; }
  .empty { color: #6b6b73; font-style: italic; }
</style>
</head>
<body>
<div class="stage" id="stage">
  <section class="slide" aria-live="polite">
    <h1 id="title"></h1>
    <ul id="body"></ul>
  </section>
  <section class="next-pane">
    <p class="pane-label">Next</p>
    <h2 id="next-title"></h2>
    <ul id="next-body"></ul>
  </section>
  <section class="notes-pane">
    <p class="pane-label">Speaker notes</p>
    <div class="notes" id="notes"></div>
  </section>
  <div class="bar">
    <span class="counter"><span id="pos"></span> / <span id="total"></span></span>
    <span id="role-label"></span>
    <span class="clock" id="clock"></span>
  </div>
</div>
<script type="application/json" id="deck-data">${data}</script>
<script>
(function () {
  var deck = JSON.parse(document.getElementById("deck-data").textContent);
  var slides = Array.isArray(deck.slides) ? deck.slides : [];
  var total = slides.length;
  var KEY = ${JSON.stringify(indexKey)};
  var role = location.hash.replace("#", "") === "presenter" ? "presenter" : "audience";
  document.body.classList.add(role);
  document.getElementById("role-label").textContent =
    role === "presenter" ? "Presenter view" : "";

  function clamp(i) { return Math.max(0, Math.min(total - 1, i)); }
  // localStorage is the cross-window sync channel, but it can be
  // unavailable for a file:// origin (or throw in locked-down
  // contexts). Guard every access and keep a per-window fallback so a
  // window still renders and navigates on its own; only live sync
  // between the two windows is lost when storage is unavailable.
  var memIndex = clamp(deck.startIndex || 0);
  function storageGet() {
    try { return window.localStorage.getItem(KEY); } catch (e) { return null; }
  }
  function storageSet(v) {
    try { window.localStorage.setItem(KEY, v); } catch (e) { /* fall back to memIndex */ }
  }
  function readIndex() {
    var stored = storageGet();
    var raw = parseInt(stored === null ? "" : stored, 10);
    return isNaN(raw) ? clamp(memIndex) : clamp(raw);
  }
  function writeIndex(i) {
    memIndex = clamp(i);
    storageSet(String(memIndex));
  }

  function fillBullets(ul, lines) {
    ul.textContent = "";
    (lines || []).forEach(function (line) {
      if (String(line).length === 0) return;
      var li = document.createElement("li");
      li.textContent = line;
      ul.appendChild(li);
    });
  }

  function render() {
    var i = readIndex();
    var s = slides[i] || { title: "", lines: [], notes: "" };
    document.getElementById("title").textContent = s.title || "";
    fillBullets(document.getElementById("body"), s.lines);
    document.getElementById("pos").textContent = total === 0 ? "0" : String(i + 1);
    document.getElementById("total").textContent = String(total);

    var next = slides[i + 1];
    var nextTitle = document.getElementById("next-title");
    var nextBody = document.getElementById("next-body");
    if (next) {
      nextTitle.textContent = next.title || "(untitled)";
      fillBullets(nextBody, next.lines);
    } else {
      nextTitle.textContent = "End of deck";
      nextBody.textContent = "";
    }

    var notes = document.getElementById("notes");
    if (s.notes && String(s.notes).trim().length > 0) {
      notes.textContent = s.notes;
      notes.classList.remove("empty");
    } else {
      notes.textContent = "No notes for this slide.";
      notes.classList.add("empty");
    }
  }

  function go(delta) { writeIndex(readIndex() + delta); render(); }

  if (storageGet() === null) writeIndex(deck.startIndex || 0);

  window.addEventListener("keydown", function (e) {
    if (e.key === "ArrowRight" || e.key === "PageDown" || e.key === " ") {
      e.preventDefault(); go(1);
    } else if (e.key === "ArrowLeft" || e.key === "PageUp") {
      e.preventDefault(); go(-1);
    } else if (e.key === "Home") {
      e.preventDefault(); writeIndex(0); render();
    } else if (e.key === "End") {
      e.preventDefault(); writeIndex(total - 1); render();
    } else if (e.key === "Escape") {
      window.close();
    }
  });
  window.addEventListener("storage", function (e) {
    if (e.key === KEY) render();
  });

  var clock = document.getElementById("clock");
  function tick() {
    var d = new Date();
    clock.textContent = d.toLocaleTimeString();
  }
  tick();
  setInterval(tick, 1000);

  render();
})();
</script>
</body>
</html>`;
}

/** Minimal HTML-escape for the few values placed in element text/attrs. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

/** App temp dir, falling back to the OS temp dir when `app` is absent. */
function presentationTempDir(): string {
  let base: string;
  try {
    base = app.getPath("temp");
  } catch {
    base = os.tmpdir();
  }
  return path.join(base, "tessera-presentation");
}

export function registerSlidesHandlers(): void {
  idempotentHandle(
    "slides:startPresentation",
    async (_event, request: unknown) => {
      const parsed = StartPresentationSchema.parse(request ?? {});
      const deck = normalizePresentation(parsed);
      const slideCount = deck.slides.length;
      if (slideCount === 0) {
        return { ok: false, slideCount: 0 };
      }

      // One token per presentation, reused for both the temp file name
      // and the localStorage key, so a presentation's two windows share
      // state while distinct presentations stay isolated even on the
      // shared persistent partition.
      const token = `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
      const html = buildPresentationHtml(deck, presentationIndexKey(token));
      const dir = presentationTempDir();
      mkdirSync(dir, { recursive: true });
      const file = path.join(dir, `deck-${token}.html`);
      writeFileSync(file, html, "utf-8");

      const webPreferences: Electron.WebPreferences = {
        partition: PRESENTATION_PARTITION,
        contextIsolation: true,
        nodeIntegration: false,
        sandbox: true,
      };

      const audience = new BrowserWindow({
        fullscreen: true,
        backgroundColor: "#0b0b0d",
        title: deck.deckTitle,
        webPreferences,
      });
      await audience.loadFile(file, { hash: "audience" });

      const presenter = new BrowserWindow({
        width: 960,
        height: 720,
        backgroundColor: "#0b0b0d",
        title: `${deck.deckTitle} — Presenter`,
        webPreferences,
      });
      await presenter.loadFile(file, { hash: "presenter" });

      // Closing either window tears down the other so the user is never
      // left with an orphaned half of the presentation. Once both are
      // gone, the generated temp file is no longer needed, so remove it
      // (best-effort) to avoid leaking a file per presentation.
      let closedCount = 0;
      const onClosed = () => {
        if (!audience.isDestroyed()) audience.close();
        if (!presenter.isDestroyed()) presenter.close();
        closedCount += 1;
        if (closedCount >= 2) {
          try {
            unlinkSync(file);
          } catch {
            /* best-effort temp cleanup */
          }
        }
      };
      audience.on("closed", onClosed);
      presenter.on("closed", onClosed);

      return { ok: true, slideCount };
    },
  );
}
