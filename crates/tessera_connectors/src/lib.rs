//! Cloud connector integrations (Notion, Google Drive, OneDrive,
//! Confluence, Jira, Figma) with shared retry and failure-state handling.
#![warn(missing_docs)]

pub mod confluence;
pub mod error;
pub mod failure_state;
pub mod figma;
pub mod gdrive;
pub mod jira;
pub mod notion;
pub mod onedrive;
pub mod registry;
pub mod retry;
pub mod token;
pub mod traits;
pub mod types;
pub mod url_encode;

pub use confluence::ConfluenceConnector;
pub use error::{ConnectorError, ConnectorResult, FailureKind};
pub use failure_state::{
    PersistedFailureKind, PersistedSyncError, SyncBackoffPolicy, SyncFailureState,
};
pub use figma::FigmaConnector;
pub use gdrive::GoogleDriveConnector;
pub use jira::JiraConnector;
pub use notion::NotionConnector;
pub use onedrive::OneDriveConnector;
pub use registry::ConnectorRegistry;
pub use retry::{send_with_retry, RetryPolicy};
pub use traits::RemoteConnector;
pub use types::{AuthConfig, ConnectorStatus, RemoteFile, SyncResult};

/// Expand `$inner` once per shipping connector with `(<Type>, <stable
/// provider name>)` as arguments. This is the single source of truth
/// for the connector roster across the entire crate. Adding a 7th
/// connector is a single edit here in this macro; every check that
/// expands `for_each_connector!` automatically grows to cover it.
///
/// Current callers (all gated on a single update to this macro):
///
///   * `src/traits.rs::tests::every_connector_implements_remote_connector`
///     — compile-time `assert_impl::<T: RemoteConnector>()` for the
///     read-only summary trait.
///   * `src/traits.rs::tests::provider_names_are_stable` — pins
///     `<T>::new().provider_name() == $n` for each connector.
///   * `src/traits.rs::tests::fresh_state_is_disconnected` — pins
///     fresh-construction invariants (status, last_sync_time,
///     file_count).
///   * `tests/smoke_connectors.rs::every_connector_implements_remote_connector`
///     — external mirror of the trait-impl check.
///   * `tests/smoke_connectors.rs::connector_provider_names_are_stable`
///     — external mirror of the provider-name pinning.
///   * `tests/smoke_connectors.rs::every_connector_exposes_authenticate_sync_revoke`
///     — macro-driven lifecycle-method shape check. Each invocation
///     emits an anonymous `const _: () = { async fn check_lifecycle(
///     c: &mut $t, …) { c.authenticate(...).await; c.sync_changes(
///     ...).await; c.revoke().await; } };` block. The block is
///     never executed; cargo type-checks it as part of compiling the
///     test crate, which pins both the method names AND their
///     argument shapes for every connector listed here.
///
/// Forgetting to implement any of the read-only trait methods, the
/// `new() / provider_name()` constructor pattern, or any of the
/// three lifecycle methods on a newly-added connector becomes a
/// compile error pointing at the new type.
///
/// Note that the `RemoteConnector` trait deliberately covers only
/// the read-only summary surface; the lifecycle methods are inherent
/// methods on each concrete connector because they have
/// provider-shaped argument sets (Jira records cloud-id internally,
/// Notion takes a `known_file_ids` set, etc. — see `src/traits.rs`
/// for the rationale). That's why the lifecycle check has to be
/// macro-driven rather than relying on the trait alone.
///
/// `$inner` is the *name* of another `macro_rules!` macro that takes
/// `($t:ty, $n:literal)`. We can't accept a closure here because
/// some callers — notably the compile-time `assert_impl::<T>()`
/// invocations and the lifecycle async-fn — need access to the type
/// as a TYPE token, not as a runtime value.
///
/// # Example
///
/// ```ignore
/// macro_rules! check_name {
///     ($t:ty, $n:literal) => {
///         assert_eq!(<$t>::new().provider_name(), $n);
///     };
/// }
/// tessera_connectors::for_each_connector!(check_name);
/// ```
#[macro_export]
macro_rules! for_each_connector {
    ($inner:ident) => {
        $inner!($crate::GoogleDriveConnector, "google_drive");
        $inner!($crate::OneDriveConnector, "onedrive");
        $inner!($crate::NotionConnector, "notion");
        $inner!($crate::JiraConnector, "jira");
        $inner!($crate::ConfluenceConnector, "confluence");
        $inner!($crate::FigmaConnector, "figma");
    };
}
