//! Cross-connector traits.
//!
//! ## Why only the read-only summary surface
//!
//! The original WS5 scoping document proposed a single, monolithic
//! `RemoteConnector` trait that would unify `authenticate`, `list_files`,
//! `sync_changes`, `refresh_access_token`, and `revoke` into one uniform
//! signature across all six connectors. That ambition runs aground on
//! genuine provider-specific affordances:
//!
//!   * `JiraConnector::authenticate` discovers the user's Atlassian
//!     cloud-id via `accessible-resources` and stores it internally —
//!     a uniform `authenticate(&AuthConfig) -> ConnectorResult<()>`
//!     signature would hide that the connector is now stateful in a way
//!     that affects subsequent `list_files` calls.
//!   * `NotionConnector::sync_changes` takes a `change_token` AND a
//!     `known_file_ids` set for periodic full-walk deletion detection;
//!     other connectors' `sync_changes` takes only a `change_token`.
//!   * `GoogleDriveConnector::list_files` takes `folder_id` for tree
//!     traversal; Notion takes a `folder_id` that's actually a
//!     database-id which dispatches to a different endpoint; Jira and
//!     Confluence have no folder concept at all.
//!
//! Forcing these into a uniform trait would require associated types
//! (complex), generic parameters that punt the problem (mostly cosmetic),
//! or a string-typed "options bag" parameter (worst — loses every
//! type-safety guarantee the trait was meant to provide).
//!
//! Instead, this trait captures the **read-only summary surface** every
//! connector shares (provider name, status, last sync time, file count).
//! This is enough for:
//!
//!   1. `ConnectorRegistry` to walk every registered connector and
//!      build a UI-facing `ConnectorInfo` summary without a per-variant
//!      match arm (eliminates the 6-arm match in `ConnectorEntry::info`).
//!   2. Health-check / monitoring code to inspect status uniformly.
//!   3. Adding a 7th connector to require implementing the trait but
//!      keeping its action-method signatures provider-shaped.
//!
//! The trait deliberately does NOT cover action methods (`authenticate`,
//! `list_files`, `sync_changes`, `revoke`). Callers that need those go
//! through the typed accessors on the registry — which is the existing
//! pattern and is correct for the reasons above.

use chrono::{DateTime, Utc};

use crate::types::ConnectorStatus;

/// Read-only summary surface common to every remote connector.
///
/// See module docs for why this is intentionally a small trait.
pub trait RemoteConnector: Send + Sync {
    /// Stable, lower-snake-case provider identifier used as the
    /// connector's registry key (e.g. `"google_drive"`, `"onedrive"`,
    /// `"notion"`, `"jira"`, `"confluence"`, `"figma"`).
    fn provider_name(&self) -> &'static str;

    /// Current lifecycle status (Disconnected, Connecting, Connected,
    /// Syncing, Error).
    fn status(&self) -> ConnectorStatus;

    /// Timestamp of the last successful `sync_changes` call, or `None`
    /// if no sync has succeeded yet.
    fn last_sync_time(&self) -> Option<DateTime<Utc>>;

    /// Best-effort running count of files this connector is currently
    /// tracking. Uses NET semantics — adds bump it up, removes bump it
    /// down — see `SyncResult::apply_to_file_count` for the formula.
    /// Modifications do not change the count.
    fn file_count(&self) -> u64;
}

// Blanket impls for the six current connectors live on each connector
// module — see e.g. `gdrive.rs::impl RemoteConnector for GoogleDriveConnector`.

#[cfg(test)]
mod tests {
    use super::*;
    use crate::confluence::ConfluenceConnector;
    use crate::figma::FigmaConnector;
    use crate::gdrive::GoogleDriveConnector;
    use crate::jira::JiraConnector;
    use crate::notion::NotionConnector;
    use crate::onedrive::OneDriveConnector;

    /// Every connector must implement RemoteConnector. This test fails
    /// to compile if a new connector forgets the impl.
    #[test]
    fn every_connector_implements_remote_connector() {
        fn assert_impl<T: RemoteConnector>() {}
        assert_impl::<GoogleDriveConnector>();
        assert_impl::<OneDriveConnector>();
        assert_impl::<NotionConnector>();
        assert_impl::<JiraConnector>();
        assert_impl::<ConfluenceConnector>();
        assert_impl::<FigmaConnector>();
    }

    /// Pin each connector's provider name as the stable registry key.
    /// Renaming any of these is a breaking change for stored config /
    /// token records.
    #[test]
    fn provider_names_are_stable() {
        assert_eq!(GoogleDriveConnector::new().provider_name(), "google_drive");
        assert_eq!(OneDriveConnector::new().provider_name(), "onedrive");
        assert_eq!(NotionConnector::new().provider_name(), "notion");
        assert_eq!(JiraConnector::new().provider_name(), "jira");
        assert_eq!(ConfluenceConnector::new().provider_name(), "confluence");
        assert_eq!(FigmaConnector::new().provider_name(), "figma");
    }

    /// A fresh-constructed connector is always Disconnected with no
    /// sync time and 0 files. Pin this so a constructor refactor
    /// doesn't accidentally claim "Connected" before authenticate.
    #[test]
    fn fresh_connectors_start_disconnected() {
        fn assert_fresh<T: RemoteConnector>(c: T) {
            assert_eq!(c.status(), ConnectorStatus::Disconnected);
            assert!(c.last_sync_time().is_none());
            assert_eq!(c.file_count(), 0);
        }
        assert_fresh(GoogleDriveConnector::new());
        assert_fresh(OneDriveConnector::new());
        assert_fresh(NotionConnector::new());
        assert_fresh(JiraConnector::new());
        assert_fresh(ConfluenceConnector::new());
        assert_fresh(FigmaConnector::new());
    }

    /// Box<dyn RemoteConnector> compiles and behaves like the concrete
    /// type. This pins the trait's object-safety — if a future
    /// refactor adds an async method or a `Self`-typed return, this
    /// test fails to compile.
    #[test]
    fn trait_is_object_safe() {
        let connectors: Vec<Box<dyn RemoteConnector>> = vec![
            Box::new(GoogleDriveConnector::new()),
            Box::new(OneDriveConnector::new()),
            Box::new(NotionConnector::new()),
            Box::new(JiraConnector::new()),
            Box::new(ConfluenceConnector::new()),
            Box::new(FigmaConnector::new()),
        ];
        assert_eq!(connectors.len(), 6);
        for c in &connectors {
            assert_eq!(c.status(), ConnectorStatus::Disconnected);
        }
    }
}
