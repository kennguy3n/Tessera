# Changelog

All notable changes to Tessera are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Tessera
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

- **Phase 15 — Production quality & E2E reliability (six themes,
  30 tasks).**

  - **Performance & startup (PR 1, Tasks 1-6).** `performance.mark()` /
    `performance.measure()` instrumentation at every cold-start stage
    (app ready, bridge init, DB open, window show); heavy modules
    (`marpExport`, `typstExport`, `diffusionSidecar`, `autoUpdater`)
    converted to dynamic `import()` so they no longer block the first
    render. Indexer + extractor moved to a `rayon` thread pool bounded
    to `num_cpus / 2` (UI headroom preserved); content-hash gate keeps
    incremental re-index correct. Hybrid search picks up a covering
    index on `chunk_hash`+`source_id` and an idle `PRAGMA optimize`
    pass; n-gram hash table now caches across queries. Streaming bulk
    indexing in batches of 500 keeps peak RSS under the 200 MB
    integration-test budget on a 10 K-chunk corpus. File watcher
    coalesces events in a 500 ms window and dedupes per-path, so
    write+rename storms (atomic-save pattern) fire one re-index. New
    `sources:batchReindex` and `artifacts:batchExport` IPC channels
    collapse N round-trips to 1 and report per-item success/error.
  - **Reliability & crash recovery (PR 2, Tasks 7-12).** SQLCipher DB
    now opens in WAL mode with `wal_checkpoint(TRUNCATE)` on graceful
    shutdown and `integrity_check` on startup; an unrecoverable DB
    surfaces a typed error rather than silently truncating. Editors
    write a `.tessera-recovery` JSON sidecar before each auto-save
    and the renderer offers to restore via `artifacts:checkRecovery`
    /`artifacts:discardRecovery`. Sidecar lifecycle now records PIDs
    to `{userData}/tessera-sidecar.pid`, orphan-cleans them at next
    startup, and escalates SIGTERM→5 s grace→SIGKILL on `will-quit`.
    Failed exports land in a persistent queue (`failedExportQueue.ts`)
    and surface via `artifacts:failedExports` / `artifacts:retryExport`;
    the queue survives restart through `config.json`. Connector sync
    errors are classified transient (timeout / 429 / 503) vs permanent
    (401 / 403 / 404) and retried with exponential backoff (base 2 s,
    max 5 min, jitter); per-source last-error + retry-count is
    persisted. Audit log rotates at 100 K rows to
    `audit-archive-<ts>.jsonl.gz` and exposes archives via
    `audit:getArchives`.
  - **Export fidelity & platform parity (PR 3, Tasks 13-18).** Five
    DOCX golden fixtures (headings / lists / tables / code blocks /
    citations) pin byte-stable output AND OOXML-schema validity.
    XLSX export now preserves SUM / AVERAGE / COUNT / MIN / MAX
    formulas as strings (not computed values) and round-trips named
    ranges. PDF export pre-renders Mermaid blocks to SVG and embeds
    them through the Typst pipeline so a flowchart no longer leaks as
    raw source. Linux smoke harness (`scripts/smoke-test-linux.sh` +
    `scripts/Dockerfile.smoke`) builds the `.deb` and AppImage,
    installs in an `ubuntu:22.04` container, launches under
    `xvfb-run`, asserts main-window ready, and round-trips one IPC.
    Windows portable-zip verifier (`scripts/verify-windows-package.ps1`)
    asserts the NSIS exe + portable zip both ship `Tessera.exe`,
    `resources/`, and the native `.node` addon. macOS verifier
    (`scripts/verify-macos-package.sh`) asserts the native addon is
    universal (`lipo -info` reports both `x86_64` and `arm64` slices)
    or splits into two architecture-specific DMGs.
  - **UX completeness (PR 4, Tasks 19-24).** Three-step first-run
    onboarding wizard (`OnboardingWizard.tsx`) fires only when the
    workspace is empty and persists `onboarding_completed` in config.
    Every list page (Sources / Tasks / Automations / Templates) now
    renders a Lucide-iconified empty state with descriptive copy and
    a primary CTA. Toast provider enforces stack-max-3, 5 s
    auto-dismiss for non-errors, persistence-until-dismissed for
    errors, focus trap on hover, and Escape to dismiss. Settings
    grows a Source Health dashboard backed by a new `sources:healthReport`
    IPC (last sync time, status, indexed chunk count, storage size).
    Template gallery is fully keyboard-navigable (roving tabindex,
    arrow keys, Enter to select, Tab between filter and grid,
    `aria-activedescendant`). Version history supports a section /
    cell / record-level diff between any two versions of an artifact
    via an in-tree LCS implementation (no external diff library).
  - **Security & compliance (PR 5, Tasks 25-28).** CSP is now nonce-
    based — `script-src` and `style-src-elem` no longer carry
    `'unsafe-inline'`; a fresh 32-byte nonce per session flows main →
    preload (`additionalArguments`) → renderer (`useCspNonce()` hook)
    and is applied to every app-owned `<style>` tag. `connect-src` is
    locked to `'self'` + `127.0.0.1` (sidecar) + explicitly configured
    external provider endpoints. OAuth refresh races are coalesced
    onto a single in-flight `Promise` via a per-provider mutex in
    `ipc/connectors/handlers.ts` — concurrent expired-token detections
    now produce exactly one upstream call. Sensitive buffers (SQLCipher
    key in `dbKey.ts`, password-vault decryption fragments in
    `passwordVault.ts`) are zeroed in `finally` blocks via the new
    `secureBuffer.ts` helper. The KChat loopback API now enforces a
    sliding-window per-IP rate limit (`kchatRateLimiter.ts`, default
    100 req / 60 s, 429 + `Retry-After` clamped ≥ 1 s per RFC 7231),
    applied BEFORE host / bearer checks so an attacker cannot drain
    a legitimate caller's budget via malformed traffic.
  - **Documentation & verification (PR 6, Tasks 29-30).** Linux
    consistency pass across `README.md` / `ARCHITECTURE.md` /
    `CONTRIBUTING.md` — Linux prerequisites (libsecret-1-dev,
    libgtk-3-dev, libnss3-dev, libasound2-dev, libxss1, libxtst6,
    xdg-utils), Linux packaging (AppImage, `.deb`, arm64), Linux
    runtime detection (AVX2 / AVX-512 VNNI / NEON / dotprod / Vulkan
    / CUDA / ROCm) now mentioned on equal footing with macOS /
    Windows everywhere they belong. `sidecars/scripts/download-llama-server.sh`
    documents Linux arm64 explicitly. `PHASES.md` carries a Phase 15
    row; `PROGRESS.md` carries the 30-task table with every box
    checked.

### Changed

- **CSP `script-src` / `style-src-elem`** — replaced `'unsafe-inline'`
  with `'nonce-<random>'`. App-owned `<style>` tags carry the same
  nonce via the new `useCspNonce()` hook. `style-src-attr` retains
  `'unsafe-inline'` to cover trusted framework-generated `style="…"`
  attributes from React/lucide-react.
- **`napi` crate** documented as targeting **macOS, Windows, AND Linux**
  (x64 + arm64) — previous wording listed only macOS and Windows.

### Tests

- 50+ new Vitest + Rust integration tests across the six PRs:
  startup-perf guard, indexing/search Criterion benches, memory peak
  RSS budget test, watcher coalescing test, batch-IPC tests, WAL +
  integrity crash-recovery test, artifact recovery sidecar tests,
  sidecar PID registry tests, failed-export queue tests, connector
  backoff classification tests, audit rotation test, DOCX golden +
  OOXML schema tests, XLSX formula + named-range round-trip tests,
  PDF Mermaid embedding test, Linux smoke-test exit-code gate,
  Windows / macOS package-verifier tests, onboarding wizard +
  empty-state + toast + source-health + keyboard-nav + version-diff
  Vitest suites, CSP nonce assembly + no-unsafe-inline tests, OAuth
  refresh race tests, secret zero-on-free tests, sliding-window
  rate-limiter unit + HTTP integration tests.

- **KChat Desktop integration via `.kcz` extension + loopback HTTP API
  + deeplinks (Phase 14).** Replaces Phase 13's socket-bridge
  integration with the correct architecture: Tessera and KChat
  Desktop are two independent Electron clients that share only the
  KChat server backend. Cross-app surface is (a) a signed `.kcz`
  extension under [`extensions/tessera-kchat/`](extensions/tessera-kchat/)
  installed inside KChat Desktop and talking to Tessera over a
  loopback-only HTTP API on `127.0.0.1` (bearer-token auth via 256-bit
  `crypto.randomBytes(32)` → base64url with timing-safe compare,
  Host-header SSRF guard against DNS-rebind, 64 KiB body cap, port
  discovery via `{userData}/tessera-kchat-port.json` at mode 0600 via
  atomic rename), (b) `tessera://` deeplinks for KChat Desktop →
  Tessera navigation handled by `kchatDeeplinkBridge.ts` with
  pre-ready route parking and Windows/Linux cold-start argv scanning
  in the single-instance-lock else branch, and (c) `kchat://`
  deeplinks for Tessera → KChat Desktop navigation via
  `shell.openExternal()` (`kchat:openInDesktop`,
  `kchat:openDesktopExtensions`, sharing a single rate-limiter bucket
  so a runaway renderer can't multiply the OS-shell budget).
- **Loopback API routes.** `GET /api/status` returns Tessera connection
  state and indexed channels; `GET /api/sources` enumerates
  KChat-sourced rows; `POST /api/ingest-channel` triggers a channel
  backfill; `POST /api/share-artifact` accepts an artifact id +
  optional evidence pack from the extension. Errors return a typed
  `LocalApiErrorCode` envelope (`forbidden` / `not_found` /
  `method_not_allowed` / `invalid_request` / `payload_too_large` /
  `rate_limited` / `internal`) paired one-to-one with the HTTP status.
- **`tessera://` deeplink protocol.** Routes: `tessera://source/<id>`,
  `tessera://artifact/<id>`, `tessera://ingest?channel=&team=`.
  Pre-ready URLs are parked in a FIFO queue and replayed on consumer
  registration. macOS uses `open-url`, Win/Linux warm-start uses
  `second-instance`, Win/Linux cold-start uses an argv scan inside
  the single-instance-lock else branch so the URL doesn't get dropped
  on the about-to-quit second instance.
- **Concurrency-hardened start/stop state machine** for
  `KchatLocalApiServer`. Three-slot state machine in `appState.ts`
  (`kchatLocalApiServer` cached slot, `kchatLocalApiServerPending`
  start-in-flight slot, `kchatLocalApiServerStopping` stop-in-flight
  slot) safe against every overlap of start and stop: concurrent
  starts coalesce onto one server; stop-during-in-flight-start
  (success and rejection paths) does not strand a server;
  start-during-in-flight-stop parks the new start on the stopping
  promise rather than racing it; concurrent stops resolve to one
  `server.close()` call.
- **`KchatSettingsCard` passive detection.** Renders a passive
  "KChat Desktop detected — enhanced integration active" affordance
  when the loopback API has received a bearer-authed request from the
  extension within the last 90 seconds. "Open KChat Desktop
  extensions" button invokes `kchat://app/settings/extensions` via
  the typed `openDesktopExtensions()` IPC.
- **`KchatSidebarSection` per-channel deeplink action.** Small
  external-link button next to each KChat channel source opens the
  corresponding conversation in KChat Desktop via
  `kchat://app/conversation/<id>`. A heartbeat dot turns green when
  the loopback API has seen a recent extension request.
- **`.kcz` extension build pipeline.** `npm run build:kchat-extension`
  bundles the extension into
  `extensions/tessera-kchat/releases/com.tessera.kchat-bridge@<version>.kcz`.
  Build is deterministic (reverse-alpha walk + stable timestamps);
  the walker throws on symbolic links rather than silently dropping
  them (`.kcz` archives must contain only regular files for
  cross-platform reproducibility).
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
- **`KchatAuthService` symmetric teardown.** `disconnect()` flips
  `authMode = "none"` BEFORE calling `client.shutdown()`, so no
  `disconnected` status push ever carries a stale `authMode: "pat"`.
- **SSRF guard re-validated on vault restore.** `enforceKchatServerUrl`
  is re-run when restoring a PAT session from the vault — defence-in-depth
  against SSRF policy tightening between sessions and against tampered
  vault entries.
- **`restoreFromVault()` token-only rollback policy** on verify failure
  (Phase 14 Round 9). The in-memory token is rolled back via
  `setToken(null)` but `serverUrl` is intentionally NOT rolled back —
  `setServerUrl("")` would silently fall back to `DEFAULT_KCHAT_SERVER`
  (a worse failure mode than the stale value), and the token-presence
  guard in `KchatClient.request()` prevents outbound traffic to the
  stale URL. Documented in JSDoc + mirroring NOTE comments on the
  catch blocks of both `restoreFromVault()` and `connect()`.
- **`LocalApiErrorCode` wire-code/HTTP-status canonical mapping** (Phase
  14 Round 10). Added `payload_too_large` paired with 413 so extensions
  can branch on `code` to distinguish payload-size failures from
  malformed-body failures. Mirrored in `TesseraLocalApiError`.
- **Port-file-write failure rollback** in `KchatLocalApiServer.start()`
  (Phase 14 Round 8). If `writeAtomic()` fails after a successful
  `listen()`, the server closes the bound socket and clears
  `this.server` / `this.boundPort` / `this.portFileAbsPath` before
  re-throwing — without this rollback the leaked listener would hold
  an event-loop handle for the lifetime of the process.
- **Windows/Linux cold-start `tessera://` argv scan** (Phase 14 Round 14).
  Runs inside the `else` branch of the single-instance-lock check
  (primary instance only) and feeds any URL into
  `getKchatDeeplinkBridge().ingestRawUrl(url)` so it lands in the
  bridge's parking queue and gets FIFO-dispatched when the renderer
  consumer registers later in the `whenReady` chain.
- **Hoisted `shell` import** in `apps/desktop/electron/ipc/kchat.ts`
  (Phase 14 Round 13). Dropped two `await import("electron")` sites in
  the new deeplink handlers in favour of a top-level
  `import { shell } from "electron"`. CONTRIBUTING.md compliance — new
  code shouldn't propagate the pre-existing dynamic-import convention
  violation in `artifacts.ts`.
- **Hardened symmetric teardown on `KchatLocalApiServer.start()`
  null-address branch** (Phase 14 Round 13 ANALYSIS_0007). `server.close()`
  before the null-address throw, symmetric with the wrong-address
  branch. Structurally unreachable in current Node but defended in
  depth against any future `node:net` surprise where `address() === null`
  after a successful `listen()`.
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

### Removed

- **Phase 13 socket-bridge surface.** Removed
  `kchatExtensionBridge.ts`, `kchatExtensionSession.ts`,
  `kchatExtensionEvents.ts`, `extensionSocketPath.test.ts`,
  `kchatExtension.test.ts`, three `kchat:extension*` preload channels
  (`kchat:extensionStatus`, `kchat:extensionConnect`,
  `kchat:extensionDisconnect`), the `extension-delegated` vault
  provider, and the per-platform discovery code (Linux
  `$XDG_RUNTIME_DIR`, macOS Application Support, Windows named pipe).
  Superseded by Phase 14's `.kcz` extension + loopback HTTP API + deeplink
  architecture (see Added). PAT mode survives unchanged — it remains
  the single source of auth between Tessera and the KChat server.
- **`KchatAuthMode` value `"extension"`.** `authMode` is now
  `"none" | "pat"`. The mode-aware UI surfaces in `KchatSettingsCard`
  collapsed to a single PAT path + the passive "KChat Desktop
  detected" affordance driven by the loopback API heartbeat.

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
- **Preload contract regression.** Source-text assertion that every
  channel in the 17-entry `EXPECTED_KCHAT_CHANNELS` master list has
  a matching `ipcRenderer.invoke("<channel>")` string in
  `preload.ts` — catches the failure mode where a handler is
  registered but the preload bridge entry is missing, rendering the
  channel silently unreachable from the renderer.
- **KChat Desktop integration suite** (Phase 14 PR #58).
  `kchatDesktopIntegration.test.ts` covers bind/discovery, auth +
  Host-header policy, route surface, deeplink parsing, bridge
  lifecycle, cold-start argv scanning, and two regression cases:
  Round 8 BUG_0001 port-file-write rollback (kernel-assigned port
  captured from inside the failing writer, ECONNREFUSED, second
  `start()` succeeds), and Round 13 ANALYSIS_0007 null-address
  symmetric teardown (uses the `createServerFn` injection seam to
  swap `address` for `() => null`).
- **Start/stop state machine regression suite** (Phase 14 Rounds
  11/12/15). `kchatLocalApiServerSingleton.test.ts` pins seven race
  scenarios: concurrent-starts coalesce, sequential cached fast
  path, stop-then-start cycle, stop-during-in-flight-start
  (success path), stop-during-in-flight-start (rejection path),
  start-during-in-flight-stop (parks on stopping promise), and
  concurrent-stops resolve to one `server.close()`.
- **Cold-start argv scanning** (Phase 14 Round 14). Two regression
  cases in `kchatDesktopIntegration.test.ts`: cold-start argv with
  `tessera://` URL → URL extracted via the existing
  `extractUrlFromArgv()` helper, parked, dispatched on consumer
  registration; cold-start argv without deeplink → no-op, empty
  queue at consumer-registration time.
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
