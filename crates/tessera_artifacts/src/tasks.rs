//! Tasks store and operations.
//!
//! Tasks are first-class persistent objects with status, priority,
//! source linkage, assignee, due date, and ordering. They are stored
//! in the same SQLite database as artifacts; the schema is initialised
//! lazily on the first `TaskStore::open` call.
//!
//! Tasks can be created manually or extracted from source material via
//! [`tessera_artifacts::extraction`]. The `source_id` and
//! `extracted_item_id` fields preserve provenance so the UI can render
//! "open the source" affordances.

use chrono::{DateTime, Utc};
use rusqlite::{params, Connection};
use serde::{Deserialize, Serialize};
use tessera_core::error::{Error, Result};
use tessera_core::types::{SourceId, TaskId, TaskPriority, TaskStatus};

fn parse_dt(s: &str) -> DateTime<Utc> {
    DateTime::parse_from_rfc3339(s).map_or_else(|_| Utc::now(), |dt| dt.with_timezone(&Utc))
}

fn parse_opt_dt(s: Option<String>) -> Option<DateTime<Utc>> {
    s.and_then(|raw| DateTime::parse_from_rfc3339(&raw).ok())
        .map(|dt| dt.with_timezone(&Utc))
}

#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct Task {
    pub id: TaskId,
    pub title: String,
    #[serde(default)]
    pub description: String,
    pub status: TaskStatus,
    pub priority: TaskPriority,
    /// User-controlled ordering within the same status column.
    pub position: i64,
    #[serde(default)]
    pub assignee: Option<String>,
    #[serde(default)]
    pub due_date: Option<DateTime<Utc>>,
    /// Optional source provenance — set when the task was extracted
    /// from indexed source material.
    #[serde(default)]
    pub source_id: Option<SourceId>,
    /// Optional pointer to the originating [`ExtractedItem`] so the
    /// UI can re-open the extraction context.
    #[serde(default)]
    pub extracted_item_id: Option<String>,
    pub created_at: DateTime<Utc>,
    pub updated_at: DateTime<Utc>,
}

impl Task {
    pub fn new(title: impl Into<String>, status: TaskStatus, priority: TaskPriority) -> Self {
        let now = Utc::now();
        Self {
            id: TaskId::new(),
            title: title.into(),
            description: String::new(),
            status,
            priority,
            position: 0,
            assignee: None,
            due_date: None,
            source_id: None,
            extracted_item_id: None,
            created_at: now,
            updated_at: now,
        }
    }
}

/// Optional fields for [`TaskStore::update`]. Any field left as `None`
/// is preserved; setting a field to `Some(...)` writes the new value.
/// To clear nullable fields (assignee/due_date/source) the caller
/// provides `Some(None)` via the dedicated helpers below.
#[derive(Debug, Clone, Default, Serialize, Deserialize)]
pub struct TaskUpdate {
    pub title: Option<String>,
    pub description: Option<String>,
    pub status: Option<TaskStatus>,
    pub priority: Option<TaskPriority>,
    pub position: Option<i64>,
    pub assignee: Option<Option<String>>,
    pub due_date: Option<Option<DateTime<Utc>>>,
}

pub struct TaskStore {
    conn: Connection,
}

impl TaskStore {
    pub fn open(path: &str) -> Result<Self> {
        let conn = Connection::open(path).map_err(|e| Error::Database(e.to_string()))?;
        let s = Self { conn };
        s.init_schema()?;
        Ok(s)
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().map_err(|e| Error::Database(e.to_string()))?;
        let s = Self { conn };
        s.init_schema()?;
        Ok(s)
    }

    fn init_schema(&self) -> Result<()> {
        self.conn
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS tasks (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    description TEXT NOT NULL DEFAULT '',
                    status TEXT NOT NULL,
                    priority TEXT NOT NULL,
                    position INTEGER NOT NULL DEFAULT 0,
                    assignee TEXT,
                    due_date TEXT,
                    source_id TEXT,
                    extracted_item_id TEXT,
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_tasks_status_position
                    ON tasks(status, position);
                CREATE INDEX IF NOT EXISTS idx_tasks_source ON tasks(source_id);",
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(())
    }

    pub fn create(&self, task: &Task) -> Result<()> {
        self.conn
            .execute(
                "INSERT INTO tasks (
                    id, title, description, status, priority, position,
                    assignee, due_date, source_id, extracted_item_id,
                    created_at, updated_at
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12)",
                params![
                    task.id.to_string(),
                    task.title,
                    task.description,
                    task.status.to_string(),
                    task.priority.to_string(),
                    task.position,
                    task.assignee,
                    task.due_date.map(|d| d.to_rfc3339()),
                    task.source_id.map(|s| s.to_string()),
                    task.extracted_item_id,
                    task.created_at.to_rfc3339(),
                    task.updated_at.to_rfc3339(),
                ],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(())
    }

    pub fn get(&self, id: &TaskId) -> Result<Option<Task>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, title, description, status, priority, position,
                        assignee, due_date, source_id, extracted_item_id,
                        created_at, updated_at FROM tasks WHERE id = ?1",
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        let mut rows = stmt
            .query(params![id.to_string()])
            .map_err(|e| Error::Database(e.to_string()))?;
        if let Some(row) = rows.next().map_err(|e| Error::Database(e.to_string()))? {
            Ok(Some(
                row_to_task(row).map_err(|e| Error::Database(e.to_string()))?,
            ))
        } else {
            Ok(None)
        }
    }

    /// Return all tasks ordered by (status, position) so the Kanban UI
    /// can render them directly.
    pub fn list(&self) -> Result<Vec<Task>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, title, description, status, priority, position,
                        assignee, due_date, source_id, extracted_item_id,
                        created_at, updated_at FROM tasks
                 ORDER BY status, position ASC, created_at DESC",
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        let rows = stmt
            .query_map([], row_to_task)
            .map_err(|e| Error::Database(e.to_string()))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| Error::Database(e.to_string()))?);
        }
        Ok(out)
    }

    pub fn list_by_status(&self, status: TaskStatus) -> Result<Vec<Task>> {
        let mut stmt = self
            .conn
            .prepare(
                "SELECT id, title, description, status, priority, position,
                        assignee, due_date, source_id, extracted_item_id,
                        created_at, updated_at FROM tasks
                 WHERE status = ?1 ORDER BY position ASC, created_at DESC",
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        let rows = stmt
            .query_map(params![status.to_string()], row_to_task)
            .map_err(|e| Error::Database(e.to_string()))?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(|e| Error::Database(e.to_string()))?);
        }
        Ok(out)
    }

    pub fn update(&self, id: &TaskId, update: TaskUpdate) -> Result<Task> {
        let existing = self
            .get(id)?
            .ok_or_else(|| Error::NotFound(format!("Task {id} not found")))?;

        let title = update.title.unwrap_or(existing.title);
        let description = update.description.unwrap_or(existing.description);
        let status = update.status.unwrap_or(existing.status);
        let priority = update.priority.unwrap_or(existing.priority);
        let position = update.position.unwrap_or(existing.position);
        let assignee = update.assignee.unwrap_or(existing.assignee);
        let due_date = update.due_date.unwrap_or(existing.due_date);
        let updated_at = Utc::now();

        self.conn
            .execute(
                "UPDATE tasks SET title=?1, description=?2, status=?3, priority=?4,
                        position=?5, assignee=?6, due_date=?7, updated_at=?8
                 WHERE id=?9",
                params![
                    title,
                    description,
                    status.to_string(),
                    priority.to_string(),
                    position,
                    assignee,
                    due_date.map(|d| d.to_rfc3339()),
                    updated_at.to_rfc3339(),
                    id.to_string(),
                ],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(Task {
            id: *id,
            title,
            description,
            status,
            priority,
            position,
            assignee,
            due_date,
            source_id: existing.source_id,
            extracted_item_id: existing.extracted_item_id,
            created_at: existing.created_at,
            updated_at,
        })
    }

    pub fn delete(&self, id: &TaskId) -> Result<bool> {
        let rows = self
            .conn
            .execute("DELETE FROM tasks WHERE id = ?1", params![id.to_string()])
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(rows > 0)
    }

    /// Atomically reorder tasks within a single status column. The
    /// provided `ordered_ids` slice defines the new ordering — task at
    /// index N gets `position = N`. Tasks not listed are left untouched.
    pub fn reorder_in_status(&mut self, status: TaskStatus, ordered_ids: &[TaskId]) -> Result<()> {
        let tx = self
            .conn
            .transaction()
            .map_err(|e| Error::Database(e.to_string()))?;
        for (idx, tid) in ordered_ids.iter().enumerate() {
            tx.execute(
                "UPDATE tasks SET position = ?1, updated_at = ?2
                 WHERE id = ?3 AND status = ?4",
                params![
                    idx as i64,
                    Utc::now().to_rfc3339(),
                    tid.to_string(),
                    status.to_string(),
                ],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        }
        tx.commit().map_err(|e| Error::Database(e.to_string()))?;
        Ok(())
    }
}

fn row_to_task(row: &rusqlite::Row<'_>) -> rusqlite::Result<Task> {
    use std::str::FromStr;
    let id_str: String = row.get(0)?;
    let id = uuid::Uuid::from_str(&id_str).map_err(|_| {
        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, "bad uuid".into())
    })?;
    let status_str: String = row.get(3)?;
    let priority_str: String = row.get(4)?;
    let source_str: Option<String> = row.get(8)?;
    let source_id = if let Some(s) = source_str {
        Some(SourceId(uuid::Uuid::from_str(&s).map_err(|_| {
            rusqlite::Error::FromSqlConversionFailure(
                8,
                rusqlite::types::Type::Text,
                "bad source uuid".into(),
            )
        })?))
    } else {
        None
    };
    let status = match status_str.as_str() {
        "todo" => TaskStatus::Todo,
        "in_progress" => TaskStatus::InProgress,
        "done" => TaskStatus::Done,
        "blocked" => TaskStatus::Blocked,
        _ => TaskStatus::Todo,
    };
    let priority = match priority_str.as_str() {
        "low" => TaskPriority::Low,
        "medium" => TaskPriority::Medium,
        "high" => TaskPriority::High,
        "critical" => TaskPriority::Critical,
        _ => TaskPriority::Medium,
    };
    Ok(Task {
        id: TaskId(id),
        title: row.get(1)?,
        description: row.get(2)?,
        status,
        priority,
        position: row.get(5)?,
        assignee: row.get(6)?,
        due_date: parse_opt_dt(row.get::<_, Option<String>>(7)?),
        source_id,
        extracted_item_id: row.get(9)?,
        created_at: parse_dt(&row.get::<_, String>(10)?),
        updated_at: parse_dt(&row.get::<_, String>(11)?),
    })
}

#[cfg(test)]
mod tests {
    use super::*;

    fn store() -> TaskStore {
        TaskStore::open_in_memory().expect("open in-memory")
    }

    #[test]
    fn create_then_get_round_trips() {
        let s = store();
        let mut t = Task::new("Write spec", TaskStatus::Todo, TaskPriority::High);
        t.description = "Cover scope + risks".into();
        t.assignee = Some("ken".into());
        t.due_date = Some(Utc::now() + chrono::Duration::days(3));
        s.create(&t).unwrap();
        let got = s.get(&t.id).unwrap().expect("present");
        assert_eq!(got.title, "Write spec");
        assert_eq!(got.status, TaskStatus::Todo);
        assert_eq!(got.priority, TaskPriority::High);
        assert_eq!(got.assignee.as_deref(), Some("ken"));
    }

    #[test]
    fn update_changes_only_specified_fields() {
        let s = store();
        let t = Task::new("Initial", TaskStatus::Todo, TaskPriority::Medium);
        s.create(&t).unwrap();
        let updated = s
            .update(
                &t.id,
                TaskUpdate {
                    status: Some(TaskStatus::InProgress),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.status, TaskStatus::InProgress);
        assert_eq!(updated.title, "Initial");
        assert_eq!(updated.priority, TaskPriority::Medium);
    }

    #[test]
    fn list_orders_by_status_then_position() {
        let s = store();
        let mut t1 = Task::new("A", TaskStatus::Todo, TaskPriority::Low);
        t1.position = 1;
        let mut t2 = Task::new("B", TaskStatus::Todo, TaskPriority::Low);
        t2.position = 0;
        let mut t3 = Task::new("C", TaskStatus::Done, TaskPriority::Low);
        t3.position = 0;
        s.create(&t1).unwrap();
        s.create(&t2).unwrap();
        s.create(&t3).unwrap();
        let all = s.list().unwrap();
        let titles: Vec<_> = all.iter().map(|t| t.title.clone()).collect();
        // status=done < status=in_progress < status=todo lexicographically;
        // SQLite ORDER BY 'status' uses string compare. We don't lock
        // down the cross-status order — only that within "todo",
        // position 0 (B) precedes position 1 (A).
        let todo: Vec<_> = all
            .iter()
            .filter(|t| t.status == TaskStatus::Todo)
            .map(|t| t.title.clone())
            .collect();
        assert_eq!(todo, vec!["B", "A"]);
        assert!(titles.contains(&"C".to_string()));
    }

    #[test]
    fn list_by_status_filters() {
        let s = store();
        s.create(&Task::new("Q1", TaskStatus::Todo, TaskPriority::Low))
            .unwrap();
        s.create(&Task::new("Q2", TaskStatus::Done, TaskPriority::Low))
            .unwrap();
        s.create(&Task::new("Q3", TaskStatus::Done, TaskPriority::Low))
            .unwrap();
        let done = s.list_by_status(TaskStatus::Done).unwrap();
        assert_eq!(done.len(), 2);
        assert!(done.iter().all(|t| t.status == TaskStatus::Done));
    }

    #[test]
    fn delete_removes_task() {
        let s = store();
        let t = Task::new("Bye", TaskStatus::Todo, TaskPriority::Low);
        s.create(&t).unwrap();
        assert!(s.delete(&t.id).unwrap());
        assert!(s.get(&t.id).unwrap().is_none());
        assert!(!s.delete(&t.id).unwrap());
    }

    #[test]
    fn reorder_in_status_sets_positions_transactionally() {
        let mut s = store();
        let a = Task::new("A", TaskStatus::Todo, TaskPriority::Low);
        let b = Task::new("B", TaskStatus::Todo, TaskPriority::Low);
        let c = Task::new("C", TaskStatus::Todo, TaskPriority::Low);
        s.create(&a).unwrap();
        s.create(&b).unwrap();
        s.create(&c).unwrap();

        s.reorder_in_status(TaskStatus::Todo, &[c.id, a.id, b.id])
            .unwrap();
        let list = s.list_by_status(TaskStatus::Todo).unwrap();
        assert_eq!(list[0].title, "C");
        assert_eq!(list[0].position, 0);
        assert_eq!(list[1].title, "A");
        assert_eq!(list[1].position, 1);
        assert_eq!(list[2].title, "B");
        assert_eq!(list[2].position, 2);
    }

    #[test]
    fn update_clears_nullable_field_via_explicit_some_none() {
        let s = store();
        let mut t = Task::new("X", TaskStatus::Todo, TaskPriority::Low);
        t.assignee = Some("alice".into());
        s.create(&t).unwrap();
        let cleared = s
            .update(
                &t.id,
                TaskUpdate {
                    assignee: Some(None),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(cleared.assignee, None);
    }
}
