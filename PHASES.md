# Tessera — Phase Index

A one-page summary of Tessera's delivery phases. For task-by-task tracking,
exit criteria, and full changelog, see [PROGRESS.md](PROGRESS.md).

---

## Phase summary

| Phase | Theme | Status |
|---|---|---|
| **Phase 0** | Open-source foundation (repo, license, contribution guide, security policy, architecture & proposal docs, app skeleton). | `DONE` |
| **Phase 1** | Desktop shell — Electron + React + TypeScript renderer, Rust N-API bridge, Home / Sources / Templates / Settings screens, local config persistence. | `DONE` |
| **Phase 2** | Local source indexing — local folders & files, file watcher, content hashing, text extraction (PDF / DOCX / PPTX / XLSX / CSV / MD / TXT / HTML / JSON), chunking, encrypted local store, hybrid retrieval (FTS5 + vector + recency), source detail page. | `DONE` |
| **Phase 3** | Templates & artifacts — template/artifact JSON schemas, TipTap document editor, slide & sheet & base editors, citation panel, version history, exports (Markdown / HTML / CSV / PDF). | `DONE` |
| **Phase 4** | Local model runtime — sidecar lifecycle, Ternary-Bonsai 1.7B / 4B / 8B, streaming generation, GBNF structured output, runtime status UI. | `DONE` |
| **Phase 5** | First remote connector — Google Drive OAuth 2.0, OS-keychain token storage, file/folder picker, incremental + metadata sync, local indexing, disconnect, audit events. | `DONE` |
| **Phase 6** | Productivity workflows — PRD / Proposal / SOP / QBR generators, budget / vendor / risk register templates, task & decision extraction, source comparison, review checklist, evidence-pack export. | `DONE` |
| **Phase 7** | Platform expansion, rendering integrations, new generators, export coverage — Linux as first-class target, Mermaid / Marp / Typst rendering, Lucide + Phosphor icons, Infographic & Landing Page artifact types, DOCX / PPTX / XLSX exports, CI matrix, full doc sweep. *Foundations landed in Phase 7; many runtime integrations were finally wired into source in **Phase 8**.* | `DONE` (implementation completed in Phase 8) |
| **Phase 8** | Connectors, surfaces, views, missing features — 5 new remote connectors (OneDrive/SharePoint, Notion, Jira, Confluence, Figma), Tasks/Plans & Automations surfaces with scheduler, Plan & Approve template categories, four new Base views (Kanban / Calendar / Timeline / Gallery), Analyze workflows on `CreatePage`, end-to-end Mermaid & icon export coverage, integration tests. Closes the gap between Phase 7's claimed surface and the code that ships. | `DONE` |
| **Phase 9** | Feature pass — five missing templates (Form, Asset inventory, Tracker, Inventory, Roadmap-as-Base), advanced citation workflows (source-changed detection, replacement, removal with audit events), optional external LLM provider (OpenAI-compatible / Anthropic / custom) with keychain-stored API keys, `.gitignore`-style ignore patterns + image metadata extraction + incremental re-index progress, UI hardening (keyboard shortcuts, focus traps, dark mode, dismissible toasts), production readiness (root error boundary, JSONL logger, release workflow). | `DONE` |
| **Phase 10** | Production hardening — hybrid retrieval UX (embedding backfill, config UI, relevance display), security hardening (CSP per-connector allow-list, password vault, rate limiter, export path containment, audit-trail completeness, extracted-item XSS), external LLM provider SSE streaming + retry + token counting + model listing + cancellation UX, template & artifact expansion (>170 templates across ten industries and ten BCP-47 locales), comprehensive testing & accessibility audit, documentation consistency sweep, HomePage breakdown, template-validation audit logging, structured source comparison modal. | `DONE` |
| **Phase 11** | Multi-capability model slots — vision + image-generation capabilities alongside the existing text capability. Per-slot model registry, vision + diffusion sidecars and bridges, VLM-powered image / PDF / chart extraction in the indexing pipeline, image-generation wiring into the infographic + landing-page editors, dedicated Vision page UI, per-capability Settings panels, ARM64 / NEON / dotprod / ROCm runtime detection. (Blocks A–F.) | `DONE` |
| **Phase 12** | KChat (Mattermost v4) integration — server-URL + PAT auth, channel-files indexing, ShareToKchat artifact upload, WebSocket-driven event pipe with backpressure, single-file targeted sync (`file_added`), channel ACL projection (`user_added` / `user_removed` / `channel_member_updated`), cryptoshred-on-revoke, KChat post indexing with per-source DEK + column AEAD, historical backfill watermark loop, KChat post content retrieval bridge + `kchat:searchPosts` IPC + KchatPostSearchHit citation surface. (Blocks A–D.) | `DONE` |
| **Phase 13** | KChat extension bridge & polish — *(superseded by Phase 14)* Tessera-as-extension to a running `uney-chat-desktop` instance over a per-platform handshake socket. The socket-bridge surface (`kchatExtensionBridge.ts` / `kchatExtensionSession.ts` / `kchatExtensionEvents.ts`, the three `kchat:extension*` IPC channels, the `extension-delegated` vault provider, and the per-platform discovery code) was removed in Phase 14 in favour of a `.kcz` extension installed *inside* KChat Desktop. The PAT auth path, KChat content retrieval (citation rendering, backfill progress, file preview, evidence-pack share, thread context, hybrid search), and AEAD + cryptoshred regression tests landed in Phase 13 and remain in production unchanged. | `DONE` (socket bridge superseded by Phase 14; REST + PAT surface unchanged) |
| **Phase 14** | KChat Desktop integration via `.kcz` extension + loopback HTTP API + deeplinks (Tasks 1–8 in PR #58, Tasks 9–30 in this docs sweep). Replaces Phase 13's socket bridge with the correct architecture: Tessera and KChat Desktop are *two independent Electron clients* that share only the KChat server backend. Cross-app surface is (a) a signed `.kcz` extension (`extensions/tessera-kchat/`) installed inside KChat Desktop and talking to Tessera over a loopback-only HTTP API on `127.0.0.1` (bearer-token auth, Host-header SSRF guard, 64 KiB body cap, port discovery via `{userData}/tessera-kchat-port.json` at mode 0600), (b) `tessera://` deeplinks for KChat-Desktop → Tessera navigation with pre-ready route parking + Windows/Linux cold-start argv scan, and (c) `kchat://` deeplinks for Tessera → KChat-Desktop navigation via `shell.openExternal()`. Concurrency-hardened start/stop state machine for the loopback server (pending-promise + stopping-promise slots) verified across 7 race scenarios. 17 rounds of Devin Review surfaced 13 real bugs / doc bugs / footguns — all fixed with correct long-term architectural changes. | `DONE` |
| **Phase 15** | Production quality & E2E reliability — six themes across 30 tasks: (1) **Performance & startup** — lazy-loaded heavy modules, startup-time profiler, parallel `rayon`-backed extraction, search/indexing Criterion benches, streamed bulk indexing under a 200 MB peak-RSS budget, 500 ms watcher coalescing, batch IPC channels. (2) **Reliability & crash recovery** — WAL mode + integrity-check-on-open, editor recovery sidecar journals, sidecar PID-file orphan cleanup with SIGTERM→SIGKILL escalation, persistent failed-export queue, per-connector exponential-backoff classifier (transient vs permanent), audit-log rotation to compressed JSONL archives. (3) **Export fidelity & platform parity** — DOCX golden + OOXML schema regression, XLSX formula + named-range preservation, PDF Mermaid SVG embedding, Linux `.deb`/AppImage Docker smoke harness, Windows portable-zip verifier, macOS universal-binary verifier. (4) **UX completeness** — first-run onboarding wizard, empty-state illustrations across every list page, dismissible+stacked toast provider, source health dashboard in Settings, keyboard-navigable template gallery (roving tabindex + `aria-activedescendant`), artifact version diff view. (5) **Security & compliance** — nonce-based CSP audit, OAuth refresh per-provider mutex, sensitive-buffer zero-on-free across every vault, sliding-window per-IP rate limiter on the KChat loopback API. (6) **Documentation & verification** — full Linux consistency sweep across `README.md` / `ARCHITECTURE.md` / `CONTRIBUTING.md` / sidecar download script, Phase 15 close-out across `PHASES.md` / `PROGRESS.md` / `CHANGELOG.md`. | `DONE` |

---

## Reading order

1. [PROPOSAL.md](PROPOSAL.md) — the product, in plain English.
2. [ARCHITECTURE.md](ARCHITECTURE.md) — how the pieces fit together (Rust crates, Electron main, React renderer, IPC surface, connectors).
3. [PROGRESS.md](PROGRESS.md) — per-phase task tables, exit criteria, and changelog.
4. [README.md](README.md) — quickstart and contributor entry point.

---

## Conventions

- **Status legend**: `DONE` / `IN PROGRESS` / `NOT STARTED`.
- **Phase ownership**: each phase carries its own exit criteria in
  [PROGRESS.md](PROGRESS.md); a phase only flips to `DONE` once every exit
  criterion is met in source.
- **Cross-phase cleanup**: when a later phase has to repair earlier phase
  claims (as Phase 8 did for Phase 7's rendering / connector / surface
  promises), the gap is documented in the changelog rather than silently
  re-stamping older entries.
