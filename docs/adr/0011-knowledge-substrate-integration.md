# 11. Integrate the `kennguy3n/knowledge` substrate as an additive native layer

## Status

Accepted.

## Context

Tessera's `ARCHITECTURE.md` long described the `kennguy3n/knowledge`
Rust substrate as "Tessera's local memory and retrieval layer", but the
two systems shared zero code: Tessera hand-rolled its own storage,
search, chunking, connectors, and crypto under `crates/tessera_*`, while
knowledge's capabilities (encrypted append-only evidence storage,
entity/fact/task/decision extraction, a decay-based memory model, a
typed concept graph, GBNF-constrained synthesis, 140+ connectors, and
post-quantum crypto) were never actually invoked.

The goal of this integration was to close that gap and make those
capabilities real — without regressing Tessera's existing
single-user / single-file SQLCipher posture, its stable N-API/IPC
contract, or its encryption-at-rest guarantees (the product targets up
to ~5000 SME tenants, so data isolation and at-rest encryption are
first-class).

A hard constraint surfaced immediately: knowledge's `evidence_store`
pins `rusqlite = 0.36` with `bundled-sqlcipher-vendored-openssl`, while
Tessera pinned `0.32` with the same feature. Both activate
`libsqlite3-sys`'s `links = "sqlite3"` key, and two SemVer-incompatible
versions that each bundle SQLCipher cannot coexist in one build graph.

## Decision

Integrate the knowledge crates as **git dependencies** (not vendored),
pinned to a single rev, behind a thin Tessera-owned adapter, in a purely
**additive** way:

- **Dependency form.** Knowledge crates are pulled as git dependencies of
  `https://github.com/kennguy3n/knowledge`, pinned to the snapshot-API
  rev `b49daf4c4b4f567aa94eb4d11fcbb2ac6df56537` (knowledge#220). They
  are **not** vendored/copied — upstream stays the source of truth and
  bumps are deliberate, single-line rev changes.
- **`rusqlite` unification.** The workspace `rusqlite` pin was bumped
  `0.32 → 0.36` (same `bundled-sqlcipher-vendored-openssl` feature, plus
  `blob` to match knowledge) so a single `libsqlite3-sys`/SQLCipher build
  serves the whole graph. All existing `tessera_*` crates compile against
  the bump with no code changes (the 0.32→0.36 API surface Tessera uses
  is stable).
- **Adapter crate `crates/tessera_substrate`.** Wraps the multi-tenant
  knowledge crates (`evidence_store`, `observation_engine`,
  `memory_manager`, `concept_graph`, `synthesis_pipeline`) into Tessera's
  single-user model: it derives a substrate master key via
  `HKDF(sqlcipher_key, "tessera:substrate:master:v1")`, opens
  SQLCipher-encrypted **sibling** DB files (`*substrate-evidence.db`,
  `*substrate-concepts.db`) keyed from that derived key, and collapses
  knowledge's multi-scope APIs onto a single default scope.
- **Bridge wiring.** `tessera_bridge` holds the adapter as
  `substrate: Mutex<SubstrateManager>` in `AppState`, initialized in
  `init_bridge()`. The substrate lock is always acquired **last**; on the
  auto-ingest path the `source_manager` and `substrate` locks are taken
  **sequentially, never overlapping**.
- **Additive N-API/IPC surface.** New `bridge_*` exports and `substrate:*`
  IPC channels (extract observations, list/pin/unpin/forget memories, get
  concept graph, run decay sweep, trigger synthesis, enriched search,
  related-source suggestions). No existing N-API/IPC signature changed.
- **Connectors v2.** `connector_framework` + `connectors` back the
  existing `connectors:*` IPC behind a `useV2Connectors` flag (default
  on), adding HubSpot/Slack/Email/GitHub to the original six. The legacy
  `tessera_connectors` path is retained as a reversible fallback.
- **Post-quantum crypto.** The knowledge `crypto` crate provides
  XChaCha20-Poly1305 AEAD (v2 DEK wrapping, discriminated by 24-byte
  nonce vs. legacy 12-byte AES-GCM v1), an optional hybrid
  X25519 + ML-KEM-768 KEM (cargo feature `pqc`, default off), and
  ML-DSA-65 (FIPS 204) detached export-signing sidecars.
- **Single `crypto` source of truth.** The substrate and the
  post-quantum layer both depend on the upstream `crypto` crate. It is
  declared **once** in the workspace manifest (alias `knowledge_crypto`,
  rev `b49daf4`) and consumed by every crate via `{ workspace = true }`,
  so exactly one copy of `crypto` (and its ML-KEM/ML-DSA transitive tree)
  is compiled and audited. A second declaration at a different rev would
  silently fork the crypto crate in two — see Consequences.

### What was replaced vs. kept

- **Kept (unchanged, still the source of truth):** `tessera_sources`
  indexing, chunking, BM25+vector hybrid retrieval, and the existing
  `sources` / `chunks` / `chunk_embeddings` tables. The substrate never
  reads or writes those tables.
- **Added (net-new capability):** observation extraction, the decay-based
  memory model, the concept graph, synthesis windows, observation- and
  retention-enriched search, connectors v2, local backup/restore, and the
  post-quantum crypto primitives.
- **Replaced internals (API/on-disk layout preserved):** per-source DEK
  wrapping in `tessera_sources::kchat_crypto` now delegates to
  `tessera_core::crypto` (XChaCha20-Poly1305 for new writes; legacy
  AES-GCM still decrypts), and the legacy six connectors prefer the v2
  bridge when `useV2Connectors` is enabled.

## Consequences

- Knowledge capabilities are now real and additive: existing flows keep
  working unchanged, and new data lives in separately-encrypted sibling
  DBs keyed from the same master key, preserving the at-rest posture.
- **One `crypto` crate, not two.** Declaring the upstream `crypto`
  dependency twice (e.g. the substrate at one rev and the PQC layer at
  another) makes Cargo treat them as distinct crates: two compiled copies
  of `crypto` plus its entire ML-KEM/ML-DSA transitive tree, a larger
  binary, slower builds, two code paths to security-audit, and a latent
  type-mismatch hazard if a `crypto` value is ever passed between the
  substrate and PQC layers. The workspace therefore keeps a **single**
  `knowledge_crypto` declaration; do not add a second `crypto` git entry
  at a different rev. `cargo tree --duplicates` must show no duplicate
  `crypto`.
- **Reproducible builds need one rev.** Every knowledge git dependency is
  pinned to the same rev (`b49daf4`). When bumping, change all of them
  together and run a build so `Cargo.lock` is regenerated consistently
  (`cargo metadata --locked` must succeed).
- **Private knowledge repo in CI — RESOLVED.** Originally, because
  `kennguy3n/knowledge` is private and CI had no credential for it, any
  workspace build in CI failed at the git-fetch step, and local builds
  were the only correctness signal. This has since been fixed with
  option (1) from the original plan: a read-only SSH **deploy key**
  (the `KNOWLEDGE_DEPLOY_KEY` repo secret, wired through the
  `.github/actions/knowledge-ssh` composite action) lets CI clone and
  build the private dependency, so substrate-touching changes build and
  test in CI on every push. Local `cargo +1.88 fmt/clippy/test` and the
  desktop `lint`/`type-check`/`test` suites remain the fast first-line
  check.
