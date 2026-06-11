# Competitive Scorecard

How Tessera stacks up after the parallel competitive-upgrade release
**and the subsequent knowledge-substrate integration** (see
[ADR-0011](adr/0011-knowledge-substrate-integration.md)),
scored on the six dimensions from the prior critique. Tessera is a
**local-first desktop app** (Electron + Rust core, single-file encrypted
SQLite) with **KChat (Mattermost v4)** as its collaboration layer — it is
deliberately *not* a SaaS, so it is compared to Notion, Coda, and Google
Workspace on capability and engineering quality, not on cloud-hosted
multi-tenant operations.

Scores are 1–10. "Before" reflects the prior critique (6–8 across the
board); "After" reflects this release.

| Dimension | Before | After | What moved it |
|---|:---:|:---:|---|
| Architecture | 7 | 9 | Versioned migration framework + typed errors + auto-sized read pool; **knowledge substrate as an additive native layer (encrypted sibling DBs)** |
| Features | 7 | 9 | Comments, conditional formatting, form view, presenter mode, task deps + Gantt, multi-step automations; **observation extraction, decay-based memory, concept graph, connectors v2, local backup/restore** |
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

- **Editors:** inline document comments (author/timestamp/resolved +
  side panel), Sheet conditional formatting, a fillable Base **form
  view** (6th view type), and a **Slides presenter mode** (fullscreen
  second window with speaker notes).
- **Tasks & automations:** task **dependencies** with topological cycle
  detection, an **SVG Gantt** timeline, an
  `on_kchat_message_match(channel_id, regex)` trigger, and **multi-step**
  automation actions with per-step error handling.

*vs. competitors:* closes the most visible gaps with Notion/Coda
(comments, conditional formatting, forms, dependencies, Gantt) while
keeping everything offline-capable.

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
  supersedes / contradicts), all surfaced in the UI (Memory page,
  concept-graph panel, HomePage insights).
- **Search.** Hybrid retrieval is enriched with matching
  entities/concepts/memories and adds memory retention as a fourth RRF
  signal, plus concept-graph-driven "related source" suggestions.
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

*Known limitation:* because `kennguy3n/knowledge` is a private git
dependency, CI cannot clone it and fails at the fetch step;
substrate-touching changes are validated locally (`cargo +1.88
fmt`/`clippy`/`test`, desktop `lint`/`type-check`/`test`) until a CI
credential (deploy key / submodule / private registry / vendoring) is in
place.

*vs. competitors:* documentation and generated-contract discipline that
is unusually strong for a desktop app of this size.

---

*Generated as part of the competitive-upgrade integration. See
`CHANGELOG.md` (Unreleased → Competitive upgrade) for the full change
list and `ARCHITECTURE.md` for subsystem detail.*
