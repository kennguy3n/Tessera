//! Bridge layer for Tasks. Exposes JSON-shaped DTOs that the Electron
//! IPC layer can pass straight to renderer code without re-marshalling.

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use tessera_artifacts::tasks::{Task, TaskStore, TaskUpdate};
use tessera_core::error::Result;
use tessera_core::types::{SourceId, TaskId, TaskPriority, TaskStatus};

#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct TaskInfo {
    pub id: String,
    pub title: String,
    pub description: String,
    pub status: String,
    pub priority: String,
    pub position: i64,
    pub assignee: Option<String>,
    pub due_date: Option<String>,
    pub source_id: Option<String>,
    pub extracted_item_id: Option<String>,
    pub created_at: String,
    pub updated_at: String,
}

impl From<Task> for TaskInfo {
    fn from(t: Task) -> Self {
        Self {
            id: t.id.to_string(),
            title: t.title,
            description: t.description,
            status: t.status.to_string(),
            priority: t.priority.to_string(),
            position: t.position,
            assignee: t.assignee,
            due_date: t.due_date.map(|d| d.to_rfc3339()),
            source_id: t.source_id.map(|s| s.to_string()),
            extracted_item_id: t.extracted_item_id,
            created_at: t.created_at.to_rfc3339(),
            updated_at: t.updated_at.to_rfc3339(),
        }
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CreateTaskRequest {
    pub title: String,
    #[serde(default)]
    pub description: String,
    #[serde(default = "default_status")]
    pub status: String,
    #[serde(default = "default_priority")]
    pub priority: String,
    #[serde(default)]
    pub assignee: Option<String>,
    #[serde(default)]
    pub due_date: Option<String>,
    #[serde(default)]
    pub source_id: Option<String>,
    #[serde(default)]
    pub extracted_item_id: Option<String>,
}

fn default_status() -> String {
    "todo".to_string()
}
fn default_priority() -> String {
    "medium".to_string()
}

impl Default for CreateTaskRequest {
    // Keep `Default` in sync with the serde defaults above. We can't
    // `derive(Default)` because the serde attribute would produce an
    // empty-string status/priority, which now (correctly) fails
    // parsing.
    fn default() -> Self {
        Self {
            title: String::new(),
            description: String::new(),
            status: default_status(),
            priority: default_priority(),
            assignee: None,
            due_date: None,
            source_id: None,
            extracted_item_id: None,
        }
    }
}

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct UpdateTaskRequest {
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<String>,
    pub priority: Option<String>,
    pub position: Option<i64>,
    /// `Some(Some("x"))` sets assignee="x", `Some(None)` clears,
    /// `None` leaves unchanged.
    #[serde(default)]
    pub assignee: Option<Option<String>>,
    #[serde(default)]
    pub due_date: Option<Option<String>>,
}

fn parse_status(s: &str) -> Result<TaskStatus> {
    match s {
        "todo" => Ok(TaskStatus::Todo),
        "in_progress" => Ok(TaskStatus::InProgress),
        "done" => Ok(TaskStatus::Done),
        "blocked" => Ok(TaskStatus::Blocked),
        other => Err(tessera_core::error::Error::InvalidConfig(format!(
            "unknown task status `{other}` (expected todo|in_progress|done|blocked)"
        ))),
    }
}

fn parse_priority(s: &str) -> Result<TaskPriority> {
    match s {
        "low" => Ok(TaskPriority::Low),
        "medium" => Ok(TaskPriority::Medium),
        "high" => Ok(TaskPriority::High),
        "critical" => Ok(TaskPriority::Critical),
        other => Err(tessera_core::error::Error::InvalidConfig(format!(
            "unknown task priority `{other}` (expected low|medium|high|critical)"
        ))),
    }
}

fn parse_task_id(s: &str) -> Result<TaskId> {
    Ok(TaskId(uuid::Uuid::parse_str(s).map_err(|e| {
        tessera_core::error::Error::InvalidConfig(format!("invalid task id: {e}"))
    })?))
}

/// Parse an optional RFC 3339 string into an optional `DateTime<Utc>`,
/// surfacing parse failures as errors instead of silently dropping the
/// input. `None`/`Some("")` round-trip to `None`; any non-empty value
/// must parse successfully.
fn parse_opt_rfc3339(s: Option<&str>) -> Result<Option<chrono::DateTime<chrono::Utc>>> {
    match s {
        None | Some("") => Ok(None),
        Some(raw) => chrono::DateTime::parse_from_rfc3339(raw)
            .map(|dt| Some(dt.with_timezone(&chrono::Utc)))
            .map_err(|e| {
                tessera_core::error::Error::InvalidConfig(format!(
                    "invalid RFC 3339 timestamp `{raw}`: {e}"
                ))
            }),
    }
}

/// Parse an optional UUID string into an optional `SourceId`. Like
/// `parse_opt_rfc3339`, surfaces parse failures rather than silently
/// dropping the field.
fn parse_opt_source_id(s: Option<&str>) -> Result<Option<SourceId>> {
    match s {
        None | Some("") => Ok(None),
        Some(raw) => uuid::Uuid::parse_str(raw)
            .map(|u| Some(SourceId(u)))
            .map_err(|e| {
                tessera_core::error::Error::InvalidConfig(format!("invalid source id `{raw}`: {e}"))
            }),
    }
}

pub fn create_task(store: &TaskStore, req: CreateTaskRequest) -> Result<TaskInfo> {
    let mut t = Task::new(
        req.title,
        parse_status(&req.status)?,
        parse_priority(&req.priority)?,
    );
    t.description = req.description;
    t.assignee = req.assignee;
    t.due_date = parse_opt_rfc3339(req.due_date.as_deref())?;
    t.source_id = parse_opt_source_id(req.source_id.as_deref())?;
    t.extracted_item_id = req.extracted_item_id;
    store.create(&t)?;
    Ok(t.into())
}

pub fn list_tasks(store: &TaskStore) -> Result<Vec<TaskInfo>> {
    Ok(store.list()?.into_iter().map(Into::into).collect())
}

pub fn get_task(store: &TaskStore, id: &str) -> Result<Option<TaskInfo>> {
    let tid = parse_task_id(id)?;
    Ok(store.get(&tid)?.map(Into::into))
}

pub fn update_task(store: &TaskStore, id: &str, req: UpdateTaskRequest) -> Result<TaskInfo> {
    let tid = parse_task_id(id)?;
    // `req.due_date` distinguishes three states:
    //   `None`            -> field unchanged
    //   `Some(None)`      -> explicit clear (set to NULL)
    //   `Some(Some("x"))` -> set to parsed value; parse errors propagate
    //                        instead of falling through to clear.
    let due_date = match req.due_date {
        None => None,
        Some(inner) => Some(parse_opt_rfc3339(inner.as_deref())?),
    };
    let status = req.status.as_deref().map(parse_status).transpose()?;
    let priority = req.priority.as_deref().map(parse_priority).transpose()?;
    let update = TaskUpdate {
        title: req.title,
        description: req.description,
        status,
        priority,
        position: req.position,
        assignee: req.assignee,
        due_date,
    };
    Ok(store.update(&tid, update)?.into())
}

pub fn delete_task(store: &TaskStore, id: &str) -> Result<bool> {
    let tid = parse_task_id(id)?;
    store.delete(&tid)
}

pub fn reorder_tasks(store: &mut TaskStore, status: &str, ids: &[String]) -> Result<()> {
    let parsed: Vec<TaskId> = ids
        .iter()
        .map(|s| parse_task_id(s))
        .collect::<Result<Vec<_>>>()?;
    store.reorder_in_status(parse_status(status)?, &parsed)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> TaskStore {
        TaskStore::open_in_memory().expect("open in-memory")
    }

    #[test]
    fn create_task_rejects_invalid_due_date() {
        let s = store();
        let req = CreateTaskRequest {
            title: "Bad date".into(),
            due_date: Some("next-friday".into()),
            ..Default::default()
        };
        let err = create_task(&s, req).expect_err("invalid date must fail");
        assert!(
            format!("{err}").contains("invalid RFC 3339 timestamp"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn create_task_rejects_invalid_source_id() {
        let s = store();
        let req = CreateTaskRequest {
            title: "Bad source".into(),
            source_id: Some("not-a-uuid".into()),
            ..Default::default()
        };
        let err = create_task(&s, req).expect_err("invalid source id must fail");
        assert!(
            format!("{err}").contains("invalid source id"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn create_task_accepts_empty_optional_strings_as_none() {
        let s = store();
        let req = CreateTaskRequest {
            title: "Empty strings".into(),
            due_date: Some(String::new()),
            source_id: Some(String::new()),
            ..Default::default()
        };
        let info = create_task(&s, req).expect("create should succeed");
        assert!(info.due_date.is_none());
        assert!(info.source_id.is_none());
    }

    #[test]
    fn update_task_with_invalid_due_date_does_not_clear_existing() {
        // Regression for Devin Review BUG_0001: an unparseable due_date
        // string must not silently overwrite the existing due date.
        let s = store();
        let created = create_task(
            &s,
            CreateTaskRequest {
                title: "Has date".into(),
                due_date: Some("2026-06-01T12:00:00Z".into()),
                ..Default::default()
            },
        )
        .expect("create");
        let original_due = created.due_date.clone();
        assert!(original_due.is_some());

        let bad_update = UpdateTaskRequest {
            due_date: Some(Some("next-friday".into())),
            ..Default::default()
        };
        let err = update_task(&s, &created.id, bad_update).expect_err("invalid date must fail");
        assert!(format!("{err}").contains("invalid RFC 3339 timestamp"));

        // Verify the stored due date is untouched.
        let after = get_task(&s, &created.id).expect("get").expect("present");
        assert_eq!(after.due_date, original_due);
    }

    #[test]
    fn create_task_rejects_unknown_status() {
        let s = store();
        let req = CreateTaskRequest {
            title: "Bad status".into(),
            status: "wip".into(),
            ..Default::default()
        };
        let err = create_task(&s, req).expect_err("unknown status must fail");
        assert!(
            format!("{err}").contains("unknown task status"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn create_task_rejects_unknown_priority() {
        let s = store();
        let req = CreateTaskRequest {
            title: "Bad priority".into(),
            priority: "urgent".into(),
            ..Default::default()
        };
        let err = create_task(&s, req).expect_err("unknown priority must fail");
        assert!(
            format!("{err}").contains("unknown task priority"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn update_task_rejects_unknown_status() {
        let s = store();
        let created = create_task(
            &s,
            CreateTaskRequest {
                title: "Has status".into(),
                ..Default::default()
            },
        )
        .expect("create");
        let err = update_task(
            &s,
            &created.id,
            UpdateTaskRequest {
                status: Some("wip".into()),
                ..Default::default()
            },
        )
        .expect_err("unknown status must fail");
        assert!(format!("{err}").contains("unknown task status"));
    }

    #[test]
    fn reorder_rejects_unknown_status() {
        let mut s = store();
        let err = reorder_tasks(&mut s, "wip", &[]).expect_err("unknown reorder bucket must fail");
        assert!(format!("{err}").contains("unknown task status"));
    }

    #[test]
    fn update_task_with_some_none_clears_due_date() {
        // `Some(None)` is the explicit-clear sentinel and must still work.
        let s = store();
        let created = create_task(
            &s,
            CreateTaskRequest {
                title: "Clear me".into(),
                due_date: Some("2026-06-01T12:00:00Z".into()),
                ..Default::default()
            },
        )
        .expect("create");
        assert!(created.due_date.is_some());

        let cleared = update_task(
            &s,
            &created.id,
            UpdateTaskRequest {
                due_date: Some(None),
                ..Default::default()
            },
        )
        .expect("clear");
        assert!(cleared.due_date.is_none());
    }
}
