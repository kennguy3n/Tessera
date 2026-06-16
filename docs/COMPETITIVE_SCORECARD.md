# Competitive Scorecard

How Tessera stacks up on the six dimensions from the original product
critique. Tessera is a **local-first desktop app** (Electron + Rust core,
single-file encrypted SQLite) with **KChat (Mattermost v4)** as its
collaboration layer — it is deliberately *not* a SaaS, so it is compared to
Notion, Coda, and Google Workspace on capability and engineering quality,
not on cloud-hosted multi-tenant operations.

Scores are 1–10. "Baseline" reflects the original critique (6–8 across the
board); "Tessera" reflects the product as it ships today, including the
additive on-device knowledge substrate (encrypted sibling DBs; see
[ADR-0011](adr/0011-knowledge-substrate-integration.md)).

| Dimension | Baseline | Tessera | What moved it |
|---|:---:|:---:|---|
| Architecture | 7 | 9 | Versioned migration framework + typed errors + auto-sized read pool; **knowledge substrate as an additive native layer (encrypted sibling DBs)** |
| Features | 7 | 9 | **Editor parity wave: Document callout/toggle/TOC blocks + outline/reading-time + AI writing assistant; Sheet 160+ formula functions + named ranges + data validation + conditional formatting + range-bound charts + pivot tables; Base multi-table linked records + lookup/rollup + expand-record modal + group-by + form view + App mode; Slide layout engine + deck templates + themes + speaker notes + presenter mode + Brand Kit; in-editor template galleries + save-as-template + portable template files across all four editors; a deliberate multi-step Skills engine; registry-derived Create + 287-template (530 with locales) library**; inline comments, task deps + Gantt, multi-step automations; observation extraction, decay-based memory, concept graph, **33 read-only connectors**, local backup/restore; the knowledge browser (Memory page, concept-graph panel, "Knowledge" citation tab, HomePage insights) ships in the renderer |
| Performance | 6 | 9 | Incremental IVF, 100K/500K benches, virtual scrolling, read-pool pre-warm, 3s cold-start CI gate |
| Cost / install size | 7 | 8 | Symbol stripping, locale pruning, delta updates, resumable model downloads, sharper CI cache |
| Security | 8 | 9 | FIDO2 app-lock, secure_delete everywhere, keychain enforce-block, tightened CSP, supply-chain CI gates; **XChaCha20-Poly1305 DEK wrapping, optional ML-KEM-768 KEM, ML-DSA-65 export signing** |
| Maintainability | 6 | 9 | 11 ADRs, `missing_docs` + `cargo doc` gate, generated IPC types, error boundaries, dependency inventory; **single upstream-`crypto` source of truth** |

---

## Architecture — 7 → 9

- **Versioned migrations.** `crates/tessera_migrate` runs forward-only,
  numbered SQL migrations recorded in a `_migrations` table with rollback
  stubs. The previously ad-hoc migration blocks inlined in
  `tessera_sources` are ported into discrete migration files, so schema
  evolution is auditable and testable (fresh DB, v1→v5 upgrade,
  idempotency).
- **Typed errors.** `Error::Database(String)` is replaced by
  `Error::Sqlite` (wrapping `rusqlite::Error` so callers can match the
  concrete cause) and `Error::DatabaseState(String)` (semantic failures).
- **Adaptive read pool.** Reader connections auto-size to CPU count
  (capped at 4) and are pre-warmed at boot.

*vs. competitors:* a single-file, schema-versioned, fully typed local
core is more transparent and portable than the opaque server-side schemas
of Notion/Coda; parity-or-better on engineering rigor.

## Features — 7 → 9

- **Editor parity wave.** The four editors moved from "structured output
  targets" to full editing surfaces at parity with the category leaders,
  all on-device:
  - **Document → Google-Docs/Notion level.** Callout, toggle, and
    table-of-contents blocks (`DocumentEditor.tsx` + TipTap extensions);
    a scroll-tracked outline panel with reading-time estimate; and an
    on-device AI writing assistant (`AiAssistantPanel.tsx`:
    rewrite/shorten/expand/tone/translate/continue + Ask-AI with a
    word-diff preview).
  - **Sheet → Google-Sheets level.** A real formula engine with **160+
    functions** (`editors/formulaEngine/functions/*`: math, stats, logic,
    conditional, lookup, text, date), **named ranges**
    (`NamedRangePanel.tsx`), **data validation** (dropdown/checkbox,
    `sheetDataValidation.ts`), rule-based **conditional formatting**,
    **range-bound charts** (bar/line/pie, `ChartsPanel.tsx`), and **pivot
    tables**, plus AI NL→formula/explain/fix (`SheetAiPanel.tsx`).
  - **Base → Airtable level.** Multi-table bases with **cross-table
    linked records** carrying **lookup/rollup** fields, an
    **expand-record modal** with comments + activity, grid
    group-by / row-height / frozen-columns, and **six views** (Grid /
    Kanban / Calendar / Timeline / Gallery / Form); on-device AI for
    schema-gen / NL→formula / column-fill (`baseEditorTypes.ts`). A
    builder⇄**App mode** turns any base into a lightweight internal app —
    app-shell nav, record-detail page, runtime data-entry forms, and a
    summary dashboard over existing fields.
  - **Slide → Google-Slides/Gamma level.** A smart **layout engine**
    (timeline / process / comparison / gallery / metric), **deck
    templates** and insert-card presets (`slideTemplates.ts`), richer
    themes with a visual picker, a **Brand Kit** (colours / fonts / logo /
    background) with portable brand packs (`tessera.brandpack`),
    **brand-faithful PPTX / PDF / HTML export**, **brand import from an
    existing `.pptx`**, **speaker notes**, a **presenter mode**
    (fullscreen second window), and AI deck generation
    (`SlideAiPanel.tsx`).
- **In-editor template galleries.** Every editor — Document, Sheet, Slide,
  Base — opens a built-in template gallery: insert a starter, save the
  current artifact (or a selection) as a reusable template, and import /
  export portable template files (`tessera.doctemplate`,
  `tessera.sheettemplate`, `tessera.slidetemplate`, `tessera.basetemplate`),
  each guarded by a hardened envelope-version check that mints a fresh id on
  import.
- **Deliberate Skills engine.** AI actions run as ordered multi-step skills
  with per-step deterministic output checks and bounded auto-repair, per-step
  sampling, and a per-step output-format contract, so a small on-device model
  produces structured, reliable output. Skills are wired into Slides, Sheets,
  and Base, are user-authorable, and export / import as portable
  `tessera.skill` files.
- **Registry-derived Create + enriched library.** Create cards are derived
  from the template registry, so dropping a template YAML surfaces a
  filterable card (industry / language / country filters) with no
  `CreatePage` edit. The library ships **287 English templates** across six
  artifact types (**530 including nine non-English locales**), pre-tagged
  across 10 industries with country / jurisdiction variants.
- **Connectors.** A catalog of **33 read-only, least-privilege
  providers** (`connectorDescriptors.ts`) spanning storage (Drive,
  OneDrive, Dropbox, Box, SharePoint), docs/wikis (Notion, Confluence,
  Google Docs/Sheets), project/issue tracking (Jira, Linear, Asana,
  ClickUp, Trello, Monday.com, GitHub, GitLab, Bitbucket), CRM/support
  (HubSpot, Salesforce, Intercom), design (Figma, Miro), and
  comms/calendar (Slack, Teams, Discord, Zoom, Google Calendar/Meet,
  Gmail).
- **Tasks & automations:** task **dependencies** with topological cycle
  detection, an **SVG Gantt** timeline, an
  `on_kchat_message_match(channel_id, regex)` trigger, and **multi-step**
  automation actions with per-step error handling.

*vs. competitors:* closes the visible gaps with Notion/Coda/Airtable and
Google/Microsoft (rich blocks + AI writing, a real formula library,
multi-table linked records with lookup/rollup, slide layouts/themes/
presenter mode) while keeping every editor and every connector
offline-capable and least-privilege.

## Performance — 6 → 9

- **Incremental IVF:** new vectors are assigned to the nearest centroid;
  a full k-means rebuild only triggers past a 20% corpus change.
- **Scale benches:** Criterion corpora extended to 100K and 500K chunks.
- **UI:** virtual scrolling for Sheet/Base grids at 10K+ rows.
- **Boot:** read-pool pre-warm + a CI **cold-start gate** that fails if
  boot-to-first-render exceeds 3s on the ubuntu runner.

*vs. competitors:* sub-second local retrieval at large corpus sizes with
no network round-trips, which web apps cannot match.

## Cost / install size — 7 → 8

- Release builds **strip** debug symbols from the Rust N-API addon.
- Unused Electron **locales** pruned from packaging.
- **Delta (blockmap) updates** and **HTTP range-request resume** for
  model downloads cut bytes-on-the-wire.
- CI cargo cache key hashes `rustc --version` alongside `Cargo.lock`.

*vs. competitors:* zero per-seat subscription; smaller download/update
footprint than a typical Electron app of this scope.

## Security — 8 → 9

- **FIDO2/WebAuthn** as a third app-lock method (with PIN + biometric).
- `PRAGMA secure_delete` wraps **every** artifact/source deletion path.
- Linux `basic_text` keychain fallback warns at runtime and **blocks
  secret writes in enforce mode**.
- CSP **wildcard origins removed**.
- `cargo vet` + `npm audit --audit-level=high` as CI **supply-chain
  gates**.

*vs. competitors:* data stays on-device in an encrypted single-file DB;
no server-side data custody to breach.

## Maintainability — 6 → 9

- **11 ADRs** under `docs/adr/` for the load-bearing decisions.
- `#![warn(missing_docs)]` on public Rust crates + a `cargo doc --no-deps`
  CI step.
- Renderer TypeScript types **auto-generated** from the zod IPC schemas,
  with a CI drift check (`check:ipc-types`).
- React **error boundaries** around every editor/page writing
  `crash-report.json` on crash.
- Auto-generated `docs/DEPENDENCIES.md` license inventory.

---

## Knowledge substrate integration

The `kennguy3n/knowledge` Rust substrate — previously documented but
never invoked — is now wired in as an **additive** native layer behind a
thin Tessera-owned adapter (`crates/tessera_substrate`), keeping the
existing `tessera_sources` storage/search and the N-API/IPC contract
unchanged. New data lives in **separately-encrypted sibling DB files**
keyed from the same master key, preserving the single-file local-first,
encryption-at-rest posture. See
[ADR-0011](adr/0011-knowledge-substrate-integration.md).

- **Memory & knowledge.** `observation_engine` extracts
  entities/facts/tasks/decisions on ingest; `memory_manager` applies a
  decay state machine (active → fading → archived) with retention
  scoring; `concept_graph` builds a typed graph (is_a / part_of /
  supersedes / contradicts). These engines and their N-API/IPC data
  plane (`sources:searchEnriched`, `substrate:suggestRelatedSources`)
  ship on `main`. The dedicated knowledge UI surfaces now **ship in the
  renderer** too: a **Memory page** (sidebar **Memory** / `Ctrl+9` /
  `/memory`) with a **concept-graph panel**, an enriched **"Knowledge"
  citation tab** (open an artifact → **Citations** → Sources/Knowledge),
  **HomePage knowledge insights**, and a substrate section on each
  source's detail page. The substrate is therefore a full knowledge
  browser, not just a backend/data-plane capability.
- **Search.** Hybrid retrieval is enriched with matching
  entities/concepts/memories and adds memory retention as a fourth RRF
  signal. The user-facing controls that ship today are the Settings →
  Search card (hybrid lexical+vector toggle, temporal-decay toggle,
  recency half-life) and concept-graph-driven "related source"
  suggestions in the Create flow.
- **Connectors v2.** `connector_framework` + `connectors` back the
  existing `connectors:*` IPC (behind `useV2Connectors`, default on),
  with synced content flowing through evidence → observation → memory;
  legacy connectors remain a reversible fallback.
- **Resilience.** Zero-config local backup/restore via SQLite's Online
  Backup API (hot copies, scheduler, retention pruning, bundle
  export/import) now also covers the substrate sibling DBs.
- **Post-quantum-ready crypto.** Per-source DEKs are wrapped with
  XChaCha20-Poly1305 (legacy AES-GCM stays readable, discriminated by
  nonce length); an optional hybrid X25519 + ML-KEM-768 KEM sits behind
  the `pqc` feature; exports carry ML-DSA-65 (FIPS 204) provenance
  signatures.

*vs. competitors:* structured, on-device knowledge extraction and a
local concept graph over the user's own sources — with post-quantum-ready
encryption and zero-config local backup — go beyond the raw
text-search-and-store model of Notion/Coda while keeping everything
offline-capable.

*CI note:* `kennguy3n/knowledge` is a private git dependency. CI now
clones and builds it over a **read-only SSH deploy key** (the
`KNOWLEDGE_DEPLOY_KEY` repo secret, wired through the
`.github/actions/knowledge-ssh` composite action), so substrate-touching
changes build and test in CI on every push — the earlier "CI cannot
clone the private dependency" limitation no longer applies. Local
validation (`cargo +1.88 fmt`/`clippy`/`test`, desktop
`lint`/`type-check`/`test`) remains the fast first-line check.

*vs. competitors:* documentation and generated-contract discipline that
is unusually strong for a desktop app of this size.

---

*Generated as part of the competitive-upgrade integration. See
`CHANGELOG.md` (Unreleased → Competitive upgrade) for the full change
list and `ARCHITECTURE.md` for subsystem detail.*
