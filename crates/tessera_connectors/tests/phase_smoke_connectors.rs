//! Phase-verification smoke test for the connector framework.
//!
//! This suite is part of the cross-cutting Phase 7/8 tracking-integrity
//! guarantee: every connector PROGRESS.md claims must be backed by real,
//! compileable code — not just a checked checkbox. The renderer-side
//! companion is `apps/desktop/renderer/src/__tests__/smoke/
//! phaseVerification.test.ts`.
//!
//! The plan asks us to verify that each connector "has a `connect` +
//! `sync` + `disconnect` function". Tessera's connector trait actually
//! names these (intentionally) after the OAuth lifecycle they implement
//! — `authenticate`, `sync_changes`, and `revoke` — for the reasons
//! laid out in `src/traits.rs` (different connectors need different
//! parameter shapes, so a uniform action trait was rejected in favour
//! of a uniform _summary_ trait). This test verifies BOTH layers:
//!
//!   1. The summary trait `RemoteConnector` is implemented by every
//!      one of the six shipping connectors (compile-time `assert_impl`).
//!   2. Each connector exposes the three lifecycle methods with the
//!      expected signatures, via wrapper async fns that call them —
//!      a method rename or arity change fails to compile this test.
//!
//! The cargo build profile already runs `cargo test --all` in CI, so
//! this file is picked up automatically. `npm run test:smoke` at the
//! repo root invokes `cargo test -p tessera_connectors --test
//! phase_smoke_connectors` for a focused, fast-feedback run.
//!
//! ## Roster source of truth
//!
//! The list of shipping connectors lives in exactly one place — the
//! `tessera_connectors::for_each_connector!` macro in `src/lib.rs` —
//! and ALL three checks in this smoke suite expand from that macro,
//! along with the in-crate unit tests in `src/traits.rs`:
//!
//!   * `every_connector_implements_remote_connector` — macro-driven
//!     trait-impl assertion (the trait covers the read-only summary
//!     surface only — see `src/traits.rs` for the rationale).
//!   * `connector_provider_names_are_stable` — macro-driven
//!     provider-name pinning.
//!   * `every_connector_exposes_authenticate_sync_revoke` —
//!     macro-driven lifecycle-method shape check. Each invocation of
//!     `for_each_connector!` emits an anonymous `const _: () = {...}`
//!     block whose body type-checks calls to `authenticate`,
//!     `sync_changes`, and `revoke` on the connector type. The block
//!     is never executed; cargo type-checks it as part of compiling
//!     the test crate.
//!
//! Adding a 7th connector therefore requires a single edit: extend
//! `for_each_connector!` in `src/lib.rs`. All three checks (and the
//! in-crate trait-impl + provider-name + fresh-state checks in
//! `src/traits.rs`) automatically grow to cover it. Forgetting to
//! implement any of the lifecycle methods on the new connector is a
//! compile error pointing at the new connector type.
//!
//! Earlier rounds of this PR had each test maintain its own
//! hand-typed list, which Devin Review correctly flagged as a
//! duplication hazard (drift between the two copies would have gone
//! unnoticed until CI ran both). An intermediate round shipped
//! macro-driven trait/provider-name checks but kept the lifecycle
//! wrappers hand-written + listed via `stringify!`. The bot then
//! correctly flagged that `stringify!` does not force compilation of
//! the referenced functions, so a missing 7th-connector wrapper
//! could slip through. The current round closes that gap by making
//! the lifecycle check itself macro-driven.

use std::collections::HashSet;

// The macro-expanded checks below path-qualify each connector type via
// `$crate::...`, so individual connector types don't need to be in scope
// here. We do still need `AuthConfig`, `ConnectorResult`, `SyncResult`,
// `RemoteConnector`, and `StoredTokens` in scope because they appear
// unqualified in the macro's expansion body. `StoredTokens` lives in the
// `types` submodule and is not currently re-exported at the crate root.
use tessera_connectors::types::StoredTokens;
use tessera_connectors::{
    for_each_connector, AuthConfig, ConnectorResult, RemoteConnector, SyncResult,
};

/// Compile-time assertion that the given type implements the
/// `RemoteConnector` trait. Inlined into a doc-test-like pattern so
/// adding a 7th connector — or accidentally removing the trait impl —
/// surfaces immediately at `cargo test`.
const fn assert_remote_connector<T: RemoteConnector>() {}

#[test]
fn every_connector_implements_remote_connector() {
    // Compile-time only: the body runs no code, but `cargo test`
    // still has to *compile* this function, which forces the trait
    // bounds to resolve. If any connector loses its `impl
    // RemoteConnector`, the build fails here with a clear error.
    //
    // The roster comes from `for_each_connector!` so this and the
    // in-crate `traits::tests::every_connector_implements_remote_connector`
    // can never drift apart.
    macro_rules! check {
        ($t:ty, $n:literal) => {
            assert_remote_connector::<$t>();
        };
    }
    for_each_connector!(check);
}

// ----------------------------------------------------------------------
// Lifecycle-method smoke check.
//
// The `RemoteConnector` trait deliberately covers only the read-only
// summary surface (provider name, status, last sync time, file count
// — see `src/traits.rs` for the rationale). The OAuth lifecycle
// methods `authenticate` / `sync_changes` / `revoke` live as inherent
// methods on each concrete connector because (a) `authenticate`
// signatures vary by provider — Jira's discovers the cloud-id from
// `accessible-resources` and stores it internally, which a uniform
// `authenticate(&AuthConfig) -> ConnectorResult<()>` would hide — and
// (b) we want the trait surface to stay read-only.
//
// That means the macro-driven trait-impl check above does NOT verify
// the lifecycle surface — adding a 7th connector to
// `for_each_connector!` while forgetting to define its lifecycle
// methods would not fail to compile from the trait-impl test alone.
//
// To close that gap we generate a per-connector compile-time check
// from the SAME `for_each_connector!` macro. Each invocation emits an
// anonymous `const _: () = { ... }` block containing an async fn whose
// body calls `authenticate` / `sync_changes` / `revoke` on the
// connector type. The async fn is never called at runtime (no OAuth,
// no network), but cargo still has to TYPE-CHECK it as part of
// compiling the test crate — and type-checking the call sites pins
// the method names AND their argument shapes for every connector
// listed in the macro. Adding a 7th connector to the macro therefore
// automatically extends the lifecycle check; forgetting to define
// `authenticate` (etc.) on the new connector becomes a "method not
// found" compile error pointing at the new connector type.
//
// Uniform `sync_changes` signature assumption: the macro generates a
// SINGLE `check_lifecycle` async fn signature shared by every
// connector, hard-coding `sync_changes(Option<&str>,
// &HashSet<String>)`. Today all six shipping connectors take exactly
// that signature (Notion needed the `known_file_ids` set for
// full-walk deletion detection, and the other connectors thread it
// through for symmetry — see `src/traits.rs` for the design
// rationale). Devin Review round-9 correctly noted that this turns
// the macro into a CONSTRAINT on any 7th connector rather than just
// a verification of an existing invariant. If a future connector
// genuinely needs a divergent `sync_changes` shape, the right
// response is to either reshape it to fit (preserving the macro's
// single-arm uniformity) or split this macro into per-connector
// arms; we accept that future cost in exchange for the current
// one-edit "add a connector" ergonomics. This comment is the
// long-term doc of the design tension.
// ----------------------------------------------------------------------

macro_rules! smoke_check_lifecycle {
    ($t:ty, $n:literal) => {
        // `const _: () = { ... }` is the canonical Rust idiom for a
        // compile-time-only block: the body is type-checked, but the
        // const is never read. Multiple `_`-named consts at module
        // scope are legal, so the macro can expand this once per
        // connector without naming collisions.
        const _: () = {
            #[allow(dead_code)]
            async fn check_lifecycle(
                c: &mut $t,
                cfg: &AuthConfig,
                tok: Option<&str>,
                known: &HashSet<String>,
            ) -> (
                ConnectorResult<StoredTokens>,
                ConnectorResult<SyncResult>,
                ConnectorResult<()>,
            ) {
                (
                    c.authenticate(cfg).await,
                    c.sync_changes(tok, known).await,
                    c.revoke().await,
                )
            }
        };
    };
}
for_each_connector!(smoke_check_lifecycle);

#[test]
fn every_connector_exposes_authenticate_sync_revoke() {
    // The actual verification happens at compile time, in the
    // anonymous `const _: () = { ... }` blocks emitted above by
    // `for_each_connector!(smoke_check_lifecycle)`. If any of the
    // three lifecycle methods (`authenticate` / `sync_changes` /
    // `revoke`) goes missing on any connector type listed in the
    // macro, the test crate fails to compile with a clear error
    // pointing at the offending connector.
    //
    // This `#[test]` body itself exists only so `cargo test --list`
    // surfaces the lifecycle check as a named target, so reviewers
    // can see explicitly that the smoke check ran. It is intentionally
    // a no-op — `let _ = ();` is more honest than `stringify!(...)`
    // would be, since stringify! suggests a list-of-functions
    // contract while the real contract is the macro-generated
    // const-blocks above.
    let _ = ();
}

/// Pin the stable provider-name identifiers used as registry keys.
/// Renaming any of these is a breaking change for stored config and
/// token records — keeping the check here means any rename has to go
/// through a deliberate phase-verification update.
///
/// Same roster source as the trait-impl test above: a single edit to
/// `for_each_connector!` covers both.
#[test]
fn connector_provider_names_are_stable() {
    macro_rules! check {
        ($t:ty, $n:literal) => {
            assert_eq!(<$t>::new().provider_name(), $n);
        };
    }
    for_each_connector!(check);
}
