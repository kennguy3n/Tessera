pub mod confluence;
pub mod error;
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
pub use error::{ConnectorError, ConnectorResult};
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
/// for the connector roster *for the checks whose body is identical
/// across connectors* — specifically:
///
///   * compile-time `assert_impl::<T: RemoteConnector>()` (every
///     connector implements the summary trait),
///   * provider-name pinning (`<T>::new().provider_name() == "..."`),
///   * fresh-state invariants (`<T>::new()` is Disconnected, etc.).
///
/// Adding a 7th connector updates the macro and the three checks
/// above automatically cover it.
///
/// **What this macro deliberately does NOT cover.** The async
/// lifecycle-method smoke check
/// (`every_connector_exposes_authenticate_sync_revoke`, in
/// `tests/phase_smoke_connectors.rs`) is still implemented as six
/// hand-written `_smoke_*` wrappers, one per connector. Those
/// wrappers can't be macro-expanded because each connector's
/// `authenticate` / `sync_changes` / `revoke` methods have
/// provider-specific argument shapes — e.g. `JiraConnector::authenticate`
/// silently records the user's Atlassian cloud-id while
/// `GoogleDriveConnector::authenticate` does not, and
/// `NotionConnector::sync_changes` takes a `known_file_ids` set that
/// some other connectors don't — see `src/traits.rs` for the full
/// rationale on why a uniform action trait was rejected. Adding a
/// 7th connector therefore still requires (a) extending this macro
/// AND (b) hand-writing a matching `_smoke_<provider>` wrapper in
/// the smoke test (and appending its name to the `stringify!` list
/// in `every_connector_exposes_authenticate_sync_revoke`).
///
/// `$inner` is the *name* of another `macro_rules!` macro that takes
/// `($t:ty, $n:literal)`. We can't accept a closure here because
/// some callers — notably the compile-time `assert_impl::<T>()`
/// invocations — need access to the type as a TYPE token, not as a
/// runtime value.
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
