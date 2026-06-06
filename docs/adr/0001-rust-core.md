# 1. Rust for the core engine

## Status

Accepted.

## Context

Tessera's core does CPU- and IO-heavy work that runs on every user's
machine and must be correct, fast, and memory-safe: file scanning and
folder watching, BLAKE3 hashing and deduplication, multi-format text
extraction, chunking and embedding orchestration, hybrid retrieval,
encrypted local storage, the artifact generation pipeline, connector
sync, audit logging, the export engine, and supervision of local model
sidecars.

This work also has to interoperate with a knowledge substrate that is
already Rust-oriented, and it has to ship to desktop (macOS, Windows,
Linux) without a garbage-collector pause profile that would hurt
indexing throughput or UI responsiveness.

## Decision

Implement the core engine in Rust as a Cargo workspace of focused
crates under `crates/`:

- `tessera_core` — shared types, configuration, error handling, and the
  database layer.
- `tessera_sources` — ingestion, extraction, chunking, embedding, and
  hybrid search.
- `tessera_artifacts`, `tessera_templates`, `tessera_citations`,
  `tessera_export`, `tessera_audit` — the artifact domain.
- `tessera_runtime` — the local model runtime and adapters.
- `tessera_connectors` — cloud connector integrations.
- `tessera_bridge` — the N-API surface exposed to Electron (see
  [ADR-0008](0008-n-api-bridge.md)).

The workspace pins `rust-version = "1.88"` and forbids `unsafe` code via
workspace lints in `Cargo.toml`. CI builds with `RUSTFLAGS="-D warnings"`
so every warning is a hard error.

## Consequences

- Memory safety and `unsafe`-forbidden lints remove an entire class of
  bugs from the most security-sensitive part of the app (it handles
  decrypted user data and OAuth-bearing connector traffic).
- The strong type system and `Result`-based error handling
  (`tessera_core::Error`) make failure modes explicit across the
  ingestion and generation pipelines.
- The crate split keeps compile units small and dependencies acyclic,
  but it adds ceremony: cross-crate changes touch several `Cargo.toml`
  files, and the `-D warnings` gate means even doc and lint nits block
  the build.
- The team must maintain Rust expertise, and the N-API boundary
  ([ADR-0008](0008-n-api-bridge.md)) is required to reach the Electron
  UI because the UI itself is not written in Rust.
