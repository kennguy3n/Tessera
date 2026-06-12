# Changelog

All notable changes to Tessera are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Tessera
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

#### Competitive upgrade — parallel feature streams

This release integrates eight parallel work streams (merged in the order
arch → opt → perf → sec → dx → editors → tasks → kchat) that push every
critique dimension toward best-in-class against Notion / Coda / Google
Workspace while staying a local-first desktop app. See
`docs/COMPETITIVE_SCORECARD.md` for the dimension-by-dimension scoring.

- **Architecture — versioned migrations & typed errors.** New
  `crates/tessera_migrate` runs forward-only, numbered SQL migrations
  tracked in a `_migrations` table (with rollback stubs), replacing the
  ad-hoc migration blocks previously inlined in `tessera_sources`. The
  read pool auto-sizes to the CPU count (capped at four readers), and
  `Error::Database(String)` is gone in favor of typed variants
  (`Error::Sqlite` wrapping `rusqlite::Error` so callers can match on the
  concrete cause, and `Error::DatabaseState(String)` for semantic
  failures). Migration-runner tests cover a fresh DB, a v1→v5 upgrade,
  and idempotent re-runs.
- **Editors — comments, conditional formatting, form view, presenter.**
  TipTap inline document comments (author, timestamp, resolved state,
  side panel); rule-based conditional formatting in the Sheet editor; a
  sixth Base view that renders a fillable form which creates records; and
  a Slides presenter mode that opens a fullscreen second `BrowserWindow`
  with speaker notes over the new `slides:startPresentation` IPC channel.
- **Tasks & automations — dependencies, Gantt, new triggers.** Tasks
  gain a `depends_on` set with topological-sort cycle detection; an
  SVG Gantt timeline on the Tasks page; a new
  `on_kchat_message_match(channel_id, regex)` automation trigger that
  fires when the KChat WebSocket delivers a matching post; and
  multi-step automation actions that chain sequentially with per-step
  error reporting. Schema changes ride Session 1's migration framework.
- **Performance & scale.** Criterion benches extended to 100K and 500K
  chunk corpora; incremental IVF index updates assign new vectors to the
  nearest centroid and only trigger a full k-means rebuild past a 20%
  corpus change; virtual scrolling for Sheet/Base grids at 10K+ rows;
  read-pool connections pre-warmed at boot; and a CI cold-start gate that
  fails if boot-to-first-render exceeds 3s on the ubuntu runner.
- **Cost & install size.** Release builds strip debug symbols from the
  Rust N-API addon (`strip = true`); unused Electron locales are pruned
  from the packaging config; the CI cargo cache key now hashes
  `rustc --version` alongside `Cargo.lock`; blockmap-based delta updates
  are enabled in the auto-updater; and model downloads support HTTP
  range-request resume.
- **Security & privacy.** FIDO2/WebAuthn is now a third app-lock method
  alongside PIN and biometric; `PRAGMA secure_delete` wraps every
  artifact/source deletion path so freed pages are zero-filled; the Linux
  `basic_text` keychain fallback raises a runtime warning and blocks
  secret writes in enforce mode; the CSP drops its remaining wildcard
  origins; and `cargo vet` + `npm audit --audit-level=high` run as CI
  supply-chain gates.
- **Maintainability (DX).** Ten Architecture Decision Records under
  `docs/adr/`; `#![warn(missing_docs)]` across the public Rust crates
  plus a `cargo doc --no-deps` CI step; renderer TypeScript types
  auto-generated from the zod IPC schemas with a CI drift check; React
  error boundaries around every editor and page that write a
  `crash-report.json` on crash; and an auto-generated
  `docs/DEPENDENCIES.md` license inventory.
- **KChat collaboration depth.** An offline queue persists
  `shareArtifact` / `ingest-channel` requests when the server is
  unreachable and replays them on reconnect; an `@mention` TipTap
  extension searches KChat users and resolves to `@username` on share;
  a notification bridge surfaces new posts in watched channels as native
  OS notifications; share-to-channel adds DOCX/PDF attachment and
  `tessera://` deeplink formats alongside Markdown; the Sidebar shows a
  KChat presence / sync-status indicator; and task sync is bidirectional
  (Tessera tasks can post to KChat, and task-like KChat messages can
  auto-create Tessera tasks).

#### Knowledge browser UI

The knowledge substrate's browsing surfaces are now wired into the
shipping renderer (previously the engines and data plane shipped while
this UI was built-and-tested but unmounted).

- **Memory page.** A dedicated `/memory` route
  (`pages/MemoryPage.tsx`, mounted in `App.tsx`) reachable from the new
  **Memory** sidebar item ("More tools" tier, `Ctrl/Cmd+9`, added to
  `navigation.ts`). Lists memories with decay state and retention and
  embeds the concept-graph panel.
- **Concept-graph panel.** `components/ConceptGraphPanel.tsx`
  (helpers in `utils/conceptGraph.ts`) renders concept nodes and their
  typed links over the user's own sources.
- **"Knowledge" citation tab.** The additive Sources/Knowledge tabbed
  view in `components/CitationPanel.tsx` (entities/facts/concepts
  alongside source chunks) is now mounted in the artifact editor behind
  the **Citations** button (`pages/ArtifactEditorPage.tsx`). The
  Knowledge plane degrades to an empty tab rather than breaking the
  panel when the substrate is unavailable.
- **HomePage knowledge insights.** A "Knowledge insights" card on the
  home screen (`hooks/useSubstrateInsights.ts`, rendered in
  `pages/HomePage.tsx`) summarizing the memory plane and concept graph,
  plus a substrate section on each source's detail page
  (`pages/SourceDetailPage.tsx`).
- **Searchable connector gallery.** `components/ConnectorsList.tsx`
  gains a searchable, categorized remote-connector gallery with health
  and scope-transparency surfacing.

#### Continuous integration

- **Private substrate dependency builds in CI.** A read-only SSH deploy
  key (`KNOWLEDGE_DEPLOY_KEY` repo secret, wired through the
  `.github/actions/knowledge-ssh` composite action) lets CI clone and
  build the private `kennguy3n/knowledge` git dependency, so
  substrate-touching changes now build and test on every push. This
  removes the earlier "CI cannot clone the private dependency"
  limitation noted in the competitive scorecard.

#### Security & privacy

- **Auto-updater signature verification.** Update artifacts are
  verified against a hardcoded `UPDATER_TRUST_ANCHORS` array of
  Ed25519 public keys before `electron-updater` is allowed to call
  `quitAndInstall`. Multi-anchor support lets a new pubkey ship
  alongside the old one for an overlap window during key rotation;
  every other anchor is still tried if one throws during verification.
  The verifier never returns `true` for a tampered artifact, and the
  install gate re-checks the verification result at `quitAndInstall`
  time so a TOCTOU between download and install cannot launder an
  unverified artifact through. A `release-tool/signUpdateArtifact.ts`
  companion script signs the release artifact server-side.
- **Per-app keychain ACL policy.** `safeStorage`-backed token writes
  go through a runtime gate that classifies the active backend into
  a trust tier: `enforced-by-os` (macOS Keychain, Code-Signing-pinned
  bundle ID), `user-scoped` (Windows DPAPI; Linux gnome-libsecret /
  kwallet), `none` (Linux `basic_text` — XOR with a hardcoded key,
  *not* real encryption). When the active backend is `basic_text`
  the policy refuses to encrypt secrets by default; Settings →
  Security surfaces the active tier. On macOS the
  `keychain-access-groups` entitlement pins the access group to
  Tessera's bundle ID, so other apps signed with a different identity
  cannot read Tessera Keychain items. Mid-session backend drift
  (e.g. kwallet daemon crash) is detected and logged before the
  refusal so operators have forensic visibility.
- **OAuth scope governance.** Granted scopes are inspected on every
  connector sync. If the consent screen has been narrowed since the
  last grant, the renderer receives a precise list of missing scopes
  and a re-auth CTA instead of an opaque 403. Meta-scopes (e.g.
  `offline_access`) are filtered out of the required set so they
  cannot cause permanent false-positive errors; a `SCOPELESS_PROVIDERS`
  allow-list (`notion`, …) silences the warning for providers whose
  tokens carry no scopes by design.
- **App-lock (PIN + biometric).** Optional. PIN is hashed with
  scrypt (`N = 2^14`, per-PIN salt, key length 64) and stored
  vault-encrypted at rest, with the scrypt parameters stored
  alongside so a future parameter bump doesn't lock anyone out.
  Failed attempts trigger exponential backoff (30 s → 1 h cap).
  Biometric unlock dispatches to TouchID on macOS or the WinRT
  `UserConsentVerifier` on Windows. Every app-lock IPC channel
  (`setPin`, `changePin`, `removePin`, `attemptUnlock`,
  `attemptBiometric`) shares a token-bucket rate limiter so a
  compromised renderer cannot side-step throttling by alternating
  channels.
- **Telemetry — local-only, opt-in.** Off by default. The sink never
  opens a socket. When on, only whitelisted counter / event keys are
  accepted; events are buffered in memory and flushed to a single
  on-disk JSONL file. Disabling truncates the file. There is no
  remote endpoint and no opt-out from an opt-in-only system.
- **Sensitive buffer zero-on-free.** SQLCipher key and password-vault
  decryption fragments are zeroed in `finally` blocks via a
  `secureBuffer.ts` helper so secret material does not linger in
  freed heap memory.
- **CSP nonce-based** — `script-src` and `style-src-elem` no longer
  carry `'unsafe-inline'`. A fresh 32-byte nonce per session flows
  main → preload → renderer (`useCspNonce()` hook) and is applied to
  every app-owned `<style>` tag. In production `connect-src` is
  locked to `'self'` only — the renderer never makes a direct
  outbound HTTP call; every network call goes through main-process
  IPC.
- **KChat loopback API rate limit.** Sliding-window per-IP limiter
  (default 100 req / 60 s, 429 + RFC 7231-compliant `Retry-After`),
  applied BEFORE host / bearer checks so a malformed-traffic
  attacker cannot drain a legitimate caller's budget.
- **Export-path containment with deny-list.** `isSafeExportPath`
  accepts an optional `denyRoots` parameter that is checked BEFORE
  the allow-list. `~/.tessera/kchat-channels` is on the deny-list so
  a compromised renderer cannot overwrite the KChat channel cache
  via `artifacts:exportToFile` and inject attacker-controlled
  content the connector would later re-ingest.

#### Search & retrieval

- **Approximate nearest-neighbor vector index.** IVF-Flat index over
  the embedding store with `K = √N` centroids, 5-iteration Lloyd
  k-means build, `nprobe = ⌈√K⌉` probe count. First query after an
  embedding write pays the synchronous build (<50 ms at 50 K vectors
  on modern hardware); subsequent queries are an Arc-clone lookup.
  Falls through to brute-force scoring on cache miss so recall is
  never worse than the previous baseline.
- **Read-pool SQLite split.** Search reads now go through a
  dedicated WAL read pool, leaving the writer connection free for
  ingest. The pool gracefully degrades to the writer connection on
  open failure so a file-descriptor exhaustion event reduces search
  throughput but does not break the app.
- **Configurable model idle-timeout.** Settings → Performance
  exposes a `modelIdleTimeoutSecs` knob with five buckets (30 s, 1 m,
  5 m, 30 m, 1 h, never) plus a synthetic "Custom (Xs)" option that
  surfaces non-bucket values from manual config edits. Defaults to
  60 s; the SettingsPage warns memory-constrained-GPU users to pick
  the 30 s bucket.

#### Editors

- **Sheet — formula engine.** Tokenizer → Pratt parser →
  tree-walking evaluator over a `DependencyGraph` (topological
  recompute). **64 functions** across math (SUM, AVERAGE, COUNT,
  MIN, MAX, ROUND, etc.), conditional (IF, IFS, SWITCH), logic
  (AND, OR, NOT, XOR), text (CONCAT, LEFT, RIGHT, MID, UPPER, LOWER,
  TRIM, …), lookup (VLOOKUP, HLOOKUP, INDEX, MATCH), date
  (TODAY, NOW, YEAR, MONTH, DAY, …), and statistics (MEDIAN, MODE,
  STDEV, VAR, …) categories. Cross-sheet references (`Sheet2!A1`)
  and a persistent on-disk dependency cache. Incremental recalc
  walks only the dirty subtree.
- **Sheet — workbook UX.** Multi-sheet tabs, column / row resize,
  rectangular and multi-cell selection, copy / paste, freeze panes,
  auto-fill, cell formatting, CSV import, XLSX export with native
  formulas and named-range round-trip.
- **Base — field types.** **20 field types**: six baseline (`text`,
  `number`, `date`, `select`, `checkbox`, `url`); seven advanced
  (`multi_select`, `formula`, `linked_record`, `rollup`, `lookup`,
  `attachment`, `long_text`); seven simple (`email`, `phone`,
  `currency`, `percent`, `rating`, `duration`, `auto_number`).
  Per-type filters; bulk-select with shift-click range and bulk
  delete; manage-fields dialog (reorder / rename / type-change with
  data migration / delete); CSV / JSON import-export (RFC 4180);
  five views (Grid, Kanban, Calendar, Timeline, Gallery) over the
  same records.
- **Document — TipTap UX.** Toolbar, outline panel, find / replace
  with case-sensitive and whole-word toggles, slash-command menu,
  tables, task lists, code-block syntax highlighting via `lowlight`
  (30+ languages), text-align, highlight, underline.
- **Slides — layout & block editing.** Five layouts (`blank`,
  `title`, `titleContent`, `twoColumn`, `imageCaption`), per-block
  reorder / type-change / delete, stable UUID block IDs, native
  HTML5 drag-and-drop sidebar reorder, per-slide and deck word
  count, deck-wide find panel, image uploads inlined through a
  shared 5 MiB cap.
- **Global UX.** `Cmd+K` (`Ctrl+K` on Windows / Linux) command
  palette; global search across artifacts, sources, tasks, and
  templates; favorites and recents; breadcrumb navigation; 30+
  keyboard shortcuts; right-click context menus on lists and
  cells.

#### KChat integration

- **`.kcz` extension + loopback HTTP API.** Tessera and KChat
  Desktop are two independent Electron clients sharing only the
  KChat server backend. Cross-app integration uses a signed `.kcz`
  extension under `extensions/tessera-kchat/` installed inside KChat
  Desktop, talking to Tessera over a `127.0.0.1`-bound HTTP API
  with bearer-token auth (256-bit `crypto.randomBytes(32)` →
  base64url, timing-safe compare), Host-header SSRF guard against
  DNS-rebind, 64 KiB body cap, port discovery via
  `{userData}/tessera-kchat-port.json` (mode 0600 via atomic
  rename). Routes: `GET /api/status`, `GET /api/sources`,
  `POST /api/ingest-channel`, `POST /api/share-artifact`; errors
  return a typed envelope (`forbidden` / `not_found` /
  `method_not_allowed` / `invalid_request` / `payload_too_large` /
  `rate_limited` / `internal`) paired one-to-one with the HTTP
  status.
- **`tessera://` deeplinks.** Routes: `tessera://source/<id>`,
  `tessera://artifact/<id>`, `tessera://ingest?channel=&team=`.
  Pre-ready URLs are parked in a FIFO queue and replayed on
  consumer registration. macOS uses `open-url`, Windows / Linux
  warm-start uses `second-instance`, Windows / Linux cold-start
  uses an argv scan inside the single-instance-lock else branch so
  the URL doesn't get dropped on the about-to-quit second instance.
- **`kchat://` deeplinks (Tessera → KChat Desktop navigation).**
  `kchat:openInDesktop`, `kchat:openDesktopExtensions`, sharing a
  single rate-limiter bucket so a runaway renderer can't multiply
  the OS-shell budget.
- **KChat Desktop "enhanced integration active" affordance.**
  Settings card renders a passive detection chip when the loopback
  API has received a bearer-authed request from the extension
  within the last 90 seconds.
- **Per-channel deeplink action in KChat sidebar.** Small
  external-link button next to each KChat channel source opens the
  corresponding conversation in KChat Desktop. Heartbeat dot turns
  green when the loopback API has seen a recent extension request.
- **KChat post citation rendering.** KChat post hits in
  `CitationPanel` render with chat semantics: chat icon,
  `#channel @sender`, threaded indicator. User and channel display
  names are resolved via bounded LRU caches with dedupe-then-bulk-
  fetch enrichment.
- **KChat backfill progress UI.** `kchat:backfillProgress` IPC
  surfaces live `postsIngested` / `oldestFetched` counters during a
  historical walk, driving a progress card on `SourceDetailPage`
  with idle / active / complete / error states.
- **KChat channel file preview.** File rows in
  `KchatChannelSourcePicker` show type-family icon + filename +
  type + size + "Uploaded by @username on date".
- **KChat evidence-pack share-to-channel.** `kchat:shareArtifact`
  uploads the artifact as Markdown to a channel, optionally with a
  SHA-256-verified evidence-pack ZIP. Audit rows are emitted for
  successful uploads and pack-only failures.
- **KChat thread context.** Threaded post hits surface the thread
  root plus up to 2 earlier replies (3 rows total, chronologically
  ordered) in `CitationPanel`.
- **`backfill_kchat_channel` scheduler action.** Periodic
  historical-backfill sweeps without a renderer trigger.

#### Workspace & reliability

- **Performance instrumentation.** `performance.mark()` /
  `performance.measure()` at every cold-start stage (app ready,
  bridge init, DB open, window show). Heavy modules
  (`marpExport`, `typstExport`, `diffusionSidecar`, `autoUpdater`)
  are dynamic-imported so they no longer block the first render.
- **Streaming bulk indexing.** Indexer + extractor now run on a
  `rayon` thread pool bounded to `num_cpus / 2` (UI headroom
  preserved); content-hash gate keeps incremental re-index correct.
  Batches of 500 keep peak RSS under the 200 MB budget on a 10 K-
  chunk corpus.
- **File watcher debounce.** Coalesces events in a 500 ms window
  and dedupes per-path, so write+rename storms (atomic-save
  pattern) fire one re-index.
- **Batch IPC.** `sources:batchReindex` and
  `artifacts:batchExport` collapse N round-trips to 1 and report
  per-item success/error.
- **SQLCipher DB resilience.** WAL mode with
  `wal_checkpoint(TRUNCATE)` on graceful shutdown and
  `integrity_check` on startup; an unrecoverable DB surfaces a
  typed error rather than silently truncating.
- **Editor crash recovery.** Editors write a `.tessera-recovery`
  JSON sidecar before each auto-save; the renderer offers to
  restore via `artifacts:checkRecovery` /
  `artifacts:discardRecovery` on next launch.
- **Sidecar PID registry.** Sidecar lifecycle records PIDs to
  `{userData}/tessera-sidecar.pid`, orphan-cleans them at next
  startup, and escalates SIGTERM → 5 s grace → SIGKILL on
  `will-quit`.
- **Failed-export queue.** Failed exports land in a persistent
  queue (`failedExportQueue.ts`) and surface via
  `artifacts:failedExports` / `artifacts:retryExport`; the queue
  survives restart through `config.json`.
- **Connector backoff classification.** Sync errors are classified
  transient (timeout / 429 / 503) vs permanent (401 / 403 / 404)
  and retried with exponential backoff (base 2 s, max 5 min,
  jitter); per-source last-error + retry-count is persisted.
- **Audit log rotation.** Rotates at 100 K rows to
  `audit-archive-<ts>.jsonl.gz` and exposes archives via
  `audit:getArchives`.
- **Three-step onboarding wizard.** Fires only when the workspace
  is empty; persists `onboarding_completed`.
- **Empty states.** Every list page (Sources, Tasks, Automations,
  Templates) renders a Lucide-iconified empty state with
  descriptive copy and a primary CTA.
- **Toast policy.** Stack-max-3, 5 s auto-dismiss for non-errors,
  persistence-until-dismissed for errors, focus trap on hover,
  Escape to dismiss.
- **Source Health dashboard.** Backed by a new
  `sources:healthReport` IPC (last sync time, status, indexed
  chunk count, storage size).
- **Template gallery keyboard nav.** Roving tabindex, arrow keys,
  Enter to select, Tab between filter and grid,
  `aria-activedescendant`.
- **Version diff.** Section / cell / record-level diff between any
  two versions of an artifact, via an in-tree LCS implementation
  (no external diff library).
- **HomePage dashboard.** Real recent artifacts (sorted by modified
  time) and a source-status breakdown card driven by the canonical
  Rust `SourceStatus` ordering, with quick actions for Templates /
  Tasks / Sources / Settings.
- **Source-type glyphs.** Per-source-kind glyph (📁 local folder,
  📄 local file, 💬 KChat channel) on `SourcesPage` and
  `SourceDetailPage`. `role="img"` + `aria-label` for screen-reader
  support.
- **Template-validation audit logging.** Template parse and
  validation failures route through the audit log via a typed
  `TemplateLoadFailureKind` (`parse` vs. `validation`), so silently
  dropped templates are visible in packaged builds.

#### Export fidelity

- **DOCX golden fixtures.** Five fixtures (headings, lists,
  tables, code blocks, citations) pin byte-stable output AND
  OOXML-schema validity.
- **XLSX formula fidelity.** SUM / AVERAGE / COUNT / MIN / MAX are
  preserved as formula strings (not computed values), and named
  ranges round-trip.
- **PDF Mermaid embedding.** Mermaid blocks pre-render to SVG and
  are embedded through the Typst pipeline; flowcharts no longer
  leak as raw source.

#### Platform support

- **Linux on equal footing.** Prerequisites (`libsecret-1-dev`,
  `libgtk-3-dev`, `libnss3-dev`, `libasound2-dev`, `libxss1`,
  `libxtst6`, `xdg-utils`), packaging (AppImage, `.deb`, arm64),
  runtime detection (AVX2 / AVX-512 VNNI / NEON / dotprod /
  Vulkan / CUDA / ROCm) are now documented alongside macOS and
  Windows in `README.md`, `ARCHITECTURE.md`, and
  `CONTRIBUTING.md`.
- **Linux smoke test.** `scripts/smoke-test-linux.sh` +
  `scripts/Dockerfile.smoke` build the `.deb` and AppImage, install
  in an `ubuntu:22.04` container, launch under `xvfb-run`, assert
  the main window is ready, and round-trip one IPC.
- **Windows portable-zip verifier.** `scripts/verify-windows-package.ps1`
  asserts that the NSIS exe and portable zip both ship
  `Tessera.exe`, `resources/`, and the native `.node` addon.
- **macOS universal-binary verifier.** `scripts/verify-macos-package.sh`
  asserts the native addon is universal (`lipo -info` reports
  both `x86_64` and `arm64` slices) or splits into two
  architecture-specific DMGs.
- **Custom-provider `/v1/models` 404 handling.**
  `externalProvider:listModels` returns a typed `endpoint_not_found`
  result on HTTP 404 from a custom provider; the renderer surfaces
  a clear hint pointing at the exact URL and the manual-entry input.
- **External-provider rate limits.**
  `externalProvider:listModels` and `externalProvider:test` share
  token-bucket gates (1 req / s, burst 5 and 3 respectively) on
  separate buckets.
- **KChat citation dark-mode styling.** KChat-specific class names
  in `CitationPanel` now render as chip-style badges with a
  primary-tinted background, brand-tinted left-accent on
  KChat-derived rows, muted secondary text for metadata fragments,
  theme-aware link tokens for permalinks. Every color is a
  `var(--color-…)` reference so dark-mode overrides apply
  automatically.

#### Keyboard-first navigation — fuzzy quick switcher & expanded palette

- **Global fuzzy quick switcher (`Ctrl/Cmd+O`).** An Obsidian-style
  overlay, distinct from the command palette, that fuzzy-finds and jumps
  to any source, artifact, template, automation, task, or app page —
  reading live data via `window.tessera.*`, ranking by fuzzy score with
  a recency boost, and floating recently-viewed artifacts to the top.
  Keyboard-only operable (ARIA combobox + listbox, focus trap, focus
  restoration), debounced via `useDeferredValue`, results capped and
  virtualised past 30 rows for large libraries. Degrades gracefully with
  a banner when the bridge is unavailable or a partial load fails.
- **Broader command palette.** Commands to navigate to every page,
  create each artifact type, open settings sections via deep links
  (e.g. `/settings#performance`), run connector actions, trigger
  substrate decay/synthesis, and open the keyboard-shortcuts help — all
  sourced from the single `COMMAND_REGISTRY`.
- **Consistent global shortcuts.** `Ctrl/Cmd+K` (and `Ctrl/Cmd+P`)
  command palette, `Ctrl/Cmd+O` quick switcher, `Ctrl/Cmd+/` (and `?`)
  keyboard-shortcuts help. The three overlays are mutually exclusive,
  and every chord is listed in the cheatsheet.

### Changed

- **Quick switch rebinds to `Ctrl/Cmd+O`; `Ctrl/Cmd+P` now opens the
  command palette.** Previously `Ctrl/Cmd+P` opened a recent-artifact
  quick switch. It now opens the full command palette (aliasing
  `Ctrl/Cmd+K`), and the new cross-entity quick switcher takes
  `Ctrl/Cmd+O` (Obsidian convention). Users relying on `Ctrl/Cmd+P`
  muscle memory for artifact switching should use `Ctrl/Cmd+O`.
- **OAuth refresh races are coalesced.** Concurrent expired-token
  detections now produce exactly one upstream refresh call via a
  per-provider mutex in `ipc/connectors/handlers.ts`.
- **CSP `script-src` / `style-src-elem`** swap `'unsafe-inline'`
  for `'nonce-<random>'`. `style-src-attr` retains
  `'unsafe-inline'` to cover trusted framework-generated `style="…"`
  attributes from React / lucide-react.
- **`napi` crate documented as targeting macOS, Windows, AND
  Linux** (x64 + arm64) — previous wording listed only macOS and
  Windows.
- **`KchatAuthService` symmetric teardown.** `disconnect()` flips
  `authMode = "none"` BEFORE calling `client.shutdown()`, so no
  `disconnected` status push ever carries a stale `authMode: "pat"`.
- **SSRF guard re-validated on vault restore.**
  `enforceKchatServerUrl` is re-run when restoring a PAT session
  from the vault — defence-in-depth against SSRF policy tightening
  between sessions and against tampered vault entries.
- **`restoreFromVault()` token-only rollback** on verify failure.
  The in-memory token is rolled back via `setToken(null)` but
  `serverUrl` is intentionally NOT rolled back; the token-presence
  guard in `KchatClient.request()` prevents outbound traffic to
  the stale URL.
- **`LocalApiErrorCode` ↔ HTTP-status canonical mapping.** Added
  `payload_too_large` paired with 413 so extensions can branch on
  `code` to distinguish payload-size failures from malformed-body
  failures.
- **Port-file-write failure rollback** in
  `KchatLocalApiServer.start()`. If `writeAtomic()` fails after a
  successful `listen()`, the server closes the bound socket and
  clears `this.server` / `this.boundPort` / `this.portFileAbsPath`
  before re-throwing.
- **Concurrency-hardened start/stop state machine** for
  `KchatLocalApiServer` — three-slot state machine in `appState.ts`
  safe against every overlap of start and stop: concurrent starts
  coalesce, stop-during-in-flight-start (success and rejection
  paths) does not strand a server, start-during-in-flight-stop
  parks the new start on the stopping promise, concurrent stops
  resolve to one `server.close()` call.
- **Hoisted `shell` import** in `apps/desktop/electron/ipc/kchat.ts`
  — replaced two `await import("electron")` sites with a top-level
  `import { shell } from "electron"`.

### Removed

- **`PHASES.md` and `PROGRESS.md`.** Internal phase / task tracking
  superseded by the per-release changelog and per-PR descriptions.
  All user-facing content is reflected here, in `README.md`,
  `ARCHITECTURE.md`, or `SECURITY.md`.
- **Prior KChat socket-bridge surface.** Removed
  `kchatExtensionBridge.ts`, `kchatExtensionSession.ts`,
  `kchatExtensionEvents.ts`, three `kchat:extension*` preload
  channels (`kchat:extensionStatus`, `kchat:extensionConnect`,
  `kchat:extensionDisconnect`), the `extension-delegated` vault
  provider, and the per-platform socket-discovery code. Superseded
  by the `.kcz` extension + loopback HTTP API + deeplink
  architecture (see Added). PAT mode survives unchanged.
- **`KchatAuthMode` value `"extension"`.** `authMode` is now
  `"none" | "pat"`. The mode-aware UI surfaces in
  `KchatSettingsCard` collapsed to a single PAT path plus the
  passive "KChat Desktop detected" affordance driven by the
  loopback API heartbeat.

### Tests

- **AEAD full-lifecycle round-trip.** Integration tests on
  `tessera_sources::manager` exercise the full ingest → DEK wrap →
  ciphertext → decrypt → cryptoshred → regrant → re-ingest →
  search chain, plus thread-context retrieval across a cryptoshred
  boundary.
- **Hybrid search regression battery.** Scoring-axis consistency
  between file and post search (RRF `1.0 / (rank + 1.0)`),
  revocation-takes-effect-immediately on the same manager
  instance, BM25 ordering preserved through AEAD verification,
  cross-source revocation isolation.
- **Preload contract regression.** Asserts that every channel in
  the 17-entry `EXPECTED_KCHAT_CHANNELS` master list has a matching
  `ipcRenderer.invoke("<channel>")` string in `preload.ts` —
  catches the failure mode where a handler is registered but the
  preload bridge entry is missing.
- **Ed25519 updater signature.** Real-key (`crypto.generateKeyPairSync("ed25519")`,
  no algorithm mocks) tests for happy path (single anchor),
  multi-anchor rotation overlap, tampered payload and signature
  rejection, large-payload streaming, disk vs in-memory flow, and
  the anchor-loop continuation behaviour (one anchor throws → next
  anchor still verifies). 60+ tests across `updaterSignature.test.ts`
  and `autoUpdaterSignature.test.ts`.
- **Per-app keychain ACL.** Trust-tier classification per backend,
  `enforceKeychainAcl` flag respected (refuses to encrypt under
  `basic_text` when set), mid-session backend drift logged before
  refusal, reads never gated. 26 tests in `keychainAcl.test.ts`.
- **App-lock.** PIN scrypt parameters read back from the stored
  record (not module constants); rate-limit parity across all five
  app-lock IPC channels; bidirectional `appLockMode` ↔ PIN
  lifecycle coupling (`settings:update({mode:'pin'})` requires a
  stored PIN, `settings:update({mode:'off'})` clears the PIN,
  `appLock:removePin` resets mode to `'off'`).
- **OAuth scope governance.** `MissingScopeError` classified as
  permanent (not retried with exponential backoff), `offline_access`
  filtered out of the required set, Jira / Confluence / OneDrive
  regression cases pinned, `SCOPELESS_PROVIDERS` allow-list
  documented.
- **Telemetry sink.** Buffer cap re-applied on re-enqueue (no
  unbounded growth on persistent retriable errors), `flushSync` →
  `flushAsync` asymmetry documented, `getEventsSnapshot`
  flush-disjointness invariant documented.
- **KChat Desktop integration suite.** `kchatDesktopIntegration.test.ts`
  covers bind / discovery, auth + Host-header policy, route
  surface, deeplink parsing, bridge lifecycle, cold-start argv
  scanning, port-file-write rollback (kernel-assigned port
  captured from inside the failing writer, ECONNREFUSED, second
  `start()` succeeds), and null-address symmetric teardown.
- **Start/stop state machine regression suite.**
  `kchatLocalApiServerSingleton.test.ts` pins seven race
  scenarios: concurrent-starts coalesce, sequential cached fast
  path, stop-then-start cycle, stop-during-in-flight-start
  (success and rejection paths), start-during-in-flight-stop
  (parks on stopping promise), concurrent-stops resolve to one
  `server.close()`.
- **KChat citation dark-mode contract.** `darkModeTokens.test.ts`
  pins that every KChat-specific CSS class CitationPanel
  references has a rule in `components.css`, that every rule uses
  only `var(--color-…)` token references (no bare hex / rgb /
  hsl), and that every token referenced is in the dark-mode-safe
  allow list.
- **50+ new Vitest + Rust integration tests** across the workspace
  reliability tranche: startup-perf guard, indexing / search
  Criterion benches, memory peak RSS budget test, watcher
  coalescing test, batch-IPC tests, WAL + integrity crash-recovery
  test, artifact recovery sidecar tests, sidecar PID registry
  tests, failed-export queue tests, connector backoff
  classification tests, audit rotation test, DOCX golden + OOXML
  schema tests, XLSX formula + named-range round-trip tests,
  PDF Mermaid embedding test, Linux smoke-test exit-code gate,
  Windows / macOS package-verifier tests, onboarding wizard +
  empty-state + toast + source-health + keyboard-nav + version-
  diff Vitest suites, CSP nonce assembly + no-unsafe-inline tests,
  OAuth refresh race tests, secret zero-on-free tests,
  sliding-window rate-limiter unit + HTTP integration tests.

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
