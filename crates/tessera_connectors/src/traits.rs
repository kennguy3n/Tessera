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
    // Tests delegate to the crate-level `for_each_connector!` macro so
    // the connector roster lives in exactly one place (lib.rs). Adding
    // a 7th connector requires updating the macro and nothing else —
    // both these in-crate tests AND the external `phase_smoke_connectors`
    // suite expand to cover it automatically.

    /// Every connector must implement RemoteConnector. This test fails
    /// to compile if a new connector forgets the impl.
    #[test]
    fn every_connector_implements_remote_connector() {
        fn assert_impl<T: RemoteConnector>() {}
        macro_rules! check {
            ($t:ty, $n:literal) => {
                assert_impl::<$t>();
            };
        }
        crate::for_each_connector!(check);
    }

    /// Pin each connector's provider name as the stable registry key.
    /// Renaming any of these is a breaking change for stored config /
    /// token records.
    #[test]
    fn provider_names_are_stable() {
        macro_rules! check {
            ($t:ty, $n:literal) => {
                assert_eq!(<$t>::new().provider_name(), $n);
            };
        }
        crate::for_each_connector!(check);
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
        macro_rules! check {
            ($t:ty, $n:literal) => {
                assert_fresh(<$t>::new());
            };
        }
        crate::for_each_connector!(check);
    }

    /// Box<dyn RemoteConnector> compiles and behaves like the concrete
    /// type. This pins the trait's object-safety — if a future
    /// refactor adds an async method or a `Self`-typed return, this
    /// test fails to compile.
    #[test]
    fn trait_is_object_safe() {
        let mut connectors: Vec<Box<dyn RemoteConnector>> = Vec::new();
        macro_rules! push {
            ($t:ty, $n:literal) => {
                connectors.push(Box::new(<$t>::new()));
            };
        }
        crate::for_each_connector!(push);
        // The macro is the source of truth for the count; we don't
        // hardcode 6 here because adding a 7th connector should pass
        // this test without an unrelated edit.
        assert!(!connectors.is_empty());
        for c in &connectors {
            assert_eq!(c.status(), ConnectorStatus::Disconnected);
        }
    }
}
