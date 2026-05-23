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
//! Note on `sync_changes`: today all six connectors *do* share the
//! same `(change_token: Option<&str>, known_file_ids: &HashSet<String>)`
//! signature — Notion was the first to need the `known_file_ids` set
//! for periodic full-walk deletion detection, and rather than carve
//! out a Notion-only quirk we threaded the set through every
//! connector for symmetry (each one ignores it iff its native delta
//! API already covers deletes). The macro-driven lifecycle smoke
//! check in `tests/phase_smoke_connectors.rs` leans on that uniform
//! signature to type-check `sync_changes` calls on every connector
//! from one macro arm. If a future 7th connector ever genuinely needs
//! a divergent `sync_changes` shape, the smoke macro becomes a
//! constraint rather than a verification — the right response then is
//! to either reshape the new connector to fit, or split the smoke
//! check into per-connector arms. Devin Review round-9 flagged this
//! design tension; documenting it here is the long-term fix.
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
        // Floor — the macro is the source of truth for the upper end
        // of the count, but we DO want to catch the failure mode where
        // the macro gets accidentally emptied (or trimmed to one
        // connector) during a refactor. Six connectors were the
        // PROGRESS.md Phase 7/8 deliverable, so anything below that is
        // a regression. A `>= 6` floor lets the macro grow to a 7th
        // connector without an unrelated edit here, while still
        // catching the "macro accidentally lost all but one connector"
        // case Devin Review correctly flagged when this assertion was
        // weakened to `!is_empty()`.
        assert!(
            connectors.len() >= 6,
            "expected at least the 6 shipping connectors from PROGRESS.md \
             Phase 7/8, found {}; check `for_each_connector!` in src/lib.rs",
            connectors.len(),
        );
        for c in &connectors {
            assert_eq!(c.status(), ConnectorStatus::Disconnected);
        }
    }
}
