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
/// provider name>)` as arguments. The single source of truth for the
/// connector roster is this macro — every other location that needs
/// to "do something for each connector" (compile-time `assert_impl`,
/// runtime provider-name pinning, fresh-state checks, smoke tests in
/// downstream crates) goes through this so adding a 7th connector
/// updates exactly one place.
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
