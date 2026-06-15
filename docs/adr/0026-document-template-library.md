# 26. Document template library — in-editor gallery, user templates, and portable files

## Status

Accepted. Brings the slide template arc
([0020](0020-slide-template-library.md),
[0023](0023-slide-user-templates.md)) to the **Document** editor: an
in-editor template gallery, user-authored ("Save as template") templates
persisted in the renderer, and a portable single-template file. Reuses
the renderer-only persisted-store + `useSyncExternalStore` hook pattern
established for custom Skills ([0013](0013-user-authored-skills.md)),
their portable file ([0018](0018-skill-export-import.md)), and the slide
user-template work it most closely mirrors
([0023](0023-slide-user-templates.md)). Renderer-only; no IPC, Rust, or
schema change.

## Context

The Document editor (`editors/DocumentEditor.tsx`) is a TipTap editor
whose content is an **HTML string** — the exact shape `editor.getHTML()`
emits and `setContent` / `insertContent` consume. Unlike Slides, it had
no in-editor template gallery and no way to save or reuse a document as a
template: a starter could only be picked once, at Create time. A user who
had written a good meeting-notes or PRD layout could not re-apply it, and
the editor shipped no curated document starters at all.

The slide work already solved the hard parts in this codebase, and the
shapes carry over almost directly:

1. **A built-in catalogue as stateless metadata.**
   `slideTemplates.ts` lists built-in templates by category, filtered by
   a pure `filterSlideTemplates`. The document analogue is a catalogue of
   professional HTML starters (meeting notes, PRD, status report, SOP,
   one-pager, decision record, project plan, retro, …).
2. **A versioned, defensive `localStorage` store + a shared hook.**
   `customSlideTemplates.ts` / `useCustomSlideTemplates.ts` persist a
   `{ version, templates }` envelope behind `useSyncExternalStore`, so a
   mutation in one editor is reflected everywhere and a corrupt blob never
   throws.
3. **A portable, single-item file.**
   [0018](0018-skill-export-import.md) / [0023](0023-slide-user-templates.md)
   established the `{ format, version, <item> }` envelope (distinct from
   the store envelope, versioned independently), a hardened version guard,
   and **non-destructive import** — the file's id is always dropped and a
   fresh one minted so an import can never overwrite an existing item.

What was missing was the document-domain analogue of each: a model that
captures a document's HTML (not a metadata skeleton), a store for it, the
"Save as template" UX wired into the TipTap toolbar, and a portable file.
This is purely a renderer concern.

Two hazards shape the design. First, **identity**, as in
[0018](0018-skill-export-import.md): the store keys templates by a
custom-namespaced id (`doctpl-…`); an imported file that kept its id could
silently overwrite a different template, and a non-`doctpl-` id could
shadow a built-in (`doc-…`). Import must always mint a fresh id. Second,
**preview safety**: a document's content is raw HTML, and the renderer
has no HTML sanitizer (no DOMPurify, no `dangerouslySetInnerHTML`
anywhere). A gallery preview must therefore never inject stored HTML into
the DOM.

## Decision

Add `editors/documentTemplates.ts` (built-in catalogue + filter + preview
helper), `editors/customDocumentTemplates.ts` (model + store + portable
file), `editors/useCustomDocumentTemplates.ts` (shared hook), the
`editors/components/DocumentTemplateGallery.tsx` /
`DocumentTemplateSaveModal.tsx` UI, and the toolbar wiring in
`DocumentEditor.tsx`. Everything is additive and renderer-only.

**Built-in catalogue.** `documentTemplates.ts` is pure, side-effect-free
metadata (mirrors `slideTemplates.ts`): a closed `DocumentTemplateCategory`
union, a `DOCUMENT_TEMPLATES` array of
`{ id, label, description, icon, category?, content }`, and a pure
`filterDocumentTemplates<T extends FilterableDocumentTemplate>` generalised
so it filters built-in **or** user templates with one code path. Each
`content` is authored as TipTap-insertable HTML using only schema-supported
nodes (headings, paragraphs, bullet/ordered/task lists, blockquotes,
tables); task lists use the canonical `ul[data-type="taskList"]` /
`li[data-type="taskItem"]` shape and table cells wrap their text in a
paragraph to satisfy the `block+` schema, so every node round-trips through
the editor's parser unchanged.

**Model (`CustomDocumentTemplate`).** A user template captures the saved
document plus gallery metadata:
`{ id, label, description?, category?, content: string }`, where `content`
is the HTML `editor.getHTML()` persists. The shape is flat and
JSON-serialisable so a future bundle can embed a
`templates?: CustomDocumentTemplate[]` array without coupling to this
module.

**One validation gate.** Every persisted / imported template flows through
`buildCustomDocumentTemplate(draft)`, which collapses + length-bounds the
label (rejecting an empty name), drops a blank description, coerces an
unknown `category` to undefined ("All"), and — crucially — routes the
embedded HTML through `normalizeDocumentTemplateContent`, which wraps the
editor's own `parseDocumentContent`. A non-string content degrades to the
parser's empty document rather than stuffing a raw blob into the editor.
The HTML is then re-parsed by TipTap's schema on insert, which strips any
node or attribute the schema disallows — the same mechanism that protects
every other content path in the editor — so a hand-edited or corrupt blob
can never inject markup the editor wouldn't itself emit, and a stored
template can never be less well-formed than one authored in the UI.

**Persisted store + hook.** A `{ version, templates }` envelope at
`tessera.doctemplates.custom`. `parseCustomDocumentTemplateStore` never
throws: bad JSON, a wrong `SCHEMA_VERSION`, or a non-array `templates`
degrade to "nothing stored"; individually-malformed, duplicate-id, and
foreign-id (non-`doctpl-`) entries are dropped; the list is capped at
`MAX_CUSTOM_DOCUMENT_TEMPLATES` (50, oldest dropped on overflow).
`useCustomDocumentTemplates` mirrors `useCustomSlideTemplates`: a
module-level store read via `useSyncExternalStore` exposes
`customTemplates` plus `saveTemplate` / `deleteTemplate` /
`duplicateTemplate` / `templateById`, so a save in one editor updates
every open gallery.

**Gallery + insertion UX.** A "Templates" toolbar control opens
`DocumentTemplateGallery`, a searchable, category-filtered card grid. Each
card shows a **plain-text** excerpt of the body (`documentTemplatePreviewText`
strips tags with a non-evaluating regex and the result is rendered as a
React text node) — the preview is text, never markup, so a tampered
template can never inject into the gallery and there is no
`dangerouslySetInnerHTML`. Applying a built-in or user card inserts its
HTML into the document: an **empty** document is replaced wholesale (the
starter becomes the document); otherwise the content is inserted at the
cursor. The user's own templates appear in a "Your templates" section
above the built-in grid with Insert / Edit / Duplicate / Export / two-step
Delete. The gallery is the single hub for template actions (Save current,
Import); a sensible default that keeps the busy toolbar to one new control.

**Save as template — document or selection.** "Save current as template"
captures `editor.getHTML()` by default, or — when a non-empty selection
exists — just that selection, serialised to block-level HTML via
ProseMirror's `DOMSerializer` (a within-paragraph selection is wrapped in
a paragraph so the captured content stays block-level and
`parseDocumentContent` treats it as trusted rather than escaping it). The
capture opens `DocumentTemplateSaveModal`, a thin form over the shared
`Modal` for name / description / category. Capture logic lives in
`DocumentEditor.tsx` (which owns the editor); all validation and
normalisation stay pure in `customDocumentTemplates.ts`.

**Single active overlay.** The app's `useFocusTrap` documents a
one-overlay-at-a-time invariant (so a single Escape/Tab handler is live).
Save / Edit / Import are launched from _within_ the open gallery, so the
host closes the gallery before opening the modal and reopens it on close —
the user returns to the now-updated grid without ever stacking two focus
traps. The gallery's search box is the first focusable control so the
trap's deferred initial focus lands on it.

**Portable template file.** A `{ format: "tessera.doctemplate",
version: 1, template }` envelope, versioned independently of the store
`SCHEMA_VERSION`. `serializeDocumentTemplate` pretty-prints it and never
mutates the source; `documentTemplateFilename` derives a stable
`tessera-doc-template-<slug>.json` name. `parseDocumentTemplate(raw)` →
`{ ok: true, draft } | { ok: false, error }` never throws: it validates
the `format` tag, applies the hardened version guard (reject
non-numeric/non-integer/`< 1` — so `0`, `-1`, `0.5`, `NaN`, `Infinity` all
read as "not valid" — _then_ reject `> DOCUMENT_TEMPLATE_VERSION` as
"newer"), and routes the embedded HTML through the same
`normalizeDocumentTemplateContent` + `buildCustomDocumentTemplate` gate. It
builds the draft **without an id**, so saving mints a fresh `doctpl-` id
and an import is non-destructive. Export / Import controls live in the
gallery; Import drives a hidden `<input type="file" accept=".json">`,
reads the text, and on success opens the modal pre-filled
(review-then-save, like Duplicate); a rejected import shows an inline
`role="alert"` message and opens no modal.

## Consequences

- The Document editor ships a curated set of professional starters and an
  in-editor gallery to insert them (at the cursor, or replacing an empty
  document), reaching UX parity with the Slides editor.
- A user can save the current document — or just a selection — as a named,
  categorised template that appears in the gallery, re-apply it, and manage
  it (edit / duplicate / two-step delete).
- A template exports to a portable `tessera-doc-template-<slug>.json` that
  re-imports — in the same or a fresh session — as a new, non-overwriting
  template, because import always mints a fresh id.
- Imported and persisted data are held to the same bar as editor-authored
  content: both flow through `parseDocumentContent` +
  `buildCustomDocumentTemplate`, and TipTap re-parses on insert, so a
  malformed file or a corrupt store entry is rejected (or degraded) with no
  throw and nothing unexpected reaches the document.
- Preview is XSS-safe by construction: the gallery renders a plain-text
  excerpt, never stored HTML, so no sanitizer is introduced and the
  feature adds no `dangerouslySetInnerHTML` surface.
- The change is additive and legacy-safe: every new field is optional,
  existing documents are untouched, `filterDocumentTemplates` is pure, and
  there is **no `SCHEMA_VERSION` bump** — existing documents and any
  existing store load unchanged. The store envelope and the portable-file
  envelope are versioned independently so each can evolve alone.
- Renderer-only and local-first: no new IPC, Rust, network, or
  persistence-schema surface.
- The model, store round-trip + defensive parse, the hook lifecycle, the
  portable-file round-trip + every version-guard and rejection path,
  gallery filtering, the preview/text helper, and a headless round-trip of
  every built-in template through a real editor are unit-tested.
