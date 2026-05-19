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

**Status:** `IN PROGRESS`

**Goal:** Clean, safe, open-source base.

### Build

| Item | Status |
|---|---|
| Repository created | `DONE` |
| MIT license | `DONE` |
| Contribution guide | `NOT STARTED` |
| Security policy | `NOT STARTED` |
| Architecture document | `DONE` |
| Product proposal | `DONE` |
| Progress tracker | `DONE` |
| Desktop app skeleton | `NOT STARTED` |

### Exit criteria

- [ ] Public repo ready with license, contribution guide, and security policy.
- [ ] App name, license, and contribution model are clear.
- [ ] Build system works locally.

---

## Phase 1 — Desktop shell

**Status:** `NOT STARTED`

**Goal:** Tessera runs on macOS and Windows as a desktop application.

### Build

| Item | Status |
|---|---|
| Electron app with main process | `NOT STARTED` |
| React renderer with TypeScript | `NOT STARTED` |
| TypeScript IPC layer | `NOT STARTED` |
| Rust N-API bridge | `NOT STARTED` |
| Home screen | `NOT STARTED` |
| Sources screen | `NOT STARTED` |
| Templates screen | `NOT STARTED` |
| Settings screen | `NOT STARTED` |
| Local config persistence | `NOT STARTED` |

### Exit criteria

- [ ] App launches on macOS and Windows.
- [ ] Renderer calls Rust through Electron main via typed IPC.
- [ ] Settings persist across restarts.
- [ ] Coherent desktop shell with Home, Sources, Templates, and Settings.

---

## Phase 2 — Local source indexing

**Status:** `NOT STARTED`

**Goal:** Local folders and files are searchable within Tessera.

### Build

| Item | Status |
|---|---|
| Add local folder source | `NOT STARTED` |
| Add local file source | `NOT STARTED` |
| File watcher (new/changed/deleted) | `NOT STARTED` |
| Content hashing and deduplication | `NOT STARTED` |
| Text extraction (PDF, DOCX, PPTX, XLSX, CSV, MD, TXT, HTML, JSON) | `NOT STARTED` |
| Chunking pipeline | `NOT STARTED` |
| Local evidence storage (encrypted) | `NOT STARTED` |
| Basic hybrid search (FTS5 + vector + recency) | `NOT STARTED` |
| Source detail page | `NOT STARTED` |

### Exit criteria

- [ ] User selects a folder and Tessera indexes it locally.
- [ ] Search returns relevant results with source path, excerpt, and page/section.
- [ ] No network required for local indexing and search.

---

## Phase 3 — Templates and artifacts

**Status:** `NOT STARTED`

**Goal:** Users can create work artifacts from templates backed by indexed sources.

### Build

| Item | Status |
|---|---|
| Template schema (YAML) | `NOT STARTED` |
| Artifact schema | `NOT STARTED` |
| Template gallery UI | `NOT STARTED` |
| Document editor (ProseMirror/TipTap) | `NOT STARTED` |
| Slide editor | `NOT STARTED` |
| Sheet editor (grid) | `NOT STARTED` |
| Base editor (grid view) | `NOT STARTED` |
| Citation panel | `NOT STARTED` |
| Version history | `NOT STARTED` |
| Export: Markdown, HTML, CSV, PDF | `NOT STARTED` |

### Exit criteria

- [ ] User selects a template and sources, Tessera creates an editable artifact with citations.
- [ ] Citations link back to source material with provenance.
- [ ] User can export artifacts to Markdown, HTML, CSV, and PDF.

---

## Phase 4 — Local model runtime

**Status:** `NOT STARTED`

**Goal:** Local generation from indexed knowledge using on-device models.

### Build

| Item | Status |
|---|---|
| Local runtime manager | `NOT STARTED` |
| Sidecar start/stop lifecycle | `NOT STARTED` |
| Health checks and status reporting | `NOT STARTED` |
| Ternary-Bonsai 1.7B support | `NOT STARTED` |
| Ternary-Bonsai 4B support | `NOT STARTED` |
| Ternary-Bonsai 8B support | `NOT STARTED` |
| Streaming generation | `NOT STARTED` |
| Structured output parsing (GBNF) | `NOT STARTED` |
| Runtime status UI | `NOT STARTED` |

### Exit criteria

- [ ] User generates a document draft from local sources with local model inference.
- [ ] Generation runs entirely locally.
- [ ] User can see the active model and runtime status.
- [ ] Failed states are handled gracefully.

---

## Phase 5 — First remote connector (Google Drive)

**Status:** `NOT STARTED`

**Goal:** Validate the connected-source ingestion pattern with Google Drive.

### Build

| Item | Status |
|---|---|
| OAuth 2.0 flow | `NOT STARTED` |
| Secure token storage (OS keychain) | `NOT STARTED` |
| File/folder picker | `NOT STARTED` |
| Incremental sync | `NOT STARTED` |
| Metadata sync | `NOT STARTED` |
| Local indexing of selected Drive files | `NOT STARTED` |
| Disconnect flow (remove index, revoke tokens) | `NOT STARTED` |
| Connector status UI | `NOT STARTED` |
| Audit events for connect/sync/disconnect | `NOT STARTED` |

### Exit criteria

- [ ] User connects Google Drive, selects a folder, and Tessera indexes selected files.
- [ ] Artifacts can cite Google Drive files.
- [ ] Disconnecting removes local index and revokes access.

---

## Phase 6 — Productivity workflows

**Status:** `NOT STARTED`

**Goal:** Make Tessera valuable for real work with useful artifact types and workflows.

### Build

| Item | Status |
|---|---|
| PRD generator | `NOT STARTED` |
| Proposal generator | `NOT STARTED` |
| SOP generator | `NOT STARTED` |
| QBR generator | `NOT STARTED` |
| Budget tracker template | `NOT STARTED` |
| Vendor register template | `NOT STARTED` |
| Risk register template | `NOT STARTED` |
| Task/decision extraction from sources | `NOT STARTED` |
| Source comparison | `NOT STARTED` |
| Review checklist | `NOT STARTED` |
| Export evidence pack | `NOT STARTED` |

### Exit criteria

- [ ] Several useful artifact types generated from source material.
- [ ] Artifacts are editable with citations preserved.
- [ ] Local-first default maintained for all workflows.

---

## MVP feature set summary

| Category | Details |
|---|---|
| **Platforms** | macOS, Windows |
| **Sources** | Local folders, local files |
| **Artifacts** | Documents, Slides, Sheets, Bases |
| **Templates** | PRD, Proposal, SOP, QBR, Budget tracker, Vendor register, Risk register |
| **Runtime** | Local sidecar, Ternary-Bonsai 1.7B / 4B / 8B |
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
