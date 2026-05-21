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

#[derive(Debug, Clone, Default, Serialize, Deserialize)]
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

fn parse_status(s: &str) -> TaskStatus {
    match s {
        "todo" => TaskStatus::Todo,
        "in_progress" => TaskStatus::InProgress,
        "done" => TaskStatus::Done,
        "blocked" => TaskStatus::Blocked,
        _ => TaskStatus::Todo,
    }
}

fn parse_priority(s: &str) -> TaskPriority {
    match s {
        "low" => TaskPriority::Low,
        "medium" => TaskPriority::Medium,
        "high" => TaskPriority::High,
        "critical" => TaskPriority::Critical,
        _ => TaskPriority::Medium,
    }
}

fn parse_task_id(s: &str) -> Result<TaskId> {
    Ok(TaskId(uuid::Uuid::parse_str(s).map_err(|e| {
        tessera_core::error::Error::InvalidConfig(format!("invalid task id: {e}"))
    })?))
}

pub fn create_task(store: &TaskStore, req: CreateTaskRequest) -> Result<TaskInfo> {
    let mut t = Task::new(
        req.title,
        parse_status(&req.status),
        parse_priority(&req.priority),
    );
    t.description = req.description;
    t.assignee = req.assignee;
    t.due_date = req
        .due_date
        .as_deref()
        .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
        .map(|dt| dt.with_timezone(&chrono::Utc));
    t.source_id = req
        .source_id
        .as_deref()
        .and_then(|s| uuid::Uuid::parse_str(s).ok())
        .map(SourceId);
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
    let update = TaskUpdate {
        title: req.title,
        description: req.description,
        status: req.status.as_deref().map(parse_status),
        priority: req.priority.as_deref().map(parse_priority),
        position: req.position,
        assignee: req.assignee,
        due_date: req.due_date.map(|opt| {
            opt.as_deref()
                .and_then(|s| chrono::DateTime::parse_from_rfc3339(s).ok())
                .map(|dt| dt.with_timezone(&chrono::Utc))
        }),
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
    store.reorder_in_status(parse_status(status), &parsed)
}
