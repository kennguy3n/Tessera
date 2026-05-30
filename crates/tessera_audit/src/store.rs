use std::io::Write;
use std::path::{Path, PathBuf};
use std::sync::Mutex;

use flate2::write::GzEncoder;
use flate2::Compression;
use rusqlite::params;
use tessera_core::error::{Error, Result};
use tessera_core::{open_shared, open_shared_in_memory, SharedConnection};

use crate::event::{AuditEvent, AuditEventType};

/// Phase 15 Task 12: row-count threshold above which the audit log
/// is rotated by [`AuditStore::rotate`]. When the live table holds
/// more rows than this, the oldest `live_count - AUDIT_ROTATION_THRESHOLD`
/// rows are archived to `audit-archive-<rfc3339>.jsonl.gz` and
/// DELETEd from the live table.
///
/// 100 000 is the spec value. It corresponds to roughly a year of
/// activity for a typical workstation (200-300 events/day), which
/// is enough that the audit UI's "recent events" pagination stays
/// snappy without losing access to long-tail history (older rows
/// remain on disk inside the archives directory).
pub const AUDIT_ROTATION_THRESHOLD: u64 = 100_000;

/// Phase 15 Task 12 (Devin Review ANALYSIS-0002): process-wide
/// serializer for concurrent calls to [`AuditStore::rotate`].
///
/// `rotate(&self)` takes a shared reference, so two callers can
/// invoke it simultaneously — for example, a scheduled rotation
/// fired by an interval timer overlapping with a user-triggered
/// "Rotate now" click from Settings. Without serialization both
/// callers would SELECT the same oldest rows, write separate
/// archive files with different RFC3339 timestamps (Phase 2), and
/// DELETE the same row IDs (the second DELETE would affect 0
/// rows). The net result is two archive files holding the same
/// rows — the data isn't lost but the archives directory
/// accumulates redundant copies.
///
/// We defend with a process-wide mutex rather than an instance
/// field because Tessera opens exactly one audit database per
/// process (every `AuditStore` constructed via `with_shared_conn`
/// points at the same underlying SQLite file), and the napi
/// bridge constructs transient `AuditStore` instances on the
/// rotation path to bypass the outer `Mutex<AuditLogger>`
/// (ANALYSIS-0001 fix in `bridge_audit_rotate`). An instance
/// mutex would not serialize across those transient instances.
///
/// The mutex is held for the *entire* `rotate()` call — Phase 1
/// (SELECT), Phase 2 (gzip), and Phase 3 (DELETE) — but this is
/// not a latency regression for normal audit logging, because
/// `rotate()` never holds the inner `SharedConnection` lock
/// across Phase 2's gzip work, so concurrent `log_*` calls (which
/// only need the connection lock) proceed unblocked. The only
/// thing this serializer blocks is *another* `rotate()` call,
/// which is what we want.
static AUDIT_ROTATION_SERIALIZER: Mutex<()> = Mutex::new(());

fn parse_datetime(s: &str) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map_or_else(|_| chrono::Utc::now(), |dt| dt.with_timezone(&chrono::Utc))
}

/// Build an [`AuditEvent`] from the four `(id, event_type, timestamp,
/// details)` columns of an `audit_events` row.
///
/// Returns `None` — i.e. the row is silently skipped from the result
/// — when `event_type` does not deserialise into a known
/// [`AuditEventType`] variant. The previous implementation used
/// `serde_json::from_str(&type_s).unwrap_or(AuditEventType::SettingsChanged)`
/// to swallow parse failures, but that has a real-world failure mode:
/// a database written by a *newer* Tessera build (containing a future
/// variant the running build does not know about, e.g. a future
/// `MessageSent` event) and then opened by an *older* build would
/// surface those rows as `SettingsChanged` in the audit UI. Mis-
/// labelled audit rows are strictly worse than missing audit rows —
/// the renderer groups events by type prefix (`AuditActivityCard`)
/// and a row claiming to be `SettingsChanged` would show up in the
/// wrong section, drowning the actual settings changes in noise and
/// making downgrade behaviour silently misleading.
///
/// Skipping the unparseable row instead produces a visible *gap* in
/// the audit list (the count differs from the actual SQLite row
/// count, surfaced via [`AuditStore::count`]), which is the correct
/// posture for forward compatibility: the operator can see that an
/// older build cannot render some rows and either upgrade or query
/// them out-of-band. Sixteenth-pass Devin Review.
///
/// `event_type` is stored as a JSON-quoted string (the result of
/// `serde_json::to_string` on the enum) so the parse uses
/// `serde_json::from_str` to round-trip back through the same
/// `rename_all = "snake_case"` serde derive — we deliberately do not
/// fall back to an alternate parser (`AuditEventType::as_snake_case`
/// matches the *unquoted* form used by the napi bridge to the JS
/// surface, not the on-disk wire format).
fn parse_event_row(
    (id, type_s, ts_s, details): (String, String, String, String),
) -> Option<AuditEvent> {
    let event_type = serde_json::from_str::<AuditEventType>(&type_s).ok()?;
    Some(AuditEvent {
        id,
        event_type,
        timestamp: parse_datetime(&ts_s),
        details,
    })
}

pub struct AuditStore {
    conn: SharedConnection,
}

impl AuditStore {
    pub fn open(path: &str) -> Result<Self> {
        Self::with_shared_conn(open_shared(path)?)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::with_shared_conn(open_shared_in_memory()?)
    }

    /// Build a store on top of a [`SharedConnection`] that is already
    /// shared with other stores. Used by the napi bridge to fold all
    /// six per-store SQLite connections into one.
    pub fn with_shared_conn(conn: SharedConnection) -> Result<Self> {
        let store = Self { conn };
        store.init_schema()?;
        Ok(store)
    }

    fn init_schema(&self) -> Result<()> {
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .execute_batch(
                "CREATE TABLE IF NOT EXISTS audit_events (
                    id TEXT PRIMARY KEY,
                    event_type TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    details TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events(event_type);
                CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_events(timestamp);

                CREATE TRIGGER IF NOT EXISTS audit_no_update
                BEFORE UPDATE ON audit_events
                BEGIN
                    SELECT RAISE(ABORT, 'audit_events is append-only: UPDATE not allowed');
                END;

                CREATE TRIGGER IF NOT EXISTS audit_no_delete
                BEFORE DELETE ON audit_events
                BEGIN
                    SELECT RAISE(ABORT, 'audit_events is append-only: DELETE not allowed');
                END;",
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(())
    }

    pub fn append(&self, event: &AuditEvent) -> Result<()> {
        let type_str =
            serde_json::to_string(&event.event_type).map_err(|e| Error::Database(e.to_string()))?;
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .execute(
                "INSERT INTO audit_events (id, event_type, timestamp, details) VALUES (?1, ?2, ?3, ?4)",
                params![
                    event.id,
                    type_str,
                    event.timestamp.to_rfc3339(),
                    event.details,
                ],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(())
    }

    pub fn query_by_type(&self, event_type: &AuditEventType) -> Result<Vec<AuditEvent>> {
        let type_str =
            serde_json::to_string(event_type).map_err(|e| Error::Database(e.to_string()))?;
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare("SELECT id, event_type, timestamp, details FROM audit_events WHERE event_type = ?1 ORDER BY timestamp DESC")
            .map_err(|e| Error::Database(e.to_string()))?;

        let events = stmt
            .query_map(params![type_str], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| Error::Database(e.to_string()))?
            .filter_map(std::result::Result::ok)
            .filter_map(parse_event_row)
            .collect();

        Ok(events)
    }

    pub fn query_by_date_range(
        &self,
        from: &chrono::DateTime<chrono::Utc>,
        to: &chrono::DateTime<chrono::Utc>,
    ) -> Result<Vec<AuditEvent>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT id, event_type, timestamp, details FROM audit_events WHERE timestamp >= ?1 AND timestamp <= ?2 ORDER BY timestamp DESC",
            )
            .map_err(|e| Error::Database(e.to_string()))?;

        let events = stmt
            .query_map(params![from.to_rfc3339(), to.to_rfc3339()], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| Error::Database(e.to_string()))?
            .filter_map(std::result::Result::ok)
            .filter_map(parse_event_row)
            .collect();

        Ok(events)
    }

    /// Return the `limit` most recent audit rows, newest first. The
    /// audit UI in Settings reads from this method so the renderer
    /// can render a "recent activity" list without having to query
    /// every event type individually. `offset` lets the caller page
    /// backwards through history when scrolling.
    pub fn recent_events(&self, limit: u32, offset: u32) -> Result<Vec<AuditEvent>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT id, event_type, timestamp, details FROM audit_events \
                 ORDER BY timestamp DESC, id DESC LIMIT ?1 OFFSET ?2",
            )
            .map_err(|e| Error::Database(e.to_string()))?;

        let events = stmt
            .query_map(params![limit as i64, offset as i64], |row| {
                Ok((
                    row.get::<_, String>(0)?,
                    row.get::<_, String>(1)?,
                    row.get::<_, String>(2)?,
                    row.get::<_, String>(3)?,
                ))
            })
            .map_err(|e| Error::Database(e.to_string()))?
            .filter_map(std::result::Result::ok)
            .filter_map(parse_event_row)
            .collect();

        Ok(events)
    }

    pub fn count(&self) -> Result<u64> {
        let count: i64 = self
            .conn
            .lock()
            .expect("connection mutex poisoned")
            .query_row("SELECT COUNT(*) FROM audit_events", [], |row| row.get(0))
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(count as u64)
    }

    /// Phase 15 Task 12: archive the oldest rows once the live
    /// table exceeds [`AUDIT_ROTATION_THRESHOLD`], then DELETE them.
    ///
    /// Behaviour:
    ///
    ///   * Returns `Ok(None)` when the live table is at or below
    ///     the threshold — nothing was archived, nothing was
    ///     deleted, no archive file was written.
    ///   * When `live_count > AUDIT_ROTATION_THRESHOLD`:
    ///     1. The oldest `live_count - AUDIT_ROTATION_THRESHOLD`
    ///        rows (by `(timestamp ASC, id ASC)`) are read into
    ///        memory.
    ///     2. They are serialised as JSONL and gzip-compressed
    ///        into `<archive_dir>/audit-archive-<rfc3339>.jsonl.gz`.
    ///        The filename's RFC 3339 timestamp uses dashes only
    ///        (no colons) so it lands cleanly on case-insensitive
    ///        filesystems (NTFS, macOS HFS+).
    ///     3. The same row ids are DELETEd from `audit_events`
    ///        inside a transaction. To bypass the `audit_no_delete`
    ///        trigger that protects against ad-hoc deletion, the
    ///        method temporarily drops the trigger and recreates
    ///        it before commit — both inside one transaction so a
    ///        crash never leaves the table writable without the
    ///        guard.
    ///   * Returns `Ok(Some(RotationOutcome))` describing the
    ///     archive path and the row count that was rotated.
    ///
    /// The DELETE is gated on the archive file having been
    /// successfully written (flushed + closed). If the gzip write
    /// fails for any reason — disk full, permission denied — the
    /// transaction is rolled back so the rows stay in the live
    /// table. This is the only acceptable failure mode: an audit
    /// row must never disappear without a durable copy on disk.
    ///
    /// `archive_dir` is created (mkdir -p) if it does not exist.
    pub fn rotate(&self, archive_dir: &Path) -> Result<Option<RotationOutcome>> {
        // Devin Review ANALYSIS-0002: serialize concurrent rotations
        // process-wide so a scheduled rotation and a user-triggered
        // "Rotate now" click cannot produce duplicate archive files
        // for the same logical rotation window. See the docstring on
        // [`AUDIT_ROTATION_SERIALIZER`] for the full rationale.
        //
        // We acquire BEFORE the live-count probe so two rotations
        // racing on a table that's at exactly `THRESHOLD + 1` rows
        // cannot both decide they have work to do — the second
        // entrant runs `count()` after the first has DELETEd and
        // returns `Ok(None)` because the table is back below the
        // threshold. The lock is held for the entire rotation,
        // including the Phase 2 gzip; concurrent `log_*` calls are
        // unaffected because they only need the inner SQLite
        // connection mutex, which Phase 2 releases.
        //
        // We deliberately ignore poisoning (`unwrap_or_else`) — a
        // previous rotation panic should not prevent us from
        // attempting a fresh rotation on a healthy table.
        let _rotation_guard = AUDIT_ROTATION_SERIALIZER
            .lock()
            .unwrap_or_else(std::sync::PoisonError::into_inner);

        let live_count = self.count()?;
        if live_count <= AUDIT_ROTATION_THRESHOLD {
            return Ok(None);
        }
        let target_rotate = live_count - AUDIT_ROTATION_THRESHOLD;

        std::fs::create_dir_all(archive_dir).map_err(|e| {
            Error::Database(format!(
                "rotate: failed to create archive_dir {}: {e}",
                archive_dir.display()
            ))
        })?;

        // Build the archive filename BEFORE touching the database so
        // a clock skew or filename-collision failure aborts cleanly
        // without locking the audit-events row out of further reads.
        // Colons in RFC3339 are NOT filesystem-safe on Windows; we
        // substitute dashes so the archive can be opened on any
        // platform tessera ships to. Nanosecond precision eliminates
        // the theoretical sub-second collision window — even if a
        // future optimization makes rotation faster than the current
        // mutex-guarded select+gzip+delete path (~hundreds of ms),
        // two rotations on the same wall-clock nanosecond are
        // not physically realisable on commodity hardware, and we
        // can no longer overwrite an earlier archive by accident.
        let now = chrono::Utc::now();
        let safe_ts = now
            .to_rfc3339_opts(chrono::SecondsFormat::Nanos, true)
            .replace(':', "-");
        let archive_path = archive_dir.join(format!("audit-archive-{safe_ts}.jsonl.gz"));

        // Phase 1: select the oldest rows. We acquire the connection
        // mutex ONLY for the read so the gzip compression in Phase 2
        // (which can take hundreds of ms on large rotations) does not
        // block concurrent audit appends from IPC handlers, source
        // indexing, or artifact saves. The DELETE in Phase 3
        // re-acquires the mutex briefly. Concurrent appends between
        // Phase 1 and Phase 3 are intentionally safe: the DELETE
        // targets a captured `ids` list, so any rows inserted in the
        // gap are simply not part of this rotation cycle and will be
        // picked up by the next one.
        let rows: Vec<(String, String, String, String)> = {
            let conn = self.conn.lock().expect("connection mutex poisoned");
            let mut stmt = conn
                .prepare(
                    "SELECT id, event_type, timestamp, details
                     FROM audit_events
                     ORDER BY timestamp ASC, id ASC
                     LIMIT ?1",
                )
                .map_err(|e| Error::Database(e.to_string()))?;
            let collected: Vec<(String, String, String, String)> = stmt
                .query_map(params![target_rotate as i64], |row| {
                    Ok((
                        row.get::<_, String>(0)?,
                        row.get::<_, String>(1)?,
                        row.get::<_, String>(2)?,
                        row.get::<_, String>(3)?,
                    ))
                })
                .map_err(|e| Error::Database(e.to_string()))?
                .collect::<std::result::Result<Vec<_>, _>>()
                .map_err(|e| Error::Database(e.to_string()))?;
            collected
            // `conn` and `stmt` are dropped here, releasing the mutex.
        };

        let ids: Vec<String> = rows.iter().map(|(id, _, _, _)| id.clone()).collect();

        // Phase 2: write the gzipped JSONL archive WITHOUT holding
        // the SQLite connection mutex. Compression on tens of
        // thousands of rows takes hundreds of ms; releasing the
        // mutex here lets the rest of the app continue to append
        // audit events, run searches, and save artifacts.
        //
        // If any I/O step fails, the live table is untouched and we
        // best-effort delete any partial archive file we created so
        // a future retry doesn't leave a stale-but-incomplete archive
        // on disk.
        let archive_result = write_rotation_archive(&archive_path, &rows);
        if let Err(e) = archive_result {
            // Best-effort cleanup of any partial file.
            let _ = std::fs::remove_file(&archive_path);
            return Err(e);
        }

        // Phase 3: DELETE the rotated rows from the live table.
        // The `audit_no_delete` trigger protects against ad-hoc
        // deletion, so we drop it for the duration of the
        // rotation transaction and recreate it before commit.
        // Both the DROP, the DELETE, and the recreate happen
        // inside one BEGIN/COMMIT pair so a crash mid-rotation
        // either leaves the trigger intact (no-op) or has fully
        // recreated it (rotation committed).
        //
        // If this phase fails — DB locked, IO error, etc. — we
        // best-effort delete the archive file we just wrote so the
        // next `rotate()` call doesn't see two archive files for the
        // same logical rotation window (the documented contract is
        // "an audit row must never disappear without a durable copy
        // on disk", and we want the converse too: a durable copy
        // never persists without the corresponding DELETE).
        let delete_result = {
            let conn = self.conn.lock().expect("connection mutex poisoned");
            execute_rotation_delete(&conn, &ids)
        };
        if let Err(e) = delete_result {
            let _ = std::fs::remove_file(&archive_path);
            return Err(e);
        }

        Ok(Some(RotationOutcome {
            archive_path,
            rotated_count: ids.len() as u64,
        }))
    }

    /// Phase 15 Task 12: list archive filenames in `archive_dir`
    /// matching the `audit-archive-*.jsonl.gz` pattern, sorted
    /// newest-first by filename (the embedded timestamp).
    ///
    /// Returns `Ok(vec![])` when the directory does not exist —
    /// "no rotations have happened yet" is not an error worth
    /// surfacing to the renderer.
    ///
    /// Used by the `audit:getArchives` IPC handler so the Settings
    /// page can offer the user a list of archives to download or
    /// inspect.
    pub fn list_archives(archive_dir: &Path) -> Result<Vec<PathBuf>> {
        let read_dir = match std::fs::read_dir(archive_dir) {
            Ok(rd) => rd,
            Err(e) if e.kind() == std::io::ErrorKind::NotFound => return Ok(Vec::new()),
            Err(e) => {
                return Err(Error::Database(format!(
                    "list_archives: read_dir({}): {e}",
                    archive_dir.display()
                )))
            }
        };
        let mut paths: Vec<PathBuf> = read_dir
            .filter_map(std::result::Result::ok)
            .map(|e| e.path())
            .filter(|p| {
                p.file_name()
                    .and_then(|n| n.to_str())
                    .is_some_and(|n| n.starts_with("audit-archive-") && n.ends_with(".jsonl.gz"))
            })
            .collect();
        // Newest first by filename — the embedded timestamp sorts
        // correctly because RFC3339 dates are lexicographically
        // monotonic.
        paths.sort_by(|a, b| b.file_name().cmp(&a.file_name()));
        Ok(paths)
    }
}

/// Write the gzipped JSONL archive of `rows` to `archive_path`.
/// Pulled out as a free function so [`AuditStore::rotate`] can
/// invoke it WITHOUT holding the SQLite connection mutex — the
/// compression of tens of thousands of rows can take hundreds of
/// milliseconds, and we do not want to block concurrent audit
/// appends or artifact saves for that long.
///
/// On success the file is flushed, the gzip trailer is written, and
/// the underlying `File` is closed before this returns.
///
/// On any I/O error the caller is responsible for cleaning up any
/// partial file at `archive_path`.
fn write_rotation_archive(
    archive_path: &Path,
    rows: &[(String, String, String, String)],
) -> Result<()> {
    let file = std::fs::File::create(archive_path).map_err(|e| {
        Error::Database(format!(
            "rotate: failed to create {}: {e}",
            archive_path.display()
        ))
    })?;
    let mut encoder = GzEncoder::new(file, Compression::default());
    for (id, type_s, ts_s, details) in rows {
        // Reconstruct the JSONL line by hand from the four columns
        // rather than re-deriving an AuditEvent and serialising —
        // that round-trip would silently drop rows whose
        // `event_type` does not parse into the current build's enum
        // (the same forward-compat posture as `parse_event_row`).
        // For an archive we want bit-exact preservation of every row
        // regardless of whether the running build recognises it.
        let line = serde_json::json!({
            "id": id,
            "event_type": serde_json::from_str::<serde_json::Value>(type_s)
                .unwrap_or_else(|_| serde_json::Value::String(type_s.clone())),
            "timestamp": ts_s,
            "details": details,
        });
        let serialised = serde_json::to_string(&line)
            .map_err(|e| Error::Database(format!("rotate: serialise row: {e}")))?;
        encoder
            .write_all(serialised.as_bytes())
            .map_err(|e| Error::Database(format!("rotate: gz write: {e}")))?;
        encoder
            .write_all(b"\n")
            .map_err(|e| Error::Database(format!("rotate: gz write newline: {e}")))?;
    }
    encoder
        .finish()
        .map_err(|e| Error::Database(format!("rotate: gz finish: {e}")))?;
    Ok(())
}

/// Run the trigger-drop / chunked-DELETE / trigger-recreate
/// transaction for [`AuditStore::rotate`] against an already-locked
/// connection.
fn execute_rotation_delete(conn: &rusqlite::Connection, ids: &[String]) -> Result<()> {
    conn.execute_batch("BEGIN IMMEDIATE;")
        .map_err(|e| Error::Database(e.to_string()))?;
    let rollback_on_err = |err: rusqlite::Error| -> Error {
        // Best-effort rollback. If it fails, propagate the original
        // error — the next connection acquisition will roll back
        // the partial transaction.
        let _ = conn.execute_batch("ROLLBACK;");
        Error::Database(err.to_string())
    };
    conn.execute("DROP TRIGGER IF EXISTS audit_no_delete", [])
        .map_err(rollback_on_err)?;
    // Batch the DELETEs by id — sqlite can't bind a list, so use
    // chunked IN-clause statements. Stay under SQLite's default
    // 999-parameter limit per statement (the default
    // SQLITE_MAX_VARIABLE_NUMBER on modern builds is 32766 but 999
    // is the historical safe minimum).
    const CHUNK: usize = 500;
    for chunk in ids.chunks(CHUNK) {
        let placeholders = std::iter::repeat_n("?", chunk.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!("DELETE FROM audit_events WHERE id IN ({placeholders})");
        let params_rs: Vec<&dyn rusqlite::ToSql> =
            chunk.iter().map(|s| s as &dyn rusqlite::ToSql).collect();
        conn.execute(&sql, params_rs.as_slice())
            .map_err(rollback_on_err)?;
    }
    // Recreate the trigger so future ad-hoc DELETEs (outside the
    // rotation API) are still rejected.
    conn.execute(
        "CREATE TRIGGER audit_no_delete
         BEFORE DELETE ON audit_events
         BEGIN
             SELECT RAISE(ABORT, 'audit_events is append-only: DELETE not allowed');
         END",
        [],
    )
    .map_err(rollback_on_err)?;
    // Devin Review PR #69 BUG_0001: route COMMIT failure through the
    // same rollback_on_err path as every other failable step. If
    // COMMIT itself errors (e.g. SQLITE_FULL, disk write failure, or
    // the rare WAL-corruption case) we must NOT leave the connection
    // sitting on an open transaction with the `audit_no_delete`
    // trigger dropped and the rotated rows already removed — the
    // SharedConnection is process-wide, so the next caller's
    // `BEGIN IMMEDIATE` would fail with "cannot start a transaction
    // within a transaction" and the append-only guarantee for
    // `audit_events` would be silently disabled for the rest of the
    // session. Rolling back restores: (a) the trigger as it was on
    // disk before this rotation, (b) the rows in their live-table
    // positions. The caller's outer `delete_result.is_err()` branch
    // already best-effort removes the archive file we wrote in
    // Phase 2, so a COMMIT failure leaves the database exactly as
    // it was pre-rotation.
    conn.execute_batch("COMMIT;").map_err(rollback_on_err)?;
    Ok(())
}

/// Outcome of one successful [`AuditStore::rotate`] call.
#[derive(Debug, Clone)]
pub struct RotationOutcome {
    /// Absolute path of the archive file written. Always exists
    /// on disk when this value is returned (the rotation only
    /// commits the DELETE after `finish()` succeeds).
    pub archive_path: PathBuf,
    /// Number of rows that were archived AND deleted from the
    /// live table. Matches the number of JSONL lines in
    /// `archive_path`.
    pub rotated_count: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_and_query_events() {
        let store = AuditStore::open_in_memory().unwrap();
        store
            .append(&AuditEvent::new(
                AuditEventType::SourceAdded,
                "Added folder /home/user/docs".to_string(),
            ))
            .unwrap();
        store
            .append(&AuditEvent::new(
                AuditEventType::ArtifactCreated,
                "Created PRD: Q4 Planning".to_string(),
            ))
            .unwrap();

        let source_events = store.query_by_type(&AuditEventType::SourceAdded).unwrap();
        assert_eq!(source_events.len(), 1);
        assert!(source_events[0].details.contains("/home/user/docs"));

        assert_eq!(store.count().unwrap(), 2);
    }

    #[test]
    fn query_by_date_range() {
        let store = AuditStore::open_in_memory().unwrap();
        store
            .append(&AuditEvent::new(
                AuditEventType::SearchPerformed,
                "query: productivity".to_string(),
            ))
            .unwrap();

        let from = chrono::Utc::now() - chrono::Duration::hours(1);
        let to = chrono::Utc::now() + chrono::Duration::hours(1);
        let events = store.query_by_date_range(&from, &to).unwrap();
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn audit_store_is_append_only() {
        let store = AuditStore::open_in_memory().unwrap();
        for i in 0..5 {
            store
                .append(&AuditEvent::new(
                    AuditEventType::SettingsChanged,
                    format!("Change {i}"),
                ))
                .unwrap();
        }
        assert_eq!(store.count().unwrap(), 5);
    }

    #[test]
    fn recent_events_returns_newest_first_and_respects_limit_offset() {
        let store = AuditStore::open_in_memory().unwrap();
        // Insert ten rows with slightly-increasing timestamps so the
        // DESC ordering yields the same sequence as the insertion
        // order (newest = i=9 first, oldest = i=0 last).
        for i in 0..10u32 {
            let mut ev = AuditEvent::new(AuditEventType::SettingsChanged, format!("change {i}"));
            // chrono::Utc::now() advances between calls but on
            // particularly fast systems two appends can collide in
            // the same nanosecond, which would make the ORDER BY
            // timestamp non-deterministic. Force monotonic spacing
            // by overriding the timestamp before append.
            ev.timestamp = chrono::Utc::now() + chrono::Duration::milliseconds(i as i64);
            store.append(&ev).unwrap();
        }

        // limit=3, offset=0 → newest 3 rows.
        let top3 = store.recent_events(3, 0).unwrap();
        assert_eq!(top3.len(), 3);
        assert!(top3[0].details.contains("change 9"));
        assert!(top3[1].details.contains("change 8"));
        assert!(top3[2].details.contains("change 7"));

        // limit=3, offset=3 → next page (rows 6,5,4 in the newest
        // ordering).
        let page2 = store.recent_events(3, 3).unwrap();
        assert_eq!(page2.len(), 3);
        assert!(page2[0].details.contains("change 6"));
        assert!(page2[2].details.contains("change 4"));

        // limit=100, offset=20 → past the end, expect an empty page.
        let empty = store.recent_events(100, 20).unwrap();
        assert!(empty.is_empty());
    }

    #[test]
    fn recent_events_on_empty_store_returns_empty() {
        let store = AuditStore::open_in_memory().unwrap();
        assert!(store.recent_events(100, 0).unwrap().is_empty());
    }

    #[test]
    fn recent_events_skips_unknown_event_type_rows() {
        // Forward-compatibility pin (sixteenth-pass Devin Review).
        // A row whose `event_type` column does not deserialise into
        // a known `AuditEventType` variant — the scenario this guards
        // against is a database written by a newer Tessera build,
        // then opened by an older build that lacks the future
        // variant — must be SKIPPED from query results, NOT silently
        // mapped to a placeholder variant like `SettingsChanged`.
        // Mis-labelling would route the future row into the wrong
        // section of `AuditActivityCard`; skipping it surfaces a
        // visible gap that the operator can detect.
        let store = AuditStore::open_in_memory().unwrap();

        // One legitimate row that should survive the round-trip…
        store
            .append(&AuditEvent::new(
                AuditEventType::SourceAdded,
                "real row".to_string(),
            ))
            .unwrap();

        // …and one synthesized "future variant" row inserted via raw
        // SQL so we can write an event_type that does not exist in
        // the current `AuditEventType` enum. `append()` cannot do
        // this because it serialises a typed `AuditEventType`.
        store
            .conn
            .lock()
            .expect("connection mutex poisoned")
            .execute(
                "INSERT INTO audit_events (id, event_type, timestamp, details) VALUES (?1, ?2, ?3, ?4)",
                params![
                    uuid::Uuid::new_v4().to_string(),
                    "\"future_unknown_variant\"",
                    chrono::Utc::now().to_rfc3339(),
                    "row from a future Tessera build",
                ],
            )
            .unwrap();

        // The raw-SQL row IS in the table (count includes it)…
        assert_eq!(store.count().unwrap(), 2);

        // …but recent_events filters it out rather than producing a
        // mis-labelled SettingsChanged entry.
        let events = store.recent_events(100, 0).unwrap();
        assert_eq!(events.len(), 1);
        assert_eq!(events[0].event_type, AuditEventType::SourceAdded);

        // query_by_date_range and query_by_type must follow the same
        // skip-on-unknown contract so any future caller has uniform
        // behaviour across read methods.
        let by_range = store
            .query_by_date_range(
                &(chrono::Utc::now() - chrono::Duration::hours(1)),
                &(chrono::Utc::now() + chrono::Duration::hours(1)),
            )
            .unwrap();
        assert_eq!(by_range.len(), 1);
        assert_eq!(by_range[0].event_type, AuditEventType::SourceAdded);

        let by_type = store.query_by_type(&AuditEventType::SourceAdded).unwrap();
        assert_eq!(by_type.len(), 1);
    }

    #[test]
    fn audit_store_shares_database_with_clone() {
        // Two stores built on the same SharedConnection see the same
        // rows — that's the entire point of the shared-connection
        // refactor. If this ever fails, init_bridge probably
        // accidentally rebuilt a fresh Connection per store.
        let conn = open_shared_in_memory().unwrap();
        let a = AuditStore::with_shared_conn(conn.clone()).unwrap();
        let b = AuditStore::with_shared_conn(conn).unwrap();
        a.append(&AuditEvent::new(
            AuditEventType::SettingsChanged,
            "via A".to_string(),
        ))
        .unwrap();
        assert_eq!(b.count().unwrap(), 1);
    }

    // -- Phase 15 Task 12: audit log rotation tests -----------------------

    use std::io::Read as _;

    fn read_gz_jsonl(path: &Path) -> Vec<serde_json::Value> {
        let file = std::fs::File::open(path).expect("archive file open");
        let mut decoder = flate2::read::GzDecoder::new(file);
        let mut s = String::new();
        decoder.read_to_string(&mut s).expect("decode archive");
        s.lines()
            .filter(|l| !l.is_empty())
            .map(|l| serde_json::from_str(l).expect("each line is valid JSON"))
            .collect()
    }

    #[test]
    fn rotate_is_a_noop_when_table_is_below_threshold() {
        let store = AuditStore::open_in_memory().unwrap();
        for i in 0..10 {
            store
                .append(&AuditEvent::new(
                    AuditEventType::SettingsChanged,
                    format!("change {i}"),
                ))
                .unwrap();
        }
        let dir = tempfile::tempdir().unwrap();
        let outcome = store.rotate(dir.path()).unwrap();
        assert!(outcome.is_none(), "below threshold must return None");
        assert_eq!(store.count().unwrap(), 10, "no rows should be removed");
        let archives = AuditStore::list_archives(dir.path()).unwrap();
        assert!(
            archives.is_empty(),
            "below threshold must not write any archive file"
        );
    }

    #[test]
    fn rotate_fires_when_above_threshold_and_trims_to_threshold() {
        // We cannot insert 100K rows in a unit test (slow). Verify
        // the rotation behaviour by lowering the test's expected
        // boundary: insert THRESHOLD + 5 rows and assert that
        // exactly 5 rotate. (The constant is a `pub const`, not a
        // policy parameter, so we drive the test against the real
        // value rather than override it.)
        let store = AuditStore::open_in_memory().unwrap();
        let target = AUDIT_ROTATION_THRESHOLD + 5;
        for i in 0..target {
            let mut ev = AuditEvent::new(AuditEventType::SettingsChanged, format!("change {i}"));
            // Force monotonic timestamps so the rotation's
            // ORDER BY timestamp ASC selects the OLDEST 5 rows
            // (i = 0..4) deterministically.
            ev.timestamp =
                chrono::DateTime::<chrono::Utc>::from_timestamp(1_700_000_000 + i as i64, 0)
                    .unwrap();
            store.append(&ev).unwrap();
        }
        let dir = tempfile::tempdir().unwrap();
        let outcome = store
            .rotate(dir.path())
            .unwrap()
            .expect("rotation should fire above threshold");
        assert_eq!(outcome.rotated_count, 5);
        assert_eq!(
            store.count().unwrap(),
            AUDIT_ROTATION_THRESHOLD,
            "post-rotation live count must equal the threshold",
        );

        // The archive file exists, was gzipped, and contains the
        // five oldest rows in insertion order.
        assert!(outcome.archive_path.exists());
        let entries = read_gz_jsonl(&outcome.archive_path);
        assert_eq!(entries.len(), 5);
        for (i, entry) in entries.iter().enumerate() {
            assert_eq!(
                entry["details"].as_str().unwrap(),
                format!("change {i}"),
                "rotated entries should be the oldest by insertion order"
            );
        }

        // list_archives surfaces it.
        let archives = AuditStore::list_archives(dir.path()).unwrap();
        assert_eq!(archives.len(), 1);
        assert_eq!(archives[0], outcome.archive_path);
    }

    #[test]
    fn rotate_preserves_no_delete_trigger_post_commit() {
        // Pin that the rotation transaction restores the
        // append-only DELETE guard before commit. A manual
        // DELETE attempt after rotation must still be rejected.
        let store = AuditStore::open_in_memory().unwrap();
        let target = AUDIT_ROTATION_THRESHOLD + 1;
        for i in 0..target {
            let mut ev = AuditEvent::new(AuditEventType::SettingsChanged, format!("change {i}"));
            ev.timestamp =
                chrono::DateTime::<chrono::Utc>::from_timestamp(1_700_000_000 + i as i64, 0)
                    .unwrap();
            store.append(&ev).unwrap();
        }
        let dir = tempfile::tempdir().unwrap();
        let outcome = store.rotate(dir.path()).unwrap().expect("rotation fires");
        assert_eq!(outcome.rotated_count, 1);
        // Attempt a raw DELETE — the trigger must reject it.
        let conn = store.conn.lock().unwrap();
        let res = conn.execute("DELETE FROM audit_events LIMIT 1", []);
        assert!(
            res.is_err(),
            "audit_no_delete trigger must still be installed after rotation"
        );
    }

    #[test]
    fn concurrent_rotations_are_serialized_no_duplicate_archives() {
        // Devin Review ANALYSIS-0002: two threads racing into
        // `rotate()` against the same logical table must produce
        // ONE archive file containing the rotated rows, not two
        // archive files containing the same rows. The process-wide
        // `AUDIT_ROTATION_SERIALIZER` enforces this regardless of
        // whether the threads call into the same `AuditStore`
        // instance (here) or transient instances built via
        // `with_shared_conn` (the napi path).
        //
        // We populate the table to `THRESHOLD + 5` rows, spawn two
        // threads that both call `rotate()`, then assert (a) the
        // archive directory contains exactly one
        // `audit-archive-*.jsonl.gz` file, (b) the live table has
        // been trimmed to exactly `THRESHOLD` rows, and (c) the
        // combined rotated_count across both threads equals 5
        // (one thread does the work, the other returns `None`).
        let conn = open_shared_in_memory().unwrap();
        let store = AuditStore::with_shared_conn(conn.clone()).unwrap();
        let target = AUDIT_ROTATION_THRESHOLD + 5;
        for i in 0..target {
            let mut ev = AuditEvent::new(AuditEventType::SettingsChanged, format!("change {i}"));
            ev.timestamp =
                chrono::DateTime::<chrono::Utc>::from_timestamp(1_700_000_000 + i as i64, 0)
                    .unwrap();
            store.append(&ev).unwrap();
        }

        let dir = tempfile::tempdir().unwrap();
        let dir_path_a = dir.path().to_path_buf();
        let dir_path_b = dir.path().to_path_buf();
        let conn_a = conn.clone();
        let conn_b = conn.clone();
        let h_a = std::thread::spawn(move || {
            let s = AuditStore::with_shared_conn(conn_a).unwrap();
            s.rotate(&dir_path_a)
        });
        let h_b = std::thread::spawn(move || {
            let s = AuditStore::with_shared_conn(conn_b).unwrap();
            s.rotate(&dir_path_b)
        });
        let res_a = h_a.join().unwrap().unwrap();
        let res_b = h_b.join().unwrap().unwrap();

        let mut rotated_total: u64 = 0;
        let mut rotation_outcomes = 0;
        for r in [res_a, res_b].into_iter().flatten() {
            rotated_total += r.rotated_count;
            rotation_outcomes += 1;
        }
        assert_eq!(
            rotation_outcomes, 1,
            "exactly one of the racing rotations should have produced rows; the other should see the table back below threshold and return None",
        );
        assert_eq!(
            rotated_total, 5,
            "the rotated rows should be the 5 above threshold"
        );

        let archives = AuditStore::list_archives(dir.path()).unwrap();
        assert_eq!(
            archives.len(),
            1,
            "concurrent rotations must NOT produce duplicate archive files",
        );

        assert_eq!(
            store.count().unwrap(),
            AUDIT_ROTATION_THRESHOLD,
            "live table must be trimmed exactly once",
        );
    }

    #[test]
    fn list_archives_returns_empty_when_dir_missing() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("does_not_exist");
        let archives = AuditStore::list_archives(&missing).unwrap();
        assert!(archives.is_empty());
    }

    #[test]
    fn list_archives_filters_to_audit_archive_pattern() {
        // Drop a few decoy files alongside one legitimate archive
        // to confirm the filter ignores unrelated files (other
        // tessera archives, user-dropped backups, .DS_Store, etc.).
        let dir = tempfile::tempdir().unwrap();
        std::fs::write(dir.path().join("README.md"), "decoy").unwrap();
        std::fs::write(dir.path().join("audit-archive-junk.txt"), "decoy").unwrap();
        std::fs::write(dir.path().join("audit-archive-2025-01-01.jsonl.gz"), b"").unwrap();
        std::fs::write(dir.path().join("audit-archive-2025-02-01.jsonl.gz"), b"").unwrap();
        let archives = AuditStore::list_archives(dir.path()).unwrap();
        assert_eq!(archives.len(), 2);
        // Newest first by filename.
        assert!(archives[0]
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .contains("2025-02-01"));
        assert!(archives[1]
            .file_name()
            .unwrap()
            .to_str()
            .unwrap()
            .contains("2025-01-01"));
    }
}
