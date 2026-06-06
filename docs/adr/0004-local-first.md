# 4. Local-first architecture

## Status

Accepted.

## Context

Tessera transforms a user's personal and connected knowledge into
structured artifacts. That input is sensitive (private notes, company
documents, connector data), and users want ownership, offline
availability, and privacy rather than handing everything to a SaaS
backend. Tessera is explicitly *not* a cloud service.

## Decision

Adopt a **local-first** architecture: all data is stored on-device by
default, all core processing happens on-device, and network access is
opt-in and explicit.

How it manifests:

- **Storage.** The workspace database is a local SQLCipher file
  ([ADR-0003](0003-sqlcipher.md), [ADR-0009](0009-single-file-db.md));
  there is no server-side store.
- **Compute.** Ingestion, embedding, hybrid retrieval, and artifact
  generation run locally in the Rust core. The default embedding
  provider (`HashTrickEmbedding`) is fully offline, and text generation
  defaults to a local model runtime ([ADR-0006](0006-ternary-bonsai.md))
  before any external provider.
- **Explicit access.** Each source connection is user-authorized; OAuth
  tokens live in the OS keychain and are never exposed to the renderer.
  Disconnecting a source removes its local index and revokes remote
  tokens.
- **Auditability.** Source connections, syncs, generations, and exports
  are recorded in a local append-only audit log (`tessera_audit`).
- **External providers are opt-in.** The `ExternalAdapter` for hosted
  LLMs is disabled by default and only used when the user configures it
  (`crates/tessera_runtime/src/external_provider.rs`).

## Consequences

- Users keep ownership of their data and can work offline; nothing is
  sent to a third party unless the user explicitly connects a source or
  enables an external model provider.
- There is no server to operate, but also no server-side sync, sharing,
  or backup — multi-device and team workflows must be built on explicit
  integrations such as KChat ([ADR-0005](0005-kchat-collaboration.md))
  or user-managed file sync.
- Performance and model quality are bounded by the user's hardware,
  which drives the device-tiering and adapter-fallback logic in
  `tessera_runtime`.
- Security responsibility shifts onto the client: encryption at rest,
  keychain integration, the renderer sandbox, and IPC validation are all
  load-bearing rather than optional.
