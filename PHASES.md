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
| **Phase 13** | KChat extension bridge & polish — Tessera-as-extension to a running `uney-chat-desktop` instance: localhost-socket discovery, scoped session handoff, real-time event bridge, dual-mode `KchatAuthService` (PAT + extension), extension-aware Settings card + sidebar indicator, IPC audit + SSRF guard on the extension surface, post-sourced citation rendering, backfill progress UI, channel-file thumbnails / metadata, evidence-pack share path, thread context expansion in retrieval, AEAD + cryptoshred + hybrid-search regression tests, per-platform socket paths (Linux `$XDG_RUNTIME_DIR`, macOS Application Support, Windows named pipes), KChat source-type icons + dark-theme audit. | `DONE` |

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
