# 8. N-API bridge between Electron and the Rust core

## Status

Accepted.

## Context

The core engine is written in Rust ([ADR-0001](0001-rust-core.md)) and
the desktop shell is Electron + React ([ADR-0002](0002-electron.md)).
The Electron **main** process (Node.js) must call into the Rust core to
open the encrypted database, index sources, run hybrid search, generate
artifacts, and drive connectors. We need a calling convention that is
in-process (no IPC serialization tax on every call), strongly typed on
both sides, and that does not expose any native capability to the
untrusted renderer.

## Decision

Expose the Rust core to Node.js through an **N-API** native addon built
with `napi`/`napi-derive`, implemented in the `tessera_bridge` crate.

- `crates/tessera_bridge/src/napi_exports.rs` defines the `#[napi]`
  functions (e.g. `init_bridge`, `bridge_add_local_folder`,
  `bridge_list_sources`, export and citation calls). These are the only
  entry points the JavaScript side can call.
- The bridge owns a single shared `AppState` holding the stores
  (sources, artifacts, citations, tasks, automations, audit) behind
  `Arc<Mutex<…>>`. N-API callbacks are single-threaded (main thread
  only), so the mutexes provide interior mutability with a documented
  lock-acquisition order to keep the lock graph a DAG.
- Each store is backed by the single shared SQLCipher connection opened
  once at `init_bridge` ([ADR-0009](0009-single-file-db.md)).
- Only the Electron **main** process loads the addon; the renderer
  reaches these capabilities exclusively through validated IPC
  ([ADR-0002](0002-electron.md)), never the native module directly.

## Consequences

- Main-process ↔ Rust calls are in-process function calls, avoiding the
  overhead of a child-process protocol on the hot indexing/search paths.
- The native addon must be compiled per platform/architecture (macOS,
  Windows, Linux; x64 + arm64), which adds build and packaging
  complexity and a `cargo build --release -p tessera_bridge` step.
- The single-threaded N-API assumption is a real invariant: the
  documented lock order in `napi_exports.rs` must be preserved, and any
  future move to async/threaded calls would require revisiting the
  `Mutex` strategy.
- The bridge is the security choke point — because only the main process
  loads it and the renderer cannot, the encrypted DB, tokens, and model
  processes stay out of the web context by construction.
