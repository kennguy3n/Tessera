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

**Status:** `DONE` (Themes 1–5 / PRs #51, #52, #53, #54, #55)

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
| 27 | KChat source-type icon in `SourcesPage` + `SourceDetailPage` (new `sourceTypeIcon()` helper, 📁 / 📄 / 💬 glyphs with humanised aria-labels) | `DONE` (Theme 5 / PR #55) |
| 28 | KChat disconnect cleanup for extension mode — full extension-mode `disconnect()` teardown regression test pins six invariants (extension vault wiped, PAT entry preserved, authMode flips to none, no stale-authMode push, idempotency) | `DONE` (Theme 5 / PR #55) |
| 29 | Dark-theme KChat components audit — CitationPanel KChat surface classes (`citation-source-badge-kchat`, `citation-item-kchat`, `citation-search-hit-kchat`, `citation-hit-kchat-*` family) now styled with theme tokens (chip-style badge + brand left-accent + muted secondary + theme-aware link); regression test pins token-only contract | `DONE` (Theme 5 / PR #55) |
| 30 | Linux-specific KChat extension discovery (`$XDG_RUNTIME_DIR/tessera-kchat-extension.sock`) — per-platform regression test pins all four discovery branches (Linux + XDG, Linux + fallback with uid-suffix collision safety, macOS, Windows named pipe) plus edge cases (empty XDG, missing getuid, freebsd parity, named-pipe namespace integrity) | `DONE` (Theme 5 / PR #55) |

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
- [x] Thread context (thread root + up to 2 earlier replies, 3 rows
      total) surfaces on threaded hits via `fetch_kchat_thread_context`
      (Rust `SourceStore` → `SourceManager` → N-API bridge →
      `kchat:fetchThreadContext` IPC). *(Theme 2 / PR #52)*
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
- [x] Remaining polish: KChat source-type icon on Sources +
      SourceDetailPage, dark-theme audit landing token-driven CSS for
      every KChat-specific class in CitationPanel, full-teardown
      regression test on `disconnect()` extension-mode path, and
      per-platform `extensionSocketPath()` regression test pinning the
      Linux `XDG_RUNTIME_DIR` discovery + multi-user collision-safe
      fallback. *(Theme 5 / PR #55)*

---

## Phase 14 — KChat Desktop integration via `.kcz` extension + loopback API + deeplinks

**Status:** `DONE` (Tasks 1–19 / PR #58 merged; Tasks 20–30 / this PR — docs + polish sweep)

**Goal:** Replace Phase 13's socket-bridge integration with the correct
architecture. Tessera and KChat Desktop are *two independent Electron
clients* that share only the KChat server backend; cross-app surface is
(a) a signed `.kcz` extension installed inside KChat Desktop talking to
Tessera over a loopback-only HTTP API on `127.0.0.1`, (b) `tessera://`
deeplinks for KChat Desktop → Tessera navigation, and (c) `kchat://`
deeplinks for Tessera → KChat Desktop navigation via
`shell.openExternal()`. No session handoff, no shared tokens, no
external IPC channel.

### Build

Theme 1 — `.kcz` extension + loopback API + deeplinks (Tasks 1–8, PR #58)

| # | Item | Status |
|---|---|---|
| 1 | `extensions/tessera-kchat/` — `.kcz` manifest, source (`index.tsx`, `client.ts`, `portFile.ts`, `types.ts`, `views/sources-panel.tsx`), README, build pipeline. Manifest declares procedures `kchat.query_messages` / `kchat.query_conversations` / `kchat.send_message` and contributes the `tessera.sources-panel` view to the rightbar slot. | `DONE` (PR #58) |
| 2 | `apps/desktop/electron/kchat/kchatLocalApi.ts` — loopback HTTP server bound to `127.0.0.1`, bearer-token auth (`crypto.randomBytes(32)` → base64url, timing-safe compare), Host-header SSRF guard, 64 KiB body cap, heartbeat tracked in `requireBearer()`. Discovery via `{userData}/tessera-kchat-port.json` (mode 0600 via atomic rename). | `DONE` (PR #58) |
| 3 | `apps/desktop/electron/kchat/kchatDeeplinkBridge.ts` — `tessera://` parse + build for `source/<id>`, `artifact/<id>`, `ingest?channel=&team=`. Pre-ready route parking; `open-url` + `second-instance` + Win/Linux cold-start argv-scan listeners. | `DONE` (PR #58) |
| 4 | `KchatSettingsCard` — single PAT connect path; "KChat Desktop detected" affordance renders when the local API's last extension heartbeat is fresher than 90 s. Button invokes `kchat://app/settings/extensions` deeplink via typed `openDesktopExtensions()` IPC. | `DONE` (PR #58) |
| 5 | `KchatSidebarSection` — per-channel "Open in KChat Desktop" buttons that invoke `kchat://app/conversation/<id>`. Bridge-health dot (green when fresh heartbeat, grey otherwise). | `DONE` (PR #58) |
| 6 | `apps/desktop/electron/ipc/kchat.ts` — `kchat:openInDesktop`, `kchat:openDesktopExtensions`, `kchat:desktopBridgeStatus` handlers. `shell.openExternal` for deeplinks. Shared rate-limiter bucket across both deeplink handlers so a runaway renderer can't multiply the OS-shell budget. | `DONE` (PR #58) |
| 7 | `extensions/tessera-kchat/scripts/build.mjs` — builds a `.kcz` archive (deterministic zip) installable via KChat Desktop's Settings > Developer > Extensions. `npm run build:kchat-extension` at the repo root. The walker throws on symlinks rather than silently dropping them. | `DONE` (PR #58) |
| 8 | `apps/desktop/electron/__tests__/kchatDesktopIntegration.test.ts` — 42 tests covering bind/discovery, auth + Host-header policy, route surface, deeplink parsing, bridge lifecycle, cold-start argv scanning, BUG_0001 port-file-write rollback, ANALYSIS_0007 null-address teardown, and a cross-cutting end-to-end client flow. | `DONE` (PR #58) |

Theme 2 — Concurrency hardening (Tasks 9–13, PR #58)

The `startKchatLocalApiServer()` / `stopKchatLocalApiServer()` pair landed
across multiple Devin Review rounds as a three-slot state machine that is
safe against every overlap of start and stop.

| # | Item | Status |
|---|---|---|
| 9 | `kchatLocalApiServer` slot — cached fast-path on subsequent `start()` calls. | `DONE` (PR #58, initial) |
| 10 | `kchatLocalApiServerPending` slot — concurrent starts coalesce onto a single in-flight `server.start()` instead of binding two ports. | `DONE` (PR #58, Round 11) |
| 11 | Stop-during-in-flight-start fix — `stopKchatLocalApiServer()` captures pending, clears it, then awaits before checking the server slot, so the start IIFE can't write a stale server reference after stop returns. | `DONE` (PR #58, Round 12) |
| 12 | `kchatLocalApiServerStopping` slot — start drains the stopping slot before constructing; stops serialise via the same slot (preventing double-`server.close()` which would raise `ERR_SERVER_NOT_RUNNING`). | `DONE` (PR #58, Round 15) |
| 13 | Seven race scenarios pinned by regression tests in `kchatLocalApiServerSingleton.test.ts` — concurrent-starts, sequential cached fast-path, stop-then-start cycle, stop-during-in-flight-start (success + rejection), start-during-in-flight-stop, concurrent-stops. | `DONE` (PR #58, Rounds 11/12/15) |

Theme 3 — Defence-in-depth + cross-platform deeplink coverage (Tasks 14–19, PR #58)

| # | Item | Status |
|---|---|---|
| 14 | Port-file-write failure rollback — wrap `writeAtomic()` in try/catch, close the bound socket and clear `this.server` / `this.boundPort` / `this.portFileAbsPath` on failure so the leaked listener doesn't hold an event-loop handle for the lifetime of the process. Regression test captures the kernel-assigned port from inside the failing writer, asserts `ECONNREFUSED`, and confirms a second `start()` succeeds. | `DONE` (PR #58, Round 8 BUG_0001) |
| 15 | `LocalApiErrorCode` wire-code/HTTP-status canonical mapping — added `payload_too_large` paired with 413 (was `invalid_request`) so extensions can branch on `code` to distinguish payload-size failures from malformed-body failures. Mirrored in `TesseraLocalApiError`. | `DONE` (PR #58, Round 10) |
| 16 | Asymmetric teardown on null-address branch in `KchatLocalApiServer.start()` — `server.close()` before the throw, symmetric with the wrong-address branch right below. Practically unreachable but if `node:net` ever surprises us with `address() === null` after a successful `listen()`, the listening socket would otherwise orphan for the process lifetime. Regression test uses the `createServerFn` injection seam. | `DONE` (PR #58, Round 13 ANALYSIS_0007) |
| 17 | Windows/Linux cold-start `tessera://` argv scan — `extractUrlFromArgv()` runs inside the `else` branch of the single-instance-lock check (primary instance only) and feeds any URL into `getKchatDeeplinkBridge().ingestRawUrl(url)` so it lands in the bridge's parking queue and gets FIFO-dispatched when the renderer consumer registers later in the `whenReady` chain. macOS uses `open-url` (covered by existing module-load listener); Win/Linux warm-start uses `second-instance`. | `DONE` (PR #58, Round 14 BUG_0001) |
| 18 | `restoreFromVault()` rollback policy docstring + mirroring NOTE comments on the two catch blocks in `kchatAuth.ts` — documents that `setToken(null)` rolls back the token but `serverUrl` is intentionally NOT rolled back (`setServerUrl("")` would silently fall back to `DEFAULT_KCHAT_SERVER` — a worse failure mode than the stale value — and the token-presence guard in `KchatClient.request()` prevents outbound traffic to the stale URL). | `DONE` (PR #58, Round 9 BUG_0001) |
| 19 | Hoist `shell` to a top-level `import { shell } from "electron"` in `apps/desktop/electron/ipc/kchat.ts`; dropped the two `await import("electron")` sites in the new deeplink handlers. CONTRIBUTING.md compliance — new code shouldn't propagate the pre-existing dynamic-import convention violation in `artifacts.ts`. | `DONE` (PR #58, Round 13 ANALYSIS_0001) |

Theme 4 — Documentation sweep (Tasks 20–26, this PR)

| # | Item | Status |
|---|---|---|
| 20 | `PHASES.md` — Phase 14 row added; Phase 13 marked as superseded by Phase 14 with explicit note that the socket-bridge surface was removed but the REST + PAT surface remains in production. | `DONE` (this PR) |
| 21 | `PROGRESS.md` — Phase 14 section (this section) with build table for Themes 1–5, exit criteria, and dated changelog entries; new `2026-05-27 — Phase 14` block added below. | `DONE` (this PR) |
| 22 | `ARCHITECTURE.md` — socket-bridge content removed (`kchatExtensionBridge.ts` directory entry, the extension-bridge data-flow diagram, the seven extension-bridge invariants); replaced with `.kcz` extension + loopback API + deeplink architecture: extension tree under `extensions/tessera-kchat/`, `kchatLocalApi.ts` / `kchatDeeplinkBridge.ts` in the IPC tree, new "KChat Desktop integration (Phase 14)" section with localhost-API data-flow diagram and the new set of invariants (loopback bind, bearer auth, Host SSRF guard, body cap, port file mode 0600, concurrency state machine, deeplink parking). | `DONE` (this PR) |
| 23 | `README.md` — KChat integration subsection rewritten: removed dual-mode auth language ("extension vs. PAT"), replaced with the single PAT path + passive "KChat Desktop detected" affordance + cross-app deeplink description. | `DONE` (this PR) |
| 24 | `CHANGELOG.md` — under `[Unreleased]`: 4 Added (`.kcz` extension, loopback HTTP API, `tessera://` deeplinks, `kchat:openInDesktop` IPC), 6 Changed (KChat extension bridge removed, Settings card UX, sidebar deeplink action, error-code wire contract, port-file write rollback, deeplink argv scan), 2 Removed (socket-bridge files, extension IPC handlers), 3 Tests (concurrency state machine, port-file rollback, cold-start argv scanning). | `DONE` (this PR) |
| 25 | `docs/IPC_AUDIT.md` — removed three `kchat:extension*` rows (channels no longer exist in preload), added three new rows for `kchat:openInDesktop` / `kchat:openDesktopExtensions` / `kchat:desktopBridgeStatus` with real rate-limit profiles and input shapes; the trust-boundary section rewritten to describe the loopback-API + bearer-token + Host-SSRF-guard model. | `DONE` (this PR) |
| 26 | `PHASES.md` / `PROGRESS.md` consistency audit — Tasks 1–30 attributed to PRs (PR #58 for Tasks 1–19, this PR for Tasks 20–30), exit criteria checkboxes updated. | `DONE` (this PR) |

Theme 5 — Remaining polish (Tasks 27–30, this PR)

| # | Item | Status |
|---|---|---|
| 27 | Stale comment / dead-code sweep — grep on HEAD for any remaining `kchatExtensionBridge` / `kchatExtensionSession` / `kchatExtensionEvents` / `extensionSocketPath` / `extension-delegated` mentions in code or tests confirms the only surviving references are historical mentions in this `PROGRESS.md` and the `CHANGELOG.md` `[Unreleased]` Removed block. No stale imports. | `DONE` (this PR) |
| 28 | `kchatLocalApiServer` JSDoc / cross-reference audit — both `startKchatLocalApiServer()` (lines 1158–1198) and `stopKchatLocalApiServer()` (lines 1252–1262) carry round-by-round cross-references to the Devin Review IDs so a maintainer who runs `git log -S 'ANALYSIS_0001'` or `git log -S 'BUG_0001'` lands on the relevant test + JSDoc + commit message in one search. | `DONE` (PR #58 Rounds 11–15; verified this PR) |
| 29 | Deeplink builder + parser round-trip coverage — `extensions/tessera-kchat/src/client.ts` and `apps/desktop/electron/kchat/kchatDeeplinkBridge.ts` already share types; this task verified `buildKchatDeeplink(channelId)` and `parseTesseraDeeplink(url)` round-trip cleanly for every supported route, with adversarial inputs (over-long ids, non-ASCII channel names, query-string injection) rejected by the existing assertion layer. | `DONE` (PR #58; verified this PR) |
| 30 | Phase 14 verification matrix — local: `npm run lint` (0 errors), `npm run type-check` (clean tsconfig + tsconfig.electron), `npm run test:ui` (1905/1905 passing), `npm run build:kchat-extension` (produces `extensions/tessera-kchat/releases/com.tessera.kchat-bridge@0.1.0.kcz`), `npm run test:kchat-extension` (extension build pipeline tests passing). | `DONE` (PR #58 + this PR) |

### Exit criteria

- [x] `extensions/tessera-kchat/` exists in source with a valid `manifest.json`,
      source tree, build pipeline, and README; `npm run build:kchat-extension`
      produces an installable `.kcz` archive. *(PR #58)*
- [x] `KchatLocalApiServer` binds to `127.0.0.1` exclusively (asserted by
      integration test), generates a 256-bit bearer token per process
      lifetime, writes the discovery file at mode 0600 via atomic
      rename, and validates the `Host` header against
      `/^127\.0\.0\.1(?::\d+)?$/` on every request. *(PR #58)*
- [x] `tessera://` deeplinks land on the correct route from all three
      entrypoints — macOS `open-url`, Win/Linux warm-start
      `second-instance`, Win/Linux cold-start argv scan in the
      single-instance-lock else branch. Pre-ready URLs are parked and
      replayed FIFO when the renderer consumer registers. *(PR #58)*
- [x] `kchat://app/conversation/<id>` and `kchat://app/settings/extensions`
      open via `shell.openExternal()` from `kchat:openInDesktop` and
      `kchat:openDesktopExtensions`, sharing a single rate-limiter bucket
      so a runaway renderer can't multiply the OS-shell budget. *(PR #58)*
- [x] `startKchatLocalApiServer()` / `stopKchatLocalApiServer()` are safe
      against every start/stop overlap (concurrent starts, stop-during-
      in-flight-start success, stop-during-in-flight-start rejection,
      start-during-in-flight-stop, concurrent stops) — 7 race scenarios
      pinned by regression tests. *(PR #58)*
- [x] Documentation matches reality — every preload `kchat:*` channel
      appears in `docs/IPC_AUDIT.md`, no surviving references to the
      removed socket-bridge surface in `ARCHITECTURE.md` / `README.md` /
      preload contract test, and the `.kcz` extension architecture is
      described end-to-end. *(this PR)*

---

## Phase changelog

### 2026-05-27 — Phase 14 docs sweep (this PR)

- **Tasks 20–26** — Documentation sweep. `PHASES.md` Phase 14 row added,
  Phase 13 marked as superseded by Phase 14 (socket bridge removed; REST +
  PAT surface unchanged). `PROGRESS.md` Phase 14 section added with build
  table for Themes 1–5 and exit criteria. `ARCHITECTURE.md` socket-bridge
  content replaced with the new `.kcz` + loopback API + deeplink
  architecture (extension tree under `extensions/tessera-kchat/`,
  `kchatLocalApi.ts` + `kchatDeeplinkBridge.ts` in the IPC tree, new
  "KChat Desktop integration (Phase 14)" section with data-flow diagram
  and invariants). `README.md` KChat integration subsection rewritten to
  the single-PAT-path + passive detection + cross-app deeplink model.
  `CHANGELOG.md` `[Unreleased]` block updated with Added / Changed /
  Removed / Tests entries describing the Phase 14 surface. `IPC_AUDIT.md`
  `kchat:extension*` rows removed, `kchat:openInDesktop` /
  `kchat:openDesktopExtensions` / `kchat:desktopBridgeStatus` rows
  added with real rate-limit profiles and input shapes.
- **Tasks 27–30** — Polish. Grep on HEAD confirmed no stale
  `kchatExtensionBridge` / `kchatExtensionSession` / `kchatExtensionEvents`
  / `extensionSocketPath` / `extension-delegated` imports survive — only
  historical mentions in `PROGRESS.md` and `CHANGELOG.md` `Removed` block.
  Deeplink builder / parser round-trip coverage verified across every
  route. Phase 14 verification matrix re-run: lint 0 errors, type-check
  clean, 1905 tests passing, `.kcz` archive builds successfully.

### 2026-05-27 — Phase 14 Tasks 1–19 (PR #58)

- **Tasks 1–8** — Replaced Phase 13's socket bridge with the correct
  architecture. `extensions/tessera-kchat/` scaffold + `.kcz` manifest +
  source + build pipeline. `apps/desktop/electron/kchat/kchatLocalApi.ts`
  loopback HTTP server (127.0.0.1, bearer-token, Host SSRF guard, 64 KiB
  body cap, port discovery at mode 0600). `apps/desktop/electron/kchat/
  kchatDeeplinkBridge.ts` `tessera://` parse + build + pre-ready
  parking + Win/Linux cold-start argv scan. Settings card single-PAT
  path + passive "KChat Desktop detected" affordance. Sidebar
  per-channel `kchat://app/conversation/<id>` buttons. `kchat:openInDesktop`
  / `kchat:openDesktopExtensions` / `kchat:desktopBridgeStatus` IPC.
  Removed: `kchatExtensionBridge.ts`, `kchatExtensionSession.ts`,
  `kchatExtensionEvents.ts`, `extensionSocketPath.test.ts`,
  `kchatExtension.test.ts`, three `kchat:extension*` preload channels.
- **Tasks 9–19** — Concurrency hardening (Rounds 11/12/15:
  pending-promise + stopping-promise slots; 7 race scenarios pinned by
  regression tests) + defence in depth (Round 8: port-file-write
  rollback closes the leaked listener; Round 10: `payload_too_large`
  paired with 413; Round 13: symmetric teardown on null-address branch;
  Round 14: Windows/Linux cold-start argv scan in the single-instance-
  lock else branch; Round 9: `restoreFromVault()` rollback policy
  docstring; Round 13: hoisted `shell` import).

### 2026-05-27 — Phase 13 Theme 5 (PR #55)

- **Task 27** — KChat source-type icon on `SourcesPage` +
  `SourceDetailPage`. New `sourceTypeIcon(sourceType)` helper in
  `utils/sourceLabels.ts` returns `{ glyph, ariaLabel }` for every
  known kind (📁 local_folder, 📄 local_file, 💬 kchat) with a
  graceful fallback (empty glyph, humanised aria-label) for unknown
  discriminators. Emoji glyphs match the existing
  `KchatChannelSourcePicker` `fileTypeIcon` convention so visual
  vocabulary is consistent across all surfaces. Rendered with
  `role="img"` + `aria-label` for screen readers. 9 new tests
  (6 unit + 2 SourceDetailPage integration + 1 SourcesPage
  integration).
- **Task 28** — Full extension-mode `disconnect()` teardown
  regression test. Existing test 5 covered the `teardownExtension()`
  PAT-switch path; test 8 covered the desktop-driven
  `handleExtensionDisconnect`. Neither pinned the user-initiated
  explicit `disconnect()` call (the most common cleanup path). New
  test 14 pins six invariants in a single end-to-end flow:
  precondition vault state, audit-userid return contract, post-
  disconnect authMode/vault state with PAT-entry preservation
  (deliberate UX guarantee at `kchatAuth.ts:535-541`), no
  stale-authMode `disconnected` push, idempotency on second call.
- **Task 29** — Dark-theme audit for KChat citation surfaces.
  Audit found that `KchatSidebarSection` / `KchatChannelSourcePicker`
  / `KchatSettingsCard` / `ShareToKchatModal` all already use theme
  tokens correctly. Real gap: `CitationPanel.tsx` references seven
  KChat-specific CSS class names (`citation-source-badge-kchat`,
  `citation-item-kchat`, `citation-search-hit-kchat`, the
  `citation-hit-kchat-*` family) that had NO CSS rules in either
  light or dark themes — the surface rendered as undecorated inline
  text. Theme 5 adds token-driven CSS: chip-style badge using
  `--color-primary-light`, 3px brand left-accent for KChat-derived
  rows, muted secondary text for metadata fragments, theme-aware
  link styling with `:focus-visible` outline. New regression test
  pins three invariants: every class has a rule, every rule uses
  only `var(--color-…)` references (no bare color literals), every
  token referenced is in the dark-mode-safe allow list.
- **Task 30** — Per-platform `extensionSocketPath()` regression
  test. The helper had no direct test coverage in
  `kchatExtension.test.ts` (every test passes an explicit
  `socketPath: server.socketPath`, bypassing production discovery).
  11 new cases pin all four discovery branches: Linux + `XDG_RUNTIME_DIR`
  set (freedesktop.org base-dir spec compliant per-user tmpfs path),
  Linux fallback with uid-suffix multi-user collision safety, macOS
  `~/Library/Application Support/Tessera/...`, Windows
  `\\.\pipe\tessera-kchat-extension` named pipe. Plus edge-case
  defences: empty `XDG_RUNTIME_DIR` treated as unset, missing
  `process.getuid` defaults to 0, freebsd takes the Linux path,
  Windows path has no tmpdir fragments (kernel-managed namespace),
  whitespace-only XDG documents `length > 0` semantics.

Phase 13 closes here. Local: vitest 1835/1835, tsc clean on both
configs, cargo workspace clean.

### 2026-05-27 — Phase 13 Theme 3 (PR #53, merged 19:32 UTC+7)

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

### 2026-05-27 — Phase 13 Theme 2 (PR #52, merged 17:12 UTC+7)

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
  enrichment reuses the shared LRUs); thread root + up to 2 earlier
  replies (3 rows total, chronologically ordered) surface on threaded
  hits.

### 2026-05-27 — Phase 13 Theme 1 (PR #51, merged 11:48 UTC+7)

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

### 2026-05-27 — Phase 13 opens (start of session)

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
