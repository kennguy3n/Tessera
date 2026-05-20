# Tessera — Progress Tracker

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

**Status:** `IN PROGRESS`

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

## MVP feature set summary

| Category | Details |
|---|---|
| **Platforms** | macOS (Intel & Apple Silicon), Windows (x64), Linux (x64, arm64 — AppImage / `.deb` / `.rpm`) |
| **Sources** | Local folders, local files, Google Drive (remote connector) |
| **Artifacts** | Documents, Slides, Sheets, Bases, Infographic, Landing Page |
| **Templates** | PRD, Proposal, SOP, QBR, Budget tracker, Vendor register, Risk register, Strategy, Review, Training, Pitch, Infographic (stats-overview / process-flow / comparison), Landing Page (SaaS product) |
| **Runtime** | Local sidecar, Ternary-Bonsai 1.58-bit (1.7B / 4B / 8B), MLX 2-bit on Apple Silicon, GGUF Q1_0_g128 (PrismML llama.cpp fork) everywhere else; Vulkan / CUDA / ROCm acceleration on Linux & Windows, Metal on macOS |
| **Rendering** | Mermaid (diagrams), Marp Core (slides), Typst (typesetting), Lucide + Phosphor (icons) |
| **Export** | Markdown, HTML, CSV, JSON, PDF, DOCX, PPTX, XLSX |
| **Packaging** | AppImage + `.deb` + `.rpm` (Linux), DMG + `.zip` (macOS), NSIS + portable `.zip` (Windows) |
| **Core** | Knowledge substrate, encrypted local store, hybrid retrieval, citations, audit trail, export |

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

## Links

- [README.md](README.md) — project overview
- [PROPOSAL.md](PROPOSAL.md) — product proposal
- [ARCHITECTURE.md](ARCHITECTURE.md) — technical architecture
- [kennguy3n/knowledge](https://github.com/kennguy3n/knowledge) — local knowledge substrate

---

## Changelog

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
