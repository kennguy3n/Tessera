# Changelog

All notable changes to Tessera are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/) and Tessera
adheres to [Semantic Versioning](https://semver.org/spec/v2.0.0.html).

---

## [Unreleased]

### Added

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

### Changed

- **Custom-provider `/v1/models` 404s.** `externalProvider:listModels`
  now returns a typed `endpoint_not_found` result on HTTP 404 from a
  custom provider; the renderer surfaces a clear hint pointing at the
  exact URL and the manual-entry input.
- **`externalProvider:listModels` / `externalProvider:test` rate
  limits.** Both channels share token-bucket gates (1 req / s, burst
  5 and 3 respectively) on separate buckets, matching the protection
  posture of the sibling generation channels.

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
