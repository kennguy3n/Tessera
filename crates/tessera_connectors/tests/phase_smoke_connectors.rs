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
//! and BOTH the in-crate unit tests (`src/traits.rs`) AND this smoke
//! suite expand the same macro. Adding a 7th connector updates the
//! macro and that's it; both the trait-impl assertion and the
//! provider-name pinning automatically cover it. Earlier rounds of
//! this PR had each test maintain its own hand-typed list, which
//! Devin Review correctly flagged as a duplication hazard (drift
//! between the two copies would have gone unnoticed until CI ran
//! both).

use std::collections::HashSet;

use tessera_connectors::{
    for_each_connector, AuthConfig, ConfluenceConnector, ConnectorResult, FigmaConnector,
    GoogleDriveConnector, JiraConnector, NotionConnector, OneDriveConnector, RemoteConnector,
    SyncResult,
};
// `StoredTokens` lives in the `types` submodule and is not currently
// re-exported at the crate root. We import it via its module path so
// this smoke test doesn't have to wait on a re-export landing.
use tessera_connectors::types::StoredTokens;

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
// Lifecycle-method smoke wrappers.
//
// Each `_smoke_*` async fn below takes a mutable connector reference
// plus the OAuth-lifecycle args and threads them straight through to
// the corresponding method. The wrappers exist purely so `cargo test`
// has to type-check them — they are NEVER called at runtime, so no
// OAuth, no network, no side effects.
//
// If any connector method goes missing, gets renamed, or has its
// signature changed, the matching wrapper fails to compile and the
// smoke suite breaks with a useful "method not found" error pointing
// at the offending connector.
// ----------------------------------------------------------------------

#[allow(dead_code)]
async fn _smoke_gdrive(
    c: &mut GoogleDriveConnector,
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

#[allow(dead_code)]
async fn _smoke_onedrive(
    c: &mut OneDriveConnector,
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

#[allow(dead_code)]
async fn _smoke_notion(
    c: &mut NotionConnector,
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

#[allow(dead_code)]
async fn _smoke_jira(
    c: &mut JiraConnector,
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

#[allow(dead_code)]
async fn _smoke_confluence(
    c: &mut ConfluenceConnector,
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

#[allow(dead_code)]
async fn _smoke_figma(
    c: &mut FigmaConnector,
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

#[test]
fn every_connector_exposes_authenticate_sync_revoke() {
    // The actual verification happens at compile time — the six
    // wrappers above each invoke `authenticate`, `sync_changes`,
    // and `revoke`. If any of those methods go missing or change
    // shape, this test fails to compile with a clear error pointing
    // at the offending connector.
    //
    // This `#[test]` body itself just exists so `cargo test --list`
    // surfaces the suite as a named target, so reviewers can see
    // explicitly that the smoke check ran.
    let _ = stringify!(
        _smoke_gdrive,
        _smoke_onedrive,
        _smoke_notion,
        _smoke_jira,
        _smoke_confluence,
        _smoke_figma,
    );
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
