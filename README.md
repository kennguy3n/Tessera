# Tessera

> Tessera is a local-first open-source productivity workspace for creating documents, slides, sheets, and bases from your own files and connected sources.

---

## Design system

Tessera's UI follows the **KChat design system** ([https://kchat.com](https://kchat.com)).

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

## What Tessera does

- **Index local folders and files** — point Tessera at any folder and it indexes the content locally.
- **Connect approved external sources** — Google Drive, OneDrive/SharePoint, Notion, Jira, Confluence, Figma.
- **Create documents, slides, sheets, and bases from templates** — pick a template, select sources, generate a draft.
- **Generate source-backed drafts** — outlines, summaries, tables, plans, and reports grounded in your knowledge.
- **Review citations and provenance** — every generated section links back to the source material it drew from.
- **Export completed work** — Markdown, HTML, PDF, DOCX, CSV, XLSX, PPTX.

## What Tessera is not

- **Not a chat app** — Tessera produces structured work artifacts, not conversation threads.
- **Not a messaging client** — there is no inbox, no contacts list, no real-time messaging.
- **Not a cloud-first assistant** — your data stays local by default; remote sources are explicitly connected.
- **Not a general chatbot wrapper** — Tessera is a productivity workspace, not a chat UI over an LLM API.

---

## Core principles

1. **Local-first by default** — data lives on your machine; nothing leaves without explicit action.
2. **Open source** — MIT-licensed, auditable, extensible.
3. **User-controlled sources** — you decide which folders, files, and services Tessera can access.
4. **Source-backed generation** — every generated artifact cites the sources it used.
5. **Editable artifacts, not chat transcripts** — Tessera produces documents, slides, sheets, and bases you can edit, not throwaway chat messages.
6. **Transparent citations** — click any citation to see the original source, excerpt, page, and confidence.
7. **Secure desktop boundaries** — the renderer never touches files, tokens, or model binaries directly; everything goes through a secure IPC boundary.

---

## Platforms

| Platform | Status |
|---|---|
| macOS (Intel & Apple Silicon) | Planned |
| Windows (x64) | Planned |

Desktop only. Supports **CPU-only** and **CPU+GPU** configurations.

Local optimization:

- **MLX** — Apple Silicon (macOS)
- **llama.cpp** (PrismML fork) with **AVX2 / AVX-VNNI / AVX-512 VNNI** — CPU (Windows)
- **Vulkan / CUDA** — GPU (Windows)

---

## Planned source connectors

| Connector | Type |
|---|---|
| Local folders | Local |
| Local files | Local |
| Google Drive | Remote |
| OneDrive / SharePoint | Remote |
| Notion | Remote |
| Jira | Remote |
| Confluence | Remote |
| Figma | Remote |

## Planned artifact types

| Artifact | Description |
|---|---|
| Documents | PRDs, proposals, SOPs, reports, memos |
| Slides | QBRs, strategy decks, review presentations |
| Sheets | Budgets, scorecards, roadmaps, trackers |
| Bases | Vendor registers, risk registers, roadmap tables |
| Forms | Intake forms, surveys, checklists |
| Plans | Project plans, task lists, launch checklists |
| Reports | Generated reports from source analysis |

---

## Stack summary

| Layer | Technology |
|---|---|
| Desktop shell | Electron |
| UI framework | React + TypeScript |
| Core engine | Rust |
| Local storage | SQLite / SQLCipher |
| Model runtime | llama.cpp / PrismML sidecar |
| Apple Silicon acceleration | MLX |
| Electron ↔ Rust bridge | N-API |
| Packaging | electron-builder |

---

## Architecture overview

Tessera is structured as an Electron desktop application with a React/TypeScript renderer, a Rust core engine accessed via N-API, and a local model sidecar for inference. The Electron main process enforces a strict security boundary between the renderer and native capabilities.

For the full technical architecture, see [ARCHITECTURE.md](ARCHITECTURE.md).

---

## Knowledge substrate

Tessera uses [**kennguy3n/knowledge**](https://github.com/kennguy3n/knowledge) as the local memory and retrieval substrate.

The knowledge substrate provides:

- **Encrypted local storage** — SQLite/SQLCipher with per-scope encryption.
- **Evidence ingestion** — append-only, content-hash deduplicated storage.
- **Hybrid retrieval** — FTS5 full-text search + vector similarity + temporal recency.
- **Observation extraction** — entity and fact extraction from raw evidence.
- **Concept graph** — higher-order synthesized entities and relationships.
- **Memory management** — decay state machine, retention scoring, working memory.
- **Cryptographic forgetting** — permanent data deletion by destroying scope-specific DEKs.

The substrate is a modular 20-crate Rust architecture (`evidence_store`, `observation_engine`, `memory_manager`, `concept_graph`, `synthesis_pipeline`, `inference_router`, `crypto`, `ffi`, `napi`, `export_plane`, and more).

---

## Local model support

| Tier | Model | Use case |
|---|---|---|
| Lightweight | Ternary-Bonsai 1.7B | Quick drafts, extraction, tagging |
| Balanced | Ternary-Bonsai 4B | Normal generation |
| Higher quality | Ternary-Bonsai 8B | Longer reports, complex artifacts |

- **CPU and CPU+GPU** support on Windows (AVX2 minimum, AVX-VNNI/AVX-512 VNNI when available; Vulkan/CUDA for GPU).
- **MLX** on macOS Apple Silicon.

---

## Repository layout

```
tessera/
├── apps/
│   └── desktop/
│       ├── electron/        # Electron main process
│       └── renderer/        # React/TypeScript UI
├── crates/                  # Rust core engine crates
├── sidecars/                # Model runtime sidecar binaries
├── templates/               # YAML artifact templates
├── schemas/                 # Artifact and template schemas
├── packaging/               # electron-builder configs, platform installers
├── docs/                    # Additional documentation
├── LICENSE                  # MIT
├── README.md
├── PROPOSAL.md
├── ARCHITECTURE.md
└── PROGRESS.md
```

---

## License

MIT — see [LICENSE](LICENSE).

---

## Links

- [PROPOSAL.md](PROPOSAL.md) — full product proposal
- [ARCHITECTURE.md](ARCHITECTURE.md) — technical architecture
- [PROGRESS.md](PROGRESS.md) — phased delivery tracker
- [kennguy3n/knowledge](https://github.com/kennguy3n/knowledge) — local knowledge substrate
