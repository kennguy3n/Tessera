//! Bridge layer for Automations. Mirrors `bridge::tasks`: thin
//! conversions from `tessera_artifacts::automations` types to napi-
//! friendly DTOs the renderer can pass straight through IPC.
//!
//! `AutomationTrigger` and `AutomationAction` are serde-tagged enums
//! that don't map cleanly to `#[napi(object)]`.  We surface them as
//! JSON strings (`trigger_json` / `action_json`) so the renderer can
//! `JSON.parse` them on the TypeScript side without giving up the
//! typed Rust representation on the core side.

use chrono::{DateTime, Utc};
use napi_derive::napi;
use serde::{Deserialize, Serialize};
use tessera_artifacts::automations::{
    Automation, AutomationAction, AutomationStore, AutomationTrigger,
};
use tessera_core::error::{Error, Result};
use tessera_core::types::{AutomationId, TemplateId};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
/// Automation Info.
pub struct AutomationInfo {
    /// Id.
    pub id: String,
    /// Name.
    pub name: String,
    /// `AutomationTrigger` encoded as JSON. Discriminator key `kind`
    /// is `schedule` or `on_generate` (matches the tagged-enum
    /// representation in the core crate).
    pub trigger_json: String,
    /// `AutomationAction` encoded as JSON. Discriminator key `kind`
    /// is `reindex_source` or `generate_from_template`.
    pub action_json: String,
    /// Enabled.
    pub enabled: bool,
    /// Created at.
    pub created_at: String,
    /// Updated at.
    pub updated_at: String,
    /// Last run at.
    pub last_run_at: Option<String>,
    /// Last run status.
    pub last_run_status: Option<String>,
    /// Convenience field: for `Schedule` triggers, the next moment the
    /// runner would fire this automation.  `None` for `OnGenerate`.
    pub next_scheduled_at: Option<String>,
}

impl From<Automation> for AutomationInfo {
    fn from(a: Automation) -> Self {
        let next_scheduled_at = a.next_scheduled_at().map(|dt| dt.to_rfc3339());
        // Both serializations are infallible (the types are pure data),
        // but we still surface the failure path defensively so a future
        // schema change can't silently truncate.
        let trigger_json = serde_json::to_string(&a.trigger).unwrap_or_else(|_| "{}".to_string());
        let action_json = serde_json::to_string(&a.action).unwrap_or_else(|_| "{}".to_string());
        Self {
            id: a.id.to_string(),
            name: a.name,
            trigger_json,
            action_json,
            enabled: a.enabled,
            created_at: a.created_at.to_rfc3339(),
            updated_at: a.updated_at.to_rfc3339(),
            last_run_at: a.last_run_at.map(|dt| dt.to_rfc3339()),
            last_run_status: a.last_run_status,
            next_scheduled_at,
        }
    }
}

/// Wire-shape for the create request. `trigger_json` / `action_json`
/// must parse as `AutomationTrigger` / `AutomationAction` respectively.
#[derive(Debug, Clone, Deserialize)]
pub struct CreateAutomationRequest {
    /// Name.
    pub name: String,
    /// Trigger json.
    pub trigger_json: String,
    /// Action json.
    pub action_json: String,
    #[serde(default = "default_enabled")]
    /// Enabled.
    pub enabled: bool,
}

fn default_enabled() -> bool {
    true
}

fn parse_automation_id(s: &str) -> Result<AutomationId> {
    Ok(AutomationId(uuid::Uuid::parse_str(s).map_err(|e| {
        Error::InvalidConfig(format!("invalid automation id: {e}"))
    })?))
}

fn parse_trigger(s: &str) -> Result<AutomationTrigger> {
    let trigger: AutomationTrigger = serde_json::from_str(s)
        .map_err(|e| Error::InvalidConfig(format!("invalid trigger json: {e}")))?;
    if let AutomationTrigger::Schedule { interval_seconds } = &trigger {
        if *interval_seconds <= 0 {
            return Err(Error::InvalidConfig(
                "schedule interval_seconds must be positive".into(),
            ));
        }
    }
    Ok(trigger)
}

fn parse_action(s: &str) -> Result<AutomationAction> {
    serde_json::from_str(s).map_err(|e| Error::InvalidConfig(format!("invalid action json: {e}")))
}

/// Create automation.
pub fn create_automation(
    store: &AutomationStore,
    req: CreateAutomationRequest,
) -> Result<AutomationInfo> {
    let trigger = parse_trigger(&req.trigger_json)?;
    let action = parse_action(&req.action_json)?;
    let mut a = Automation::new(req.name, trigger, action);
    a.enabled = req.enabled;
    store.create(&a)?;
    Ok(a.into())
}

/// List automations.
pub fn list_automations(store: &AutomationStore) -> Result<Vec<AutomationInfo>> {
    Ok(store.list()?.into_iter().map(Into::into).collect())
}

/// Get automation.
pub fn get_automation(store: &AutomationStore, id: &str) -> Result<Option<AutomationInfo>> {
    let aid = parse_automation_id(id)?;
    Ok(store.get(&aid)?.map(Into::into))
}

/// Set automation enabled.
pub fn set_automation_enabled(store: &AutomationStore, id: &str, enabled: bool) -> Result<()> {
    let aid = parse_automation_id(id)?;
    store.set_enabled(&aid, enabled)
}

/// Delete automation.
pub fn delete_automation(store: &AutomationStore, id: &str) -> Result<bool> {
    let aid = parse_automation_id(id)?;
    store.delete(&aid)
}

/// Return all enabled `Schedule` automations that are due as of `now`.
///
/// The scheduler service in the Electron main process ticks every
/// 30 seconds, calls this, and dispatches the resulting actions. We
/// surface the convenience JSON fields on each row (same shape as
/// `list_automations`) rather than a sparse "id + action" pair so the
/// renderer and the Electron scheduler can share a single deserialiser.
pub fn due_scheduled_automations(
    store: &AutomationStore,
    now: DateTime<Utc>,
) -> Result<Vec<AutomationInfo>> {
    Ok(store
        .due_scheduled(now)?
        .into_iter()
        .map(Into::into)
        .collect())
}

/// Return all enabled `OnGenerate` automations tied to `template_id`.
/// Called from the artifact-generation IPC handler after a successful
/// generation so the scheduler can immediately dispatch any
/// template-triggered automation (e.g. "re-index Drive every time the
/// weekly summary is generated").
pub fn matching_on_generate_automations(
    store: &AutomationStore,
    template_id: &str,
) -> Result<Vec<AutomationInfo>> {
    // Templates have a stable string id (e.g. "prd-v1") that's hashed
    // into a UUID via `TemplateId::from_string` (UUID5 of the bytes).
    // Use the same hash here so an automation created with the YAML
    // template's `id` matches the `TemplateId` recorded by the artifact
    // generator at run-time.
    if template_id.is_empty() {
        return Err(Error::InvalidConfig(
            "template_id is required for matching_on_generate".into(),
        ));
    }
    let tid = TemplateId::from_string(template_id);
    Ok(store
        .matching_on_generate(&tid)?
        .into_iter()
        .map(Into::into)
        .collect())
}

/// Record the result of an automation run. `status` is a short string
/// the UI renders verbatim (`"ok"` / `"failed: <reason>"`). `ran_at`
/// defaults to `Utc::now()` on the Rust side; the Electron scheduler
/// doesn't need to thread a clock for the common case.
pub fn record_automation_run(store: &AutomationStore, id: &str, status: &str) -> Result<()> {
    let aid = parse_automation_id(id)?;
    if status.is_empty() {
        return Err(Error::InvalidConfig(
            "automation run status must not be empty".into(),
        ));
    }
    store.record_run(&aid, Utc::now(), status)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_trigger_rejects_non_positive_schedule_interval() {
        // Zero would mean "fire on every tick", negative would flow
        // straight into `chrono::Duration::seconds` and produce a
        // next-run-in-the-past, which would re-fire forever — both
        // are invariants `parse_trigger` enforces.
        for bad in ["0", "-1", "-86400"] {
            let json = format!(r#"{{"kind":"schedule","interval_seconds":{bad}}}"#);
            let err = parse_trigger(&json).expect_err("non-positive interval must fail");
            assert!(
                format!("{err}").contains("interval_seconds must be positive"),
                "unexpected error for {bad}: {err}"
            );
        }
    }

    #[test]
    fn parse_trigger_accepts_positive_schedule_interval() {
        let json = r#"{"kind":"schedule","interval_seconds":3600}"#;
        let trigger = parse_trigger(json).expect("positive interval should parse");
        match trigger {
            AutomationTrigger::Schedule { interval_seconds } => {
                assert_eq!(interval_seconds, 3600);
            }
            AutomationTrigger::OnGenerate { .. } => panic!("expected Schedule, got OnGenerate"),
        }
    }

    #[test]
    fn parse_trigger_accepts_on_generate() {
        let tid = uuid::Uuid::new_v4();
        let json = format!(r#"{{"kind":"on_generate","template_id":"{tid}"}}"#);
        let trigger = parse_trigger(&json).expect("on_generate should parse");
        assert!(matches!(trigger, AutomationTrigger::OnGenerate { .. }));
    }

    // Bridge-level helpers that the Electron scheduler service depends
    // on — exercising them against an in-memory store proves the
    // tagged-enum JSON, `record_run` plumbing, and `TemplateId::from_string`
    // hashing all line up with the `tessera_artifacts::AutomationStore`
    // contract.

    fn open_store() -> AutomationStore {
        AutomationStore::open_in_memory().expect("in-memory store")
    }

    fn sample_source_id() -> String {
        // Both `SourceId` and `TemplateId` deserialize from JSON as
        // UUIDs (via serde-on-`Uuid`), so the action_json must contain
        // a real UUID string — not an arbitrary slug like "src-1".
        uuid::Uuid::new_v4().to_string()
    }

    fn sample_reindex_action_json() -> String {
        format!(
            r#"{{"kind":"reindex_source","source_id":"{}"}}"#,
            sample_source_id(),
        )
    }

    #[test]
    fn record_automation_run_rejects_empty_status() {
        let store = open_store();
        let info = create_automation(
            &store,
            CreateAutomationRequest {
                name: "test".into(),
                trigger_json: r#"{"kind":"schedule","interval_seconds":3600}"#.into(),
                action_json: sample_reindex_action_json(),
                enabled: true,
            },
        )
        .expect("create");

        let err = record_automation_run(&store, &info.id, "").expect_err("empty rejected");
        assert!(format!("{err}").contains("status must not be empty"));
    }

    #[test]
    fn record_automation_run_persists_status() {
        let store = open_store();
        let info = create_automation(
            &store,
            CreateAutomationRequest {
                name: "test".into(),
                trigger_json: r#"{"kind":"schedule","interval_seconds":3600}"#.into(),
                action_json: sample_reindex_action_json(),
                enabled: true,
            },
        )
        .expect("create");

        record_automation_run(&store, &info.id, "ok").expect("record ok");
        let reloaded = get_automation(&store, &info.id)
            .expect("get")
            .expect("present");
        assert_eq!(reloaded.last_run_status.as_deref(), Some("ok"));
        assert!(reloaded.last_run_at.is_some());

        // Subsequent record overwrites — last_run_at must advance.
        record_automation_run(&store, &info.id, "failed: timeout").expect("record fail");
        let reloaded2 = get_automation(&store, &info.id)
            .expect("get")
            .expect("present");
        assert_eq!(
            reloaded2.last_run_status.as_deref(),
            Some("failed: timeout")
        );
    }

    #[test]
    fn matching_on_generate_requires_template_id() {
        let store = open_store();
        let err =
            matching_on_generate_automations(&store, "").expect_err("empty template_id rejected");
        assert!(format!("{err}").contains("template_id is required"));
    }

    #[test]
    fn matching_on_generate_resolves_by_template_string_id() {
        let store = open_store();
        // Create an automation whose trigger references the template by
        // its UUID5(name="prd-v1"). Use `TemplateId::from_string` so
        // the JSON contains the same UUID the bridge produces from the
        // string id passed to `matching_on_generate_automations`.
        let template_string_id = "prd-v1";
        let template_uuid = TemplateId::from_string(template_string_id);
        let trigger_json = format!(
            r#"{{"kind":"on_generate","template_id":"{}"}}"#,
            template_uuid.0
        );
        let action_json = sample_reindex_action_json();
        let info = create_automation(
            &store,
            CreateAutomationRequest {
                name: "test".into(),
                trigger_json,
                action_json,
                enabled: true,
            },
        )
        .expect("create");

        let matches =
            matching_on_generate_automations(&store, template_string_id).expect("matching");
        assert_eq!(matches.len(), 1);
        assert_eq!(matches[0].id, info.id);

        // A different string id must NOT match (different UUID5).
        let no_match =
            matching_on_generate_automations(&store, "other-template").expect("matching");
        assert!(no_match.is_empty());
    }

    #[test]
    fn due_scheduled_returns_empty_when_no_automations() {
        let store = open_store();
        let due = due_scheduled_automations(&store, Utc::now()).expect("due");
        assert!(due.is_empty());
    }
}
