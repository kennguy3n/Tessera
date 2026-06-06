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
use regex::Regex;
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
    /// Run when the KChat WebSocket delivers a post in `channel_id`
    /// whose body matches `regex`. The KChat event path
    /// (`apps/desktop/electron/kchat/kchatEventForwarder`) calls into
    /// [`AutomationStore::matching_kchat_message`] on every `posted`
    /// event to resolve the firing automations.
    ///
    /// `channel_id` is a KChat (Mattermost) channel id — a 26-char
    /// base32 string, not a Tessera UUID — so it is stored as a plain
    /// `String`. `regex` is an unanchored Rust `regex`-crate pattern;
    /// an invalid pattern is rejected at creation time by the bridge
    /// and, defensively, treated as "never matches" at dispatch time.
    OnKchatMessageMatch {
        /// KChat (Mattermost) channel id to watch.
        channel_id: String,
        /// Unanchored `regex`-crate pattern matched against post bodies.
        regex: String,
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
    /// Run several actions in order as a single automation. Steps
    /// execute sequentially and independently: a failing step is
    /// reported but does NOT abort the remaining steps (see
    /// [`run_action_sequence`]). Nesting is flattened by
    /// [`AutomationAction::steps`] so a `Sequence` of `Sequence`s
    /// behaves as one flat ordered list of leaf actions.
    Sequence {
        /// Ordered child actions executed sequentially.
        actions: Vec<AutomationAction>,
    },
}

impl AutomationAction {
    /// Flatten this action into the ordered list of leaf (non-sequence)
    /// actions to execute. A non-`Sequence` action yields just itself;
    /// a `Sequence` expands recursively so callers always iterate a
    /// flat list regardless of how the steps were nested on write.
    pub fn steps(&self) -> Vec<&AutomationAction> {
        match self {
            AutomationAction::Sequence { actions } => {
                actions.iter().flat_map(AutomationAction::steps).collect()
            }
            other => vec![other],
        }
    }
}

/// Outcome of executing a single step within a multi-step action.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct StepOutcome {
    /// Zero-based index of the step within the flattened action list.
    pub index: usize,
    /// `None` if the step succeeded; `Some(message)` if its executor
    /// returned an error.
    pub error: Option<String>,
}

impl StepOutcome {
    /// True when the step executed without error.
    pub fn succeeded(&self) -> bool {
        self.error.is_none()
    }
}

/// Aggregate result of running a multi-step action via
/// [`run_action_sequence`]. Carries one [`StepOutcome`] per executed
/// step, in execution order.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SequenceReport {
    /// One outcome per executed step, in execution order.
    pub steps: Vec<StepOutcome>,
}

impl SequenceReport {
    /// True when every step succeeded.
    pub fn all_succeeded(&self) -> bool {
        self.steps.iter().all(StepOutcome::succeeded)
    }

    /// The steps that failed, in execution order.
    pub fn failures(&self) -> impl Iterator<Item = &StepOutcome> {
        self.steps.iter().filter(|s| !s.succeeded())
    }

    /// Render a UI/audit status string with the same `"ok"` /
    /// `"failed: ..."` convention the scheduler records via
    /// `record_run`. Returns `"ok"` when all steps succeeded, otherwise
    /// `"failed: K/N steps failed: step <i>: <msg>; ..."` (1-based step
    /// numbers) so a partial failure is visible without hiding which
    /// steps broke.
    pub fn status_string(&self) -> String {
        let failures: Vec<&StepOutcome> = self.failures().collect();
        if failures.is_empty() {
            return "ok".to_string();
        }
        let detail = failures
            .iter()
            .map(|s| {
                format!(
                    "step {}: {}",
                    s.index + 1,
                    s.error.as_deref().unwrap_or("unknown error")
                )
            })
            .collect::<Vec<_>>()
            .join("; ");
        format!(
            "failed: {}/{} steps failed: {}",
            failures.len(),
            self.steps.len(),
            detail
        )
    }
}

/// Execute a multi-step action by invoking `exec` once per leaf step,
/// in order. Each step is independent: when a step's executor returns
/// `Err(message)` the failure is recorded in the returned
/// [`SequenceReport`] and execution CONTINUES with the next step — a
/// single failing step never aborts the rest of the chain. `exec`
/// receives the zero-based step index and the leaf action, returning
/// `Ok(())` on success or `Err(message)` to record a failure.
///
/// `actions` is the flat list of leaf steps; callers typically pass
/// [`AutomationAction::steps`] so nested `Sequence`s are flattened
/// first.
pub fn run_action_sequence<F>(actions: &[&AutomationAction], mut exec: F) -> SequenceReport
where
    F: FnMut(usize, &AutomationAction) -> std::result::Result<(), String>,
{
    let mut steps = Vec::with_capacity(actions.len());
    for (index, action) in actions.iter().enumerate() {
        let error = exec(index, action).err();
        steps.push(StepOutcome { index, error });
    }
    SequenceReport { steps }
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

    /// Return all enabled `OnKchatMessageMatch` automations whose
    /// `channel_id` equals `channel_id` AND whose `regex` matches
    /// `message`. Called from the KChat event path on every `posted`
    /// WebSocket event.
    ///
    /// The pattern is matched unanchored (i.e. "contains a match"),
    /// mirroring `Regex::is_match`. An automation whose stored pattern
    /// fails to compile is skipped defensively — it can never match, so
    /// it is treated as a non-match rather than aborting the whole
    /// resolution (a single corrupt rule must not silence every other
    /// automation on the channel). The bridge validates the pattern at
    /// creation time, so a compile failure here implies an externally
    /// edited database.
    pub fn matching_kchat_message(
        &self,
        channel_id: &str,
        message: &str,
    ) -> Result<Vec<Automation>> {
        Ok(self
            .list()?
            .into_iter()
            .filter(|a| {
                if !a.enabled {
                    return false;
                }
                match &a.trigger {
                    AutomationTrigger::OnKchatMessageMatch {
                        channel_id: cid,
                        regex,
                    } if cid == channel_id => {
                        Regex::new(regex).is_ok_and(|re| re.is_match(message))
                    }
                    _ => false,
                }
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

    // --- OnKchatMessageMatch trigger ---

    fn kchat_match_automation(name: &str, channel_id: &str, regex: &str) -> Automation {
        Automation::new(
            name,
            AutomationTrigger::OnKchatMessageMatch {
                channel_id: channel_id.into(),
                regex: regex.into(),
            },
            AutomationAction::ReindexSource {
                source_id: SourceId::new(),
            },
        )
    }

    #[test]
    fn kchat_trigger_round_trips_through_store() {
        let s = store();
        let a = kchat_match_automation("deploys", "chan-ops", r"deploy\s+prod");
        s.create(&a).unwrap();
        let got = s.get(&a.id).unwrap().expect("present");
        assert_eq!(
            got.trigger,
            AutomationTrigger::OnKchatMessageMatch {
                channel_id: "chan-ops".into(),
                regex: r"deploy\s+prod".into(),
            }
        );
    }

    #[test]
    fn matching_kchat_message_matches_channel_and_regex() {
        let s = store();
        let ops = kchat_match_automation("ops", "chan-ops", r"(?i)deploy");
        let eng = kchat_match_automation("eng", "chan-eng", r"(?i)deploy");
        s.create(&ops).unwrap();
        s.create(&eng).unwrap();

        // Right channel + body matches the (case-insensitive) pattern.
        let hits = s
            .matching_kchat_message("chan-ops", "Please DEPLOY now")
            .unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "ops");

        // Right channel but body doesn't match the pattern.
        let none = s
            .matching_kchat_message("chan-ops", "just chatting")
            .unwrap();
        assert!(none.is_empty());

        // Pattern matches but the channel id differs → no fire.
        let wrong_channel = s
            .matching_kchat_message("chan-other", "deploy please")
            .unwrap();
        assert!(wrong_channel.is_empty());
    }

    #[test]
    fn matching_kchat_message_skips_disabled_and_uncompilable() {
        let s = store();
        let disabled = kchat_match_automation("disabled", "c1", "hello");
        s.create(&disabled).unwrap();
        s.set_enabled(&disabled.id, false).unwrap();
        // Disabled automations never fire even on a clear match.
        assert!(s
            .matching_kchat_message("c1", "hello there")
            .unwrap()
            .is_empty());

        // A rule whose stored regex can't compile is skipped (treated as
        // a non-match) rather than erroring out the whole resolution.
        let bad = kchat_match_automation("bad", "c1", "(unclosed");
        s.create(&bad).unwrap();
        let good = kchat_match_automation("good", "c1", "hello");
        s.create(&good).unwrap();
        let hits = s.matching_kchat_message("c1", "well hello").unwrap();
        assert_eq!(hits.len(), 1);
        assert_eq!(hits[0].name, "good");
    }

    // --- Multi-step (Sequence) actions ---

    fn reindex() -> AutomationAction {
        AutomationAction::ReindexSource {
            source_id: SourceId::new(),
        }
    }

    #[test]
    fn sequence_action_round_trips_and_flattens() {
        let s = store();
        let seq = AutomationAction::Sequence {
            actions: vec![
                reindex(),
                // A nested sequence flattens into the parent's step list.
                AutomationAction::Sequence {
                    actions: vec![reindex(), reindex()],
                },
            ],
        };
        let a = Automation::new(
            "multi",
            AutomationTrigger::Schedule {
                interval_seconds: 60,
            },
            seq,
        );
        s.create(&a).unwrap();
        let got = s.get(&a.id).unwrap().expect("present");
        // 1 leaf + 2 nested leaves = 3 flattened steps; no Sequence
        // appears in the flattened list.
        let steps = got.action.steps();
        assert_eq!(steps.len(), 3);
        assert!(steps
            .iter()
            .all(|s| !matches!(s, AutomationAction::Sequence { .. })));
    }

    #[test]
    fn run_action_sequence_runs_all_steps_in_order_on_success() {
        let actions = [reindex(), reindex(), reindex()];
        let refs: Vec<&AutomationAction> = actions.iter().collect();
        let mut seen = Vec::new();
        let report = run_action_sequence(&refs, |i, _| {
            seen.push(i);
            Ok(())
        });
        assert_eq!(seen, vec![0, 1, 2]);
        assert!(report.all_succeeded());
        assert_eq!(report.status_string(), "ok");
    }

    #[test]
    fn run_action_sequence_continues_past_a_failing_step() {
        let actions = [reindex(), reindex(), reindex()];
        let refs: Vec<&AutomationAction> = actions.iter().collect();
        let mut seen = Vec::new();
        // Middle step fails; the chain must NOT abort — step 2 (index 2)
        // still runs, and the failure is reported.
        let report = run_action_sequence(&refs, |i, _| {
            seen.push(i);
            if i == 1 {
                Err("boom".to_string())
            } else {
                Ok(())
            }
        });
        assert_eq!(
            seen,
            vec![0, 1, 2],
            "every step must run despite the failure"
        );
        assert!(!report.all_succeeded());
        let failures: Vec<&StepOutcome> = report.failures().collect();
        assert_eq!(failures.len(), 1);
        assert_eq!(failures[0].index, 1);
        assert_eq!(failures[0].error.as_deref(), Some("boom"));
        let status = report.status_string();
        assert!(status.starts_with("failed: 1/3 steps failed"));
        assert!(status.contains("step 2: boom"));
    }

    #[test]
    fn run_action_sequence_reports_multiple_failures() {
        let actions = [reindex(), reindex(), reindex()];
        let refs: Vec<&AutomationAction> = actions.iter().collect();
        let report = run_action_sequence(&refs, |i, _| {
            if i == 0 || i == 2 {
                Err(format!("err{i}"))
            } else {
                Ok(())
            }
        });
        assert_eq!(report.failures().count(), 2);
        let status = report.status_string();
        assert!(status.contains("2/3 steps failed"));
        assert!(status.contains("step 1: err0"));
        assert!(status.contains("step 3: err2"));
    }
}
