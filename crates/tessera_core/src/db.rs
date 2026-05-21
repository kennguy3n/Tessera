//! Shared SQLite connection plumbing used by every Tessera store
//! (`SourceStore`, `AuditStore`, `CitationStore`, `ArtifactStore`,
//! `TaskStore`, `AutomationStore`).
//!
//! # Why this exists
//!
//! Each store used to call `rusqlite::Connection::open(path)` in its
//! own constructor, so the bridge's `AppState` held **six independent
//! Connections** to the same on-disk database file. That worked fine
//! correctness-wise — the N-API callbacks are single-threaded, so the
//! per-store outer `Mutex` was already serialising all writes — but it
//! cost six OS file descriptors, six rusqlite per-connection caches,
//! and six SQLite page caches in process memory for what is logically
//! a single workspace.
//!
//! The fix is a single shared `Connection` that every store borrows
//! through a `SharedConnection = Arc<Mutex<rusqlite::Connection>>`.
//! Locking around the inner `Connection` keeps the same write-
//! serialisation guarantee the outer `Mutex<*Manager>` provided while
//! also collapsing the six-handle / six-cache footprint to one.
//!
//! # Lock discipline
//!
//! Every store keeps a `SharedConnection` field and acquires the lock
//! for the duration of a single SQL operation (or a single
//! transaction). The lock graph is therefore a single node: there is
//! no possibility of cross-store deadlock because the only lock to
//! acquire is the one on the inner `Connection`.
//!
//! Stores never hold the connection guard across an `.await` (none of
//! the store code is async anyway) and never call into another store
//! while holding the guard, so the single-lock invariant holds
//! trivially.
//!
//! # Construction
//!
//! Production code calls [`open_shared`] once at bridge init to open
//! the on-disk database, and then hands the resulting
//! `SharedConnection` to every store constructor.
//!
//! Tests typically want an isolated in-memory database per store, so
//! each store keeps its existing `open_in_memory()` constructor that
//! builds its own private `SharedConnection`. Tests that want to
//! exercise multiple stores against the *same* in-memory database
//! (i.e. integration tests that touch artifacts + citations
//! together) should call [`open_shared_in_memory`] once and clone the
//! returned handle into each store via `with_shared_conn(...)`.

use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use crate::error::{Error, Result};

/// Shared SQLite connection handle.
///
/// Cheap to clone — cloning bumps the `Arc` refcount; the underlying
/// `Connection` is not duplicated. Every clone locks the *same* mutex
/// when used, so reads and writes are serialised across all clones.
pub type SharedConnection = Arc<Mutex<Connection>>;

/// Open the database at `path` and wrap it in a [`SharedConnection`].
///
/// Call this once during bridge initialisation; pass the returned
/// handle (cloned) into each store constructor.
pub fn open_shared(path: &str) -> Result<SharedConnection> {
    let conn = Connection::open(path).map_err(|e| Error::Database(e.to_string()))?;
    Ok(Arc::new(Mutex::new(conn)))
}

/// Open an in-memory SQLite database and wrap it in a
/// [`SharedConnection`].
///
/// Intended for tests that want to share a single in-memory database
/// across multiple stores. Single-store tests can keep using each
/// store's `open_in_memory()` helper instead.
pub fn open_shared_in_memory() -> Result<SharedConnection> {
    let conn = Connection::open_in_memory().map_err(|e| Error::Database(e.to_string()))?;
    Ok(Arc::new(Mutex::new(conn)))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn open_shared_in_memory_is_writable() {
        let db = open_shared_in_memory().expect("in-memory");
        let conn = db.lock().expect("lock");
        conn.execute("CREATE TABLE t (id INTEGER)", []).unwrap();
        conn.execute("INSERT INTO t (id) VALUES (?1)", [1]).unwrap();
        let count: i64 = conn
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }

    #[test]
    fn shared_connection_clones_share_the_same_database() {
        // The whole point of the type alias is that clones go through
        // the same inner Mutex<Connection>. If a refactor ever
        // accidentally produced an `Arc::new(Mutex::new(...))` per
        // store instead of cloning the existing one, this test would
        // fail: writes via clone A wouldn't be visible via clone B.
        let db_a = open_shared_in_memory().expect("in-memory");
        let db_b = db_a.clone();
        {
            let conn = db_a.lock().expect("lock");
            conn.execute("CREATE TABLE t (id INTEGER)", []).unwrap();
            conn.execute("INSERT INTO t (id) VALUES (?1)", [42])
                .unwrap();
        }
        let count: i64 = db_b
            .lock()
            .expect("lock")
            .query_row("SELECT COUNT(*) FROM t", [], |r| r.get(0))
            .unwrap();
        assert_eq!(count, 1);
    }
}
