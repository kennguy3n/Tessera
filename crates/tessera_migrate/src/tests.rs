use std::collections::HashSet;

use rusqlite::Connection;

use super::{migrations, Migrator};

/// Column names of `table`.
fn columns(conn: &Connection, table: &str) -> HashSet<String> {
    let mut stmt = conn
        .prepare(&format!("PRAGMA table_info({table})"))
        .expect("prepare table_info");
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(1))
        .expect("query table_info");
    rows.map(|r| r.expect("column name")).collect()
}

/// Names of the user-defined (non-autoindex) indexes in the database.
fn index_names(conn: &Connection) -> HashSet<String> {
    let mut stmt = conn
        .prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name NOT LIKE 'sqlite_autoindex_%'")
        .expect("prepare index query");
    let rows = stmt
        .query_map([], |row| row.get::<_, String>(0))
        .expect("query indexes");
    rows.map(|r| r.expect("index name")).collect()
}

/// Whether a table exists.
fn table_exists(conn: &Connection, table: &str) -> bool {
    conn.query_row(
        "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
        [table],
        |_| Ok(()),
    )
    .is_ok()
}

/// `(version, name, applied_at, checksum)` rows from `_migrations`,
/// ordered by version.
fn bookkeeping(conn: &Connection) -> Vec<(i64, String, String, String)> {
    let mut stmt = conn
        .prepare("SELECT version, name, applied_at, checksum FROM _migrations ORDER BY version")
        .expect("prepare bookkeeping");
    let rows = stmt
        .query_map([], |row| {
            Ok((
                row.get::<_, i64>(0)?,
                row.get::<_, String>(1)?,
                row.get::<_, String>(2)?,
                row.get::<_, String>(3)?,
            ))
        })
        .expect("query bookkeeping");
    rows.map(|r| r.expect("bookkeeping row")).collect()
}

#[test]
fn fresh_db_applies_every_migration() {
    let mut conn = Connection::open_in_memory().expect("open");
    let report = Migrator::new().run(&mut conn).expect("run");

    assert_eq!(report.applied, vec![1, 2, 3, 4, 5]);
    assert!(report.already_applied.is_empty());

    // The final schema must match the legacy ad-hoc `init_schema`.
    let chunk_cols = columns(&conn, "chunks");
    for col in [
        "id",
        "indexed_file_id",
        "chunk_index",
        "byte_offset",
        "content",
        "hash",
        "extraction_method",
        "extraction_model_id",
        "kind",
        "content_aead",
        "content_aead_nonce",
    ] {
        assert!(chunk_cols.contains(col), "chunks missing column {col}");
    }

    let source_cols = columns(&conn, "sources");
    for col in [
        "id",
        "source_type",
        "path",
        "status",
        "created_at",
        "last_indexed",
        "file_count",
        "kchat_backfill_oldest_post_id",
        "kchat_backfill_completed_at",
        "last_sync_error",
        "retry_count",
        "failed_permanently",
    ] {
        assert!(source_cols.contains(col), "sources missing column {col}");
    }

    for table in [
        "sources",
        "indexed_files",
        "chunks",
        "chunks_fts",
        "chunk_embeddings",
        "kchat_principal",
        "kchat_source_acl",
        "kchat_source_deks",
        "kchat_posts",
    ] {
        assert!(table_exists(&conn, table), "missing table {table}");
    }

    let indexes = index_names(&conn);
    for idx in [
        "idx_chunk_embeddings_model",
        "idx_kchat_source_acl_member",
        "idx_kchat_posts_channel",
        "idx_kchat_posts_indexed_file",
        "idx_chunks_extraction_model",
        "idx_sources_type_path",
        "idx_chunks_hash_file",
    ] {
        assert!(indexes.contains(idx), "missing index {idx}");
    }
}

#[test]
fn upgrade_path_applies_only_missing_migrations() {
    let mut conn = Connection::open_in_memory().expect("open");

    // Simulate a database that only ever saw migration 1.
    let first_only = &migrations()[..1];
    let report = Migrator::with_migrations(first_only)
        .run(&mut conn)
        .expect("apply v1");
    assert_eq!(report.applied, vec![1]);

    // Bringing it up to the full set must apply only 2..=5.
    let report = Migrator::new().run(&mut conn).expect("upgrade to v5");
    assert_eq!(report.applied, vec![2, 3, 4, 5]);
    assert_eq!(report.already_applied, vec![1]);

    // And the upgraded schema is complete.
    assert!(columns(&conn, "chunks").contains("content_aead_nonce"));
    assert!(index_names(&conn).contains("idx_chunks_hash_file"));
}

#[test]
fn running_twice_is_a_noop() {
    let mut conn = Connection::open_in_memory().expect("open");

    let first = Migrator::new().run(&mut conn).expect("first run");
    assert_eq!(first.applied, vec![1, 2, 3, 4, 5]);

    let second = Migrator::new().run(&mut conn).expect("second run");
    assert!(
        second.applied.is_empty(),
        "second run should apply nothing, applied {:?}",
        second.applied
    );
    assert_eq!(second.already_applied, vec![1, 2, 3, 4, 5]);

    // Exactly one bookkeeping row per migration — no duplicates.
    assert_eq!(bookkeeping(&conn).len(), 5);
}

#[test]
fn migrations_bookkeeping_is_recorded_correctly() {
    let mut conn = Connection::open_in_memory().expect("open");
    Migrator::new().run(&mut conn).expect("run");

    let rows = bookkeeping(&conn);
    assert_eq!(rows.len(), migrations().len());

    for (row, migration) in rows.iter().zip(migrations()) {
        let (version, name, applied_at, checksum) = row;
        assert_eq!(*version, migration.version);
        assert_eq!(name, migration.name);
        assert_eq!(
            checksum,
            &migration.checksum(),
            "stored checksum must match the embedded migration"
        );
        // `applied_at` is a well-formed RFC3339 timestamp.
        chrono::DateTime::parse_from_rfc3339(applied_at)
            .unwrap_or_else(|e| panic!("applied_at {applied_at:?} not RFC3339: {e}"));
    }
}

#[test]
fn legacy_db_without_bookkeeping_reconciles_without_error() {
    // A database an older build populated has the full schema but no
    // `_migrations` table. Re-running the migrator must not fail on
    // duplicate columns / pre-existing objects: the CREATEs are
    // `IF NOT EXISTS` no-ops and the column-adds are skipped.
    let mut conn = Connection::open_in_memory().expect("open");
    Migrator::new().run(&mut conn).expect("seed schema");
    conn.execute_batch("DROP TABLE _migrations;")
        .expect("drop bookkeeping");

    let report = Migrator::new().run(&mut conn).expect("reconcile");
    assert_eq!(report.applied, vec![1, 2, 3, 4, 5]);

    // Columns are present exactly once (no duplicate-add corruption).
    let chunk_cols = columns(&conn, "chunks");
    assert!(chunk_cols.contains("kind"));
    assert!(chunk_cols.contains("extraction_method"));
}

#[test]
fn legacy_partial_chunks_table_gets_missing_columns_added() {
    // Simulate a database created before the AEAD column-add: `chunks`
    // exists with the base + extraction columns but WITHOUT
    // kind / content_aead / content_aead_nonce, and there is no
    // `_migrations` table.
    let mut conn = Connection::open_in_memory().expect("open");
    conn.execute_batch(
        "CREATE TABLE chunks (
            id INTEGER PRIMARY KEY AUTOINCREMENT,
            indexed_file_id INTEGER NOT NULL,
            chunk_index INTEGER NOT NULL,
            byte_offset INTEGER NOT NULL,
            content TEXT NOT NULL,
            hash TEXT NOT NULL,
            extraction_method TEXT,
            extraction_model_id TEXT
        );",
    )
    .expect("seed legacy chunks");

    let report = Migrator::new().run(&mut conn).expect("upgrade legacy");
    assert_eq!(report.applied, vec![1, 2, 3, 4, 5]);

    let chunk_cols = columns(&conn, "chunks");
    for col in ["kind", "content_aead", "content_aead_nonce"] {
        assert!(chunk_cols.contains(col), "legacy upgrade missing {col}");
    }
}

#[test]
fn checksum_drift_is_detected() {
    let mut conn = Connection::open_in_memory().expect("open");
    Migrator::new().run(&mut conn).expect("run");

    // Corrupt a recorded checksum to simulate an edited migration file.
    conn.execute(
        "UPDATE _migrations SET checksum = 'deadbeef' WHERE version = 3",
        [],
    )
    .expect("tamper");

    let err = Migrator::new()
        .run(&mut conn)
        .expect_err("drift must be rejected");
    let msg = err.to_string();
    assert!(msg.contains("checksum drift"), "unexpected error: {msg}");
}

#[test]
fn rollback_last_runs_down_stub_and_clears_bookkeeping() {
    let mut conn = Connection::open_in_memory().expect("open");
    let migrator = Migrator::new();
    migrator.run(&mut conn).expect("run");
    assert!(index_names(&conn).contains("idx_chunks_hash_file"));

    // 0005 carries a `.down.sql` that drops the secondary indexes.
    let rolled_back = migrator.rollback_last(&mut conn).expect("rollback");
    assert_eq!(rolled_back, Some(5));
    assert!(!index_names(&conn).contains("idx_chunks_hash_file"));
    assert_eq!(bookkeeping(&conn).len(), 4);

    // Re-running re-applies only the rolled-back migration.
    let report = migrator.run(&mut conn).expect("re-apply");
    assert_eq!(report.applied, vec![5]);
    assert!(index_names(&conn).contains("idx_chunks_hash_file"));
}
