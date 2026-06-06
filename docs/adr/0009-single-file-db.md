# 9. Single shared SQLite connection / single-file database

## Status

Accepted.

## Context

Tessera's domain is split across several stores — `SourceStore`,
`AuditStore`, `CitationStore`, `ArtifactStore`, `TaskStore`,
`AutomationStore`. Originally each store opened its own
`rusqlite::Connection` to the same on-disk file, so the bridge's
`AppState` held **six independent connections** to one logical
workspace. Correctness was fine (N-API callbacks are single-threaded, so
the per-store outer `Mutex` already serialised writes), but it cost six
OS file descriptors, six rusqlite statement caches, and six SQLite page
caches in process memory for what is conceptually one database.

## Decision

Store the entire workspace in a **single SQLite (SQLCipher) database
file**, accessed through **one shared connection** that every store
borrows (`crates/tessera_core/src/db.rs`):

- `SharedConnection = Arc<Mutex<rusqlite::Connection>>`. The connection
  is opened once (with the encryption key applied,
  [ADR-0003](0003-sqlcipher.md)) at `init_bridge` and handed to every
  store.
- Locking around the inner `Connection` preserves the same
  write-serialisation guarantee the per-store `Mutex` gave, while
  collapsing the six-handle / six-cache footprint to one.
- WAL journal mode is enabled (`apply_wal_pragmas`) so a single writer
  and concurrent readers behave well, and a read-only pool
  (`SharedReadPool`) is available for read-heavy paths.

## Consequences

- One file is trivial to encrypt as a unit ([ADR-0003](0003-sqlcipher.md)),
  back up, or move, and the process footprint drops from six connections
  and caches to one.
- All stores share one write lock, so writes are globally serialised.
  That is acceptable because the N-API boundary is single-threaded
  ([ADR-0008](0008-n-api-bridge.md)), but it means a long write holds up
  every store; the read pool exists to keep reads from contending.
- The shared connection's lifecycle is centralised in `db.rs` and tied
  to bridge init/dispose; stores no longer own their connection, so
  cross-store transactions are possible but lock ordering must be
  respected.
- A single file is also a single point of failure — corruption or a lost
  key affects the whole workspace — which raises the stakes on the
  encryption-key handling and first-run migration paths in `db.rs`.
