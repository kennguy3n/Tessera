# Changelog

All notable changes to Tessera are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Tessera
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- **KChat extension bridge.** Tessera now connects to a locally-running
  [`uney-chat-desktop`](https://github.com/uneycom/uney-chat-desktop)
  instance over a per-platform handshake socket (Linux
  `$XDG_RUNTIME_DIR`, macOS Application Support, Windows named pipe)
  and runs as an *extension* of the user's authenticated KChat session.
  The desktop app's master credentials never enter Tessera's vault —
  only a scoped, short-lived delegated token that auto-refreshes
  before expiry via `KchatExtensionSession.onRefreshSuccess`,
  rotating the in-memory `KchatClient.token` so downstream REST
  calls always carry a fresh bearer. PAT mode remains available as a
  manual fallback. `kchat:status` exposes `authMode`
  (`"none" | "pat" | "extension"`) so the UI lights up the right
  surfaces without polling.
- **KChat post citation rendering.** KChat post hits in `CitationPanel`
  render with chat semantics — chat icon, `#channel @sender`, threaded
  indicator. Two module-scoped `KchatNameCache` LRUs (500-entry user-id
  cache, 200-entry channel-id cache; both empty-string-rejecting and
  reconnect-safe) resolve display names from server ids via a
  dedupe-then-bulk-fetch enrichment pass.
- **KChat backfill progress UI.** `kchat:backfillProgress` IPC surfaces
  live `postsIngested` / `oldestFetched` counters maintained by the
  orchestrator during a historical-backfill walk. The
  `useKchatBackfillProgress` hook (2 s poll, cancel-safe,
  transport-failure self-heal at 3 consecutive failures) drives a
  progress card on `SourceDetailPage` with idle / active / complete /
  error states.
- **KChat channel file preview.** File-row metadata enrichment in
  `KchatChannelSourcePicker` — type-family icon + filename + TYPE +
  SIZE + "Uploaded by @username on date".
- **KChat evidence-pack share-to-channel.** `kchat:shareArtifact`
  uploads the artifact as Markdown to a channel, optionally with a
  SHA-256-verified evidence-pack ZIP. Audit rows are emitted for
  successful and pack-only-failure paths; primary-upload failures
  are not audited (no phantom records for an unchanged channel).
- **KChat thread context.** `fetch_kchat_thread_context(post_id)` on
  `SourceStore` surfaces the thread root plus up to 2 earlier replies
  (3 rows total, chronologically ordered) on threaded hits.
  The retrieval pipeline is plumbed end to end:
  `SourceStore` → `SourceManager` → N-API bridge →
  `kchat:fetchThreadContext` IPC → `CitationPanel`.
- **Scheduler `backfill_kchat_channel` action.** The automation
  scheduler can now drive periodic KChat backfill sweeps without a
  renderer-side trigger. New `AutomationAction` action kind validates
  `channel_id`, reads `getKchatBackfillImpl()` from `appState`,
  invokes the impl with the channel id, and records the run via
  `bridgeRecordAutomationRun(status: "ok" | "failed")`.
- **HomePage breakdown.** The dashboard now renders real recent
  artifacts (sorted by modified time) and a source-status breakdown
  card driven by the canonical Rust `SourceStatus` ordering, with
  quick actions for Templates / Tasks / Sources / Settings.
- **Template-validation audit logging.** Template parse and validation
  failures route through the audit log via a typed
  `TemplateLoadFailureKind` (`parse` vs. `validation`). Operators of
  packaged builds can find silently-dropped templates in the audit
  log instead of stderr alone.
- **Structured source comparison.** Source comparison surfaces a
  typed result (`common`, `uniqueToA`, `uniqueToB`, `similarity`)
  through a dedicated modal with download-as-markdown, open-artifact,
  and parent-qualified labels for sources that share the same last
  path segment.
- **Source-type glyphs on Sources surfaces.** `SourcesPage` and
  `SourceDetailPage` now render a per-source-kind glyph (📁 local
  folder, 📄 local file, 💬 KChat channel) next to the source title.
  New `sourceTypeIcon()` helper in `utils/sourceLabels.ts` returns
  `{ glyph, ariaLabel }` for every known kind with a graceful
  fallback (empty glyph, humanised aria-label) for unknown
  discriminators. Glyphs are emoji to match the existing
  `fileTypeIcon` convention in `KchatChannelSourcePicker`; rendered
  with `role="img"` + `aria-label` for screen reader support.

### Changed

- **Export-path containment now supports a deny-list.** `isSafeExportPath`
  accepts an optional `denyRoots` parameter that is checked BEFORE
  the allow-list. `getDenyExportRoots()` returns
  `~/.tessera/kchat-channels` so a compromised renderer cannot
  overwrite the KChat channel cache via `artifacts:exportToFile` and
  inject attacker-controlled content the connector would later
  ingest. Wired into all four export-path call sites in
  `ipc/artifacts.ts`.
- **`KchatAuthService` symmetric teardown.** All four shutdown sites
  (`handleExtensionRefreshFailure`, `handleExtensionDisconnect`,
  `teardownExtension`, `disconnect`) flip `authMode = "none"` BEFORE
  calling `client.shutdown()`, so no `disconnected` status push ever
  carries a stale `authMode: "extension"`.
- **SSRF guard re-validated on extension vault restore.**
  `enforceKchatServerUrl` is re-run when restoring an extension
  session from the vault — defence-in-depth against SSRF policy
  tightening between sessions and against tampered vault entries.
- **Custom-provider `/v1/models` 404s.** `externalProvider:listModels`
  now returns a typed `endpoint_not_found` result on HTTP 404 from a
  custom provider; the renderer surfaces a clear hint pointing at the
  exact URL and the manual-entry input.
- **`externalProvider:listModels` / `externalProvider:test` rate
  limits.** Both channels share token-bucket gates (1 req / s, burst
  5 and 3 respectively) on separate buckets, matching the protection
  posture of the sibling generation channels.
- **KChat citation surfaces are styled for dark mode.**
  `CitationPanel`'s KChat-specific class names
  (`citation-source-badge-kchat`, `citation-item-kchat`,
  `citation-search-hit-kchat`, the `citation-hit-kchat-*` family)
  shipped without any CSS rules in either light or dark themes —
  the surface rendered as undecorated inline text. They now render
  as a chip-style badge with a primary-tinted background, KChat-
  derived rows carry a 3px brand left-accent, metadata fragments
  use the muted secondary text token, and the permalink uses the
  theme-aware link token. Every color value is a `var(--color-…)`
  reference so dark-mode overrides apply automatically.

### Tests

- **AEAD full-lifecycle round-trip.** Integration tests on
  `tessera_sources::manager` exercise the full ingest → DEK wrap →
  ciphertext → decrypt → cryptoshred → regrant → re-ingest → search
  chain, plus thread-context retrieval across a cryptoshred
  boundary.
- **Hybrid search regression battery.** Scoring-axis consistency
  between file and post search (RRF `1.0 / (rank + 1.0)`),
  revocation-takes-effect-immediately on the same manager instance,
  BM25 ordering preserved through AEAD verification, cross-source
  revocation isolation.
- **Extension bridge token expiry + refresh.** Fake-timer-driven
  auto-refresh at `REFRESH_MARGIN_MS`, refresh failure invalidates
  the session, already-expired tokens classified as
  `protocol-error`, multi-refresh chain (1 → 2 → 3 → 4 token
  rotations).
- **Preload contract regression.** Source-text assertion that every
  channel in the 17-entry `EXPECTED_KCHAT_CHANNELS` master list has
  a matching `ipcRenderer.invoke("<channel>")` string in
  `preload.ts` — catches the failure mode where a handler is
  registered but the preload bridge entry is missing, rendering the
  channel silently unreachable from the renderer.
- **Explicit `disconnect()` extension-mode teardown.** Test 14 in
  `kchatExtension.test.ts` pins six invariants of the
  user-initiated `disconnect()` path while extension mode is
  active: extension vault entry deleted, saved PAT entry preserved
  (deliberate UX guarantee), authMode flips to `"none"`, no
  stale-authMode `disconnected` push reaches subscribers,
  audit-userid return contract, idempotency on second call.
- **`extensionSocketPath()` per-platform discovery.** 11 cases in
  `extensionSocketPath.test.ts` pin all four discovery branches
  (Linux + `XDG_RUNTIME_DIR`, Linux fallback with uid-suffix
  collision safety, macOS Application Support, Windows named
  pipe) plus edge defences (empty XDG treated as unset, missing
  `process.getuid`, freebsd parity with Linux, named-pipe namespace
  integrity on Windows).
- **KChat citation surface dark-mode contract.** Regression test in
  `darkModeTokens.test.ts` pins that every KChat-specific CSS class
  CitationPanel references has a rule in `components.css`, that
  every rule uses only `var(--color-…)` token references (no bare
  hex / rgb / hsl), and that every token referenced is in the
  dark-mode-safe allow list.

---

## [0.1.0] — 2026-05-23

First release-ready cut of Tessera.

### Added

#### Workspace and artifacts

- Desktop shell — Electron + React + TypeScript renderer, Rust N-API
  bridge, Home / Sources / Templates / Create / Tasks / Automations /
  Settings surfaces.
- Six editors — **Document** (TipTap / ProseMirror), **Slides**
  (Marp mode), **Sheet** (formulas + CSV / XLSX), **Base** (Grid /
  Kanban / Calendar / Timeline / Gallery views over the same
  records), **Infographic**, **Landing page**.
- 170+ YAML templates spanning ten industries (healthcare, legal,
  education, government, finance, manufacturing, retail, nonprofit,
  creative / marketing, real estate) and ten BCP-47 locales (`en`,
  `es`, `fr`, `de`, `ja`, `zh`, `pt`, `ko`, `ar`, `hi`).
- Productivity workflows — PRD / Proposal / SOP / QBR generators,
  task and decision extraction, source comparison, review checklist,
  evidence-pack export.
- Exports — Markdown, HTML, CSV, JSON, PDF (Typst), DOCX, XLSX,
  PPTX (Marp), evidence-pack ZIP.

#### Knowledge substrate

- Local-first encrypted storage on SQLite / SQLCipher.
- Local source indexing — folders / files, watcher, content hashing,
  text extraction for PDF / DOCX / PPTX / XLSX / CSV / MD / TXT /
  HTML / JSON, chunking.
- **Hybrid retrieval** — FTS5 lexical + `HashTrickEmbedding` vector
  similarity + temporal recency decay, fused via Reciprocal Rank
  Fusion (k=60). Configurable from Settings (hybrid toggle + recency
  half-life) with `CitationPanel` surfacing a tiered relevance
  percentage.
- Embedding backfill — `sources:backfillEmbeddings` IPC + bridge +
  SourceDetailPage "Re-embed" button + observable progress.

#### Connectors

- Local folders, local files.
- Google Drive, OneDrive / SharePoint, Notion, Jira, Confluence,
  Figma — OAuth 2.0, OS-keychain token storage, file / page / issue
  picker, incremental delta sync, metadata sync, local indexing
  through the FTS5 pipeline, clean disconnect with token revocation
  and audit events.
- Every remote connector ships wiremock-driven integration tests
  covering OAuth refresh, listing, incremental sync, disconnect, and
  401 / 403 / 404 / 429 error paths.

#### Model runtime

- Ternary-Bonsai 1.7B / 4B / 8B selected automatically from device
  tier and platform.
- **MLX 2-bit** on Apple Silicon; **GGUF Q1\_0\_g128** (PrismML
  llama.cpp ternary repack) on Windows / Linux / macOS Intel.
- CPU acceleration — AVX2 minimum, AVX-VNNI / AVX-512 VNNI, ARM
  NEON / dotprod.
- GPU acceleration — Vulkan / CUDA (Windows / Linux), ROCm (Linux),
  Metal (Apple Silicon).
- Single-model storage — only the recommended weight for the
  device tier and platform is on disk at a time.
- GBNF-constrained structured output, streaming generation,
  visible "Stop generating" UX in the artifact editor.

#### Optional external LLM provider

- OpenAI-compatible, Anthropic, and custom providers, disabled by
  default.
- Server-Sent-Events streaming with `AbortController` cancellation.
- Exponential-backoff retry (1 s / 2 s / 4 s) on transient HTTP
  (408 / 429 / 5xx), honoring `Retry-After` on 429, never retrying
  on 4xx.
- Token-usage counter with reset, cumulative across sessions.
- Model dropdown driven by `GET /v1/models` with manual-entry
  fallback.
- API keys stored in the OS keychain; URL / type / enabled may be
  overridden in-flight without saving.

#### Security and hardening

- **Encrypted local storage** — SQLite / SQLCipher with per-scope
  encryption keys; cryptographic forgetting via DEK destruction.
- **Renderer sandbox** — `contextIsolation: true`,
  `nodeIntegration: false`, typed IPC only, no direct file system
  or token access.
- **Password-vault fallback** — when `safeStorage` cannot reach an
  OS keyring (headless Linux, certain CI runners), Tessera derives
  a 256-bit key from a user passphrase via PBKDF2-SHA256
  (600 000 iterations) and wraps the DB key + OAuth tokens + API
  keys with AES-256-GCM. Unlocked at startup by an ephemeral
  `data:text/html` `BrowserWindow` with `sandbox: true`.
- **CSP per-connector image-source allow-list** — the previous
  wildcard `https:` image source replaced by an explicit allow-list
  keyed off the connected providers.
- **IPC rate limiter** — token-bucket gates on expensive channels.
- **Export-path containment** — renderer-initiated file writes
  resolve against an allow-list; symlinks and `..` traversal
  rejected at the IPC boundary.
- **Extracted-item validation + HTML escape** — every batch of
  extracted tasks / decisions / risks is schema-validated and
  renderer-bound string fields are HTML-escaped.
- **Audit trail** — every IPC handler that mutates state writes a
  structured audit event via `tessera_audit`.
- **IPC channel audit** — every `ipcMain.handle()` channel is
  enumerated with its validation strategy and auth flag in
  [`docs/IPC_AUDIT.md`](docs/IPC_AUDIT.md); CI fails on drift.

#### Accessibility

- Every modal traps focus, exposes `aria-labelledby`, restores
  focus on close, dismisses on Escape.
- Every form input has an associated label; sidebar exposes
  `aria-current`; sidebar shortcuts surface through
  `aria-keyshortcuts`.

#### Themes

- Light / Dark / System theme switching driven by
  `[data-theme="dark"]` with a `prefers-color-scheme: dark`
  fallback; tokenized — no hardcoded hex colors in renderer
  components.

#### Packaging and releases

- Cross-platform installers (AppImage / .deb / .rpm / .dmg / NSIS)
  built by the `Release` workflow on `v*` tags.
- `electron-updater` auto-updater wrapped behind `updates:*` IPC
  channels with renderer-side toast UX and opt-out from Settings.
- Structured JSONL logging to the OS user-data directory with
  rotation.
- Root error boundary in the renderer.

[Unreleased]: https://github.com/kennguy3n/Tessera/compare/v0.1.0...HEAD
[0.1.0]: https://github.com/kennguy3n/Tessera/releases/tag/v0.1.0
