//! Automations store and runtime.
//!
//! An automation is a persistent rule that fires on a trigger and
//! performs an action against a target. Triggers we support:
//!
//! - **Schedule** — fixed cron-like interval (e.g. every 6 hours).
//! - **OnGenerate** — when an artifact is generated from a particular
//!   template (e.g. "every time a weekly-summary is generated, reindex
//!   the linked sources").
//!
//! Actions:
//!
//! - **ReindexSource(SourceId)** — re-run extraction on a known source.
//! - **GenerateFromTemplate(TemplateId, `Vec<SourceId>`)** — generate
//!   a new artifact from a template + sources.
//!
//! The store handles persistence; the runner (in
//! `automations_runner`) loops over enabled rules and dispatches.
//!
//! # Scalability follow-up
//!
//! `due_scheduled()` and `matching_on_generate()` currently load every
//! row and filter in process. That is acceptable for the realistic
//! ceiling of automations a single user maintains (< a few hundred),
//! but the long-term fix is:
//!
//! - add `next_scheduled_at TEXT` (nullable for non-schedule triggers),
//!   maintained on insert/update/`record_run`, indexed on
//!   `(enabled, next_scheduled_at)` so `due_scheduled()` becomes a
//!   single indexed range scan rather than an in-process filter;
//! - extract `trigger_template_id` into its own column (or a separate
//!   `automation_triggers` table) and index it so
//!   `matching_on_generate()` can push the predicate into SQLite.
//!
//! These require a schema migration plus a refactor of `is_due()` /
//! `next_scheduled_at()` to read the precomputed column, so they are
//! deferred to a follow-up rather than mixing into the current scope.

use chrono::{DateTime, Utc};
use rusqlite::params;
use serde::{Deserialize, Serialize};
use std::str::FromStr;
use tessera_core::error::{Error, Result};
use tessera_core::types::{AutomationId, SourceId, TemplateId};
use tessera_core::{open_shared, open_shared_in_memory, with_secure_delete, SharedConnection};

/// Parse an RFC 3339 timestamp from a SQLite row, surfacing corruption as
/// a `rusqlite::Error` instead of silently substituting the current time.
/// The store always writes `to_rfc3339()` so any failure here indicates
/// the database was edited externally or otherwise corrupted; for
/// scheduled automations a wrong `created_at` would skew `is_due()`, so
/// we'd rather fail loudly than silently re-anchor the schedule.
fn parse_dt(s: &str, col: usize) -> rusqlite::Result<DateTime<Utc>> {
    DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&Utc))
        .map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(
                col,
                rusqlite::types::Type::Text,
                format!("invalid RFC 3339 timestamp `{s}`: {e}").into(),
            )
        })
}

fn parse_opt_dt(s: Option<String>, col: usize) -> rusqlite::Result<Option<DateTime<Utc>>> {
    match s {
        None => Ok(None),
        Some(raw) => parse_dt(&raw, col).map(Some),
    }
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
/// Automation Trigger.
pub enum AutomationTrigger {
    /// Run every `interval_seconds` seconds. The runner schedules the
    /// next run from `last_run_at + interval_seconds`, or `created_at`
    /// for the first run.
    Schedule {
        /// Interval seconds.
        interval_seconds: i64,
    },
    /// Run when an artifact is generated from `template_id`.
    OnGenerate {
        /// Template id.
        template_id: TemplateId,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
#[serde(tag = "kind", rename_all = "snake_case")]
/// Automation Action.
pub enum AutomationAction {
    /// Reindex Source.
    ReindexSource {
        /// Source id.
        source_id: SourceId,
    },
    /// Generate From Template.
    GenerateFromTemplate {
        /// Template id.
        template_id: TemplateId,
        /// Source ids.
        source_ids: Vec<SourceId>,
    },
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
/// Automation.
pub struct Automation {
    /// Id.
    pub id: AutomationId,
    /// Name.
    pub name: String,
    /// Trigger.
    pub trigger: AutomationTrigger,
    /// Action.
    pub action: AutomationAction,
    /// Enabled.
    pub enabled: bool,
    /// Created at.
    pub created_at: DateTime<Utc>,
    /// Updated at.
    pub updated_at: DateTime<Utc>,
    /// Last run at.
    pub last_run_at: Option<DateTime<Utc>>,
    /// Last run status.
    pub last_run_status: Option<String>,
}

impl Automation {
    /// Creates a new instance.
    pub fn new(
        name: impl Into<String>,
        trigger: AutomationTrigger,
        action: AutomationAction,
    ) -> Self {
        let now = Utc::now();
        Self {
            id: AutomationId::new(),
            name: name.into(),
            trigger,
            action,
            enabled: true,
            created_at: now,
            updated_at: now,
            last_run_at: None,
            last_run_status: None,
        }
    }

    /// For [`AutomationTrigger::Schedule`], compute the next scheduled
    /// time. Returns `None` for non-schedule triggers.
    pub fn next_scheduled_at(&self) -> Option<DateTime<Utc>> {
        let AutomationTrigger::Schedule { interval_seconds } = self.trigger else {
            return None;
        };
        let interval = chrono::Duration::seconds(interval_seconds);
        Some(self.last_run_at.unwrap_or(self.created_at) + interval)
    }

    /// Whether a scheduled automation is currently due. Always false
    /// for non-schedule triggers and for disabled automations.
    pub fn is_due(&self, now: DateTime<Utc>) -> bool {
        if !self.enabled {
            return false;
        }
        match self.next_scheduled_at() {
            Some(next) => now >= next,
            None => false,
        }
    }
}

/// Automation Store.
pub struct AutomationStore {
    conn: SharedConnection,
}

impl AutomationStore {
    /// Open.
    pub fn open(path: &str) -> Result<Self> {
        Self::with_shared_conn(open_shared(path)?)
    }

    /// Open in memory.
    pub fn open_in_memory() -> Result<Self> {
        Self::with_shared_conn(open_shared_in_memory()?)
    }

    /// Build a store on top of a [`SharedConnection`] that is already
    /// shared with other stores. Used by the napi bridge.
    pub fn with_shared_conn(conn: SharedConnection) -> Result<Self> {
        let s = Self { conn };
        s.init_schema()?;
        Ok(s)
    }

    fn init_schema(&self) -> Result<()> {
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS automations (
                    id TEXT PRIMARY KEY,
                    name TEXT NOT NULL,
                    trigger_json TEXT NOT NULL,
                    action_json TEXT NOT NULL,
                    enabled INTEGER NOT NULL DEFAULT 1,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    last_run_at TEXT,
                    last_run_status TEXT
                );",
            )
            .map_err(Error::Sqlite)?;
        Ok(())
    }

    /// Create.
    pub fn create(&self, a: &Automation) -> Result<()> {
        let trigger_json = serde_json::to_string(&a.trigger)?;
        let action_json = serde_json::to_string(&a.action)?;
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .execute(
                "INSERT INTO automations (
                    id, name, trigger_json, action_json, enabled,
                    created_at, updated_at, last_run_at, last_run_status
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9)",
                params![
                    a.id.to_string(),
                    a.name,
                    trigger_json,
                    action_json,
                    a.enabled as i64,
                    a.created_at.to_rfc3339(),
                    a.updated_at.to_rfc3339(),
                    a.last_run_at.map(|d| d.to_rfc3339()),
                    a.last_run_status,
                ],
            )
            .map_err(Error::Sqlite)?;
        Ok(())
    }

    /// Get.
    pub fn get(&self, id: &AutomationId) -> Result<Option<Automation>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT id, name, trigger_json, action_json, enabled,
                        created_at, updated_at, last_run_at, last_run_status
                 FROM automations WHERE id = ?1",
            )
            .map_err(Error::Sqlite)?;
        let mut rows = stmt.query(params![id.to_string()]).map_err(Error::Sqlite)?;
        if let Some(row) = rows.next().map_err(Error::Sqlite)? {
            Ok(Some(row_to_automation(row).map_err(Error::Sqlite)?))
        } else {
            Ok(None)
        }
    }

    /// List.
    pub fn list(&self) -> Result<Vec<Automation>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT id, name, trigger_json, action_json, enabled,
                        created_at, updated_at, last_run_at, last_run_status
                 FROM automations ORDER BY created_at DESC",
            )
            .map_err(Error::Sqlite)?;
        let rows = stmt
            .query_map([], row_to_automation)
            .map_err(Error::Sqlite)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(Error::Sqlite)?);
        }
        Ok(out)
    }

    /// Set enabled.
    pub fn set_enabled(&self, id: &AutomationId, enabled: bool) -> Result<()> {
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .execute(
                "UPDATE automations SET enabled = ?1, updated_at = ?2 WHERE id = ?3",
                params![enabled as i64, Utc::now().to_rfc3339(), id.to_string(),],
            )
            .map_err(Error::Sqlite)?;
        Ok(())
    }

    /// Delete.
    pub fn delete(&self, id: &AutomationId) -> Result<bool> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        // Zero-fill the freed page so the deleted automation rule
        // (trigger/action config) is unrecoverable from the freelist.
        let rows = with_secure_delete(&conn, |conn| {
            conn.execute(
                "DELETE FROM automations WHERE id = ?1",
                params![id.to_string()],
            )
            .map_err(Error::Sqlite)
        })?;
        Ok(rows > 0)
    }

    /// Record the result of a run. Persists `last_run_at` and a string
    /// status the UI can render (e.g. "ok", "failed: `<message>`").
    pub fn record_run(&self, id: &AutomationId, ran_at: DateTime<Utc>, status: &str) -> Result<()> {
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .execute(
                "UPDATE automations SET last_run_at = ?1, last_run_status = ?2,
                        updated_at = ?3 WHERE id = ?4",
                params![
                    ran_at.to_rfc3339(),
                    status,
                    Utc::now().to_rfc3339(),
                    id.to_string(),
                ],
            )
            .map_err(Error::Sqlite)?;
        Ok(())
    }

    /// Return all enabled scheduled automations that are due as of `now`.
    pub fn due_scheduled(&self, now: DateTime<Utc>) -> Result<Vec<Automation>> {
        Ok(self
            .list()?
            .into_iter()
            .filter(|a| matches!(a.trigger, AutomationTrigger::Schedule { .. }) && a.is_due(now))
            .collect())
    }

    /// Return all enabled `OnGenerate` automations tied to `template_id`.
    pub fn matching_on_generate(&self, template_id: &TemplateId) -> Result<Vec<Automation>> {
        Ok(self
            .list()?
            .into_iter()
            .filter(|a| {
                a.enabled
                    && matches!(
                        &a.trigger,
                        AutomationTrigger::OnGenerate { template_id: tid } if tid == template_id
                    )
            })
            .collect())
    }
}

fn row_to_automation(row: &rusqlite::Row<'_>) -> rusqlite::Result<Automation> {
    let id_str: String = row.get(0)?;
    let id = uuid::Uuid::from_str(&id_str).map_err(|_| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, "bad uuid".into())
    })?;
    let trigger_json: String = row.get(2)?;
    let action_json: String = row.get(3)?;
    let trigger: AutomationTrigger = serde_json::from_str(&trigger_json).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(2, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let action: AutomationAction = serde_json::from_str(&action_json).map_err(|e| {
        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(e))
    })?;
    let enabled: i64 = row.get(4)?;
    Ok(Automation {
        id: AutomationId(id),
        name: row.get(1)?,
        trigger,
        action,
        enabled: enabled != 0,
        created_at: parse_dt(&row.get::<_, String>(5)?, 5)?,
        updated_at: parse_dt(&row.get::<_, String>(6)?, 6)?,
        last_run_at: parse_opt_dt(row.get::<_, Option<String>>(7)?, 7)?,
        last_run_status: row.get(8)?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> AutomationStore {
        AutomationStore::open_in_memory().expect("open in-memory")
    }

    fn a_template() -> TemplateId {
        TemplateId::from_string("prd-v1")
    }

    #[test]
    fn create_and_list_round_trip() {
        let s = store();
        let a = Automation::new(
            "Re-index every 6h",
            AutomationTrigger::Schedule {
                interval_seconds: 21600,
            },
            AutomationAction::ReindexSource {
                source_id: SourceId::new(),
            },
        );
        s.create(&a).unwrap();
        let list = s.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "Re-index every 6h");
        assert!(matches!(
            list[0].trigger,
            AutomationTrigger::Schedule {
                interval_seconds: 21600
            }
        ));
    }

    #[test]
    fn is_due_handles_schedule() {
        let now = Utc::now();
        let mut a = Automation::new(
            "hourly",
            AutomationTrigger::Schedule {
                interval_seconds: 3600,
            },
            AutomationAction::ReindexSource {
                source_id: SourceId::new(),
            },
        );
        a.created_at = now - chrono::Duration::hours(2);
        a.last_run_at = None;
        assert!(a.is_due(now));
        a.last_run_at = Some(now - chrono::Duration::minutes(30));
        assert!(!a.is_due(now));
        a.last_run_at = Some(now - chrono::Duration::hours(2));
        assert!(a.is_due(now));
    }

    #[test]
    fn disabled_automation_never_due() {
        let now = Utc::now();
        let mut a = Automation::new(
            "x",
            AutomationTrigger::Schedule {
                interval_seconds: 10,
            },
            AutomationAction::ReindexSource {
                source_id: SourceId::new(),
            },
        );
        a.created_at = now - chrono::Duration::hours(1);
        a.enabled = false;
        assert!(!a.is_due(now));
    }

    #[test]
    fn on_generate_trigger_never_schedule_due() {
        let now = Utc::now();
        let a = Automation::new(
            "g",
            AutomationTrigger::OnGenerate {
                template_id: a_template(),
            },
            AutomationAction::ReindexSource {
                source_id: SourceId::new(),
            },
        );
        assert!(!a.is_due(now));
    }

    #[test]
    fn record_run_updates_status_and_timestamp() {
        let s = store();
        let a = Automation::new(
            "n",
            AutomationTrigger::Schedule {
                interval_seconds: 10,
            },
            AutomationAction::ReindexSource {
                source_id: SourceId::new(),
            },
        );
        s.create(&a).unwrap();
        let ran_at = Utc::now();
        s.record_run(&a.id, ran_at, "ok").unwrap();
        let got = s.get(&a.id).unwrap().unwrap();
        assert!(got.last_run_at.is_some());
        assert_eq!(got.last_run_status.as_deref(), Some("ok"));
    }

    #[test]
    fn matching_on_generate_filters_by_template_id() {
        let s = store();
        let prd = a_template();
        let other = TemplateId::from_string("other-v1");
        let a = Automation::new(
            "prd",
            AutomationTrigger::OnGenerate { template_id: prd },
            AutomationAction::ReindexSource {
                source_id: SourceId::new(),
            },
        );
        let b = Automation::new(
            "other",
            AutomationTrigger::OnGenerate { template_id: other },
            AutomationAction::ReindexSource {
                source_id: SourceId::new(),
            },
        );
        s.create(&a).unwrap();
        s.create(&b).unwrap();
        let matches_a = s.matching_on_generate(&prd).unwrap();
        assert_eq!(matches_a.len(), 1);
        assert_eq!(matches_a[0].name, "prd");
    }

    #[test]
    fn set_enabled_and_delete() {
        let s = store();
        let a = Automation::new(
            "x",
            AutomationTrigger::Schedule {
                interval_seconds: 1,
            },
            AutomationAction::ReindexSource {
                source_id: SourceId::new(),
            },
        );
        s.create(&a).unwrap();
        s.set_enabled(&a.id, false).unwrap();
        assert!(!s.get(&a.id).unwrap().unwrap().enabled);
        assert!(s.delete(&a.id).unwrap());
        assert!(s.get(&a.id).unwrap().is_none());
    }

    #[test]
    fn due_scheduled_returns_only_due_and_enabled() {
        let s = store();
        let now = Utc::now();
        // due
        let mut due = Automation::new(
            "due",
            AutomationTrigger::Schedule {
                interval_seconds: 60,
            },
            AutomationAction::ReindexSource {
                source_id: SourceId::new(),
            },
        );
        due.created_at = now - chrono::Duration::minutes(5);
        s.create(&due).unwrap();
        // not due (last run was just now)
        let mut not_due = Automation::new(
            "not_due",
            AutomationTrigger::Schedule {
                interval_seconds: 600,
            },
            AutomationAction::ReindexSource {
                source_id: SourceId::new(),
            },
        );
        not_due.last_run_at = Some(now);
        s.create(&not_due).unwrap();

        let due_list = s.due_scheduled(now).unwrap();
        assert_eq!(due_list.len(), 1);
        assert_eq!(due_list[0].name, "due");
    }

    #[test]
    fn automation_store_shares_database_with_clone() {
        // Two stores built on the same SharedConnection see the same
        // rows. Mirrors `audit_store_shares_database_with_clone` so the
        // shared-connection refactor is exercised per-crate.
        let conn = tessera_core::open_shared_in_memory().unwrap();
        let a = AutomationStore::with_shared_conn(conn.clone()).unwrap();
        let b = AutomationStore::with_shared_conn(conn).unwrap();
        let auto = Automation::new(
            "shared",
            AutomationTrigger::Schedule {
                interval_seconds: 60,
            },
            AutomationAction::ReindexSource {
                source_id: SourceId::new(),
            },
        );
        a.create(&auto).unwrap();
        let list = b.list().unwrap();
        assert_eq!(list.len(), 1);
        assert_eq!(list[0].name, "shared");
    }
}
