# Tessera

[![CI](https://github.com/kennguy3n/Tessera/actions/workflows/ci.yml/badge.svg)](https://github.com/kennguy3n/Tessera/actions/workflows/ci.yml)

> Tessera is a local-first open-source productivity workspace for creating documents, slides, sheets, bases, infographics, and landing pages from your own files and connected sources.

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
| macOS (Intel & Apple Silicon) | Available |
| Windows (x64) | Available |
| Linux (x64, arm64) | Available |

Download installers from the [Releases](https://github.com/kennguy3n/Tessera/releases) page. Unsigned builds are fully functional; code-signed builds require CI secrets (see [CONTRIBUTING.md](CONTRIBUTING.md) and [RELEASING.md](RELEASING.md)).

Desktop only. Supports **CPU-only** and **CPU+GPU** configurations.

Local optimization:

- **MLX 2-bit** — Apple Silicon (macOS)
- **llama.cpp** (PrismML fork) with **GGUF Q1_0_g128** ternary repack — Windows, Linux, macOS Intel
- **CPU acceleration** — AVX2 minimum, AVX-VNNI / AVX-512 VNNI, ARM NEON / dotprod
- **GPU acceleration** — Vulkan / CUDA (Windows, Linux), ROCm (Linux), Metal (macOS Apple Silicon)

---

## Source connectors

| Connector | Type | Status |
|---|---|---|
| Local folders | Local | Available |
| Local files | Local | Available |
| Google Drive | Remote | Available |
| OneDrive / SharePoint | Remote | Available |
| Notion | Remote | Available |
| Jira | Remote | Available |
| Confluence | Remote | Available |
| Figma | Remote | Available |
| KChat (Mattermost v4) | Remote (chat) | Available |

Every remote connector follows the same shape as `tessera_connectors::gdrive`: OAuth 2.0
flow, OS-keychain token storage, file/folder (or page/issue/file) picker, incremental
sync via the provider's native delta / `updated` / `last_modified` filter, metadata
sync, local indexing through the existing extraction → chunking → FTS5 pipeline,
clean disconnect that revokes tokens and removes indexed content, and audit events
for connect/sync/disconnect.

KChat is the exception to the OAuth shape because it doesn't model chat
as "files" — see the [KChat integration](#kchat-integration) section
below for its dual-mode auth (extension vs. personal access token),
WebSocket-driven event pipe, and post-level AEAD.

### KChat integration

KChat (a Mattermost-v4-compatible chat server) is supported as both a
**source** (channels, posts, and files are indexed and become
retrievable evidence) and a **destination** (artifacts can be shared
into a channel, optionally with an evidence-pack ZIP). It's the only
connector that ships with its own dedicated UI surfaces.

**Two auth modes:**

- **Extension mode** — if a [`uney-chat-desktop`](https://github.com/uneycom/uney-chat-desktop)
  instance is running locally, Tessera connects to it over a
  per-platform handshake socket (Linux `$XDG_RUNTIME_DIR/tessera-kchat-extension.sock`,
  macOS Application Support, Windows named pipe) and receives a
  scoped, short-lived delegated token. The desktop app's master
  credentials never enter Tessera's vault. The token auto-refreshes
  before expiry; the in-memory `KchatClient.token` rotates via an
  `onRefreshSuccess` listener so downstream REST calls always carry a
  fresh bearer.
- **PAT mode** — manual fallback when the extension isn't available
  (or the user prefers a personal access token). Standard `kchat:connect`
  flow with the token stored in the vault under provider `kchat`.

**What gets indexed:**

- Channel files (PDF, DOCX, PPTX, XLSX, MD, TXT, images, etc.) flow
  through the same extraction → chunking → FTS5 + vector pipeline as
  every other connector.
- Channel posts are indexed with **column-level AEAD**: a per-source
  DEK encrypts post body / sender display name / channel name on
  `kchat_posts` with AES-256-GCM. The plaintext FTS5 column carries
  only the queryable text; the canonical body is verified on every
  search hit before being surfaced to the renderer.
- Historical backfill is **watermarked and resumable** — the
  orchestrator drains on `will-quit` and resumes from the last
  watermark on the next launch. Progress is observable from
  `SourceDetailPage` via the `useKchatBackfillProgress` hook (2 s
  poll, transport-failure self-heal).
- **Cryptoshred on revoke** — disconnecting a KChat source destroys
  the per-source DEK and deletes the post rows; AEAD-sealed chunks on
  disk are unrecoverable thereafter.

**Retrieval surfaces:**

- `kchat:searchPosts` — AEAD-verified post search; results render in
  `CitationPanel` as `#channel @sender` with chat semantics.
- `kchat:fetchThreadContext` — up-to-3 parent messages surface on
  threaded hits so retrieval includes the conversational context
  that motivated the matched post.
- File hits coexist with post hits under a single Reciprocal Rank
  Fusion (RRF) scoring axis, so the renderer can merge them without
  type-aware re-scoring.

**Sharing artifacts back to KChat:**

- `kchat:shareArtifact` uploads the artifact as Markdown to a
  channel, optionally with a SHA-256-verified evidence-pack ZIP.
  Audit rows are emitted for both successful and pack-only-failure
  paths; primary-upload failures are *not* audited (no phantom
  records for an unchanged channel).

**Automation:**

- The scheduler supports a `backfill_kchat_channel` action kind, so a
  user can configure periodic backfill sweeps on a channel without a
  manual button-press.

### Google Drive connector

- **OAuth 2.0** — standard consent flow via system browser, localhost redirect, token refresh
- **Secure token storage** — OS keychain via Electron safeStorage (macOS Keychain, Windows Credential Manager)
- **File/folder picker** — browse and multi-select files from Drive within Tessera
- **Incremental sync** — Google Drive Changes API for efficient delta updates
- **Metadata sync** — name, mimeType, modifiedTime, size, permissions, parents
- **Local indexing** — downloaded files pipe through the existing extraction/chunking/FTS5 pipeline
- **Disconnect** — revokes OAuth tokens and removes all locally indexed Drive content
- **Audit events** — all connector lifecycle events (connect, sync, disconnect) logged

## Artifact types

| Artifact | Description |
|---|---|
| Documents | PRDs, proposals, SOPs, reports, memos, forms — plus industry-specific variants (clinical protocols, legal briefs, lesson plans, policy briefs, investment memos, audit findings, brand guidelines, campaign briefs, …) |
| Slides | QBRs, strategy decks, pitch decks, board / investor updates, onboarding decks, sales enablement, workshop decks |
| Sheets | Budgets, scorecards, roadmaps, trackers, product catalogs, sales forecasts |
| Bases | Vendor registers, risk registers, roadmap tables, asset inventory, CRM, incident tracker, employee directory, compliance register — five views (Grid / Kanban / Calendar / Timeline / Gallery) over the same records |
| Infographics | Stats overview, process flow, comparison, KPI dashboard, organization chart, timeline |
| Landing pages | Hero / features / stats / testimonials / CTA sections — SaaS, event / conference, nonprofit cause, personal & agency portfolio — exportable as standalone HTML or PDF |

## Industry coverage

Templates ship pre-tagged for the following industries; the CreatePage industry filter surfaces them on demand. Templates without an `industry:` tag are industry-agnostic ("General").

| Industry | Sample templates |
|---|---|
| Healthcare | Clinical protocol, patient care plan, HIPAA incident report, discharge summary |
| Legal | Legal brief (IRAC), contract summary, compliance audit, case intake |
| Education | Lesson plan, course syllabus, student progress report, curriculum map |
| Government / Public Sector | Policy brief, grant proposal, impact assessment, public consultation report |
| Finance | Investment memo, financial analysis, audit findings, loan proposal |
| Manufacturing / Supply Chain | Quality control report, safety incident report, maintenance schedule |
| Retail / E-commerce | Product catalog, sales forecast |
| Nonprofit | Donor report, volunteer handbook, nonprofit cause landing |
| Creative / Marketing | Content calendar, brand guidelines, campaign brief, portfolio landing |
| Real Estate | Property analysis, lease summary |

## Language support

The ten most-used templates (PRD, proposal, SOP, report, meeting agenda, meeting notes, task list, form, budget, pitch) ship localized variants in nine languages besides English. Section titles and LLM prompts are translated and the prompt itself asks the model to respond in the target language. The CreatePage language filter switches the visible cards to a locale; non-localized templates default to English regardless of selection.

| Locale | Language | Variants shipped |
|---|---|---|
| `en` | English | All 100+ templates (default) |
| `es` | Spanish | Top 10 core templates |
| `fr` | French | Top 10 core templates |
| `de` | German | Top 10 core templates |
| `ja` | Japanese | Top 10 core templates |
| `zh` | Chinese (Simplified) | Top 10 core templates |
| `pt` | Portuguese | Top 10 core templates |
| `ko` | Korean | Top 10 core templates |
| `ar` | Arabic | Top 10 core templates |
| `hi` | Hindi | Top 10 core templates |

Localized templates live under `templates/<category>/locales/<locale>/<slug>.yaml` and share the same base id with a locale suffix (e.g. `prd-v1-es`). `crates/tessera_templates/tests/bundled_templates.rs` enforces that every non-English locale ships the full canonical set so the filter shows a consistent picker across languages.

## Productivity workflows

| Feature | Description |
|---|---|
| **Generators** | PRD, Proposal, SOP, QBR — select sources, generate structured draft with citations |
| **Analyze workflows** | `CreatePage` Analyze tab — Summarize sources, Generate report, Analyze spreadsheet — preselected shortcuts onto the report / analysis templates |
| **Plan & Approve templates** | Meeting agenda, Project plan, Task list, Launch checklist, Meeting notes, Brief, Purchase / Budget approval, Policy exception, Vendor review |
| **Tasks / Plans** | Dedicated `TasksPage` with status (todo / in-progress / done / blocked), priority badges, drag-and-drop reordering, source references, due dates; tasks can be created manually or extracted from indexed sources |
| **Automations** | Scheduled index refreshes and template-triggered workflows, driven by a scheduler service in Electron main with a `will-quit`-safe drain |
| **Task/Decision Extraction** | Keyword-proximity heuristics to extract actionable items from source material |
| **Source Comparison** | N-gram analysis comparing two source sets — common themes, differences, similarity score |
| **Review Checklist** | Generate checklists from source material for structured review |
| **Evidence Pack** | Export artifact + cited source excerpts + citation metadata as a single ZIP |

---

## Stack summary

| Layer | Technology |
|---|---|
| Desktop shell | Electron |
| UI framework | React + TypeScript, Lucide + Phosphor icons |
| Editor stack | TipTap / ProseMirror (documents), custom slide / sheet / base / infographic / landing editors |
| Diagram & slide rendering | Mermaid (diagrams), Marp Core + Marpit (slides), Typst (high-fidelity PDF / SVG) |
| Core engine | Rust |
| Local storage | SQLite / SQLCipher |
| Model runtime | llama.cpp / PrismML sidecar |
| Apple Silicon acceleration | MLX |
| External LLM provider *(optional)* | OpenAI-compatible / Anthropic / custom — real Server-Sent-Events streaming via `apps/desktop/electron/externalProviderStream.ts`, OS-keychain-stored API key, `AbortController` cancellation, disabled by default |
| Electron ↔ Rust bridge | N-API |
| Auto-updater | `electron-updater` wrapped behind `updates:*` IPC channels; ambient toast UX on the renderer side, opt-out from Settings |
| Packaging | electron-builder (AppImage / .deb / .rpm / .dmg / NSIS exe) |

## Security & hardening

Tessera layers five defense-in-depth controls on top of the baseline
SQLCipher-encrypted local store. Each is documented in
[ARCHITECTURE.md](ARCHITECTURE.md#defense-in-depth-controls) and pinned
with regression tests under `apps/desktop/electron/__tests__/`.

| Control | What it does |
|---|---|
| **Password vault fallback** | When Electron's `safeStorage` cannot reach an OS keyring (headless Linux, certain CI runners), Tessera derives a 256-bit key from a user passphrase via **PBKDF2-SHA256 (600 000 iterations)** and wraps the SQLCipher DB key + OAuth tokens + API keys with **AES-256-GCM**. The vault is unlocked at startup by an ephemeral `BrowserWindow` (`data:text/html`, `sandbox: true`, single-purpose preload). |
| **CSP per-connector image-source allow-list** | Replaces the prior wildcard `https:` image source with an explicit allow-list keyed off the connected providers — only the CDN hosts that ship thumbnails for the user's enabled connectors are allowed. |
| **IPC rate limiting** | Token-bucket rate limiter applied to expensive IPC channels (search, generate, indexing actions) so a compromised renderer cannot exhaust the main process. |
| **Export-path containment** | Renderer-initiated file writes resolve against an allow-list before reaching disk; symlinks and `..` traversal are rejected at the IPC boundary. |
| **Extracted-item validation + HTML escape** | Every batch of extracted tasks / decisions / risks the bridge surfaces is validated against a zod schema and the renderer-bound string fields are HTML-escaped before display so an attacker-controlled source file cannot inject script into the Tessera UI. |

Every `ipcMain.handle()` channel is enumerated, with its validation
strategy and auth flag, in [`docs/IPC_AUDIT.md`](docs/IPC_AUDIT.md).
CI fails if a new channel ships without an entry in that table.

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
- **Hybrid retrieval** — FTS5 lexical + `HashTrickEmbedding` vector similarity + temporal recency decay, fused via Reciprocal Rank Fusion (RRF, k=60). Configurable from the Settings page (hybrid toggle + recency half-life). See `crates/tessera_sources/src/hybrid.rs` and `embedding.rs`.
- **Observation extraction** — entity and fact extraction from raw evidence.
- **Concept graph** — higher-order synthesized entities and relationships.
- **Memory management** — decay state machine, retention scoring, working memory.
- **Cryptographic forgetting** — permanent data deletion by destroying scope-specific DEKs.

The substrate is a modular 20-crate Rust architecture (`evidence_store`, `observation_engine`, `memory_manager`, `concept_graph`, `synthesis_pipeline`, `inference_router`, `crypto`, `ffi`, `napi`, `export_plane`, and more).

---

## Local model support

Tessera ships **one** Ternary-Bonsai 1.58-bit weight on disk at a time. The file is selected automatically from the device tier (RAM) and the platform (format).

| Tier | Model | MLX (Apple Silicon) | GGUF (Windows / Linux / macOS Intel) | Use case |
|---|---|---|---|---|
| Low (< 4 GB RAM) | Ternary-Bonsai 1.7B | ~248 MB · 2-bit | ~450 MB · Q1_0_g128 | Quick drafts, extraction, tagging |
| Medium (4–8 GB) | Ternary-Bonsai 4B | ~600 MB · 2-bit | ~1.0 GB · Q1_0_g128 | Normal generation |
| High (8+ GB) | Ternary-Bonsai 8B | ~1.2 GB · 2-bit | ~2.0 GB · Q1_0_g128 | Longer reports, complex artifacts |

- **MLX 2-bit** is the preferred path on macOS Apple Silicon (smaller file, memory-bandwidth advantage).
- **GGUF Q1_0_g128** (PrismML llama.cpp ternary repack — not Q4_K_M) is the path on every other platform.
- **CPU and CPU+GPU** support on Windows and Linux (AVX2 minimum, AVX-VNNI / AVX-512 VNNI when available; Vulkan / CUDA / ROCm for GPU). Linux additionally supports ARM NEON / dotprod on arm64.
- **Single-model storage** — only the recommended weight for your tier and platform is downloaded. Swapping tier deletes the prior file first so disk never holds two model variants.

---

## Quick start

### Prerequisites

- **Rust** 1.88+ (`rustup` recommended)
- **Node.js** 20+ and npm 10+
- **C toolchain** for SQLCipher compilation (gcc/clang on Linux/macOS, MSVC on Windows)
- **Python 3** on `PATH` — used by `sidecars/scripts/download-llama-server.sh` to resolve the correct `{url, sha256}` entry for your platform + compute backend from `sidecars/models.json`. Pre-installed on macOS and most Linux distros; on Windows install from [python.org](https://www.python.org/downloads/) or use `winget install Python.Python.3` (the equivalent PowerShell script does not need python3, but the bash script does and is what runs on macOS/Linux).
- **Linux only** — install Electron's native build prerequisites: `libsecret-1-dev`, `libgtk-3-dev`, `libnss3-dev`, `libasound2-dev`, `libxss1`, `libxtst6`, `xdg-utils` (Debian/Ubuntu — adjust for your distro)
- **Google API credentials** (optional, for Google Drive connector) — create a project in Google Cloud Console, enable the Drive API, and configure OAuth 2.0 credentials

### Setup

```bash
git clone https://github.com/kennguy3n/Tessera.git
cd Tessera
npm install
cargo build --all-targets
```

### Run tests

```bash
# Rust tests
cargo test --all

# TypeScript/React tests
npm test

# Lint
cargo clippy --all-targets --all-features
npm run lint --workspace=apps/desktop

# Type-check
npm run type-check --workspace=apps/desktop
```

### Development

```bash
# Start Vite dev server (renderer only — Electron shell requires packaging)
npm run dev --workspace=apps/desktop
```

---

## Editors

Tessera ships six real editor implementations — no stubs:

| Editor | Description |
|---|---|
| **Document** | TipTap (ProseMirror) rich text with headings, lists, code blocks, links, outline navigation, Mermaid diagram block |
| **Slides** | Ordered slide deck with thumbnails, content blocks, speaker notes, Marp Mode (Markdown + Shadow-DOM-isolated live preview), Diagram (Mermaid) block, Marp CLI–backed PPTX / HTML / PDF export |
| **Sheet** | Spreadsheet grid with formulas (SUM, AVERAGE, COUNT, MIN, MAX), CSV import, XLSX export with native formulas |
| **Base** | Database table with typed fields (text, number, date, select, checkbox, url), sorting, filtering, five views (Grid, Kanban, Calendar, Timeline, Gallery) over the same records |
| **Infographic** | Drag-and-drop sections with icon + heading + body + stat blocks, color theme selector, vertical / horizontal / grid layouts, live HTML preview |
| **Landing Page** | Hero / features / stats / testimonials / CTA editor with `IconPicker`, exports to standalone HTML or PDF |

All editors use debounced auto-save (2s) to the Rust backend via IPC.

---

## Local Model Runtime

```bash
# Download llama-server binary
./sidecars/scripts/download-llama-server.sh

# The app auto-detects device tier and suggests an appropriate model.
# Models are downloaded on-demand from the Settings → Model Runtime panel.
```

The runtime manager (`crates/tessera_runtime/`) handles device detection, model selection, sidecar lifecycle, health checks, streaming generation, and GBNF-constrained structured output.

---

## Repository layout

```
tessera/
├── apps/
│   └── desktop/
│       ├── electron/        # Electron main process (main.ts, preload.ts, ipc/, ipc.ts, scheduler.ts, marpExport.ts, typstExport.ts, autoUpdater.ts, cspImageSources.ts, dbKey.ts, exportPathSafety.ts, extractedItemValidation.ts, externalProviderStream.ts, passwordVault.ts, vaultCrypto.ts, passwordPromptPreload.ts, passwordPromptChannels.ts, secretsVault.ts, tokenVault.ts, modelManagement.ts, logger.ts, config.ts)
│       └── renderer/        # React/TypeScript UI
│           └── src/
│               ├── editors/         # Document, Slide, Sheet, Base, Infographic, LandingPage editors
│               │   ├── baseviews/       # KanbanView, CalendarView, TimelineView, GalleryView, types.ts
│               │   └── extensions/      # TipTap Mermaid extension
│               ├── services/        # mermaidRenderer, marpRenderer, iconResolver
│               ├── components/      # CitationPanel, VersionHistory, RuntimeStatus, IconPicker, Sidebar
│               ├── pages/           # HomePage, SourcesPage, TemplatesPage, CreatePage, ArtifactEditorPage, TasksPage, AutomationsPage, SettingsPage
│               └── hooks/           # useTasks, useAutomations, … React hooks for IPC
├── crates/                  # Rust core engine crates
│   ├── tessera_core/            # Shared types, config, errors (ArtifactType: Document/Slides/Sheet/Base/Infographic/LandingPage)
│   ├── tessera_bridge/          # N-API bridge layer
│   ├── tessera_sources/         # Source indexing, extraction, search
│   ├── tessera_templates/       # YAML template parsing and registry (Create / Analyze / Plan / Approve categories)
│   ├── tessera_artifacts/       # Artifact CRUD, version history, storage, tasks model
│   ├── tessera_citations/       # Citation tracking and provenance
│   ├── tessera_export/          # Markdown / HTML / CSV / JSON / PDF / Typst PDF / DOCX / XLSX exports + Mermaid integration
│   ├── tessera_connectors/      # Google Drive, OneDrive / SharePoint, Notion, Jira, Confluence, Figma connectors
│   ├── tessera_runtime/         # Local model runtime management
│   └── tessera_audit/           # Append-only audit logging
├── templates/               # YAML artifact templates
│   ├── documents/           # PRD, Proposal, SOP, Report, Memo, Form, Meeting agenda, Project plan, Task list, Launch checklist, Meeting notes, Brief, Purchase / Budget / Policy / Vendor approval flows
│   ├── slides/              # QBR, Strategy, Review, Training, Pitch
│   ├── sheets/              # Budget, Scorecard, Roadmap, Tracker, Inventory
│   ├── bases/               # Vendor Register, Risk Register, Decision Log, Asset Inventory, Roadmap
│   ├── infographics/        # Stats overview, Process flow, Comparison
│   ├── landing_pages/       # SaaS product, Nonprofit cause, Event / conference, Personal & agency portfolio
│   └── grammars/            # GBNF grammar files for structured LLM output
├── sidecars/                # Model sidecar binaries and manifests
│   ├── scripts/             # Platform download scripts for llama-server
│   └── models.json          # Model download manifest (URLs, checksums, sizes)
├── schemas/                 # JSON Schema for templates and artifacts
├── packaging/               # electron-builder configs, platform installers
├── docs/                    # Additional documentation
├── .github/workflows/ci.yml # CI configuration (Ubuntu / macOS / Windows matrix)
├── LICENSE                  # MIT
├── README.md
├── CONTRIBUTING.md
├── SECURITY.md
├── PROPOSAL.md
├── ARCHITECTURE.md
└── CHANGELOG.md
```

---

## Design system

Tessera's UI follows the **KChat design system**

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

Tessera also ships a complete dark theme. The renderer switches between
`Light` / `Dark` / `System` via the **Theme** setting on the Settings page;
the choice is applied through `[data-theme="dark"]` on the root element and
backed by a `prefers-color-scheme: dark` fallback so first-run users on a
dark OS desktop see dark mode immediately.

---

## Keyboard shortcuts

| Shortcut | Action |
|---|---|
| `Ctrl/Cmd + N` | New artifact |
| `Ctrl/Cmd + S` | Force save (in addition to auto-save) |
| `Ctrl/Cmd + E` | Export current artifact |
| `Ctrl/Cmd + F` | Focus search |
| `Ctrl/Cmd + ,` | Open Settings |
| `Ctrl/Cmd + 1..7` | Navigate to sidebar items |
| `Ctrl + Shift + C` | Toggle citation panel |
| `Escape` | Close modal / deselect |

Sidebar items announce their shortcut through `aria-keyshortcuts`, so they
also surface in screen-reader output and in browser dev-tools accessibility
trees.

---

## License

MIT — see [LICENSE](LICENSE).

---

## Links

- [PROPOSAL.md](PROPOSAL.md) — full product proposal
- [ARCHITECTURE.md](ARCHITECTURE.md) — technical architecture
- [CHANGELOG.md](CHANGELOG.md) — release changelog
- [CONTRIBUTING.md](CONTRIBUTING.md) — contribution guide
- [SECURITY.md](SECURITY.md) — security policy
- [kennguy3n/knowledge](https://github.com/kennguy3n/knowledge) — local knowledge substrate
