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
