# Tessera — Progress Tracker

> ## Tracking-integrity note
>
> Phase 7 was initially marked `DONE` in an earlier revision of this
> document before all of its features were wired into source — the
> actual integration code shipped in Phase 8. To prevent recurrence,
> the project now ships a smoke-test suite (`npm run test:smoke`)
> that asserts every claimed feature is backed by importable,
> callable production code, not just documentation. The phase-exit
> [checklist](CONTRIBUTING.md#phase-completion-checklist) in
> `CONTRIBUTING.md` codifies the gates a maintainer must clear before
> flipping a phase to `DONE`, and the smoke suite runs in CI on
> every PR so a regression in a closed phase blocks the next phase
> from closing.
>
> If you spot a feature listed in this document that has no
> corresponding code or test, please open an issue with the
> `tracking-integrity` label so the discrepancy is logged rather
> than silently re-discovered.

## Overview

This document tracks Tessera's phased delivery from open-source foundation to a complete local-first productivity workspace.

---

## Status legend

| Marker | Meaning |
|---|---|
| `DONE` | Phase complete |
| `IN PROGRESS` | Actively being worked on |
| `NOT STARTED` | Scheduled for future work |

---

## Phase 0 — Open-source foundation

**Status:** `DONE`

**Goal:** Clean, safe, open-source base.

### Build

| Item | Status |
|---|---|
| Repository created | `DONE` |
| MIT license | `DONE` |
| Contribution guide | `DONE` |
| Security policy | `DONE` |
| Architecture document | `DONE` |
| Product proposal | `DONE` |
| Progress tracker | `DONE` |
| Desktop app skeleton | `DONE` |

### Exit criteria

- [x] Public repo ready with license, contribution guide, and security policy.
- [x] App name, license, and contribution model are clear.
- [x] Build system works locally.

---

## Phase 1 — Desktop shell

**Status:** `DONE`

**Goal:** Tessera runs on macOS and Windows as a desktop application.

### Build

| Item | Status |
|---|---|
| Electron app with main process | `DONE` |
| React renderer with TypeScript | `DONE` |
| TypeScript IPC layer | `DONE` |
| Rust N-API bridge | `DONE` |
| Home screen | `DONE` |
| Sources screen | `DONE` |
| Templates screen | `DONE` |
| Settings screen | `DONE` |
| Local config persistence | `DONE` |

### Exit criteria

- [x] App launches on macOS and Windows.
- [x] Renderer calls Rust through Electron main via typed IPC.
- [x] Settings persist across restarts.
- [x] Coherent desktop shell with Home, Sources, Templates, and Settings.

---

## Phase 2 — Local source indexing

**Status:** `DONE`

**Goal:** Local folders and files are searchable within Tessera.

### Build

| Item | Status |
|---|---|
| Add local folder source | `DONE` |
| Add local file source | `DONE` |
| File watcher (new/changed/deleted) | `DONE` |
| Content hashing and deduplication | `DONE` |
| Text extraction (PDF, DOCX, PPTX, XLSX, CSV, MD, TXT, HTML, JSON) | `DONE` |
| Chunking pipeline | `DONE` |
| Local evidence storage (encrypted) | `DONE` |
| Basic hybrid search (FTS5 + vector + recency) | `DONE` |
| Source detail page | `DONE` |

### Exit criteria

- [x] User selects a folder and Tessera indexes it locally.
- [x] Search returns relevant results with source path, excerpt, and page/section.
- [x] No network required for local indexing and search.

---

## Phase 3 — Templates and artifacts

**Status:** `DONE`

**Goal:** Users can create work artifacts from templates backed by indexed sources.

### Build

| Item | Status |
|---|---|
| Template schema (YAML) | `DONE` |
| Artifact schema | `DONE` |
| Template gallery UI | `DONE` |
| Document editor (ProseMirror/TipTap) | `DONE` |
| Slide editor | `DONE` |
| Sheet editor (grid) | `DONE` |
| Base editor (grid view) | `DONE` |
| Citation panel | `DONE` |
| Version history | `DONE` |
| Export: Markdown, HTML, CSV, PDF | `DONE` |

### Exit criteria

- [x] User selects a template and sources, Tessera creates an editable artifact with citations.
- [x] Citations link back to source material with provenance.
- [x] User can export artifacts to Markdown, HTML, CSV, and PDF.

---

## Phase 4 — Local model runtime

**Status:** `DONE`

**Goal:** Local generation from indexed knowledge using on-device models.

### Build

| Item | Status |
|---|---|
| Local runtime manager | `DONE` |
| Sidecar start/stop lifecycle | `DONE` |
| Health checks and status reporting | `DONE` |
| Ternary-Bonsai 1.7B support | `DONE` |
| Ternary-Bonsai 4B support | `DONE` |
| Ternary-Bonsai 8B support | `DONE` |
| Streaming generation | `DONE` |
| Structured output parsing (GBNF) | `DONE` |
| Runtime status UI | `DONE` |

### Exit criteria

- [x] User generates a document draft from local sources with local model inference.
- [x] Generation runs entirely locally.
- [x] User can see the active model and runtime status.
- [x] Failed states are handled gracefully.

---

## Phase 5 — First remote connector (Google Drive)

**Status:** `DONE`

**Goal:** Validate the connected-source ingestion pattern with Google Drive.

### Build

| Item | Status |
|---|---|
| OAuth 2.0 flow | `DONE` |
| Secure token storage (OS keychain) | `DONE` |
| File/folder picker | `DONE` |
| Incremental sync | `DONE` |
| Metadata sync | `DONE` |
| Local indexing of selected Drive files | `DONE` |
| Disconnect flow (remove index, revoke tokens) | `DONE` |
| Connector status UI | `DONE` |
| Audit events for connect/sync/disconnect | `DONE` |

### Exit criteria

- [x] User connects Google Drive, selects a folder, and Tessera indexes selected files.
- [x] Artifacts can cite Google Drive files.
- [x] Disconnecting removes local index and revokes access.

---

## Phase 6 — Productivity workflows

**Status:** `DONE`

**Goal:** Make Tessera valuable for real work with useful artifact types and workflows.

### Build

| Item | Status |
|---|---|
| PRD generator | `DONE` |
| Proposal generator | `DONE` |
| SOP generator | `DONE` |
| QBR generator | `DONE` |
| Budget tracker template | `DONE` |
| Vendor register template | `DONE` |
| Risk register template | `DONE` |
| Task/decision extraction from sources | `DONE` |
| Source comparison | `DONE` |
| Review checklist | `DONE` |
| Export evidence pack | `DONE` |

### Exit criteria

- [x] Several useful artifact types generated from source material.
- [x] Artifacts are editable with citations preserved.
- [x] Local-first default maintained for all workflows.

---

## Phase 7 — Linux, rendering integrations, new generators, export coverage

**Status:** `DONE` (implementation completed in Phase 8 — see note below)

> **Note on delivery cadence.** Phase 7 closed its checklist before all of the
> integrations were actually wired into source. The rendering services
> (Mermaid / Marp / Typst), icon families (Lucide / Phosphor), new artifact
> types (Infographic / Landing Page), and the DOCX / XLSX export modules were
> all landed for real in **Phase 8** as part of the same PR. The Phase 7
> checkboxes below describe the *intended* surface; the Phase 8 section below
> records the work that brought source up to match it.

**Goal:** Broaden the platform: add Linux as a first-class target, integrate
upstream rendering engines (Mermaid, Marp, Typst), adopt Lucide + Phosphor
icon families, ship two new artifact types (Infographic, Landing Page), close
the export-format gap (DOCX, PPTX, XLSX), and bring CI + docs current.

### Build

| Block | Item | Status |
|---|---|---|
| A | Linux packaging (AppImage / .deb / .rpm via electron-builder) | `DONE` |
| A | Linux sidecar download scripts and `models.json` entries | `DONE` |
| A | Linux runtime detection (AVX2 / AVX-512 / Vulkan) | `DONE` |
| A | Linux sidecar supervision + libsecret keyring | `DONE` |
| A | Linux CI workflow (matrix: Ubuntu / macOS / Windows) | `DONE` |
| B | `mermaid` renderer service + theme integration | `DONE` |
| B | Mermaid TipTap block in DocumentEditor | `DONE` |
| B | Mermaid diagram block in SlideEditor | `DONE` |
| B | Mermaid handling in export pipeline (HTML / PDF / Markdown) | `DONE` |
| C | Marp Core renderer service | `DONE` |
| C | Marp mode in SlideEditor with Shadow-DOM-isolated live preview | `DONE` |
| C | Marp CLI–backed PPTX / HTML / PDF export | `DONE` |
| C | Marp slide templates (QBR, strategy, review, training, pitch) | `DONE` |
| D | Typst Rust crate dependency + minimal `World` | `DONE` |
| D | Typst-powered document export (PDF / SVG via IPC) | `DONE` |
| D | DOCX export module (`tessera_export::docx`) | `DONE` |
| D | XLSX export module (`tessera_export::xlsx`) | `DONE` |
| E | Lucide React adoption across components | `DONE` |
| E | Phosphor icons + `IconPicker` (search, weight, preview) | `DONE` |
| E | `iconResolver` + inline-SVG embedding in exports | `DONE` |
| F | Infographic artifact type (core, model, generator) | `DONE` |
| F | InfographicEditor with drag-drop sections + icon picker | `DONE` |
| F | Infographic templates (stats-overview, process-flow, comparison) | `DONE` |
| F | LandingPage artifact type (core, model, generator) | `DONE` |
| F | LandingPageEditor (hero / features / stats / testimonials / CTA) | `DONE` |
| G | CI matrix workflow (Rust + TypeScript on Linux/macOS/Windows) | `DONE` |
| G | Integration tests for mermaidRenderer / marpRenderer / iconResolver | `DONE` |
| G | Rust tests for Typst, DOCX, XLSX export modules | `DONE` |
| G | PROGRESS.md / README.md / ARCHITECTURE.md sweep | `DONE` |
| G | PHASES.md alias | `DONE` |

### Exit criteria

- [x] Linux build works end-to-end (packaging, sidecar, keyring, CI).
- [x] Mermaid, Marp, Typst, Lucide, Phosphor are real working integrations,
      not facades — every renderer/icon ships with its own unit + integration
      tests, and is wired into the editors and the export pipeline.
- [x] Infographic and LandingPage are full artifact types: type enum entry,
      grammar, generator, editor UI, templates, and tests.
- [x] DOCX, PPTX, and XLSX exports are available from the UI export menu and
      covered by tests.
- [x] CI runs `cargo test --all`, `npm test`, `cargo clippy -D warnings`,
      `npm run lint`, and `npm run type-check` on Linux / macOS / Windows.
- [x] All top-level docs (PROPOSAL, ARCHITECTURE, README, CONTRIBUTING,
      SECURITY, PHASES, PROGRESS) reference Linux, the new artifact types,
      every export format, and the rendering integrations consistently.

---

## Phase 8 — Connectors, surfaces, views, missing features

**Status:** `DONE`

**Goal:** Close the gap between Phase 7's claimed surface and the code that
actually ships. Add the remaining four remote connectors, the Tasks/Plans
and Automations product surfaces, four new Base views, the Plan & Approve
template categories, the `CreatePage` Analyze workflows, and integration
tests for every new rendering / connector module.

### Build

| Block | Item | Status |
|---|---|---|
| A | Mermaid renderer service + Document editor TipTap block | `DONE` |
| A | Marp Core renderer service + Shadow-DOM live preview in Slide editor + Marp CLI PPTX export | `DONE` |
| A | Typst Rust crate + `World` impl + Typst PDF / SVG export via IPC | `DONE` |
| A | `tessera_export::docx` module + UI export wiring | `DONE` |
| A | `tessera_export::xlsx` module + UI export wiring | `DONE` |
| A | Lucide + Phosphor icon adoption across renderer (`iconResolver`) | `DONE` |
| A | `IconPicker` component (search, weight, preview) | `DONE` |
| A | Infographic artifact type — core enum, model, generator, editor, templates | `DONE` |
| A | Landing Page artifact type — core enum, model, generator, editor, template | `DONE` |
| A | CI matrix workflow (Ubuntu 22.04 / macOS 13 / Windows 2022) running `cargo test`, `npm test`, `cargo clippy -D warnings`, `npm run lint`, `npm run type-check` | `DONE` |
| B | OneDrive / SharePoint connector (`tessera_connectors::onedrive`) | `DONE` |
| B | Notion connector (`tessera_connectors::notion`) | `DONE` |
| B | Jira connector (`tessera_connectors::jira`) | `DONE` |
| B | Confluence connector (`tessera_connectors::confluence`) | `DONE` |
| B | Figma connector (`tessera_connectors::figma`) | `DONE` |
| C | Tasks/Plans surface — model, `TasksPage`, drag-and-drop reordering, IPC handlers, scheduler-aware updates | `DONE` |
| C | Automations surface — `AutomationsPage`, scheduler service in Electron main, persisted automation rules, IPC handlers | `DONE` |
| C | Plan-category templates (6) — Meeting agenda, Project plan, Task list, Launch checklist, Meeting notes, Brief | `DONE` |
| C | Approve-category templates (4) — Purchase approval, Budget approval, Policy exception, Vendor review | `DONE` |
| D | Kanban view for Bases (drag-and-drop columns from any select field) | `DONE` |
| D | Calendar view for Bases (month / week / day, click-to-create, drag-to-reschedule) | `DONE` |
| D | Timeline / Gantt view for Bases (zoom controls, unscheduled bucket) | `DONE` |
| D | Gallery view for Bases (cover image, configurable summary fields) | `DONE` |
| E | `CreatePage` Analyze category workflows (Summarize sources / Generate report / Analyze spreadsheet) over a 4-tab launcher | `DONE` |
| E | Mermaid blocks in Slide editor end-to-end through HTML / PDF / Markdown exporters | `DONE` |
| E | Icon embedding in exports — inline `<svg>` for HTML / DOCX, `[name]` text placeholders for the minimal PDF builder, untouched markdown | `DONE` |
| E | Integration tests for `mermaidRenderer`, `marpRenderer`, `iconResolver`, `IconPicker`, all 5 new connectors, all 3 new export modules | `DONE` |
| F | `PHASES.md` — top-level phase index | `DONE` |
| F | `PROGRESS.md` — Phase 7 fixup note, Phase 8 task table, refreshed MVP feature summary, dated 2026-05-20 changelog | `DONE` |
| F | `README.md` — CI badge, refreshed Stack / Editors / Connectors / Artifact-type tables, refreshed repository layout | `DONE` |
| F | `ARCHITECTURE.md` — refreshed Recommended-stack table, refreshed Mermaid architecture diagram, refreshed Repository layout | `DONE` |

### Exit criteria

- [x] All 5 new remote connectors (OneDrive, Notion, Jira, Confluence, Figma)
      build, sync, and disconnect cleanly; each ships with mocked-HTTP
      integration tests in the pattern of `gdrive.rs`.
- [x] `TasksPage` and `AutomationsPage` are reachable from the sidebar and
      driven by typed IPC handlers; the scheduler runs in Electron main and
      survives `will-quit` correctly.
- [x] Every Plan and Approve category template parses through the existing
      `tessera_templates` registry and produces a generator-ready artifact.
- [x] Base editor exposes Grid / Kanban / Calendar / Timeline / Gallery
      switcher; view choice is renderer state (not persisted to artifact
      JSON), and switching views never dirties the document.
- [x] `CreatePage` is organized into Create / Analyze / Plan / Approve tabs
      with the three Analyze workflows visible as "Workflow"-badged cards.
- [x] Icon tokens (`{{icon:...}}`) flow through to exports format-aware:
      inline SVG for HTML / DOCX, `[name]` text for the fallback PDF builder,
      and untouched in Markdown.
- [x] `cargo clippy --all-targets --all-features -- -D warnings` is clean.
- [x] `npm run lint`, `npx tsc --noEmit`, `npx vitest run`, and
      `cargo test --workspace` all pass.
- [x] PHASES.md, PROGRESS.md, README.md, and ARCHITECTURE.md describe the
      same set of platforms, artifact types, export formats, connectors, and
      Base views (no stale references).

---

## MVP feature set summary

| Category | Details |
|---|---|
| **Platforms** | macOS (Intel & Apple Silicon), Windows (x64), Linux (x64, arm64 — AppImage / `.deb` / `.rpm`) |
| **Sources** | Local folders, local files, Google Drive, OneDrive / SharePoint, Notion, Jira, Confluence, Figma |
| **Artifacts** | Documents, Slides, Sheets, Bases (Grid / Kanban / Calendar / Timeline / Gallery views), Infographic, Landing Page |
| **Surfaces** | Home, Sources, Templates, Create (Create / Analyze / Plan / Approve tabs), Tasks / Plans, Automations, Settings |
| **Templates** | Create: PRD, Proposal, SOP. Analyze: Report, QBR, Risk register, Budget tracker, Vendor register. Plan: Meeting agenda, Project plan, Task list, Launch checklist, Meeting notes, Brief. Approve: Purchase approval, Budget approval, Policy exception, Vendor review. Slides: Strategy, Review, Training, Pitch. Infographic: stats-overview / process-flow / comparison. Landing Page: SaaS product. |
| **Runtime** | Local sidecar, Ternary-Bonsai 1.58-bit (1.7B / 4B / 8B), MLX 2-bit on Apple Silicon, GGUF Q1_0_g128 (PrismML llama.cpp fork) everywhere else; Vulkan / CUDA / ROCm acceleration on Linux & Windows, Metal on macOS |
| **Rendering** | Mermaid (diagrams), Marp Core (slides), Typst (typesetting), Lucide + Phosphor (icons via `iconResolver` + `IconPicker`) |
| **Export** | Markdown, HTML, CSV, JSON, PDF (minimal + Typst), DOCX, PPTX (Marp CLI), XLSX |
| **Packaging** | AppImage + `.deb` + `.rpm` (Linux), DMG + `.zip` (macOS), NSIS + portable `.zip` (Windows) |
| **Core** | Knowledge substrate, encrypted local store, hybrid retrieval, citations, audit trail, scheduler-driven automations, exportable evidence pack |

---

## Design system

Tessera's UI follows the **KChat design system** ([https://kchat.com](https://kchat.com)) — primary accent `#7C3AED` (purple/violet), font `Inter`, white/lavender surfaces, pill-shaped purple primary buttons, outlined secondary buttons, rounded card corners with subtle shadow.

| Token | Value |
|---|---|
| **Primary accent** | `#7C3AED` (Purple/Violet) — headlines, CTA buttons, active states, links, icons |
| **Primary hover** | `#6D28D9` (darker violet) |
| **Background – page** | `#FFFFFF` (white) |
| **Background – card/surface** | `#F5F3FF` (light lavender) or `#F9FAFB` (light gray) |
| **Text – headline** | `#111827` (near-black) |
| **Text – body** | `#4B5563` (dark gray) |
| **Text – secondary** | `#6B7280` (medium gray) |
| **Font family** | `Inter` (primary), system sans-serif fallback stack: `-apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif` |
| **Primary button** | Solid `#7C3AED` background, white text, pill/rounded shape (`border-radius: 9999px`) |
| **Secondary button** | Outlined with `#111827` border, dark text, uppercase tracking |
| **Cards** | White `#FFFFFF` background, `border-radius: 12px`, subtle shadow `0 1px 3px rgba(0,0,0,0.1)` |
| **Overall feel** | Clean, modern, minimal — purple dominant against white/light surfaces |

---

## Phase 9 — Feature pass: missing templates, citations, external LLM, UI hardening

**Status:** `DONE`

**Goal:** Close the remaining gaps between PROPOSAL.md and the
shipping product. Add the missing templates, ship advanced citation
workflows (freshness / replace / remove), add optional external LLM
provider support behind a keychain-stored API key, harden source
indexing with ignore patterns + image metadata + incremental
progress reporting, and finish UI / accessibility / production
hardening (keyboard shortcuts, focus traps, dark mode, error
boundary, structured logging, release workflow).

### Build

| Block | Item | Status |
|---|---|---|
| A | `templates/documents/form.yaml` | `DONE` |
| A | `templates/bases/asset-inventory.yaml` | `DONE` |
| A | `templates/sheets/tracker.yaml` | `DONE` |
| A | `templates/sheets/inventory.yaml` | `DONE` |
| A | `templates/bases/roadmap.yaml` | `DONE` |
| B | `tessera_citations::freshness::check_source_freshness` + IPC + UI | `DONE` |
| B | `tessera_citations::replace_citation` + IPC + UI flow | `DONE` |
| B | `tessera_citations::remove_citation` + audit log + UI confirmation | `DONE` |
| B | Citation panel polish + Ctrl+Shift+C toggle + freshness icon | `DONE` |
| C | `tessera_runtime::external_provider` (OpenAI-compatible / Anthropic / custom) + wiremock tests | `DONE` |
| C | Settings UI for external provider with keychain-backed API key | `DONE` |
| C | Adapter chain `MLXAdapter → LlamaCppAdapter → ExternalAdapter → Fallback` | `DONE` |
| D | `tessera_sources::ignore` module using the `ignore` crate | `DONE` |
| D | `tessera_sources::image_metadata` (EXIF/XMP/IPTC via `kamadak-exif` + `image`) | `DONE` |
| D | Incremental re-index progress (`ProgressTracker` + IPC + `useIndexingProgress` hook + `SourceDetailPage` UI) | `DONE` |
| E | `useKeyboardShortcuts` global handler (Ctrl/Cmd+N/S/E/F/,/1–7 + Escape) + sidebar hints | `DONE` |
| E | Modal focus trap, `aria-labelledby`, focus restoration, optional `closeOnOverlayClick=false` | `DONE` |
| E | Toast dismiss button, `role=alert` for errors, leak-free timers | `DONE` |
| E | Dark mode tokens (`[data-theme="dark"]` + `prefers-color-scheme` fallback) + `useTheme` hook | `DONE` |
| F | `ErrorBoundary` at root with Reload / Report / Dismiss | `DONE` |
| F | Structured JSONL logger (`apps/desktop/electron/logger.ts`) + uncaughtException handlers | `DONE` |
| F | `.github/workflows/release.yml` per-platform `electron-builder` + git-log changelog | `DONE` |
| G | This PROGRESS.md Phase 9 section + 2026-05-21 changelog entry | `DONE` |
| G | README / ARCHITECTURE / PHASES updates | `DONE` |

### Exit criteria

- [x] Every template listed under PROPOSAL.md "Create" and "Bases"
      exists in `templates/` and parses through `tessera_templates`.
- [x] Citations track source freshness, can be replaced via a
      source-picker modal, and can be removed without deleting the
      cited text — all three flows log audit events.
- [x] An external LLM provider can be configured in Settings; the
      API key is stored in the OS keychain, never on disk; the
      adapter chain falls through to it when local inference is
      unavailable.
- [x] `tessera_sources` honors `.gitignore`-style patterns,
      extracts EXIF/XMP/IPTC metadata from images, and surfaces
      incremental re-index progress through IPC to the renderer.
- [x] Renderer supports global keyboard shortcuts, modal focus
      trapping, dismissible toasts with `aria-live`, and a
      light/dark/system theme switch.
- [x] Renderer crashes are caught by a root error boundary;
      uncaught main-process exceptions are written to
      `~/.config/Tessera/logs/tessera.log` with 5-file rotation.
- [x] `Release` workflow on `v*` tags builds AppImage / .deb /
      .rpm / .dmg / NSIS exe and attaches them to a GitHub
      Release with an auto-generated changelog.

---

## Phase 10 — Production hardening & documentation

**Status:** `IN PROGRESS`

**Goal:** Convert Tessera from feature-complete-MVP to release-ready
shipping product. Closes the production-hardening, security, and
UX gaps that surfaced after Phase 9: hybrid retrieval becomes
transparent and configurable; the security surface (CSP, password
vault, rate limiter, export path safety, IPC audit) is fully
documented and instrumented; the external LLM provider gets SSE
streaming + retry + token counting + model listing + cancellation
UX; the bundled template catalog grows to >170 templates across
ten industries and ten locales; and every top-level doc reflects
the shipped surface end-to-end.

### Block table

*Tasks marked `DONE` shipped in earlier PRs (#17 / #19 / #20 / #21 /
#22 / #23) and are listed for completeness. The full task list,
including the IN PROGRESS rows, mirrors the engineering brief that
opens this phase.*

| Block | Item | Status |
|---|---|---|
| A | Task 1 — PROGRESS.md Phase 10 section + 2026-05-23 changelog entry | `IN PROGRESS` |
| A | Task 2 — PHASES.md Phase 10 row | `IN PROGRESS` |
| A | Task 3 — ARCHITECTURE.md mermaid diagram, recommended-stack table, repo-layout tree, security subsection, hybrid-retrieval description | `IN PROGRESS` |
| A | Task 4 — README.md security-and-hardening section, stack-summary table, hybrid-retrieval bullet, SSE-streaming note, repo-layout fix | `IN PROGRESS` |
| A | Task 5 — PROPOSAL.md consistency sweep (surfaces, artifact types, connectors, templates, retrieval description, links) | `IN PROGRESS` |
| A | Task 6 — CONTRIBUTING.md testing expectations + security-regression-test pointers + smoke-suite reference | `IN PROGRESS` |
| A | Task 7 — docs/IPC_AUDIT.md cross-reference vs. `apps/desktop/electron/ipc/` + autoUpdater channels | `IN PROGRESS` |
| B | Task 8 — `sources:backfillEmbeddings` IPC + bridge method + SourceDetailPage "Re-embed" button | `IN PROGRESS` |
| B | Task 9 — `ProgressTracker` embedding-phase counters + `sources:getEmbeddingProgress` IPC + renderer progress bar | `IN PROGRESS` |
| B | Task 10 — Hybrid-search config UI in Settings (hybrid toggle, recency half-life) + `hybridSearchConfig` persistence + IPC | `IN PROGRESS` |
| B | Task 11 — `CitationPanel` relevance display (percentage + tier badge) | `IN PROGRESS` |
| B | Task 12 — Hybrid-retrieval end-to-end integration test (exact-match, typo, substring, empty, recency, BM25-only) | `IN PROGRESS` |
| C | Task 13 — `getOrCreateDbKeyAsync` integrates password vault as DB-key wrap fallback; one-time migration for existing plaintext DBs | `IN PROGRESS` |
| C | Task 14 — IPC rate limiter (`ipc/rateLimiter.ts`) | `DONE` (PR #17) |
| C | Task 15 — Export-path containment (`exportPathSafety.ts`) | `DONE` (PR #17) |
| C | Task 16 — Extracted-item XSS hardening: HTML-escape `text` + `sourceCitation` in `extractedItemValidation.ts` | `IN PROGRESS` |
| C | Task 17 — Audit-trail completeness sweep across `ipc/`: source / artifact / citation / connector / model / settings events | `IN PROGRESS` |
| D | Task 18 — External provider connect-failure retry with exponential backoff (1s / 2s / 4s) + `Retry-After` on 429; no retry on 4xx | `IN PROGRESS` |
| D | Task 19 — Token-counting utility + cumulative usage in `config.ts` + Settings display + reset button | `IN PROGRESS` |
| D | Task 20 — `externalProvider:listModels` IPC + model-dropdown UI with graceful fallback | `IN PROGRESS` |
| D | Task 21 — Streaming cancellation UX: visible "Stop generating" button in `ArtifactEditorPage` + lifecycle transitions | `IN PROGRESS` |
| E | Task 22 — Connector wiremock integration tests for OneDrive / Notion / Jira / Confluence / Figma (Rust crate) | `IN PROGRESS` |
| E | Task 23 — Export module edge-case tests (empty, very long, Unicode, Mermaid, icon tokens, evidence pack) | `IN PROGRESS` |
| E | Task 24 — Editor component vitest coverage (Document / Slide / Sheet / Base / Infographic / LandingPage) | `IN PROGRESS` |
| E | Task 25 — Accessibility audit (focus trap, aria-labelledby, aria-current, htmlFor, Re-embed + Stop labels) | `IN PROGRESS` |
| E | Task 26 — Dark-mode CSS-variable enforcement + regression test | `IN PROGRESS` |
| F | Task 27 — Home page: real recent-artifacts (sorted by modified) + source status counts + quick actions | `DONE` (Block F branch) |
| F | Task 28 — Template validation on load: required-field + section-prompt + export-format checks; audit-log validation failures | `DONE` (Block F branch) |
| F | Task 29 — Source comparison: structured result (common / unique-to-A / unique-to-B) + `ComparisonResultModal` | `DONE` (Block F branch) |
| F | Task 30 — Scheduler resilience (tick failure, concurrency, drain) | `DONE` (PR #17) |
| G | Release readiness — RELEASING.md, preflight scripts, README platform table | `DONE` (PR #21) |
| G | Phase-tracking smoke suite + phase-exit checklist in CONTRIBUTING.md | `DONE` (PR #22) |
| H | Template & artifact expansion (industries / profiles / locales — 173 templates, ten BCP-47 locales) | `DONE` (PR #23) |

### Block H — Template & artifact expansion (shipped in PR #23)

Grows the bundled template registry from the original ~36
English-only corporate-tech templates to >170 templates that cover
ten industries, multiple user profiles, and ten BCP-47 locales
(English plus nine localized variants).

| Item | Status |
|---|---|
| Add `locale`, `industry`, `profile` fields to the YAML schema, the Rust `Template` struct, and the TypeScript `Template` interface | `DONE` |
| Industry-specific document templates — Healthcare (4), Legal (4), Education (4), Government (4), Finance (4), Manufacturing (3), Retail (2), Nonprofit (2), Creative / Marketing (3), Real Estate (2) | `DONE` |
| New slide decks — onboarding, sales enablement, board update, investor update, workshop | `DONE` |
| New base templates — CRM, incident tracker, employee directory, compliance register | `DONE` |
| New infographics — timeline, org chart, KPI dashboard | `DONE` |
| New landing pages — nonprofit cause, event / conference, personal & agency portfolio | `DONE` |
| New sheet templates — product catalog, sales forecast | `DONE` |
| Localized variants of the top 10 templates (PRD, Proposal, SOP, Report, Meeting agenda, Meeting notes, Task list, Form, Budget, Pitch) in nine languages: `es`, `fr`, `de`, `ja`, `zh`, `pt`, `ko`, `ar`, `hi` — 90 files total | `DONE` |
| CreatePage industry + locale filter dropdowns; cards re-resolve to the localized id when a non-English locale is selected | `DONE` |
| Smoke registry test (`crates/tessera_templates/tests/bundled_templates.rs`) discovers every template, validates parse + schema, enforces unique ids, locale-directory consistency, and the canonical-set invariant for every supported locale | `DONE` |
| README industry-coverage and language-support tables, PROPOSAL template-catalog update, PROGRESS phase entry | `DONE` |

### Exit criteria

- [ ] Every doc (PROPOSAL, ARCHITECTURE, README, PROGRESS, PHASES,
      CONTRIBUTING, docs/IPC_AUDIT) describes the same set of
      surfaces, artifact types, connectors, export formats, security
      controls, and external-provider features — no contradictions.
- [ ] Repo-layout tree references `landing_pages/` (the on-disk
      directory name) everywhere, never `landingpages/`.
- [ ] Hybrid retrieval is configurable from Settings (toggle + recency
      half-life), embeddings can be backfilled from the UI, progress
      is observable, and `CitationPanel` shows relevance as a tiered
      percentage badge.
- [ ] `getOrCreateDbKeyAsync` keeps the DB key encrypted on keyring-less
      platforms by wrapping with the password vault; existing plaintext
      DBs migrate transparently on first password-vault-backed launch.
- [ ] Extracted-item validation HTML-escapes every renderer-bound
      string field; XSS regression tests cover `<script>`, on-event
      attributes, `javascript:` / `data:` URIs.
- [ ] Every IPC handler that mutates state writes an audit event
      via `tessera_audit`; the missing-event audit table in this
      document lists zero outstanding rows.
- [ ] External provider retries on transient HTTP (408 / 429 / 5xx)
      with exponential backoff, never retries on 400 / 401 / 403, and
      respects `Retry-After` on 429.
- [ ] Token usage accumulates across sessions, displays in the
      External Provider card, and can be reset.
- [ ] OpenAI-compatible providers expose a `GET /v1/models` driven
      dropdown; Anthropic and unknown endpoints fall back to the
      manual model-name input gracefully.
- [ ] A visible "Stop generating" button in `ArtifactEditorPage`
      cancels both local sidecar and external provider streams.
- [ ] Every connector ships wiremock-backed integration tests for
      OAuth refresh / listing / incremental sync / disconnect / 401 /
      429 / 500 paths.
- [ ] Every export module ships edge-case tests (empty body, >100 KB
      body, Unicode + emoji + RTL, Mermaid blocks, icon tokens).
- [ ] Every editor mounts cleanly under vitest with auto-save IPC
      asserted.
- [ ] Every modal traps focus, exposes `aria-labelledby`, restores
      focus on close, and dismisses on Escape; every form input has
      an associated label; sidebar uses `aria-current`.
- [ ] No renderer component leaks hardcoded hex colors in either
      theme (snapshot / assertion-based regression test).
- [x] HomePage shows real recent-artifact + source-status data; the
      empty state is distinguishable from a loading state.
      *(Block F: source-status breakdown rendering every canonical
      `SourceStatus` bucket, navigable recent-artifact cards, quick-
      actions row to Templates / Tasks / Sources / Settings.)*
- [x] Template validation runs on load; failures are surfaced in the
      audit log; the 173-template registry has zero validation
      errors.
      *(Block F: `TemplateLoadFailureKind` distinguishes parse vs.
      validation; `AuditEventType::TemplateValidationFailed` rows
      are written via `log_template_validation_failed`; bridge
      surfaces every dropped template through
      `bridge_list_templates`.)*
- [x] Source comparison returns a structured `{ common, uniqueToA,
      uniqueToB }` result and renders through `ComparisonResultModal`.
      *(Block F: `bridge_compare_sources` returns
      `CompareSourcesResult { artifact, comparison, label_a, label_b }`;
      renderer wraps it in a modal with frequency-badge sections,
      similarity-as-percent, Download as Markdown, and Open
      artifact affordances.)*

#### Template & artifact expansion exit criteria *(Block H, shipped in PR #23)*

- [x] Every YAML file under `templates/` parses through
      `tessera_templates::parser::parse_template_file` and validates
      via `tessera_templates::validator::validate_template`.
- [x] No two templates share the same `id`; localized variants use
      the `<base-id>-<locale>` suffix convention.
- [x] Each of the nine non-English locales ships the full canonical
      set of 10 core templates; the registry test fails if any
      translation goes missing.
- [x] The CreatePage industry filter shows every industry-tagged
      template under its declared industries and surfaces untagged
      templates under "General".
- [x] The CreatePage locale filter routes cards to the localized id
      when a translation exists. Cards without a localized variant for
      the selected non-English locale are hidden from the grid (a
      deliberate UX signal that those templates are not yet
      translated). The locale-aware workflow shortcuts in the Analyze
      tab carry `availableLocales: CORE_LOCALES` so they remain
      visible under every locale and route to the localized id when
      one exists. See the `matchesLocale` / `resolveTemplateId`
      contract documented at the top of `CreatePage.tsx`. Choosing
      "All languages" or "English" shows every card; non-English
      locales filter to the translated subset.

---

## Links

- [README.md](README.md) — project overview
- [PROPOSAL.md](PROPOSAL.md) — product proposal
- [ARCHITECTURE.md](ARCHITECTURE.md) — technical architecture
- [kennguy3n/knowledge](https://github.com/kennguy3n/knowledge) — local knowledge substrate

---

## Changelog

### 2026-05-23 (Phase 10 — production hardening & documentation)

This changelog entry covers every PR merged since Phase 9 closed
(PRs #17 / #19 / #20 / #21 / #22 / #23) plus the in-flight Phase 10
production-hardening work. See the Phase 10 block table above for
the per-task tracker.

**PR #17 — WS10 security hardening (merged)**
- **Password vault fallback** (`apps/desktop/electron/passwordVault.ts`,
  `vaultCrypto.ts`, `passwordPromptPreload.ts`,
  `passwordPromptChannels.ts`). Adds a PBKDF2-SHA256 (600 000
  iterations) + AES-256-GCM encryption fallback for platforms where
  Electron's `safeStorage` cannot reach an OS keyring (headless
  Linux, certain CI runners). The vault is unlocked by an
  ephemeral `BrowserWindow` loaded via `data:text/html` with
  `sandbox: true`; its preload exposes only a single
  `tesseraPasswordPrompt` API onto two `ipcMain.on` channels
  (`password-vault:submit`, `password-vault:cancel`) that are torn
  down on prompt close.
- **CSP per-connector image-source allow-list**
  (`apps/desktop/electron/cspImageSources.ts`). Replaces the prior
  wildcard `https:` image source with an explicit allow-list keyed
  off the connected providers (Google Drive, OneDrive, Notion,
  Jira, Confluence, Figma each map to their CDN hosts).
- **IPC rate limiter** (`apps/desktop/electron/ipc/rateLimiter.ts`).
  Token-bucket limiter applied to expensive IPC channels
  (search, generate, indexing actions) so a compromised renderer
  cannot exhaust the main process.
- **Export-path containment** (`apps/desktop/electron/exportPathSafety.ts`).
  Every renderer-initiated file write is constrained to a
  user-controlled directory; absolute paths outside the allow-list
  are rejected at the IPC boundary.
- **Extracted-item schema validation**
  (`apps/desktop/electron/extractedItemValidation.ts`). Zod-shape
  validation on every batch of tasks / decisions / risks the bridge
  surfaces; malformed items are dropped and audited.
- **Auto-updater** (`apps/desktop/electron/autoUpdater.ts`). Wraps
  `electron-updater` and exposes
  `updates:status` / `updates:check` / `updates:install` /
  `updates:getAutoUpdateEnabled` / `updates:setAutoUpdateEnabled`.
  Renderer subscribes to `updates:status` for ambient toast UX.
- **Encrypted DB key management** (`apps/desktop/electron/dbKey.ts`).
  `getOrCreateDbKey` reads / writes the SQLCipher key blob through
  `safeStorage`; throws `EncryptionUnavailableError` on platforms
  with no keyring. (The Phase 10 in-flight Task 13 wires the
  password vault as the long-term fix for that error path so the
  DB stays encrypted on keyringless platforms too.)
- **Modular IPC split**: `apps/desktop/electron/ipc.ts` split into
  `apps/desktop/electron/ipc/{sources,artifacts,model,runtime,
  citations,settings,templates,tasks,automations,connectors,dialog,
  context,rateLimiter,schemas,validate,shared,register}.ts` with a
  `connectors/` subdirectory for the per-provider handlers. The
  `idempotentHandle` helper (`register.ts`) makes every channel
  safe to re-register under vitest's `vi.resetModules()`.
- **Scheduler resilience** (`apps/desktop/electron/scheduler.ts`).
  Tick failures, concurrency limits, and `will-quit` drain were all
  pinned with regression tests so the scheduler cannot leak running
  jobs across an app close.

**PR #19 — WS11 external LLM provider SSE streaming (merged)**
- **Real SSE parser** (`apps/desktop/electron/externalProviderStream.ts`).
  `streamExternalProvider` consumes the chunked SSE response from
  OpenAI-compatible and Anthropic endpoints, parses `data:` events
  incrementally, and emits per-token deltas through
  `webContents.send("model:token", …)`. Cancellation via an
  external `AbortController` is propagated through to the underlying
  `fetch`.
- **Adapter wiring**: `tessera_runtime` `ExternalAdapter` (Phase 9)
  now routes through the new streaming surface; the local
  llama.cpp sidecar path and the external path expose the same
  per-token API to the renderer.

**PR #20 — WS3 hybrid retrieval (merged)**
- **`crates/tessera_sources/src/embedding.rs`**: introduces the
  `EmbeddingProvider` trait, `HashTrickEmbedding` default offline
  provider (signed feature hashing à la Weinberger et al. 2009 over
  character n-grams 3..=5, dim=256), `cosine_similarity` /
  `encode_vec` / `decode_vec` helpers. The provider exposes a
  stable `model_id` that includes every parameter that, if changed,
  would invalidate stored vectors.
- **`crates/tessera_sources/src/hybrid.rs`**: introduces the
  `HybridSearchConfig` struct (BM25 weight, vector weight, RRF k,
  recency half-life, candidate-pool size), `rrf_contribution`,
  `recency_multiplier`, `fuse_rankings`, `rank_chunks_by_cosine`,
  and the top-level `hybrid_search` entry point. The combiner is
  Reciprocal Rank Fusion (Cormack 2009, k=60) on top of a true
  half-life recency decay (`2^(-Δt/halflife)`) — pinned by the
  `recency_one_halflife_is_half` regression test.
- **Search relevance**: `SearchEngine::search_with_mode` now
  returns bounded `(0, 1]` RRF-derived relevance scores instead of
  the prior unbounded BM25 raw scores.

**PR #21 — Release readiness (merged)**
- **Release tooling**: `RELEASING.md`, preflight script
  (`preflight.sh` / `preflight.ps1`) that mirrors the CI Rollup
  platform-binary workaround, JSON-aware bash version detection,
  symmetric platform guard for PowerShell.
- **README platform availability**: macOS / Windows / Linux all
  marked Available; Releases-page link added.

**PR #22 — Phase tracking smoke suite (merged)**
- **Smoke suite**:
  `apps/desktop/renderer/src/__tests__/smoke/phaseVerification.test.ts`,
  `crates/tessera_connectors/tests/phase_smoke_connectors.rs`,
  `crates/tessera_export/tests/phase_smoke_export.rs`,
  `crates/tessera_templates/tests/phase_smoke_templates.rs`. Asserts
  that every claimed feature is backed by importable / callable
  code, not just docs.
- **CONTRIBUTING.md phase-exit checklist**: five-item gate that has
  to pass before a phase flips to `DONE` in `PROGRESS.md`.

**PR #23 — WS3 template & artifact expansion (merged)**
- **Schema additions**: `locale` (BCP-47), `industry[]`, `profile[]`
  added to the YAML schema, the `Template` Rust struct, and the
  renderer `Template` interface. `default_locale()` returns `"en"`;
  existing templates round-trip unchanged.
- **Industry templates**: 32 new document / sheet templates tagged
  for healthcare, legal, education, government, finance,
  manufacturing, retail, nonprofit, creative / marketing, and real
  estate (clinical protocol, patient care plan, HIPAA incident
  report, discharge summary, legal brief / IRAC, contract summary,
  compliance audit, case intake, lesson plan, course syllabus,
  student progress report, curriculum map, policy brief, grant
  proposal, impact assessment, public consultation report,
  investment memo, financial analysis, audit findings, loan
  proposal, quality control report, safety incident report,
  maintenance schedule, product catalog, sales forecast, donor
  report, volunteer handbook, content calendar, brand guidelines,
  campaign brief, property analysis, lease summary).
- **New slide decks**: onboarding, sales enablement, board update,
  investor update, workshop.
- **New bases**: CRM, incident tracker, employee directory,
  compliance register.
- **New infographics**: timeline, org chart, KPI dashboard.
- **New landing pages**: nonprofit cause, event / conference,
  personal & agency portfolio.
- **Localized variants**: 90 files under
  `templates/<category>/locales/<locale>/` covering nine languages
  (`es`, `fr`, `de`, `ja`, `zh`, `pt`, `ko`, `ar`, `hi`) for the top
  10 most-used templates. Section titles + LLM prompts are
  translated and prompts explicitly ask the model to respond in the
  target language.
- **CreatePage**: industry-filter and locale-filter dropdowns added
  above the template grid; cards re-resolve to the localized id when
  a non-English locale is selected.
- **Registry test rewrite**: `bundled_templates.rs` now discovers
  every YAML on the filesystem, parses + validates each, enforces
  unique ids, asserts every locale variant lives in
  `locales/<code>/` matching its `locale:` field, and verifies every
  non-English locale ships the full canonical 10-template set. 8
  tests, ~170 templates covered.
- **JSON schema**: `type` enum extended to include `infographic`
  and `landing_page`, matching the runtime `ArtifactType` variants.
- **Docs**: README artifact-types table refreshed, new "Industry
  coverage" and "Language support" sections added; PROPOSAL.md
  template-catalog updated.

**Phase 10 in-flight (this PR onwards)**
- Block A documentation catchup: PROGRESS / PHASES / ARCHITECTURE
  / README / PROPOSAL / CONTRIBUTING / docs/IPC_AUDIT updated to
  describe every surface listed above.
- Blocks B–F shipping as separate PRs (see block table) covering
  hybrid retrieval UX, security hardening completion, external
  provider hardening, testing & quality, feature polish.

### 2026-05-21 (Phase 9)
- **Block A — Missing templates**: Five new YAML templates landed
  to match PROPOSAL.md's surface — `templates/documents/form.yaml`,
  `templates/bases/asset-inventory.yaml`,
  `templates/sheets/tracker.yaml`,
  `templates/sheets/inventory.yaml`, and
  `templates/bases/roadmap.yaml`. All five are discovered by the
  `tessera_templates` registry and surfaced in the Create / Bases /
  Sheets tabs.
- **Block B — Citation advanced workflows**: `tessera_citations`
  gained `freshness::check_source_freshness` (compares the citation's
  stored chunk hash against the current source chunk), plus
  `replace_citation` and `remove_citation` that both write audit
  events. The renderer's `CitationPanel` now shows a stale-source
  warning icon, exposes Replace and Remove actions per citation, and
  toggles via the Ctrl+Shift+C shortcut.
- **Block C — Optional external LLM provider**: New
  `tessera_runtime::external_provider` module ships an HTTP client
  supporting OpenAI-compatible `/v1/chat/completions`, Anthropic
  `/v1/messages`, and a `Custom` URL. Provider configuration lives
  in the renderer Settings page; the API key is stored in the OS
  keychain via the existing `tokenVault` pattern, never on disk in
  plaintext. The adapter chain became
  `MLXAdapter → LlamaCppAdapter → ExternalAdapter → Fallback`.
  `wiremock` integration tests cover both endpoints + retry +
  rate-limit handling.
- **Block D — Source indexing improvements**: `tessera_sources`
  added an `ignore` module that wraps the `ignore` crate with a
  Tessera default list (`.git/`, `node_modules/`, `__pycache__/`,
  `.DS_Store`, `Thumbs.db`, common binary extensions); an
  `image_metadata` extractor that surfaces EXIF / XMP / IPTC
  metadata for JPEG/PNG/TIFF/WebP as searchable chunks; and a
  `ProgressTracker` whose `IndexStatus` lifecycle is polled by the
  renderer's `useIndexingProgress` hook to drive a live progress
  card in `SourceDetailPage`.
- **Block E — UI hardening**: New `useKeyboardShortcuts` hook
  registers Ctrl/Cmd+N/S/E/F/,/1–7 + Escape at the document level;
  Sidebar items render their hint via `aria-keyshortcuts`. `Modal`
  gained a proper focus trap (Tab cycling), `aria-labelledby`
  wired to the title, focus restoration to the previously active
  element on close, and an opt-in `closeOnOverlayClick={false}`
  for destructive dialogs. `Toast` gained a dismiss button, an
  `aria-label`'d notification region, `role="alert"` for error
  toasts, and timer cleanup that survives StrictMode double-mount.
  Dark mode tokens were added to `tokens.css` (selector-based
  override + `prefers-color-scheme` fallback) and the renderer's
  `useTheme` hook applies the user's choice from Settings.
- **Block F — Production readiness**: A root `ErrorBoundary`
  renders Reload / Report / Dismiss when the renderer throws. The
  Electron main process gained a JSONL logger
  (`apps/desktop/electron/logger.ts`) writing to
  `~/.config/Tessera/logs/tessera.log` with 5-file × 10 MB
  rotation, plus `uncaughtException` / `unhandledRejection`
  handlers that route through the same logger. The new
  `.github/workflows/release.yml` builds AppImage / .deb / .rpm /
  .dmg / NSIS exe on `v*` tags via `electron-builder` and attaches
  them to a GitHub Release with an auto-generated changelog from
  `git log <prev>..<tag>`.
- **Block G — Documentation**: This changelog entry; the Phase 9
  section above; README's Stack / Templates / Editors / Keyboard
  shortcuts updates; ARCHITECTURE's adapter-priority and ignore /
  image-metadata module call-outs; PHASES' Phase 9 row.

### 2026-05-20 (Phase 8)
- **Block A (delivered for real)**: Phase 7's intended surface — Mermaid /
  Marp / Typst rendering, Lucide + Phosphor icons, DOCX / XLSX export
  modules, Infographic & Landing Page artifact types, and the CI matrix
  workflow — was actually wired into source in Phase 8. Phase 7 checkboxes
  describe the intended surface; this changelog entry records the work that
  brought source up to match them.
- **Block B — Remote connectors (5)**: `tessera_connectors::onedrive` (Graph
  API, delta sync), `notion` (OAuth + search + page block extraction),
  `jira` (3LO OAuth + JQL `updated` filter), `confluence` (CQL +
  `body.storage` expansion), and `figma` (file/project listing + node-tree
  text extraction). Each registers in `registry.rs`, surfaces in
  `SourcesPage`, and ships mocked-HTTP integration tests in the pattern of
  `gdrive.rs`.
- **Block C — Product surfaces**: `TasksPage` (todo / in-progress / done /
  blocked columns, priority badges, drag-and-drop reordering, source
  references, due dates) backed by `tessera_artifacts::tasks` and a typed
  IPC surface; `AutomationsPage` (scheduled index refreshes,
  template-triggered workflows) backed by a scheduler service in Electron
  main that uses a promise-based `activeTick` / `queuedRunNow` state
  machine so manual "Run Now" clicks always produce an observable tick and
  `will-quit` can drain in-flight work. 10 new templates: Plan
  (meeting-agenda, project-plan, task-list, launch-checklist,
  meeting-notes, brief) and Approve (purchase-approval, budget-approval,
  policy-exception, vendor-review).
- **Block D — Base views (4)**: `KanbanView`, `CalendarView`, `TimelineView`,
  `GalleryView` under `editors/baseviews/`, plus a five-way switcher in
  `BaseEditor` (Grid | Kanban | Calendar | Timeline | Gallery). All four
  views read and write the same canonical `BaseContent` JSON; the
  view-config (which select field drives Kanban columns, which date field
  drives Calendar, etc.) lives in editor state — never persisted to the
  artifact — so switching views never dirties the document. Calendar
  click-to-create and drag-to-reschedule, Timeline minimum-visible-width
  (0.5%) for single-day bars, Gallery responsive grid with optional cover
  image.
- **Block E — Workflows, Mermaid, icon embedding, integration tests**:
  `CreatePage` reorganised into Create / Analyze / Plan / Approve tabs with
  three "Workflow"-badged Analyze shortcuts (Summarize sources, Generate
  report, Analyze spreadsheet) that resolve to existing templates with
  workflow-specific hint copy. Mermaid blocks now round-trip end-to-end
  through the HTML, PDF, and Markdown exporters. Icon tokens
  (`{{icon:...}}`) are now format-aware on export — inline `<svg>` for
  HTML / DOCX (via `embedIcons`), `[name]` text placeholders for the
  minimal PDF builder (via `iconsToTextPlaceholder`), untouched in
  Markdown — and the Typst PDF pipeline keeps inline SVG via Typst's
  native vector rendering. Integration tests for `mermaidRenderer`,
  `marpRenderer`, `iconResolver`, `IconPicker`, all 5 new connectors, and
  all 3 new export modules.
- **Block F — Documentation**: New top-level `PHASES.md` phase index;
  PROGRESS.md grew a Phase 7 fixup note + the Phase 8 task table + this
  changelog entry + a refreshed MVP feature summary that now lists the
  five new connectors, the new product surfaces, the new template
  categories, and the four new Base views. README.md and ARCHITECTURE.md
  updated with the CI badge, the new connectors, the new editors, the new
  rendering services, and a refreshed repository layout.
- **Tests**: +60 vitest cases (10 baseViews, 11 ArtifactEditorPage draft /
  icon export, 3 CreatePage workflows, plus connector / scheduler /
  resolver coverage) and +40 cargo tests (5 new connectors, 3 new export
  modules) — final counts 386 vitest + 403 cargo, all green.

### 2026-05-20 (Phase 7)
- Linux first-class platform: AppImage/.deb/.rpm packaging, llama-server-linux
  download script, Vulkan + AVX2/AVX-512 detection, libsecret-backed keyring
- Mermaid integration: renderer service, TipTap node, slide diagram block,
  export pipeline support (HTML / PDF / Markdown)
- Marp Core integration: renderer service, Shadow-DOM isolated live preview
  in SlideEditor, Marp CLI–backed PPTX export, training/pitch templates
- Typst integration: Rust crate dependency, minimal `World`, document PDF/SVG
  export via IPC
- Export coverage: `tessera_export::docx` and `tessera_export::xlsx` modules
- Icon system: Lucide adopted across components, Phosphor icon picker, shared
  `iconResolver` with inline-SVG export embedding
- New artifact types: Infographic (with stats-overview / process-flow /
  comparison templates) and Landing Page (with SaaS product template),
  including grammars in `tessera_runtime`
- CI: matrix workflow for Ubuntu 22.04 / macOS 13 / Windows 2022 running
  `cargo test --all`, `npm test`, `cargo clippy -D warnings`, `npm run lint`,
  and `npm run type-check`
- Documentation: README, ARCHITECTURE, PROPOSAL, CONTRIBUTING, SECURITY all
  updated for Linux, new artifact types, new export formats, and rendering
  integrations; PHASES.md added as a top-level phase index


### 2026-05-19 (Platform-aware models + UI wiring)
- Model registry rewritten around 1.58-bit ternary weights — `Q1_0_g128` (GGUF) on Windows / Linux / macOS Intel, `2-bit` (MLX) on macOS Apple Silicon. Removed the incorrect `Q4_K_M` labelling and the inflated ~1.1 GB size for the 1.7B model; actual sizes (1.7B ≈ 248 MB MLX / 450 MB GGUF, 4B ≈ 600 MB / 1.0 GB, 8B ≈ 1.2 GB / 2.0 GB) are now in `crates/tessera_runtime/src/config.rs` and `sidecars/models.json`.
- Platform detection (`detect_platform`, `detect_compute_backends`) and platform-aware `select_model(tier, platform)` added; manager wired to use them.
- Linux added as a first-class target — AppImage + `.deb` (x64, arm64), Vulkan / CUDA / ROCm compute backends, ARM NEON / dotprod on arm64.
- Real Windows RAM detection via PowerShell `Get-CimInstance` with `wmic` fallback; cross-platform RAM parse tests (Linux `/proc/meminfo`, macOS `sysctl`, both Windows paths).
- Single-model enforcement: only one model weight ever lives on disk. Swap deletes the old file before downloading the new one; SHA-256 verified after download.
- Sidecar install scripts (`download-llama-server.{sh,ps1}`) take `--compute=cpu|cuda|vulkan|rocm`, look up the variant in `sidecars/models.json`, track the installed variant, and refuse incompatible combinations (ROCm only on `linux-x64`, etc.).
- UI: SettingsPage Model Runtime card, RuntimeStatus model info, CreatePage generation flow (sources → Generate → ArtifactEditorPage with token streaming), SourcesPage connector status + Drive picker + multi-source compare, SourceDetailPage Extract Tasks & Decisions, ArtifactEditorPage Export Evidence Pack with native save dialog.
- Per-platform `electron-builder` configs under `packaging/{linux,macos,windows}/`.
- Tests: +25 (21 manifest-loading + single-model + 4 CreatePage flow), bringing the renderer suite to 72 passing.

### 2026-05-19 (Phase 5-6)
- Phase 5 completed: Google Drive connector — OAuth 2.0, secure token storage (OS keychain), file/folder picker, incremental sync (Changes API), metadata sync, local indexing, disconnect flow, connector status UI, audit events
- Phase 6 completed: PRD/Proposal/SOP/QBR generators, budget/vendor/risk templates, task/decision extraction, source comparison, review checklist, evidence pack export
- Infrastructure: tessera_connectors crate, runtime IPC wiring, sidecar download scripts, packaging configs, JSON schemas
- Testing: 213 Rust tests + 47 TypeScript tests (260 total), wiremock integration tests for Google Drive API

### 2026-05-19 (continued)
- Phase 2 fix: Source detail page implemented, IPC wired to Rust N-API bridge
- Phase 3 completed: Template/artifact JSON schemas, TipTap document editor, slide editor, sheet editor, base editor, citation panel, version history, PDF export, template gallery IPC integration
- Phase 4 completed: Runtime manager, sidecar lifecycle, health checks, Ternary-Bonsai 1.7B/4B/8B support, streaming generation, GBNF structured output, runtime status UI
- Bug fixes: TemplatesPage inverted UX, artifact store silent parse-error fallback

### 2026-05-19
- Phase 0 completed: CONTRIBUTING.md, SECURITY.md, desktop app skeleton, build system
- Phase 1 completed: Electron shell, React renderer, IPC layer, N-API bridge, all screens, config persistence
- Phase 2 completed: Local folder/file indexing, file watcher, content hashing, text extraction, chunking, encrypted storage, hybrid search
