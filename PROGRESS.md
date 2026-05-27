# Tessera — Progress Tracker

> ## Tracking-integrity note
>
> Phase 7 was initially marked `DONE` in an earlier revision of this
> document before all of its features were wired into source — the
> actual integration code shipped in Phase 8. To prevent recurrence,
> the project ships a smoke-test suite (`npm run test:smoke`) that
> asserts every claimed feature is backed by importable, callable
> production code, not just documentation. The phase-exit checklist
> in `CONTRIBUTING.md` codifies the gates a maintainer must clear
> before flipping a phase to `DONE`, and the smoke suite runs in CI
> on every PR so a regression in a closed phase blocks the next
> phase from closing.
>
> If you spot a feature listed in this document that has no
> corresponding code or test, please open an issue with the
> `tracking-integrity` label so the discrepancy is logged rather
> than silently re-discovered.

## Overview

This document tracks Tessera's phased delivery from open-source foundation
to a complete local-first productivity workspace with KChat (Mattermost-v4)
collaboration baked in.

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

### Build

| Item | Status |
|---|---|
| PRD / Proposal / SOP / QBR generators | `DONE` |
| Budget / Vendor / Risk register templates | `DONE` |
| Task & decision extraction | `DONE` |
| Source comparison | `DONE` |
| Review checklist | `DONE` |
| Export evidence pack | `DONE` |

### Exit criteria

- [x] Several useful artifact types generated from source material.
- [x] Local-first default maintained for all workflows.

---

## Phase 7 — Linux, rendering integrations, new generators, export coverage

**Status:** `DONE` (implementation completed in Phase 8 — see note below)

> **Note on delivery cadence.** Phase 7 closed its checklist before all of the
> integrations were actually wired into source. The rendering services
> (Mermaid / Marp / Typst), icon families (Lucide / Phosphor), new artifact
> types (Infographic / Landing Page), and the DOCX / XLSX export modules were
> all landed for real in **Phase 8** as part of the same PR.

### Build

| Block | Item | Status |
|---|---|---|
| A | Linux packaging (AppImage / `.deb` / `.rpm` via electron-builder) | `DONE` |
| A | Linux sidecar download scripts and `models.json` entries | `DONE` |
| A | Linux runtime detection (AVX2 / AVX-512 / Vulkan / NEON / dotprod / ROCm) | `DONE` |
| A | Linux sidecar supervision + libsecret keyring | `DONE` |
| A | Linux CI workflow (matrix: Ubuntu / macOS / Windows) | `DONE` |
| B | `mermaid` renderer service + theme integration | `DONE` |
| B | Mermaid TipTap block in DocumentEditor | `DONE` |
| B | Mermaid handling in export pipeline (HTML / PDF / Markdown) | `DONE` |
| C | Marp Core renderer service | `DONE` |
| C | Marp mode in SlideEditor with Shadow-DOM-isolated live preview | `DONE` |
| C | Marp CLI–backed PPTX / HTML / PDF export | `DONE` |
| D | Typst Rust crate + minimal `World` | `DONE` |
| D | DOCX export module | `DONE` |
| D | XLSX export module | `DONE` |
| E | Lucide React adoption | `DONE` |
| E | Phosphor icons + `IconPicker` | `DONE` |
| F | Infographic artifact type | `DONE` |
| F | LandingPage artifact type | `DONE` |

---

## Phase 8 — Connectors, surfaces, views, missing features

**Status:** `DONE`

Five additional remote connectors landed (OneDrive/SharePoint, Notion,
Jira, Confluence, Figma), the Tasks / Plans and Automations surfaces
were added with a real scheduler, four new Base views (Kanban /
Calendar / Timeline / Gallery) ship alongside the existing Grid view,
the Analyze workflows on `CreatePage` reach into the indexed corpus
through the real bridge, end-to-end Mermaid + icon export coverage
was completed across all output formats, and the Phase 7 integration
gap was closed.

---

## Phase 9 — Feature pass: missing templates, citations, external LLM, UI hardening

**Status:** `DONE`

### Build

| Block | Item | Status |
|---|---|---|
| A | Missing template set (Form, Asset inventory, Tracker, Inventory, Roadmap-as-Base) | `DONE` |
| B | `tessera_citations::freshness` + `replace_citation` + `remove_citation` + UI flows | `DONE` |
| C | `tessera_runtime::external_provider` (OpenAI / Anthropic / custom) + adapter chain | `DONE` |
| D | `tessera_sources::ignore` (`.gitignore`-style), `image_metadata` (EXIF/XMP/IPTC), incremental re-index progress | `DONE` |
| E | Keyboard shortcuts, modal focus trap, dismissible toasts, dark mode tokens | `DONE` |
| F | Root `ErrorBoundary`, structured JSONL logger, release workflow | `DONE` |

---

## Phase 10 — Production hardening

**Status:** `DONE`

### Build (Blocks A–F)

| Block | Item | Status |
|---|---|---|
| A | Documentation sweep (PROGRESS / PHASES / ARCHITECTURE / README / PROPOSAL / CONTRIBUTING / IPC_AUDIT) | `DONE` |
| B | Hybrid retrieval UX — embedding backfill IPC + UI, `HybridSearchConfig` Settings UI, relevance percentages in `CitationPanel` | `DONE` |
| C | Security hardening — password vault (PBKDF2-SHA256 + AES-256-GCM fallback), CSP per-connector image allow-list, IPC rate limiter, export-path containment, extracted-item validation + HTML escape | `DONE` |
| D | External provider SSE streaming, retry, token counting, model listing, cancellation UX | `DONE` |
| E | Comprehensive testing & accessibility audit | `DONE` |
| F | HomePage breakdown, template-validation audit logging, structured source comparison modal | `DONE` |

---

## Phase 11 — Multi-capability model slots (vision + image generation)

**Status:** `DONE`

**Goal:** Make Tessera multi-modal — first-class vision (image / chart / PDF
understanding) and on-device image generation (diffusion) capabilities,
alongside the existing text capability.

### Build (Blocks A–F)

| Block | Item | Status | PR |
|---|---|---|---|
| A | Multi-capability model slots — text / vision / imagegen slots in the model registry, per-slot installed-model storage, `ModelCapability` discriminator across the bridge surface | `DONE` | #33 |
| B | Vision + diffusion sidecars and bridges — llama.cpp `mmproj`-aware vision sidecar, stable-diffusion.cpp diffusion sidecar, native shutdown helpers, model-format requirements (`mmprojSizeMb` mandatory on vision GGUFs) | `DONE` | #34 |
| C | Vision-powered indexing — image VLM extraction, PDF OCR via VLM, chart extractor (`tessera_sources::vision_extractor`, `pdf_extractor`), strict single-filter DCTDecode + partial-OCR retry sentinel | `DONE` | #35, #36 |
| D | Image-generation editor integration — wire imagegen into infographic + landing-page editors (Block D, Task 12) | `DONE` | #38 |
| E | Vision page UI — file picker + capability mode toggle + save-as-Document (Tasks 13-16); per-slot `ModelRuntimeCard` filtering | `DONE` | #39 |
| F | Per-capability Settings panels — independent vision + imagegen slot management, sane defaults per-platform | `DONE` | #40 |

### Exit criteria

- [x] Vision capability is selectable from a per-slot model registry; vision
      sidecar boots independently of the text sidecar.
- [x] Image generation runs against a diffusion sidecar wired into the
      infographic + landing-page editors.
- [x] Indexing pipeline uses the vision sidecar to extract content from images,
      PDFs, and charts; partial-extraction is sentinel-tagged so retries are
      idempotent.
- [x] Settings exposes per-capability model slots so an operator can run text
      without vision, vision without imagegen, etc.
- [x] ARM64 NEON / dotprod / ROCm runtime detection paths exist for Linux.

---

## Phase 12 — KChat (Mattermost v4) integration

**Status:** `DONE` (Blocks A–D)

**Goal:** Treat a KChat workspace as a first-class evidence + collaboration
source — index channel files and posts, share artifacts back to channels,
and surface real-time updates with the same security posture as the rest of
the connector framework.

### Build (Blocks A–D)

| Block | Item | Status | PR |
|---|---|---|---|
| A | KChat integration foundation — `KchatClient` (Mattermost v4 REST + WebSocket), `KchatAuthService` (PAT vault), `kchat:*` IPC surface, `KchatSettingsCard`, `KchatChannelSourcePicker`, `KchatSidebarSection`, `ShareToKchatModal` | `DONE` | #42 |
| B Task 1 | WebSocket-driven event pipe with backpressure (`KchatEventForwarder`), seq-gap fallback poll, bounded ring buffer, audit-on-throw | `DONE` | #43 |
| B Task 2 | Single-file targeted sync (`sources:addKchatChannel` re-entry on `file_added`), fast-path containment, idempotent registration | `DONE` | #44 |
| B Task 3 | KChat channel ACL projection (`user_added` / `user_removed` / `channel_member_updated` → `bridgeRefreshKchatAcl`) | `DONE` | #45 |
| B Task 4 | Cryptoshred-on-revoke for KChat sources — DEK wipe, fs-scrub observability, regrant auto-resync | `DONE` | #46 |
| C Tasks 1+2 | KChat post indexing with per-source DEK + column AEAD (`kchat_crypto.rs`, `kchat_posts` table, AEAD round-trip path) | `DONE` | #47 |
| C Task 4 | Historical backfill watermark loop — `KchatBackfillState`, automation-driven backfill, drain-on-quit, idempotency | `DONE` | #48 |
| D Task 1 | KChat content retrieval bridge — `bridge_search_kchat_posts`, `KchatPostSearchHit`, `kchat:searchPosts` IPC with rate-limited audit | `DONE` | #49 |

### Exit criteria

- [x] User connects to KChat via PAT, picks channels, and Tessera indexes
      channel files locally with the same hybrid-search surface as folder
      sources.
- [x] Real-time WebSocket events are mapped to the Tessera bridge and trigger
      targeted re-syncs (file_added / user_added / user_removed / channel
      deletion) without full channel re-walks.
- [x] Revoking a KChat source crypto-shreds its DEK and audits the
      filesystem-scrub outcome.
- [x] Posts are indexed under a per-source DEK with AEAD on every encrypted
      column; backfill is watermarked and resumable.
- [x] Hybrid search returns post-sourced chunks with KChat permalink
      composition + `KchatPostSearchExecuted` audit row.

---

## Phase 13 — KChat extension bridge & polish

**Status:** `IN PROGRESS`

**Goal:** Re-architect the KChat integration so Tessera can run as an
*extension* of a locally-running `uney-chat-desktop` instance. When the
desktop app is available, Tessera delegates auth to its authenticated
session; when it isn't, Tessera falls back to the existing PAT path. Plus a
sweep of retrieval + testing + documentation + polish tasks driven by Devin
Review feedback on Blocks A–D.

### Build

Theme 1 — uney-chat-desktop extension bridge

| # | Item | Status |
|---|---|---|
| 1 | `kchatExtensionBridge.ts` — IPC-based discovery protocol, per-platform handshake socket, PAT fallback | `DONE` (PR #51) |
| 2 | `kchatExtensionSession.ts` — scoped delegated token, vault tagging (`extension-delegated`), expiry / refresh (auto-refresh timer fires `REFRESH_MARGIN_MS` before expiry; `onRefreshSuccess` listener rotates the in-memory `KchatClient.token`) | `DONE` (PR #51) |
| 3 | `kchatExtensionEvents.ts` — desktop-app → `KchatWebSocketEventView` event translation | `DONE` (PR #51) |
| 4 | Extension-aware `KchatAuthService` — `authMode: "pat" \| "extension"` surfaced through `kchat:status`; symmetric teardown ordering (`authMode = "none"` before `client.shutdown()`) across all four shutdown sites | `DONE` (PR #51) |
| 5 | `KchatSettingsCard` "Connect via KChat Desktop" primary + PAT fallback under "Manual connection" disclosure | `DONE` (PR #51) |
| 6 | `KchatSidebarSection` desktop-app connectivity indicator + amber-on-disconnect transition | `DONE` (PR #51) |
| 7 | Extension IPC audit + SSRF guard on the extension socket (re-validated on vault restore); `kchat:extensionStatus` / `extensionConnect` / `extensionDisconnect` channels with per-channel rate limits | `DONE` (PR #51) |
| 8 | Extension integration test suite — discovery, handoff, event forwarding, disconnect, PAT fallback, concurrent attempts, SSRF, refresh-failure invalidation, stale-authMode push regression | `DONE` (PR #51) |

Theme 2 — KChat content retrieval completion

| # | Item | Status |
|---|---|---|
| 9 | KChat post search results render in `CitationPanel` with chat icon, sender, channel | `DONE` (PR #52) |
| 10 | KChat backfill progress UI — `kchat:backfillProgress` IPC + progress bar on `SourceDetailPage` | `DONE` (PR #52) |
| 11 | KChat channel file preview — thumbnails + metadata in `KchatChannelSourcePicker` | `DONE` (PR #52) |
| 12 | KChat share-to-channel evidence pack end-to-end path | `DONE` (PR #52) |
| 13 | KChat post threading support — `fetch_kchat_thread_context(post_id)` surfacing parent thread on a hit | `DONE` (PR #52) |

Theme 3 — Testing hardening

| # | Item | Status |
|---|---|---|
| 14 | KChat post ingest AEAD round-trip test (post → DEK → ciphertext → decrypt → cryptoshred) | `DONE` (PR #53) |
| 15 | Hybrid search with KChat posts test (RRF ordering, revocation excludes posts) | `DONE` (PR #53) |
| 16 | Extension bridge unit tests for token expiry + refresh | `DONE` (PR #53) |
| 17 | Scheduler + KChat backfill interaction test (production code: new `backfill_kchat_channel` action kind on `AutomationAction`) | `DONE` (PR #53) |
| 18 | Export-path containment rejects writes into KChat cache dirs (production fix: new `denyRoots` parameter on `isSafeExportPath`; wired into all four export-path call sites) | `DONE` (PR #53) |
| 19 | Preload contract test covers `kchat:extension*` channels (and full 17-channel master list) | `DONE` (PR #53) |

Theme 4 — Documentation

| # | Item | Status |
|---|---|---|
| 20 | `PHASES.md` recreated | `DONE` |
| 21 | `PROGRESS.md` recreated | `DONE` |
| 22 | `ARCHITECTURE.md` updated — KChat directory listing under repo layout, `kchat.ts` / `audit.ts` / `vision.ts` / `imagegen.ts` in IPC tree, `kchat_crypto.rs` / `vision_extractor.rs` / `pdf_extractor.rs` mentioned in `tessera_sources` blurb, dedicated "KChat integration" section with extension-bridge data flow diagram and seven key invariants | `DONE` (Theme 4 / PR #54) |
| 23 | `README.md` updated — KChat row in Source connectors table; new "KChat integration" subsection covering dual-mode auth, what gets indexed (AEAD, watermarked backfill, cryptoshred), retrieval surfaces (RRF, thread context), evidence-pack share, scheduler action | `DONE` (Theme 4 / PR #54) |
| 24 | `CHANGELOG.md` updated — 7 Added + 3 Changed + 4 Tests entries under `[Unreleased]` covering Phase 13 Themes 1–3 | `DONE` (Theme 4 / PR #54) |
| 25 | `docs/IPC_AUDIT.md` updated — added missing `kchat:fetchThreadContext` row with real rate-limit profile (5/s burst 10) and input shape; documented export-path deny-list invariant below `artifacts:*` table | `DONE` (Theme 4 / PR #54) |
| 26 | `PHASES.md` / `PROGRESS.md` consistency audit — Tasks 1–19 flipped to `DONE` with PR-link attribution, exit criteria checkboxes updated, three new dated changelog entries (#51 / #52 / #53) | `DONE` (Theme 4 / PR #54) |

Theme 5 — Remaining polish

| # | Item | Status |
|---|---|---|
| 27 | KChat source-type icon in `SourcesPage` | `IN PROGRESS` |
| 28 | KChat disconnect cleanup for extension mode | `DONE` (in `kchatAuth.ts.disconnect()`) |
| 29 | Dark-theme KChat components audit | `IN PROGRESS` |
| 30 | Linux-specific KChat extension discovery (`$XDG_RUNTIME_DIR/tessera-kchat-extension.sock`) | `DONE` (in `extensionSocketPath()`) |

### Exit criteria

- [x] `kchat:status` reports `authMode` (`"none" | "pat" | "extension"`) and
      `kchat:extensionStatus` reports `available` so the renderer can light
      up the right UX without polling the bridge. *(Theme 1 / PR #51)*
- [x] Handshake / refresh / disconnect over the extension socket carries a
      scoped, time-limited token; the desktop app's master credentials never
      enter Tessera's vault. Auto-refresh rotates `KchatClient.token` via
      `onRefreshSuccess` before expiry; refresh-failure nulls the session
      so subsequent `refresh()` calls throw "no active session".
      *(Theme 1 / PR #51)*
- [x] Event bridge translates desktop-app events to the existing
      `KchatWebSocketEventView` shape so `KchatEventForwarder` /
      `KchatSidebarSection` stay unchanged in their downstream logic.
      *(Theme 1 / PR #51)*
- [x] Citations from KChat posts render with chat semantics in
      `CitationPanel` (chat icon, `#channel @sender`, threaded indicator);
      backfill progress is observable from `SourceDetailPage` via the
      `useKchatBackfillProgress` hook (2 s poll, transport-failure
      self-heal at 3 consecutive failures). *(Theme 2 / PR #52)*
- [x] Thread context (up to 3 parents) surfaces on threaded hits via
      `fetch_kchat_thread_context` (Rust `SourceStore` → `SourceManager` →
      N-API bridge → `kchat:fetchThreadContext` IPC). *(Theme 2 / PR #52)*
- [x] AEAD round-trip, revocation-excludes-posts (cross-source isolation),
      RRF scoring-axis consistency, BM25-through-AEAD ordering, scheduler
      `backfill_kchat_channel` action, export-path deny-list, token
      expiry + refresh + invalidation, and preload contract tests all
      pass locally. *(Theme 3 / PR #53)*
- [x] Documentation matches reality: every `ipcMain.handle(` / typed
      preload entry / surface mentioned in PROPOSAL appears in
      ARCHITECTURE / README / IPC_AUDIT. *(Theme 4 / PR #54: added
      `kchat:fetchThreadContext` to IPC_AUDIT, full KChat directory
      listing in ARCHITECTURE repo layout, dedicated "KChat
      integration" sections in both ARCHITECTURE and README.)*
- [ ] Remaining polish: KChat source-type icon, dark-theme audit,
      Linux extension discovery hardening (Theme 5).

---

## Phase changelog

### 2026-05-27 — Phase 13 Theme 3 (PR #53)

- **Task 14** — AEAD full-lifecycle round-trip integration tests on
  `tessera_sources::manager`: ingest → DEK wrap → ciphertext → decrypt →
  cryptoshred → regrant → re-ingest → search; plus thread-context
  retrieval across a cryptoshred boundary.
- **Task 15** — Hybrid search regression battery: scoring-axis
  consistency between file and post search (RRF `1.0 / (rank + 1.0)`),
  revocation-takes-effect-immediately on the same manager instance,
  BM25 ordering preserved through AEAD verification, cross-source
  revocation isolation.
- **Task 16** — `KchatExtensionSession` token expiry + refresh tests:
  fake-timer-driven auto-refresh at `REFRESH_MARGIN_MS`, refresh
  failure invalidates the session (subsequent `refresh()` throws
  "no active session"), already-expired tokens classified as
  `protocol-error`, multi-refresh chain (1 → 2 → 3 → 4 token rotations).
- **Task 17** — Scheduler interaction with KChat backfill: new
  `backfill_kchat_channel` action kind on `AutomationAction`; `runAutomation`
  reads the `getKchatBackfillImpl()` slot from `appState` and invokes
  it with `channel_id`; errors are recorded via
  `bridgeRecordAutomationRun(status: "failed")` so the next tick
  respects `interval_seconds`. Five tests: dispatch ok, impl null,
  missing channel_id, impl throws, mixed reindex + backfill in one
  tick.
- **Task 18** — Export-path deny-list (production fix): `isSafeExportPath`
  accepts an optional `denyRoots` parameter that is checked BEFORE the
  allow-list. `getDenyExportRoots()` returns
  `~/.tessera/kchat-channels` so a compromised renderer cannot
  overwrite the KChat channel cache via an export IPC and inject
  attacker-controlled content the connector would later ingest. Wired
  into all four export-path call sites in `ipc/artifacts.ts`. Nine
  containment tests cover prefix-overlap, escape-via-`..`, deny
  covering allow, empty deny-list passthrough.
- **Task 19** — Preload contract test: reads `preload.ts` source text
  and asserts every entry of `EXPECTED_KCHAT_CHANNELS` (the 17-channel
  master list) has a matching `ipcRenderer.invoke("<channel>")`
  string. Catches the "handler registered but missing from preload →
  silently unreachable from renderer" failure mode that the
  bidirectional master-list assertion alone cannot detect.

### 2026-05-26 — Phase 13 Theme 2 (PR #52)

- **Task 9** — KChat post citation name enrichment: `CitationPanel`
  resolves `#channel @sender` for every post hit via two module-scoped
  `KchatNameCache` LRUs (500-entry user-id cache, 200-entry channel-id
  cache; both empty-string-rejecting and reconnect-safe).
- **Task 10** — Backfill progress UI: new `kchat:backfillProgress` IPC
  with live counters (`postsIngested`, `oldestFetched`) maintained by
  the orchestrator; `useKchatBackfillProgress` hook (2 s poll,
  cancel-safe, transport-failure self-heal at 3 consecutive failures)
  drives a progress card on `SourceDetailPage` with idle / active /
  complete / error states.
- **Task 11** — Channel file preview: file-row metadata enrichment
  (type-family icon + filename + TYPE + SIZE + "Uploaded by @user on
  date"); `KchatClient.listChannelFiles` / `getFileInfo` validate
  `user_id` at the deserialisation boundary; shared
  `populateKchatUsernameCache()` between citation and file-preview
  enrichment.
- **Task 12** — Evidence-pack share-to-channel end-to-end: stands up a
  localhost HTTP server imitating KChat's `/api/v4/files` endpoint
  and exercises a REAL `KchatClient` over the wire (no mocks below
  `KchatClient.uploadFile`); validates multipart format, byte-exact
  markdown body, SHA-256 evidence-pack hash, `Authorization: Bearer`
  plumbing, audit-row emission on success and on pack-only failure
  (no phantom audit on primary failure).
- **Task 13** — Thread context: `fetch_kchat_thread_context(post_id)`
  on `SourceStore` (Rust); `SourceManager::fetch_kchat_thread_context`
  → N-API bridge → `kchat:fetchThreadContext` IPC (rate-limited, name
  enrichment reuses the shared LRUs); up-to-3 parent messages surface
  on threaded hits.

### 2026-05-25 — Phase 13 Theme 1 (PR #51)

- **Task 1** — `kchatExtensionBridge.ts`: IPC-based discovery
  protocol, per-platform handshake socket (Linux `$XDG_RUNTIME_DIR`,
  macOS Application Support, Windows named pipe), PAT fallback.
- **Task 2** — `kchatExtensionSession.ts`: scoped delegated token,
  vault tagging (`extension-delegated`), expiry + refresh lifecycle
  with auto-refresh scheduled `REFRESH_MARGIN_MS` before expiry; the
  `onRefreshSuccess` listener rotates the in-memory
  `KchatClient.token` so downstream REST calls always carry a fresh
  bearer.
- **Task 3** — `kchatExtensionEvents.ts`: translates desktop-app
  events to the existing `KchatWebSocketEventView` shape so
  `KchatEventForwarder` / `KchatSidebarSection` stay unchanged in
  their downstream logic.
- **Task 4** — Extension-aware `KchatAuthService`: `authMode: "none" |
  "pat" | "extension"` surfaced through `kchat:status`; symmetric
  teardown ordering (`authMode = "none"` BEFORE `client.shutdown()`)
  across all four shutdown sites (`handleExtensionRefreshFailure`,
  `handleExtensionDisconnect`, `teardownExtension`, `disconnect`).
- **Task 5** — `KchatSettingsCard`: "Connect via KChat Desktop"
  primary CTA, PAT under "Manual connection" disclosure; re-probes
  extension state on every `onStatusChange` push.
- **Task 6** — `KchatSidebarSection`: desktop-app connectivity
  indicator with amber-on-disconnect transition.
- **Task 7** — Extension IPC audit + SSRF guard on the extension
  socket, re-validated on vault restore (defence-in-depth against
  SSRF policy tightening and tampered vault entries);
  `kchat:extensionStatus` / `extensionConnect` / `extensionDisconnect`
  channels with per-channel rate limits.
- **Task 8** — Extension integration test suite: discovery, handoff,
  event forwarding, disconnect, PAT fallback, concurrent attempts,
  SSRF, refresh-failure invalidation, stale-authMode push regression
  (4 shutdown sites covered).

### 2026-05-27 — Phase 13 opens

- Recovered `PROGRESS.md` and `PHASES.md` from `phase10-final-docs-close`
  baseline (Phase 10 → DONE) and brought them forward with the actual
  shipped state of Phase 11 (PRs #33-#40) and Phase 12 (PRs #42-#49).
- Opened the 30-task Phase 13 plan covering the uney-chat-desktop
  extension bridge, KChat content-retrieval polish, testing hardening,
  documentation sweep, and remaining polish.

### 2026-05-26 — Phase 12 Block D Task 1 (PR #49)

- KChat content retrieval bridge: `tessera_sources` exposes
  `bridge_search_kchat_posts` over AEAD-verified post chunks.
- `kchat:searchPosts` IPC handler (rate-limited under the
  `kchat:searchPosts` profile) composes `kchat://` permalinks and
  audits the call via `KchatPostSearchExecuted` (hashed query).
- `KchatPostSearchHit` renderer wire type ships with the
  citation-badge metadata the UI panel renders alongside the excerpt.

### 2026-05-26 — Phase 12 Block C Task 4 (PR #48)

- Historical backfill watermark loop — automation-driven backfill of
  past KChat posts, durable watermark, drain-on-quit, idempotency
  across restarts.

### 2026-05-26 — Phase 12 Block C Tasks 1+2 (PR #47)

- KChat post indexing with a per-source DEK and column-level AEAD on
  every encrypted field (`kchat_crypto.rs`, `kchat_posts` table).

### 2026-05-26 — Phase 12 Block B Task 4 (PR #46)

- Cryptoshred-on-revoke for KChat sources — DEK destruction,
  filesystem-scrub observability on the audit row, regrant auto-resync.

### 2026-05-26 — Phase 12 Block B Task 3 (PR #45)

- KChat channel ACL projection — `user_added` / `user_removed` /
  `channel_member_updated` translate into `bridgeRefreshKchatAcl`.

### 2026-05-26 — Phase 12 Block B Task 2 (PR #44)

- Sync-engine integration: targeted single-file sync on `file_added`,
  fast-path containment, idempotent KChat source registration.

### 2026-05-26 — Phase 12 Block B Task 1 (PR #43)

- WebSocket-driven event pipe with backpressure — bounded ring
  buffer, seq-gap reconciliation poll, audit-on-throw, drop-warn
  rate limiting at the WS trust boundary.

### 2026-05-25 — Phase 12 Block A (PR #42)

- KChat integration foundation: `KchatClient`, `KchatAuthService`,
  `kchat:*` IPC, Settings card, channel picker, sidebar, share-to-KChat
  modal.

### 2026-05-25 — Phase 11 Blocks A–F (PRs #33-#40)

- Multi-capability model slots, vision + diffusion sidecars, VLM-powered
  indexing, image-generation editor integration, Vision page UI,
  per-capability Settings panels.

### 2026-05-23 — Phase 10 close (PRs #21-#31)

- Phase 10 production hardening across hybrid retrieval UX, security,
  external-provider SSE streaming, template / artifact expansion,
  testing & accessibility audit, documentation sweep, HomePage
  breakdown, structured source-comparison modal.

### Earlier phases

See git history under `git log --grep='Phase \d'` for the full record.
