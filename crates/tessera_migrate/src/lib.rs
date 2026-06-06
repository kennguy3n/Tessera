//! Versioned, forward-only SQL migration runner for Tessera's SQLite
//! stores.
//!
//! Migrations are numbered `.sql` files under `migrations/` that are
//! embedded into the binary at compile time (so there is no runtime
//! file IO and the set is identical on every platform). Applied
//! versions are tracked in a `_migrations` bookkeeping table
//! (`version`, `name`, `applied_at`, `checksum`); pending migrations
//! are applied in version order inside a single transaction and one
//! row is recorded per migration on success. Re-running is a no-op.
//!
//! # Idempotent column-adds
//!
//! SQLite has no `ALTER TABLE ... ADD COLUMN IF NOT EXISTS`, but a
//! database created by an older Tessera build may already carry a
//! column that a later migration adds (the legacy `init_schema` added
//! some columns both via `CREATE TABLE` and via idempotent `ALTER`).
//! To reproduce that behaviour exactly, the runner detects
//! `ALTER TABLE <t> ADD COLUMN <c> ...` statements and skips any whose
//! column already exists (checked structurally via `PRAGMA
//! table_info`), rather than matching a rusqlite error string. This is
//! the same structurally-robust approach the legacy code used, lifted
//! into the runner so it applies uniformly.
//!
//! # Rollback
//!
//! Tessera migrations are forward-only in production. The runner still
//! supports an optional `<name>.down.sql` companion per migration and a
//! [`Migrator::rollback_last`] entry point so the mechanism exists for
//! future use; today it is exercised only by tests.

use std::collections::HashMap;

use rusqlite::{params, Connection};
use tessera_core::error::{Error, Result};

/// A single migration: a forward (`up`) script and an optional
/// backward (`down`) stub.
#[derive(Debug, Clone, Copy)]
pub struct Migration {
    /// Monotonically increasing version. Used as the `_migrations`
    /// primary key and to order application.
    pub version: i64,
    /// Short human-readable name (the file's slug).
    pub name: &'static str,
    /// Forward SQL applied when the migration is pending.
    pub up: &'static str,
    /// Optional rollback SQL. `None` when no `.down.sql` companion
    /// exists (the common, forward-only case).
    pub down: Option<&'static str>,
}

impl Migration {
    /// Content checksum of the `up` script, recorded in `_migrations`
    /// so a later run can detect a migration file that was edited after
    /// it was applied (schema drift).
    pub fn checksum(&self) -> String {
        blake3::hash(self.up.as_bytes()).to_hex().to_string()
    }
}

/// The embedded, ordered migration set for Tessera's source store.
///
/// Ported 1:1 from the legacy ad-hoc `SourceStore::init_schema`:
/// `0001` is the base `CREATE TABLE`/index/trigger batch, `0002`-`0004`
/// are the idempotent column-add blocks, and `0005` is the secondary
/// indexes created after the column-adds.
static MIGRATIONS: &[Migration] = &[
    Migration {
        version: 1,
        name: "initial_schema",
        up: include_str!("../migrations/0001_initial_schema.sql"),
        down: None,
    },
    Migration {
        version: 2,
        name: "chunks_extraction_columns",
        up: include_str!("../migrations/0002_chunks_extraction_columns.sql"),
        down: None,
    },
    Migration {
        version: 3,
        name: "chunks_aead_columns",
        up: include_str!("../migrations/0003_chunks_aead_columns.sql"),
        down: None,
    },
    Migration {
        version: 4,
        name: "sources_sync_columns",
        up: include_str!("../migrations/0004_sources_sync_columns.sql"),
        down: None,
    },
    Migration {
        version: 5,
        name: "secondary_indexes",
        up: include_str!("../migrations/0005_secondary_indexes.sql"),
        down: Some(include_str!(
            "../migrations/0005_secondary_indexes.down.sql"
        )),
    },
];

/// Borrow the embedded migration set.
pub fn migrations() -> &'static [Migration] {
    MIGRATIONS
}

/// Summary of a single [`Migrator::run`].
#[derive(Debug, Default, Clone)]
pub struct MigrationReport {
    /// Versions applied (or recorded) during this run, in order.
    pub applied: Vec<i64>,
    /// Versions that were already present in `_migrations` and skipped.
    pub already_applied: Vec<i64>,
}

/// Runs an ordered slice of [`Migration`]s against a connection.
pub struct Migrator<'a> {
    migrations: &'a [Migration],
}

impl Default for Migrator<'static> {
    fn default() -> Self {
        Self {
            migrations: MIGRATIONS,
        }
    }
}

impl Migrator<'static> {
    /// Build a migrator over the embedded Tessera migration set.
    pub fn new() -> Self {
        Self::default()
    }
}

impl<'a> Migrator<'a> {
    /// Build a migrator over a caller-supplied migration slice. Used by
    /// tests to exercise partial-upgrade paths.
    pub fn with_migrations(migrations: &'a [Migration]) -> Self {
        Self { migrations }
    }

    /// Apply every pending migration in version order inside one
    /// transaction, recording each in `_migrations`. Idempotent:
    /// migrations already recorded are skipped, so a second run applies
    /// nothing.
    pub fn run(&self, conn: &mut Connection) -> Result<MigrationReport> {
        conn.execute_batch(
            "CREATE TABLE IF NOT EXISTS _migrations (
                version    INTEGER PRIMARY KEY,
                name       TEXT NOT NULL,
                applied_at TEXT NOT NULL,
                checksum   TEXT NOT NULL
            );",
        )?;

        let applied = load_applied(conn)?;

        let mut report = MigrationReport::default();
        let tx = conn.transaction()?;
        for migration in self.migrations {
            if let Some(recorded_checksum) = applied.get(&migration.version) {
                let current = migration.checksum();
                if recorded_checksum != &current {
                    return Err(Error::DatabaseState(format!(
                        "migration {} ({}) checksum drift: recorded {}, embedded {} — a migration file was edited after it was applied",
                        migration.version, migration.name, recorded_checksum, current
                    )));
                }
                report.already_applied.push(migration.version);
                continue;
            }
            apply_up(&tx, migration)?;
            tx.execute(
                "INSERT INTO _migrations (version, name, applied_at, checksum)
                 VALUES (?1, ?2, ?3, ?4)",
                params![
                    migration.version,
                    migration.name,
                    chrono::Utc::now().to_rfc3339(),
                    migration.checksum(),
                ],
            )?;
            report.applied.push(migration.version);
        }
        tx.commit()?;
        Ok(report)
    }

    /// Roll back the highest-versioned applied migration that has a
    /// `down` script, removing its `_migrations` row. Returns the
    /// version rolled back, or `None` when nothing in the set is
    /// applied. This is the (intentionally minimal) rollback stub — it
    /// is not used by production code paths.
    pub fn rollback_last(&self, conn: &mut Connection) -> Result<Option<i64>> {
        let applied = load_applied(conn)?;
        let Some(migration) = self
            .migrations
            .iter()
            .rev()
            .find(|m| applied.contains_key(&m.version))
        else {
            return Ok(None);
        };

        let tx = conn.transaction()?;
        if let Some(down) = migration.down {
            tx.execute_batch(down)?;
        }
        tx.execute(
            "DELETE FROM _migrations WHERE version = ?1",
            params![migration.version],
        )?;
        tx.commit()?;
        Ok(Some(migration.version))
    }
}

/// Load the `(version -> checksum)` map of already-applied migrations.
fn load_applied(conn: &Connection) -> Result<HashMap<i64, String>> {
    let mut stmt = conn.prepare("SELECT version, checksum FROM _migrations")?;
    let rows = stmt.query_map([], |row| {
        Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
    })?;
    let mut applied = HashMap::new();
    for row in rows {
        let (version, checksum) = row?;
        applied.insert(version, checksum);
    }
    Ok(applied)
}

/// Apply a migration's forward SQL. Migrations that contain
/// `ADD COLUMN` are applied statement-by-statement so the column-add
/// can be skipped when the column already exists; everything else
/// (including the `0001` batch with its multi-statement triggers) is
/// applied via `execute_batch`.
fn apply_up(conn: &Connection, migration: &Migration) -> Result<()> {
    if contains_add_column(migration.up) {
        apply_statements_idempotently(conn, migration.up)
    } else {
        conn.execute_batch(migration.up)?;
        Ok(())
    }
}

/// Case-insensitive probe for an `ADD COLUMN` clause.
fn contains_add_column(sql: &str) -> bool {
    sql.to_ascii_uppercase().contains("ADD COLUMN")
}

/// Apply each `;`-separated statement, skipping `ALTER TABLE ... ADD
/// COLUMN` statements whose target column already exists.
fn apply_statements_idempotently(conn: &Connection, sql: &str) -> Result<()> {
    let cleaned = strip_line_comments(sql);
    for raw in cleaned.split(';') {
        let statement = raw.trim();
        if statement.is_empty() {
            continue;
        }
        if let Some((table, column)) = parse_add_column(statement) {
            if column_exists(conn, &table, &column)? {
                continue;
            }
        }
        conn.execute(statement, [])?;
    }
    Ok(())
}

/// Strip `--` line comments so statement splitting and `ADD COLUMN`
/// parsing are not confused by commentary. Tessera's column-add
/// migrations contain no string literals with `--`, so this is safe.
fn strip_line_comments(sql: &str) -> String {
    sql.lines()
        .map(|line| match line.find("--") {
            Some(idx) => &line[..idx],
            None => line,
        })
        .collect::<Vec<_>>()
        .join("\n")
}

/// Parse `ALTER TABLE <table> ADD COLUMN <column> ...`, returning the
/// `(table, column)` names, or `None` if the statement is not an
/// add-column.
fn parse_add_column(statement: &str) -> Option<(String, String)> {
    let tokens: Vec<&str> = statement.split_whitespace().collect();
    let upper: Vec<String> = tokens.iter().map(|t| t.to_ascii_uppercase()).collect();
    if upper.first().map(String::as_str) != Some("ALTER") {
        return None;
    }
    let table_idx = upper.iter().position(|t| t == "TABLE")? + 1;
    let column_idx = upper.iter().position(|t| t == "COLUMN")? + 1;
    let table = tokens.get(table_idx)?.trim_matches(quote_char).to_string();
    let column = tokens.get(column_idx)?.trim_matches(quote_char).to_string();
    Some((table, column))
}

/// Identifier-quoting characters SQLite accepts around table/column
/// names.
fn quote_char(c: char) -> bool {
    c == '`' || c == '"' || c == '[' || c == ']'
}

/// Whether `table` already has a column named `column`.
fn column_exists(conn: &Connection, table: &str, column: &str) -> Result<bool> {
    // `table` originates from a trusted embedded migration file, so the
    // inline interpolation here is not an injection vector.
    let mut stmt = conn.prepare(&format!("PRAGMA table_info({table})"))?;
    let mut rows = stmt.query([])?;
    while let Some(row) = rows.next()? {
        let name: String = row.get(1)?;
        if name == column {
            return Ok(true);
        }
    }
    Ok(false)
}

#[cfg(test)]
mod tests;
