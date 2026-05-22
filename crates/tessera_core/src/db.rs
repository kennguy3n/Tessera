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
//! # Encryption at rest
//!
//! Tessera ships rusqlite with the `bundled-sqlcipher-vendored-openssl`
//! feature, so the bundled SQLite is SQLCipher. The bridge passes a
//! 32-byte raw key (hex-encoded) at init time, and [`open_shared_with_key`]
//! issues `PRAGMA key = "x'<hex>'"` immediately after opening the
//! connection. The key never round-trips through the SQLCipher KDF
//! because it's already 256-bit random material; the `x'...'` literal
//! tells SQLCipher to treat it as the raw cipher key. See
//! `apps/desktop/electron/dbKey.ts` for how the key is generated,
//! wrapped via Electron's `safeStorage`, and persisted at
//! `<userData>/db.key`.
//!
//! ## First-run migration of pre-encryption databases
//!
//! Existing installs may have an unencrypted `tessera.db` on disk
//! from before this layer landed. To avoid a hard data loss on
//! upgrade, [`open_shared_with_key`] probes for that case: if a key
//! is supplied but the file decrypts as plaintext SQLite, the
//! function transparently re-encrypts the file in place using
//! `sqlcipher_export` before returning. This runs at most once per
//! install; subsequent opens see a properly encrypted file and skip
//! straight to the happy path. The behaviour is covered by the
//! `plaintext_db_is_migrated_to_encrypted_on_first_open` test.
//!
//! ## Wrong-key behaviour
//!
//! If a key is supplied but does not match the on-disk database
//! (and the file is not plaintext we can migrate), the function
//! returns an `Error::Database` describing a decryption failure.
//! The bridge surfaces this to the renderer and `appState.ts`
//! refuses to bring up the rest of the application — the user
//! either restores their `db.key` from backup or accepts data loss
//! by deleting both `tessera.db` and `db.key`.
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
//! Production code calls [`open_shared_with_key`] once at bridge init
//! to open the on-disk database with the user's encryption key, and
//! then hands the resulting `SharedConnection` to every store
//! constructor.
//!
//! Tests typically want an isolated in-memory database per store, so
//! each store keeps its existing `open_in_memory()` constructor that
//! builds its own private `SharedConnection`. Tests that want to
//! exercise multiple stores against the *same* in-memory database
//! (i.e. integration tests that touch artifacts + citations
//! together) should call [`open_shared_in_memory`] once and clone the
//! returned handle into each store via `with_shared_conn(...)`.
//!
//! [`open_shared`] (no `_with_key`) is the no-encryption legacy entry
//! point. It exists for two reasons: (1) per-store seeding helpers
//! (`SourceStore::open`, `AuditStore::open`, etc.) that take a path
//! and never had a key concept, and (2) integration tests that don't
//! want to thread a key argument through every store call. New
//! production code should always go through `open_shared_with_key`.

use std::path::Path;
use std::sync::{Arc, Mutex};

use rusqlite::Connection;

use crate::error::{Error, Result};

/// Shared SQLite connection handle.
///
/// Cheap to clone — cloning bumps the `Arc` refcount; the underlying
/// `Connection` is not duplicated. Every clone locks the *same* mutex
/// when used, so reads and writes are serialised across all clones.
pub type SharedConnection = Arc<Mutex<Connection>>;

/// Length of a SQLCipher raw key, in hex characters (256-bit key = 32
/// bytes = 64 hex chars).
pub const DB_KEY_HEX_LEN: usize = 64;

/// Open the database at `path` and wrap it in a [`SharedConnection`].
///
/// This is the no-encryption variant — equivalent to
/// `open_shared_with_key(path, None)`. It exists for per-store seeding
/// helpers and tests; production code goes through the keyed variant.
pub fn open_shared(path: &str) -> Result<SharedConnection> {
    open_shared_with_key(path, None)
}

/// Open the database at `path` with an optional SQLCipher key.
///
/// When `key` is `Some(hex)`, the function:
/// 1. Validates `hex` is exactly 64 lowercase/uppercase hex
///    characters (= a 256-bit raw key).
/// 2. Opens the file.
/// 3. Issues `PRAGMA key = "x'<hex>'"` to install the cipher key.
/// 4. Probes `sqlite_master` to confirm the key works. If the probe
///    fails because the file is unencrypted plaintext, transparently
///    migrates it to encrypted via `sqlcipher_export` (see
///    `migrate_plaintext_in_place`).
///
/// When `key` is `None`, the function falls back to a plain
/// `Connection::open` with no PRAGMA key — used by per-store seeding
/// helpers and by tests that don't exercise encryption.
pub fn open_shared_with_key(path: &str, key: Option<&str>) -> Result<SharedConnection> {
    let Some(key) = key else {
        let conn = Connection::open(path).map_err(|e| Error::Database(e.to_string()))?;
        return Ok(Arc::new(Mutex::new(conn)));
    };
    validate_hex_key(key)?;

    let conn = Connection::open(path).map_err(|e| Error::Database(e.to_string()))?;
    apply_pragma_key(&conn, key)?;

    // Probe under the supplied key. Three possible outcomes:
    //   (a) success         → key matches an existing encrypted DB,
    //                         OR the file is fresh / empty and the
    //                         next write will be encrypted.
    //   (b) NotADatabase    → file exists with non-cipher bytes →
    //                         most likely a pre-encryption plaintext
    //                         DB → trigger one-shot migration.
    //   (c) any other error → corrupted / partial / different cipher
    //                         settings → bubble up.
    match conn.query_row::<i64, _, _>("SELECT count(*) FROM sqlite_master", [], |r| r.get(0)) {
        Ok(_) => Ok(Arc::new(Mutex::new(conn))),
        Err(e) => {
            // Drop the failed connection before touching the file on
            // disk. SQLite will hold a shared lock as long as `conn`
            // is alive.
            drop(conn);
            if file_looks_like_plaintext_sqlite(path) {
                migrate_plaintext_in_place(path, key)?;
                let conn = Connection::open(path).map_err(|e| Error::Database(e.to_string()))?;
                apply_pragma_key(&conn, key)?;
                // Re-probe; if this fails the migration silently went
                // wrong and we should not pretend the DB is usable.
                conn.query_row::<i64, _, _>("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))
                    .map_err(|e| {
                        Error::Database(format!(
                            "db migration completed but post-key probe failed: {e}"
                        ))
                    })?;
                Ok(Arc::new(Mutex::new(conn)))
            } else {
                Err(Error::Database(format!(
                    "db decryption failed (wrong key, corrupted file, or incompatible cipher settings): {e}"
                )))
            }
        }
    }
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

/// Validate that `key` is exactly 64 hex characters. SQLCipher
/// expects the `x'...'` literal to contain only hex digits and to be
/// 64 characters long (= a 256-bit raw cipher key). Anything else is
/// either a truncated key or accidentally-passed passphrase and
/// should fail fast rather than be silently passed to SQLCipher's
/// KDF (which would derive a different key from the same bytes).
fn validate_hex_key(key: &str) -> Result<()> {
    if key.len() != DB_KEY_HEX_LEN {
        return Err(Error::Database(format!(
            "db key must be {DB_KEY_HEX_LEN} hex characters, got {}",
            key.len()
        )));
    }
    if !key.bytes().all(|b| b.is_ascii_hexdigit()) {
        return Err(Error::Database(
            "db key must be ASCII hex digits only".to_string(),
        ));
    }
    Ok(())
}

/// Install the cipher key on `conn`. Uses the SQLCipher raw-key
/// `x'...'` literal so the KDF is bypassed; the supplied hex is the
/// final cipher key. We've already validated `key` is hex-safe, so
/// embedding it in the PRAGMA literal is not a SQL-injection risk.
fn apply_pragma_key(conn: &Connection, key: &str) -> Result<()> {
    conn.execute_batch(&format!("PRAGMA key = \"x'{key}'\";"))
        .map_err(|e| Error::Database(format!("PRAGMA key failed: {e}")))
}

/// Cheap heuristic to decide whether `path` is a plaintext SQLite
/// database (and therefore safe to migrate via `sqlcipher_export`).
///
/// The SQLite file format starts with the 16-byte magic
/// `"SQLite format 3\0"` (see <https://sqlite.org/fileformat.html>).
/// SQLCipher-encrypted databases scramble those bytes via the cipher,
/// so a header that matches the literal magic strongly implies the
/// file is plaintext.
///
/// Returns `false` for:
///  - missing files (a brand-new install)
///  - files shorter than 16 bytes (corrupted / WIP)
///  - files whose first 16 bytes are not the plaintext magic
fn file_looks_like_plaintext_sqlite(path: &str) -> bool {
    use std::io::Read;

    if !Path::new(path).exists() {
        return false;
    }
    let mut header = [0u8; 16];
    let Ok(mut f) = std::fs::File::open(path) else {
        return false;
    };
    // File shorter than 16 bytes — not a meaningful DB; we
    // shouldn't pretend it's plaintext-and-migratable.
    if f.read_exact(&mut header).is_err() {
        return false;
    }
    &header == b"SQLite format 3\0"
}

/// Migrate a plaintext SQLite database at `path` to encrypted in
/// place, using the supplied raw key. Steps:
///
/// 1. Open the plaintext DB (no PRAGMA key).
/// 2. `ATTACH DATABASE '<path>.encrypted' AS encrypted KEY "x'<hex>'";`
/// 3. `SELECT sqlcipher_export('encrypted');`
/// 4. `DETACH DATABASE encrypted;` then close the plaintext handle.
/// 5. Atomically swap the two files via `std::fs::rename`.
///
/// The original plaintext is overwritten by the rename. On error
/// before the rename, the original file is left untouched; the
/// half-written `<path>.encrypted` is best-effort cleaned up.
fn migrate_plaintext_in_place(path: &str, key: &str) -> Result<()> {
    let encrypted_path = format!("{path}.encrypted");
    // Best-effort cleanup of any leftover from a previous failed
    // attempt — we don't want sqlcipher_export to error on an
    // existing target. Ignoring the error: if the file genuinely
    // can't be removed, the ATTACH below will tell us.
    let _ = std::fs::remove_file(&encrypted_path);

    let conn = Connection::open(path).map_err(|e| Error::Database(e.to_string()))?;
    // Sanity-check the source is the plaintext DB we expect. A
    // failure here means our header heuristic was wrong and we
    // shouldn't proceed.
    conn.query_row::<i64, _, _>("SELECT count(*) FROM sqlite_master", [], |r| r.get(0))
        .map_err(|e| {
            Error::Database(format!(
                "plaintext probe failed during migration; aborting to avoid data loss: {e}"
            ))
        })?;

    // ATTACH … KEY uses the same `x'...'` raw-key literal as
    // PRAGMA key. We've already validated the hex shape before
    // calling this function, so embedding the key in SQL is safe.
    conn.execute_batch(&format!(
        "ATTACH DATABASE '{}' AS encrypted KEY \"x'{}'\";\nSELECT sqlcipher_export('encrypted');\nDETACH DATABASE encrypted;",
        encrypted_path.replace('\'', "''"),
        key
    ))
    .map_err(|e| {
        // Try to clean up the half-written encrypted file before
        // bubbling up.
        let _ = std::fs::remove_file(&encrypted_path);
        Error::Database(format!("sqlcipher_export failed: {e}"))
    })?;
    drop(conn);

    std::fs::rename(&encrypted_path, path).map_err(|e| {
        let _ = std::fs::remove_file(&encrypted_path);
        Error::Database(format!("rename encrypted db over plaintext failed: {e}"))
    })?;

    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Deterministic 32-byte raw key used by every encryption test in
    /// this module. Real keys are generated by Electron via
    /// `crypto.randomBytes(32)`.
    const TEST_KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const OTHER_KEY: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

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

    #[test]
    fn validate_hex_key_accepts_64_hex_chars() {
        assert!(validate_hex_key(TEST_KEY).is_ok());
        // Mixed-case is fine — SQLCipher's hex parser is
        // case-insensitive, and rejecting one case but not the other
        // would be a confusing failure mode for Electron callers.
        assert!(validate_hex_key(&TEST_KEY.to_uppercase()).is_ok());
    }

    #[test]
    fn validate_hex_key_rejects_wrong_length() {
        assert!(validate_hex_key("").is_err());
        assert!(validate_hex_key("abc").is_err());
        // 63 chars — one short.
        assert!(validate_hex_key(&"a".repeat(63)).is_err());
        // 65 chars — one too many.
        assert!(validate_hex_key(&"a".repeat(65)).is_err());
    }

    #[test]
    fn validate_hex_key_rejects_non_hex() {
        // Includes a non-hex byte (g).
        let mut bad = TEST_KEY.to_string();
        bad.replace_range(0..1, "g");
        assert!(validate_hex_key(&bad).is_err());
        // Unicode digit that's-not-ASCII: would pass char::is_alphanumeric
        // but not is_ascii_hexdigit. Pin the strict-ASCII guard.
        let mut bad2 = TEST_KEY.to_string();
        bad2.replace_range(0..1, "ä");
        assert!(validate_hex_key(&bad2).is_err());
    }

    #[test]
    fn encrypted_db_roundtrips_data() {
        // Open with a key, write, close, reopen with same key, read.
        // If PRAGMA key isn't taking effect we'd still pass this
        // because the writes-and-reads go through the same handle
        // session, so this also explicitly reopens.
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("encrypted.db");
        let db_path_str = db_path.to_str().unwrap();
        {
            let db = open_shared_with_key(db_path_str, Some(TEST_KEY)).expect("first open");
            let conn = db.lock().unwrap();
            conn.execute("CREATE TABLE secret (id INTEGER, val TEXT)", [])
                .unwrap();
            conn.execute(
                "INSERT INTO secret (id, val) VALUES (?1, ?2)",
                rusqlite::params![1, "the queen is dead"],
            )
            .unwrap();
        }
        let db = open_shared_with_key(db_path_str, Some(TEST_KEY)).expect("second open");
        let conn = db.lock().unwrap();
        let val: String = conn
            .query_row("SELECT val FROM secret WHERE id = 1", [], |r| r.get(0))
            .unwrap();
        assert_eq!(val, "the queen is dead");
    }

    #[test]
    fn encrypted_db_with_wrong_key_fails() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("wrong-key.db");
        let db_path_str = db_path.to_str().unwrap();
        {
            let db = open_shared_with_key(db_path_str, Some(TEST_KEY)).expect("create");
            let conn = db.lock().unwrap();
            conn.execute("CREATE TABLE t (id INTEGER)", []).unwrap();
            conn.execute("INSERT INTO t (id) VALUES (?1)", [1]).unwrap();
        }
        // Now try with a different key. The plaintext probe in
        // open_shared_with_key checks the file header — since the file
        // was created with a key, its header is not the SQLite magic,
        // so the migration path is skipped and we get a clean error.
        let err = open_shared_with_key(db_path_str, Some(OTHER_KEY)).expect_err("wrong key");
        match err {
            Error::Database(msg) => assert!(
                msg.contains("decryption failed") || msg.contains("file is not a database"),
                "unexpected error message: {msg}"
            ),
            other => panic!("expected Error::Database, got {other:?}"),
        }
    }

    #[test]
    fn encrypted_db_with_no_key_fails() {
        // Inverse of the previous test: a DB created with a key
        // cannot be opened without one.
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("no-key.db");
        let db_path_str = db_path.to_str().unwrap();
        {
            let db = open_shared_with_key(db_path_str, Some(TEST_KEY)).expect("create");
            let conn = db.lock().unwrap();
            conn.execute("CREATE TABLE t (id INTEGER)", []).unwrap();
        }
        // Open with key=None: the connection succeeds but the first
        // query will fail because the file is encrypted.
        let db = open_shared_with_key(db_path_str, None).expect("open without key");
        let conn = db.lock().unwrap();
        let result =
            conn.query_row::<i64, _, _>("SELECT count(*) FROM sqlite_master", [], |r| r.get(0));
        assert!(
            result.is_err(),
            "expected encrypted DB to fail without key, got {result:?}"
        );
    }

    #[test]
    fn plaintext_db_is_migrated_to_encrypted_on_first_open() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("plaintext-to-migrate.db");
        let db_path_str = db_path.to_str().unwrap();

        // Create a plaintext DB (key=None).
        {
            let db = open_shared_with_key(db_path_str, None).expect("create plaintext");
            let conn = db.lock().unwrap();
            conn.execute("CREATE TABLE patient (id INTEGER, name TEXT)", [])
                .unwrap();
            conn.execute(
                "INSERT INTO patient (id, name) VALUES (?1, ?2)",
                rusqlite::params![1, "Alice"],
            )
            .unwrap();
            conn.execute(
                "INSERT INTO patient (id, name) VALUES (?1, ?2)",
                rusqlite::params![2, "Bob"],
            )
            .unwrap();
        }
        assert!(
            file_looks_like_plaintext_sqlite(db_path_str),
            "precondition: file should be plaintext SQLite"
        );

        // Now open with a key. The migration should run transparently.
        {
            let db = open_shared_with_key(db_path_str, Some(TEST_KEY)).expect("open with key");
            let conn = db.lock().unwrap();
            let name: String = conn
                .query_row("SELECT name FROM patient WHERE id = 1", [], |r| r.get(0))
                .unwrap();
            assert_eq!(name, "Alice");
            let count: i64 = conn
                .query_row("SELECT count(*) FROM patient", [], |r| r.get(0))
                .unwrap();
            assert_eq!(count, 2);
        }

        // File should now be encrypted: opening without a key should
        // fail.
        assert!(
            !file_looks_like_plaintext_sqlite(db_path_str),
            "post-migration: file should no longer be plaintext"
        );

        // And opening with a different key should fail at open
        // time. The file's header is now cipher-scrambled, so the
        // plaintext heuristic in open_shared_with_key returns false
        // and we get the clean "decryption failed" error rather than
        // a lazy query failure.
        let err = open_shared_with_key(db_path_str, Some(OTHER_KEY))
            .expect_err("wrong key after migration");
        match err {
            Error::Database(msg) => assert!(
                msg.contains("decryption failed") || msg.contains("file is not a database"),
                "unexpected error after migration with wrong key: {msg}"
            ),
            other => panic!("expected Error::Database, got {other:?}"),
        }

        // No leftover `.encrypted` file from the migration.
        assert!(
            !Path::new(&format!("{db_path_str}.encrypted")).exists(),
            "migration should rename .encrypted over the original"
        );
    }

    #[test]
    fn fresh_db_opens_clean_with_key() {
        // A path that does not exist yet — common first-launch case.
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("brand-new.db");
        let db_path_str = db_path.to_str().unwrap();

        let db = open_shared_with_key(db_path_str, Some(TEST_KEY)).expect("first open");
        let conn = db.lock().unwrap();
        conn.execute("CREATE TABLE t (id INTEGER)", []).unwrap();
        conn.execute("INSERT INTO t (id) VALUES (?1)", [1]).unwrap();
        drop(conn);
        drop(db);

        // The file we wrote should be encrypted (post-write headers
        // are cipher-scrambled).
        assert!(
            !file_looks_like_plaintext_sqlite(db_path_str),
            "fresh DB with key should be encrypted"
        );
    }

    #[test]
    fn file_header_detection_skips_short_files() {
        let tmp = tempfile::tempdir().expect("tempdir");
        let path = tmp.path().join("tiny");
        std::fs::write(&path, b"abc").unwrap();
        assert!(!file_looks_like_plaintext_sqlite(path.to_str().unwrap()));
    }

    #[test]
    fn file_header_detection_returns_false_for_missing() {
        let path = "/nonexistent/path/should-not-exist-here.db";
        assert!(!file_looks_like_plaintext_sqlite(path));
    }

    #[test]
    fn key_validator_runs_before_open() {
        // A bad key should fail before we touch the filesystem,
        // proving validate_hex_key is the first thing
        // open_shared_with_key does.
        let tmp = tempfile::tempdir().expect("tempdir");
        let db_path = tmp.path().join("never-created.db");
        let db_path_str = db_path.to_str().unwrap();
        let err = open_shared_with_key(db_path_str, Some("nope")).expect_err("bad key");
        match err {
            Error::Database(msg) => assert!(
                msg.contains("64") || msg.contains("hex"),
                "expected validator error, got: {msg}"
            ),
            other => panic!("expected Error::Database, got {other:?}"),
        }
        assert!(
            !db_path.exists(),
            "bad-key open should not have touched the filesystem"
        );
    }
}
