//! Tasks store and operations.
//!
//! Tasks are first-class persistent objects with status, priority,
//! source linkage, assignee, due date, and ordering. They are stored
//! in the same SQLite database as artifacts; the schema is initialised
//! lazily on the first `TaskStore::open` call.
//!
//! Tasks can be created manually or extracted from source material via
//! `tessera_artifacts::extraction`. The `source_id` and
//! `extracted_item_id` fields preserve provenance so the UI can render
//! "open the source" affordances.

use chrono::{DateTime, Utc};
use rusqlite::{params, OptionalExtension};
use serde::{Deserialize, Serialize};
use tessera_core::error::{Error, Result};
use tessera_core::types::{SourceId, TaskId, TaskPriority, TaskStatus};
use tessera_core::{open_shared, open_shared_in_memory, with_secure_delete, SharedConnection};

/// Parse an RFC 3339 timestamp from a SQLite row, surfacing corruption as
/// a `rusqlite::Error` instead of silently substituting the current time.
/// The stores always write `to_rfc3339()` so any failure here indicates
/// the database was edited externally or otherwise corrupted.
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
/// A unit of work on the task board, optionally linked to the source
/// material it was extracted from and to other tasks it depends on.
pub struct Task {
    /// Stable unique identity of the task.
    pub id: TaskId,
    /// Short task title shown on the board card.
    pub title: String,
    #[serde(default)]
    /// Longer free-form description; empty when unset.
    pub description: String,
    /// Lifecycle/board column the task sits in.
    pub status: TaskStatus,
    /// Relative importance, used for sorting and styling.
    pub priority: TaskPriority,
    /// User-controlled ordering within the same status column.
    pub position: i64,
    #[serde(default)]
    /// Person responsible for the task, if assigned.
    pub assignee: Option<String>,
    #[serde(default)]
    /// Optional deadline, in UTC.
    pub due_date: Option<DateTime<Utc>>,
    /// Optional source provenance — set when the task was extracted
    /// from indexed source material.
    #[serde(default)]
    pub source_id: Option<SourceId>,
    /// Optional pointer to the originating `ExtractedItem` so the
    /// UI can re-open the extraction context.
    #[serde(default)]
    pub extracted_item_id: Option<String>,
    /// Ids of tasks this task depends on (must complete first). The
    /// set forms a directed dependency graph used by the Gantt view
    /// and by [`topological_sort`] to detect and reject cycles.
    /// Edges that point at unknown task ids are tolerated (they are
    /// simply ignored for ordering) so a dependency on a not-yet-
    /// created or already-deleted task never wedges the board.
    #[serde(default)]
    pub depends_on: Vec<TaskId>,
    /// When the task was created, in UTC.
    pub created_at: DateTime<Utc>,
    /// When the task was last modified, in UTC.
    pub updated_at: DateTime<Utc>,
}

impl Task {
    /// Creates a task with the given title/status/priority, a fresh
    /// id, empty optional fields, `position` 0, and both timestamps
    /// stamped to now.
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
            depends_on: Vec::new(),
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
    /// New title, or `None` to keep the existing one.
    pub title: Option<String>,
    /// New description, or `None` to keep the existing one.
    pub description: Option<String>,
    /// New status, or `None` to keep the existing one.
    pub status: Option<TaskStatus>,
    /// New priority, or `None` to keep the existing one.
    pub priority: Option<TaskPriority>,
    /// New board position, or `None` to keep the existing one.
    pub position: Option<i64>,
    /// Assignee change: `None` preserves it, `Some(None)` clears it,
    /// `Some(Some(name))` sets it.
    pub assignee: Option<Option<String>>,
    /// Due-date change with the same `Some(None)`-clears convention as
    /// `assignee`.
    pub due_date: Option<Option<DateTime<Utc>>>,
    /// Replace the dependency set. `None` preserves the existing
    /// edges; `Some(vec)` overwrites them (pass an empty vec to clear
    /// all dependencies). A set that would introduce a cycle is
    /// rejected by [`TaskStore::update`].
    pub depends_on: Option<Vec<TaskId>>,
}

/// SQLite-backed persistence for [`Task`]s and their dependency
/// edges.
pub struct TaskStore {
    conn: SharedConnection,
}

impl TaskStore {
    /// Opens (creating if needed) the task database at `path`.
    pub fn open(path: &str) -> Result<Self> {
        Self::with_shared_conn(open_shared(path)?)
    }

    /// Opens an ephemeral in-memory task database (for tests).
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
        let conn = self.conn.lock().expect("connection mutex poisoned");
        conn.execute_batch(
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
        .map_err(Error::Sqlite)?;

        // Forward-only `depends_on` migration. Databases created by
        // earlier Tessera builds have a `tasks` table WITHOUT the
        // `depends_on` column; the CREATE TABLE above is a no-op
        // against them. SQLite has no `ADD COLUMN IF NOT EXISTS`, so
        // we make this idempotent by querying `pragma_table_info`
        // FIRST and only issuing the ALTER when the column is absent —
        // the same structurally-robust pattern used in
        // `tessera_sources::store`. The column stores a JSON array of
        // task-id strings; legacy rows read as NULL and are
        // interpreted as "no dependencies".
        let has_depends_on: bool = conn
            .query_row(
                "SELECT 1 FROM pragma_table_info('tasks') WHERE name = ?1",
                params!["depends_on"],
                |_| Ok(()),
            )
            .optional()
            .map_err(|e| Error::DatabaseState(format!("table_info(tasks): {e}")))?
            .is_some();
        if !has_depends_on {
            conn.execute("ALTER TABLE tasks ADD COLUMN depends_on TEXT", [])
                .map_err(|e| {
                    Error::DatabaseState(format!("failed to add tasks.depends_on: {e}"))
                })?;
        }
        Ok(())
    }

    /// Inserts a new task row.
    pub fn create(&self, task: &Task) -> Result<()> {
        // Reject a create whose dependency edges would close a cycle
        // with the tasks already in the store. Validated BEFORE the
        // INSERT so a rejected create leaves the table untouched.
        self.ensure_acyclic_with(task)?;
        let depends_on_json = encode_depends_on(&task.depends_on)?;
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .execute(
                "INSERT INTO tasks (
                    id, title, description, status, priority, position,
                    assignee, due_date, source_id, extracted_item_id,
                    depends_on, created_at, updated_at
                ) VALUES (?1,?2,?3,?4,?5,?6,?7,?8,?9,?10,?11,?12,?13)",
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
                    depends_on_json,
                    task.created_at.to_rfc3339(),
                    task.updated_at.to_rfc3339(),
                ],
            )
            .map_err(Error::Sqlite)?;
        Ok(())
    }

    /// Validate that adding/replacing `candidate` in the store would
    /// keep the dependency graph acyclic. Builds the post-operation
    /// task set (every existing task, with `candidate` substituted for
    /// any same-id row or appended if new) and runs
    /// [`topological_sort`], surfacing its cycle error verbatim.
    fn ensure_acyclic_with(&self, candidate: &Task) -> Result<()> {
        // Fast path: a task with no declared dependencies can never be
        // the edge that introduces a cycle, so skip the full-table
        // load entirely. (An existing task that *other* tasks depend
        // on still can't form a cycle by losing its own out-edges.)
        if candidate.depends_on.is_empty() {
            return Ok(());
        }
        let mut tasks = self.list()?;
        if let Some(existing) = tasks.iter_mut().find(|t| t.id == candidate.id) {
            existing.depends_on.clone_from(&candidate.depends_on);
        } else {
            tasks.push(candidate.clone());
        }
        topological_sort(&tasks).map(|_| ())
    }

    /// Fetches a single task by id, or `None` if absent.
    pub fn get(&self, id: &TaskId) -> Result<Option<Task>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT id, title, description, status, priority, position,
                        assignee, due_date, source_id, extracted_item_id,
                        depends_on, created_at, updated_at FROM tasks WHERE id = ?1",
            )
            .map_err(Error::Sqlite)?;
        let mut rows = stmt.query(params![id.to_string()]).map_err(Error::Sqlite)?;
        if let Some(row) = rows.next().map_err(Error::Sqlite)? {
            Ok(Some(row_to_task(row).map_err(Error::Sqlite)?))
        } else {
            Ok(None)
        }
    }

    /// Return all tasks ordered by (status, position) so the Kanban UI
    /// can render them directly.
    pub fn list(&self) -> Result<Vec<Task>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT id, title, description, status, priority, position,
                        assignee, due_date, source_id, extracted_item_id,
                        depends_on, created_at, updated_at FROM tasks
                 ORDER BY status, position ASC, created_at DESC",
            )
            .map_err(Error::Sqlite)?;
        let rows = stmt.query_map([], row_to_task).map_err(Error::Sqlite)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(Error::Sqlite)?);
        }
        Ok(out)
    }

    /// Returns the tasks in `status`, ordered by their board
    /// `position`.
    pub fn list_by_status(&self, status: TaskStatus) -> Result<Vec<Task>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT id, title, description, status, priority, position,
                        assignee, due_date, source_id, extracted_item_id,
                        depends_on, created_at, updated_at FROM tasks
                 WHERE status = ?1 ORDER BY position ASC, created_at DESC",
            )
            .map_err(Error::Sqlite)?;
        let rows = stmt
            .query_map(params![status.to_string()], row_to_task)
            .map_err(Error::Sqlite)?;
        let mut out = Vec::new();
        for r in rows {
            out.push(r.map_err(Error::Sqlite)?);
        }
        Ok(out)
    }

    /// Applies a partial [`TaskUpdate`] to the task, touching
    /// `updated_at`, and returns the updated task. Rejects a
    /// `depends_on` change that would introduce a dependency cycle.
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
        let depends_on = update.depends_on.unwrap_or(existing.depends_on);
        let updated_at = Utc::now();

        // Reject an update whose new dependency set would introduce a
        // cycle, BEFORE writing, so a rejected update is a no-op. We
        // build a candidate carrying the post-update edges and validate
        // the whole graph.
        let candidate = Task {
            id: *id,
            depends_on: depends_on.clone(),
            ..Task::new(title.clone(), status, priority)
        };
        self.ensure_acyclic_with(&candidate)?;
        let depends_on_json = encode_depends_on(&depends_on)?;

        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .execute(
                "UPDATE tasks SET title=?1, description=?2, status=?3, priority=?4,
                        position=?5, assignee=?6, due_date=?7, depends_on=?8, updated_at=?9
                 WHERE id=?10",
                params![
                    title,
                    description,
                    status.to_string(),
                    priority.to_string(),
                    position,
                    assignee,
                    due_date.map(|d| d.to_rfc3339()),
                    depends_on_json,
                    updated_at.to_rfc3339(),
                    id.to_string(),
                ],
            )
            .map_err(Error::Sqlite)?;
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
            depends_on,
            created_at: existing.created_at,
            updated_at,
        })
    }

    /// Deletes the task `id`, returning whether a row was removed.
    pub fn delete(&self, id: &TaskId) -> Result<bool> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        // Zero-fill the freed page so the deleted task (title, notes,
        // assignee) is unrecoverable from the freelist.
        let rows = with_secure_delete(&conn, |conn| {
            conn.execute("DELETE FROM tasks WHERE id = ?1", params![id.to_string()])
                .map_err(Error::Sqlite)
        })?;
        Ok(rows > 0)
    }

    /// Atomically reorder tasks within a single status column. The
    /// provided `ordered_ids` slice defines the new ordering — task at
    /// index N gets `position = N`. Tasks not listed are left untouched.
    ///
    /// Takes `&self` (not `&mut self`) now that the underlying
    /// `Connection` lives behind an `Arc<Mutex<_>>`; the transaction is
    /// held under the same mutex guard as every other store operation,
    /// so write-serialisation is unchanged.
    pub fn reorder_in_status(&self, status: TaskStatus, ordered_ids: &[TaskId]) -> Result<()> {
        let mut conn = self.conn.lock().expect("connection mutex poisoned");
        let tx = conn.transaction().map_err(Error::Sqlite)?;
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
            .map_err(Error::Sqlite)?;
        }
        tx.commit().map_err(Error::Sqlite)?;
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
    // Unknown enum values from SQLite indicate either DB corruption or a
    // schema migration mismatch — surface them as a typed error rather
    // than silently coercing to a default which would mask bugs and
    // could re-bucket "blocked" tasks as "todo" on the kanban board.
    let status = match status_str.as_str() {
        "todo" => TaskStatus::Todo,
        "in_progress" => TaskStatus::InProgress,
        "done" => TaskStatus::Done,
        "blocked" => TaskStatus::Blocked,
        other => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                3,
                rusqlite::types::Type::Text,
                format!("unknown task status `{other}`").into(),
            ));
        }
    };
    let priority = match priority_str.as_str() {
        "low" => TaskPriority::Low,
        "medium" => TaskPriority::Medium,
        "high" => TaskPriority::High,
        "critical" => TaskPriority::Critical,
        other => {
            return Err(rusqlite::Error::FromSqlConversionFailure(
                4,
                rusqlite::types::Type::Text,
                format!("unknown task priority `{other}`").into(),
            ));
        }
    };
    Ok(Task {
        id: TaskId(id),
        title: row.get(1)?,
        description: row.get(2)?,
        status,
        priority,
        position: row.get(5)?,
        assignee: row.get(6)?,
        due_date: parse_opt_dt(row.get::<_, Option<String>>(7)?, 7)?,
        source_id,
        extracted_item_id: row.get(9)?,
        depends_on: decode_depends_on(row.get::<_, Option<String>>(10)?, 10)?,
        created_at: parse_dt(&row.get::<_, String>(11)?, 11)?,
        updated_at: parse_dt(&row.get::<_, String>(12)?, 12)?,
    })
}

/// Serialize a dependency set to the JSON-array text stored in the
/// `tasks.depends_on` column. An empty set is stored as `NULL` (via the
/// `None` returned here) so legacy rows and dependency-free tasks share
/// the same on-disk representation.
fn encode_depends_on(depends_on: &[TaskId]) -> Result<Option<String>> {
    if depends_on.is_empty() {
        return Ok(None);
    }
    serde_json::to_string(depends_on)
        .map(Some)
        .map_err(|e| Error::DatabaseState(format!("failed to encode depends_on: {e}")))
}

/// Parse the JSON-array text from the `tasks.depends_on` column back
/// into a dependency set. `NULL` (legacy rows / no dependencies) and
/// an empty/whitespace-only string both decode to an empty vec.
fn decode_depends_on(raw: Option<String>, col: usize) -> rusqlite::Result<Vec<TaskId>> {
    match raw {
        None => Ok(Vec::new()),
        Some(s) if s.trim().is_empty() => Ok(Vec::new()),
        Some(s) => serde_json::from_str::<Vec<TaskId>>(&s).map_err(|e| {
            rusqlite::Error::FromSqlConversionFailure(
                col,
                rusqlite::types::Type::Text,
                format!("bad depends_on JSON: {e}").into(),
            )
        }),
    }
}

/// Compute a dependency-respecting (topological) ordering of `tasks`,
/// returning [`Error::InvalidConfig`] if the `depends_on` edges contain
/// a cycle. A returned id always appears AFTER every task it depends on
/// (that is also present in `tasks`).
///
/// Implemented with Kahn's algorithm. Edges whose target id is not in
/// `tasks` are ignored for ordering (see [`Task::depends_on`]); a task
/// that lists itself as a dependency is therefore a 1-cycle and is
/// rejected. The output ordering is deterministic for a given input:
/// ties (independent tasks) are broken by ascending id string so the
/// Gantt view renders stably across reloads.
pub fn topological_sort(tasks: &[Task]) -> Result<Vec<TaskId>> {
    use std::collections::{BTreeMap, HashMap, HashSet};

    let present: HashSet<TaskId> = tasks.iter().map(|t| t.id).collect();
    // `remaining_deps`: unresolved in-set dependency count per task.
    // `dependents`: reverse edges (dependency -> tasks that need it).
    let mut remaining_deps: HashMap<TaskId, usize> = HashMap::new();
    let mut dependents: HashMap<TaskId, Vec<TaskId>> = HashMap::new();
    for t in tasks {
        remaining_deps.entry(t.id).or_insert(0);
        for dep in &t.depends_on {
            if present.contains(dep) {
                *remaining_deps.entry(t.id).or_insert(0) += 1;
                dependents.entry(*dep).or_default().push(t.id);
            }
        }
    }

    // Seed the ready frontier with every task that has no unresolved
    // dependency. `TaskId` is not `Ord`, so we key the frontier by id
    // string in a `BTreeMap` — that keeps it sorted (and the output
    // deterministic) regardless of HashMap iteration order.
    let mut ready: BTreeMap<String, TaskId> = remaining_deps
        .iter()
        .filter(|(_, &d)| d == 0)
        .map(|(&id, _)| (id.to_string(), id))
        .collect();

    let mut order = Vec::with_capacity(tasks.len());
    while let Some((key, id)) = ready.iter().next().map(|(k, &v)| (k.clone(), v)) {
        ready.remove(&key);
        order.push(id);
        if let Some(children) = dependents.get(&id) {
            for &child in children {
                let count = remaining_deps
                    .get_mut(&child)
                    .expect("dependent recorded in remaining_deps");
                *count -= 1;
                if *count == 0 {
                    ready.insert(child.to_string(), child);
                }
            }
        }
    }

    if order.len() != present.len() {
        let mut cyclic: Vec<String> = remaining_deps
            .iter()
            .filter(|(_, &d)| d > 0)
            .map(|(id, _)| id.to_string())
            .collect();
        cyclic.sort();
        return Err(Error::InvalidConfig(format!(
            "task dependency cycle detected involving: {}",
            cyclic.join(", ")
        )));
    }
    Ok(order)
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
        let s = store();
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

    #[test]
    fn task_store_shares_database_with_clone() {
        // Two stores built on the same SharedConnection see the same
        // rows. Mirrors `audit_store_shares_database_with_clone` so the
        // shared-connection refactor is exercised per-crate.
        let conn = tessera_core::open_shared_in_memory().unwrap();
        let a = TaskStore::with_shared_conn(conn.clone()).unwrap();
        let b = TaskStore::with_shared_conn(conn).unwrap();
        let t = Task::new("Shared task", TaskStatus::Todo, TaskPriority::Medium);
        a.create(&t).unwrap();
        let loaded = b.get(&t.id).unwrap().expect("task visible via clone");
        assert_eq!(loaded.title, "Shared task");
    }

    fn task_with_deps(title: &str, deps: Vec<TaskId>) -> Task {
        let mut t = Task::new(title, TaskStatus::Todo, TaskPriority::Medium);
        t.depends_on = deps;
        t
    }

    #[test]
    fn depends_on_round_trips_through_store() {
        let s = store();
        let a = Task::new("A", TaskStatus::Todo, TaskPriority::Low);
        let b = Task::new("B", TaskStatus::Todo, TaskPriority::Low);
        s.create(&a).unwrap();
        s.create(&b).unwrap();
        let c = task_with_deps("C", vec![a.id, b.id]);
        s.create(&c).unwrap();

        let loaded = s.get(&c.id).unwrap().expect("present");
        assert_eq!(loaded.depends_on, vec![a.id, b.id]);

        // A dependency-free task stores NULL and decodes to an empty vec.
        let loaded_a = s.get(&a.id).unwrap().expect("present");
        assert!(loaded_a.depends_on.is_empty());
    }

    #[test]
    fn update_replaces_and_clears_depends_on() {
        let s = store();
        let a = Task::new("A", TaskStatus::Todo, TaskPriority::Low);
        let b = Task::new("B", TaskStatus::Todo, TaskPriority::Low);
        s.create(&a).unwrap();
        s.create(&b).unwrap();
        let c = task_with_deps("C", vec![a.id]);
        s.create(&c).unwrap();

        // Replace the dependency set.
        let updated = s
            .update(
                &c.id,
                TaskUpdate {
                    depends_on: Some(vec![b.id]),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(updated.depends_on, vec![b.id]);
        assert_eq!(s.get(&c.id).unwrap().unwrap().depends_on, vec![b.id]);

        // `None` preserves the edges; `Some(vec![])` clears them.
        let untouched = s
            .update(
                &c.id,
                TaskUpdate {
                    title: Some("C2".into()),
                    ..Default::default()
                },
            )
            .unwrap();
        assert_eq!(untouched.depends_on, vec![b.id]);
        let cleared = s
            .update(
                &c.id,
                TaskUpdate {
                    depends_on: Some(vec![]),
                    ..Default::default()
                },
            )
            .unwrap();
        assert!(cleared.depends_on.is_empty());
    }

    #[test]
    fn topological_sort_accepts_dag_and_orders_deps_first() {
        // a <- b <- c  and  a <- d  (b,d depend on a; c depends on b)
        let a = Task::new("a", TaskStatus::Todo, TaskPriority::Low);
        let b = task_with_deps("b", vec![a.id]);
        let c = task_with_deps("c", vec![b.id]);
        let d = task_with_deps("d", vec![a.id]);
        let tasks = vec![c.clone(), d.clone(), b.clone(), a.clone()];

        let order = topological_sort(&tasks).expect("DAG accepted");
        assert_eq!(order.len(), 4);
        let pos = |id: TaskId| order.iter().position(|&o| o == id).unwrap();
        // Every dependency must come before its dependent.
        assert!(pos(a.id) < pos(b.id));
        assert!(pos(b.id) < pos(c.id));
        assert!(pos(a.id) < pos(d.id));
    }

    #[test]
    fn topological_sort_rejects_cycle() {
        // a -> b -> c -> a
        let mut a = Task::new("a", TaskStatus::Todo, TaskPriority::Low);
        let mut b = Task::new("b", TaskStatus::Todo, TaskPriority::Low);
        let mut c = Task::new("c", TaskStatus::Todo, TaskPriority::Low);
        a.depends_on = vec![c.id];
        b.depends_on = vec![a.id];
        c.depends_on = vec![b.id];
        let err = topological_sort(&[a, b, c]).expect_err("cycle must be rejected");
        assert!(
            format!("{err}").contains("cycle"),
            "unexpected error: {err}"
        );
    }

    #[test]
    fn topological_sort_rejects_self_dependency() {
        let mut a = Task::new("a", TaskStatus::Todo, TaskPriority::Low);
        a.depends_on = vec![a.id];
        let err = topological_sort(&[a]).expect_err("self-cycle must be rejected");
        assert!(format!("{err}").contains("cycle"));
    }

    #[test]
    fn topological_sort_ignores_unknown_dependency_ids() {
        // Depending on an id that isn't in the set is tolerated (the
        // edge is dropped) so a dangling dependency never looks like a
        // cycle.
        let dangling = TaskId::new();
        let a = task_with_deps("a", vec![dangling]);
        let order = topological_sort(&[a.clone()]).expect("dangling dep tolerated");
        assert_eq!(order, vec![a.id]);
    }

    #[test]
    fn create_rejects_dependency_cycle() {
        let s = store();
        let a = Task::new("A", TaskStatus::Todo, TaskPriority::Low);
        let b = task_with_deps("B", vec![a.id]);
        s.create(&a).unwrap();
        s.create(&b).unwrap();
        // Making A depend on B closes the cycle A -> B -> A.
        let err = s
            .update(
                &a.id,
                TaskUpdate {
                    depends_on: Some(vec![b.id]),
                    ..Default::default()
                },
            )
            .expect_err("cycle-closing update must be rejected");
        assert!(format!("{err}").contains("cycle"));
        // The rejected update must be a no-op: A still has no deps.
        assert!(s.get(&a.id).unwrap().unwrap().depends_on.is_empty());
    }

    #[test]
    fn create_accepts_valid_dag() {
        let s = store();
        let a = Task::new("A", TaskStatus::Todo, TaskPriority::Low);
        s.create(&a).unwrap();
        let b = task_with_deps("B", vec![a.id]);
        // A valid DAG edge is accepted on create.
        s.create(&b).expect("DAG create accepted");
        assert_eq!(s.get(&b.id).unwrap().unwrap().depends_on, vec![a.id]);
    }
}
