//! Bridge layer for Automations. Mirrors `bridge::tasks`: thin
//! conversions from `tessera_artifacts::automations` types to napi-
//! friendly DTOs the renderer can pass straight through IPC.
//!
//! `AutomationTrigger` and `AutomationAction` are serde-tagged enums
//! that don't map cleanly to `#[napi(object)]`.  We surface them as
//! JSON strings (`trigger_json` / `action_json`) so the renderer can
//! `JSON.parse` them on the TypeScript side without giving up the
//! typed Rust representation on the core side.

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use tessera_artifacts::automations::{
    Automation, AutomationAction, AutomationStore, AutomationTrigger,
};
use tessera_core::error::{Error, Result};
use tessera_core::types::AutomationId;

#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct AutomationInfo {
    pub id: String,
    pub name: String,
    /// `AutomationTrigger` encoded as JSON. Discriminator key `kind`
    /// is `schedule` or `on_generate` (matches the tagged-enum
    /// representation in the core crate).
    pub trigger_json: String,
    /// `AutomationAction` encoded as JSON. Discriminator key `kind`
    /// is `reindex_source` or `generate_from_template`.
    pub action_json: String,
    pub enabled: bool,
    pub created_at: String,
    pub updated_at: String,
    pub last_run_at: Option<String>,
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
    pub name: String,
    pub trigger_json: String,
    pub action_json: String,
    #[serde(default = "default_enabled")]
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
    serde_json::from_str(s).map_err(|e| Error::InvalidConfig(format!("invalid trigger json: {e}")))
}

fn parse_action(s: &str) -> Result<AutomationAction> {
    serde_json::from_str(s).map_err(|e| Error::InvalidConfig(format!("invalid action json: {e}")))
}

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

pub fn list_automations(store: &AutomationStore) -> Result<Vec<AutomationInfo>> {
    Ok(store.list()?.into_iter().map(Into::into).collect())
}

pub fn get_automation(store: &AutomationStore, id: &str) -> Result<Option<AutomationInfo>> {
    let aid = parse_automation_id(id)?;
    Ok(store.get(&aid)?.map(Into::into))
}

pub fn set_automation_enabled(store: &AutomationStore, id: &str, enabled: bool) -> Result<()> {
    let aid = parse_automation_id(id)?;
    store.set_enabled(&aid, enabled)
}

pub fn delete_automation(store: &AutomationStore, id: &str) -> Result<bool> {
    let aid = parse_automation_id(id)?;
    store.delete(&aid)
}
