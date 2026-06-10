//! Zero-config **local** backup & recovery for the SQLCipher database.
//!
//! This module is intentionally self-contained and cloud-free: every
//! operation reads or writes files on the user's own disk. The goal is
//! a no-ops safety net — if the user's disk develops bad sectors or
//! they fat-finger a delete, a recent hot copy of the encrypted
//! database is sitting in `<userData>/backups/`.
//!
//! # Hot backups of an encrypted database
//!
//! [`create_backup`] uses SQLite's **Online Backup API**
//! (`sqlite3_backup_init` / `_step` / `_finish`, surfaced by
//! [`rusqlite::backup::Backup`]) to copy the live database while the
//! app keeps running. The copy is page-consistent: SQLite takes a
//! read lock for the duration of the copy, so the backup reflects a
//! single committed snapshot rather than a smeared mid-write file.
//!
//! Because Tessera ships SQLCipher (see [`crate::db`]), the source
//! pages are encrypted. The Online Backup API copies *decrypted* pages
//! between two open connections, so the **destination connection must
//! be keyed with the same raw key** before the copy runs — otherwise
//! the backup file would be written as plaintext SQLite. We reuse the
//! exact `PRAGMA key = "x'<hex>'"` raw-key install [`crate::db`] uses
//! for the live connection, so a backup of an encrypted database is
//! itself encrypted at rest under the same key. A backup taken from an
//! unencrypted database (the headless / keyring-unavailable fallback)
//! is likewise unencrypted, matching the source's protection level.
//!
//! # Restore is staged, not in-place
//!
//! Overwriting the main database file while SQLite has it open is
//! unsafe. [`stage_restore`] therefore validates the chosen backup
//! (opens it under the key and runs `PRAGMA integrity_check`) and then
//! copies it to a sibling `*.pending-restore` file. The actual swap
//! happens at next launch via [`apply_pending_restore`], which the
//! bridge calls **before** it opens the database. This makes restore
//! crash-safe: a power loss between staging and applying leaves the
//! live database untouched, and the staged file is simply re-applied
//! (or discarded) on the next boot.
//!
//! # Workspace bundles
//!
//! [`export_bundle`] / [`import_bundle`] package the hot database copy
//! plus arbitrary sidecar files (model config, app settings JSON) into
//! a single `tar.gz` archive carrying a JSON manifest with per-entry
//! SHA-256 digests. Import verifies every digest before touching the
//! live workspace, stages the database via the same crash-safe path as
//! restore, and atomically replaces the sidecar files.

use std::fs;
use std::io::{Read, Write};
use std::path::{Path, PathBuf};
use std::time::Duration;

use chrono::{TimeZone, Utc};
use rusqlite::backup::{Backup, StepResult};
use rusqlite::Connection;
use serde::{Deserialize, Serialize};
use sha2::{Digest, Sha256};

use crate::db::{apply_pragma_key, run_integrity_check, validate_hex_key, SharedConnection};
use crate::error::{Error, Result};

/// Filename prefix shared by every timestamped backup file.
const BACKUP_FILE_PREFIX: &str = "tessera-backup-";
/// Extension for a completed backup (an encrypted SQLCipher database).
const BACKUP_FILE_EXT: &str = "tdbak";
/// Extension appended to the still-being-written temp file so a crash
/// mid-backup never leaves a truncated file that [`list_backups`]
/// would mistake for a usable backup.
const PARTIAL_SUFFIX: &str = "partial";
/// `chrono` format for the UTC timestamp embedded in a backup
/// filename. Millisecond precision keeps two backups taken in the same
/// second distinct, and the layout sorts lexicographically in
/// chronological order so a plain filename sort matches time order.
const BACKUP_TS_FMT: &str = "%Y%m%dT%H%M%S%3fZ";

/// Sibling-file suffix for a staged restore awaiting the next launch.
pub const PENDING_RESTORE_SUFFIX: &str = ".pending-restore";

/// On-disk format version stamped into a bundle manifest. Bumped only
/// on a breaking layout change so [`import_bundle`] can refuse an
/// archive it does not understand instead of silently mishandling it.
pub const BUNDLE_FORMAT_VERSION: u32 = 1;
/// Arcname of the database copy inside a bundle archive.
const BUNDLE_DB_ARCNAME: &str = "database.tdbak";
/// Arcname of the JSON manifest inside a bundle archive.
const BUNDLE_MANIFEST_ARCNAME: &str = "manifest.json";
/// Directory prefix under which sidecar files live inside a bundle.
const BUNDLE_EXTRA_PREFIX: &str = "extra/";

/// Pages copied per `sqlite3_backup_step` call. `-1` means "all
/// remaining pages in one locked step", which is the right tradeoff
/// for a single-user desktop database: the file is small, and copying
/// it in one shot avoids the repeated lock-acquire / sleep cycle
/// [`Backup::run_to_completion`] performs for large multi-user
/// databases.
const BACKUP_ALL_PAGES: i32 = -1;
/// Backoff before retrying a backup step that returned `BUSY` /
/// `LOCKED`. Transient under our single-writer model; a short sleep
/// lets the writer finish its statement.
const BACKUP_BUSY_RETRY: Duration = Duration::from_millis(25);
/// Read-buffer size for streaming files through the SHA-256 hasher and
/// the tar writer. 64 KiB balances syscall count against memory.
const COPY_BUF_LEN: usize = 64 * 1024;
/// Hard cap on a single bundle entry extracted from an untrusted
/// archive (128 MiB). Bounds the damage a maliciously-crafted bundle
/// can do (zip-bomb-style) before we notice. The database copy and the
/// small JSON sidecars are far below this.
const MAX_BUNDLE_ENTRY_BYTES: u64 = 128 * 1024 * 1024;

/// Metadata describing a single backup file on disk.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BackupInfo {
    /// Absolute path to the backup file.
    pub path: String,
    /// Bare filename (no directory), e.g.
    /// `tessera-backup-20260610T141100123Z.tdbak`.
    pub file_name: String,
    /// Creation time in milliseconds since the Unix epoch, parsed from
    /// the filename timestamp (falling back to the file's modified
    /// time if the name is non-standard).
    pub created_at_ms: i64,
    /// Size of the backup file in bytes.
    pub size_bytes: i64,
}

/// One entry recorded in a bundle manifest.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BundleManifestEntry {
    /// Path of the entry inside the archive.
    pub arcname: String,
    /// Logical role: `"database"`, or a caller-supplied tag such as
    /// `"model-config"` / `"settings"` for sidecar files.
    pub role: String,
    /// Uncompressed size in bytes.
    pub size_bytes: u64,
    /// Lowercase hex SHA-256 of the uncompressed bytes.
    pub sha256: String,
}

/// JSON manifest embedded in every bundle archive.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BundleManifest {
    /// See [`BUNDLE_FORMAT_VERSION`].
    pub format_version: u32,
    /// Bundle creation time, milliseconds since the Unix epoch.
    pub created_at_ms: i64,
    /// Optional application version string for diagnostics.
    #[serde(default)]
    pub app_version: Option<String>,
    /// Whether the contained database copy is SQLCipher-encrypted.
    pub encrypted: bool,
    /// Per-entry descriptors (database first, then sidecars).
    pub entries: Vec<BundleManifestEntry>,
}

/// A sidecar file to fold into a bundle on export.
#[derive(Debug, Clone)]
pub struct BundleSource {
    /// Logical role tag, recorded in the manifest.
    pub role: String,
    /// Stable name used inside the archive (no directory component).
    pub arcname: String,
    /// Absolute path of the file to read.
    pub path: PathBuf,
}

/// A sidecar file target to restore on import, matched by arcname.
#[derive(Debug, Clone)]
pub struct BundleTarget {
    /// Archive name to look for (matches a [`BundleSource::arcname`]).
    pub arcname: String,
    /// Absolute path the file is written to (atomically) on import.
    pub path: PathBuf,
}

/// Result of [`export_bundle`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BundleInfo {
    /// Absolute path to the written `.tessera-backup` archive.
    pub path: String,
    /// Size of the archive in bytes.
    pub size_bytes: i64,
    /// Number of entries (database + sidecars) packed.
    pub entry_count: u32,
}

/// Outcome of [`import_bundle`].
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct BundleImportReport {
    /// Absolute path of the staged `*.pending-restore` database file.
    pub staged_db_path: String,
    /// Absolute paths of the sidecar files replaced on disk.
    pub restored_files: Vec<String>,
}

// --- Backup creation ---------------------------------------------------

/// Hot-copy the live database in `source` to a new timestamped file in
/// `backup_dir` using the SQLite Online Backup API.
///
/// `key`, when `Some`, is the 64-char hex SQLCipher key the live
/// connection was opened with; the destination is keyed with the same
/// value so the backup is encrypted at rest. Pass `None` only when the
/// source database is itself unencrypted.
///
/// The copy is written to a `*.partial` temp file first and atomically
/// renamed to its final `*.tdbak` name on success, so a crash never
/// leaves a half-written file that [`list_backups`] would surface.
pub fn create_backup(
    source: &SharedConnection,
    key: Option<&str>,
    backup_dir: &Path,
) -> Result<BackupInfo> {
    if let Some(k) = key {
        validate_hex_key(k)?;
    }
    fs::create_dir_all(backup_dir).map_err(Error::Io)?;

    let now = Utc::now();
    let file_name = format!(
        "{BACKUP_FILE_PREFIX}{}.{BACKUP_FILE_EXT}",
        now.format(BACKUP_TS_FMT)
    );
    let final_path = backup_dir.join(&file_name);
    let partial_path = backup_dir.join(format!("{file_name}.{PARTIAL_SUFFIX}"));

    // Clean any leftover partial from a previously-crashed run at the
    // exact same millisecond (astronomically unlikely, but cheap).
    let _ = fs::remove_file(&partial_path);

    backup_db_to_file(source, key, &partial_path)?;

    fs::rename(&partial_path, &final_path).map_err(|e| {
        let _ = fs::remove_file(&partial_path);
        Error::Backup(format!(
            "failed to finalize backup {}: {e}",
            final_path.display()
        ))
    })?;

    let size_bytes = fs::metadata(&final_path).map_err(Error::Io)?.len() as i64;
    Ok(BackupInfo {
        path: path_to_string(&final_path)?,
        file_name,
        created_at_ms: now.timestamp_millis(),
        size_bytes,
    })
}

/// Copy the database behind `source` into a fresh file at `dest_path`
/// using the Online Backup API, keying the destination with `key`.
///
/// Shared by [`create_backup`] and [`export_bundle`]. The destination
/// is opened in the default (rollback-journal) mode and never switched
/// to WAL, so the result is a single self-contained file with no
/// `-wal` / `-shm` companions — exactly what a backup should be.
fn backup_db_to_file(source: &SharedConnection, key: Option<&str>, dest_path: &Path) -> Result<()> {
    let mut dest = Connection::open(dest_path)
        .map_err(|e| Error::Backup(format!("open backup dest {}: {e}", dest_path.display())))?;
    if let Some(k) = key {
        // Same raw-key install as the live connection so the copied
        // pages are re-encrypted under the user's key on the way out.
        apply_pragma_key(&dest, k)?;
    }

    // The source lock is held for the whole `step` loop — including the
    // brief `BACKUP_BUSY_RETRY` sleeps below. This is required, not
    // incidental: the `Backup` handle borrows `src_guard`, and SQLite's
    // Online Backup API needs the source connection to stay live across
    // steps. In Tessera's single-writer / shared-connection model the
    // only contender for this lock is the app's own request path, and a
    // hot copy with `BACKUP_ALL_PAGES` normally finishes in one step, so
    // the retry sleeps are rare and short. Releasing the lock mid-copy
    // would mean dropping the handle and restarting the backup, so we
    // deliberately hold it through the loop.
    let src_guard = source
        .lock()
        .map_err(|e| Error::Backup(format!("source connection lock poisoned: {e}")))?;

    let backup = Backup::new(&src_guard, &mut dest)
        .map_err(|e| Error::Backup(format!("backup_init failed: {e}")))?;

    loop {
        match backup
            .step(BACKUP_ALL_PAGES)
            .map_err(|e| Error::Backup(format!("backup_step failed: {e}")))?
        {
            StepResult::Done => break,
            // `-1` copies everything in one step, but a concurrent
            // writer can still force a retry; handle all non-Done
            // results defensively rather than asserting Done.
            StepResult::More => continue,
            // `StepResult` is `#[non_exhaustive]`; Busy/Locked are the
            // only other documented variants and any future transient
            // result is treated the same way — back off and retry.
            StepResult::Busy | StepResult::Locked => std::thread::sleep(BACKUP_BUSY_RETRY),
            _ => std::thread::sleep(BACKUP_BUSY_RETRY),
        }
    }

    // `Backup`'s Drop calls `sqlite3_backup_finish`; drop it (and the
    // source guard) before the destination connection closes so the
    // file handle is flushed and released in order.
    drop(backup);
    drop(src_guard);
    dest.close()
        .map_err(|(_, e)| Error::Backup(format!("close backup dest: {e}")))?;
    Ok(())
}

// --- Listing & pruning -------------------------------------------------

/// List the backup files in `backup_dir`, newest first.
///
/// Returns an empty vector (not an error) when the directory does not
/// exist yet — a fresh install simply has no backups. `*.partial`
/// temp files and any non-`.tdbak` entries are skipped.
pub fn list_backups(backup_dir: &Path) -> Result<Vec<BackupInfo>> {
    if !backup_dir.exists() {
        return Ok(Vec::new());
    }
    let mut out = Vec::new();
    for entry in fs::read_dir(backup_dir).map_err(Error::Io)? {
        let entry = entry.map_err(Error::Io)?;
        let path = entry.path();
        if !path.is_file() {
            continue;
        }
        let Some(file_name) = path.file_name().and_then(|n| n.to_str()) else {
            continue;
        };
        if !is_backup_file_name(file_name) {
            continue;
        }
        let meta = entry.metadata().map_err(Error::Io)?;
        let created_at_ms = backup_created_at_ms(file_name, &meta);
        out.push(BackupInfo {
            path: path_to_string(&path)?,
            file_name: file_name.to_string(),
            created_at_ms,
            size_bytes: meta.len() as i64,
        });
    }
    // Newest first; tie-break on filename so the order is deterministic
    // for two backups that somehow share a millisecond.
    out.sort_by(|a, b| {
        b.created_at_ms
            .cmp(&a.created_at_ms)
            .then_with(|| b.file_name.cmp(&a.file_name))
    });
    Ok(out)
}

/// Delete backups beyond the `keep` most-recent, returning the paths
/// removed.
///
/// `keep == 0` is treated as "retain at least one" rather than wiping
/// every backup: a retention setting should never be able to destroy
/// the user's entire safety net. (`backup:configure` already bounds
/// the UI value to 1..=30; this is defence-in-depth for a corrupt
/// config or a direct API caller.)
pub fn prune_backups(backup_dir: &Path, keep: usize) -> Result<Vec<String>> {
    let keep = keep.max(1);
    let backups = list_backups(backup_dir)?;
    if backups.len() <= keep {
        return Ok(Vec::new());
    }
    let mut removed = Vec::new();
    for old in &backups[keep..] {
        fs::remove_file(&old.path).map_err(Error::Io)?;
        removed.push(old.path.clone());
    }
    Ok(removed)
}

// --- Restore -----------------------------------------------------------

/// Validate `backup_path` under `key` and stage it for restore on the
/// next launch, returning the staged `*.pending-restore` path.
///
/// The backup is opened with the key and run through
/// `PRAGMA integrity_check` **before** anything on the live workspace
/// is touched, so a corrupt or wrong-key backup is rejected without
/// risking the running database. The validated bytes are then copied
/// to `<db_path>.pending-restore` via a temp-file + atomic rename.
///
/// The caller is expected to relaunch the app; [`apply_pending_restore`]
/// performs the actual swap at next boot, before the database is
/// opened.
pub fn stage_restore(backup_path: &Path, db_path: &Path, key: Option<&str>) -> Result<String> {
    validate_backup_file(backup_path, key)?;

    let staged = pending_restore_path(db_path);
    atomic_copy(backup_path, &staged)?;
    path_to_string(&staged)
}

/// If a `<db_path>.pending-restore` file exists, atomically swap it
/// into place as the live database and drop any stale `-wal` / `-shm`
/// sidecars. Returns `true` when a restore was applied.
///
/// Call this once at startup **before** opening the database. The
/// staged file was already integrity-checked by [`stage_restore`] /
/// [`import_bundle`], so this step is a pure filesystem move and is
/// safe to run unconditionally on every boot.
pub fn apply_pending_restore(db_path: &Path) -> Result<bool> {
    let staged = pending_restore_path(db_path);
    if !staged.exists() {
        return Ok(false);
    }
    // Remove the live WAL/SHM first: they describe the *old* database
    // and replaying them against the restored main file would corrupt
    // it. The restored backup is a single rollback-journal file with no
    // pending WAL of its own.
    remove_sqlite_sidecars(db_path);
    fs::rename(&staged, db_path).map_err(|e| {
        Error::Backup(format!(
            "failed to apply staged restore {} -> {}: {e}",
            staged.display(),
            db_path.display()
        ))
    })?;
    Ok(true)
}

/// Open `backup_path` under `key` and confirm it is a healthy
/// database via `PRAGMA integrity_check`.
fn validate_backup_file(backup_path: &Path, key: Option<&str>) -> Result<()> {
    if !backup_path.is_file() {
        return Err(Error::Backup(format!(
            "backup file not found: {}",
            backup_path.display()
        )));
    }
    if let Some(k) = key {
        validate_hex_key(k)?;
    }
    let conn = Connection::open(backup_path)
        .map_err(|e| Error::Backup(format!("open backup {}: {e}", backup_path.display())))?;
    if let Some(k) = key {
        apply_pragma_key(&conn, k)?;
    }
    // A wrong key or a truncated/corrupt file surfaces here as a
    // decode failure rather than passing silently.
    run_integrity_check(&conn).map_err(|e| {
        Error::Backup(format!(
            "backup failed validation (wrong key or corrupt file): {e}"
        ))
    })?;
    conn.close()
        .map_err(|(_, e)| Error::Backup(format!("close validated backup: {e}")))?;
    Ok(())
}

// --- Bundles -----------------------------------------------------------

/// Export a full workspace bundle: a hot database copy plus the given
/// sidecar files, packed into a `tar.gz` archive at `out_path` with a
/// JSON manifest carrying per-entry SHA-256 digests.
pub fn export_bundle(
    source: &SharedConnection,
    key: Option<&str>,
    extras: &[BundleSource],
    out_path: &Path,
) -> Result<BundleInfo> {
    if let Some(k) = key {
        validate_hex_key(k)?;
    }
    if let Some(parent) = out_path.parent() {
        fs::create_dir_all(parent).map_err(Error::Io)?;
    }

    // Stage the hot database copy next to the output archive so we can
    // hash it and stream it into the tar without holding the source
    // lock during compression.
    let tmp_db = out_path.with_extension("bundle-db.partial");
    let _ = fs::remove_file(&tmp_db);

    // Run the hot copy and everything that follows inside a closure so
    // the `tmp_db` cleanup below executes on *every* exit path,
    // including an early failure of `backup_db_to_file` itself. Without
    // this the partial copy would leak on disk after a failed export
    // (only reclaimed on the next attempt).
    let result = (|| -> Result<BundleInfo> {
        backup_db_to_file(source, key, &tmp_db)?;
        let mut entries = Vec::new();
        let db_sha = sha256_file(&tmp_db)?;
        let db_size = fs::metadata(&tmp_db).map_err(Error::Io)?.len();
        entries.push(BundleManifestEntry {
            arcname: BUNDLE_DB_ARCNAME.to_string(),
            role: "database".to_string(),
            size_bytes: db_size,
            sha256: db_sha,
        });
        for src in extras {
            let arcname = format!("{BUNDLE_EXTRA_PREFIX}{}", src.arcname);
            let sha = sha256_file(&src.path)?;
            let size = fs::metadata(&src.path).map_err(Error::Io)?.len();
            entries.push(BundleManifestEntry {
                arcname,
                role: src.role.clone(),
                size_bytes: size,
                sha256: sha,
            });
        }

        let manifest = BundleManifest {
            format_version: BUNDLE_FORMAT_VERSION,
            created_at_ms: Utc::now().timestamp_millis(),
            app_version: None,
            encrypted: key.is_some(),
            entries: entries.clone(),
        };
        let manifest_json =
            serde_json::to_vec_pretty(&manifest).map_err(|e| Error::Backup(e.to_string()))?;

        write_bundle_archive(out_path, &manifest_json, &tmp_db, extras)?;

        let size_bytes = fs::metadata(out_path).map_err(Error::Io)?.len() as i64;
        Ok(BundleInfo {
            path: path_to_string(out_path)?,
            size_bytes,
            entry_count: entries.len() as u32,
        })
    })();

    let _ = fs::remove_file(&tmp_db);
    result
}

/// Stream the manifest, database copy, and sidecar files into a
/// `tar.gz` archive at `out_path`.
fn write_bundle_archive(
    out_path: &Path,
    manifest_json: &[u8],
    db_path: &Path,
    extras: &[BundleSource],
) -> Result<()> {
    let file = fs::File::create(out_path).map_err(Error::Io)?;
    let gz = flate2::write::GzEncoder::new(file, flate2::Compression::default());
    let mut tar = tar::Builder::new(gz);

    // Manifest first so a streaming reader can learn the layout before
    // it reaches the payload.
    append_tar_bytes(&mut tar, BUNDLE_MANIFEST_ARCNAME, manifest_json)?;
    append_tar_file(&mut tar, BUNDLE_DB_ARCNAME, db_path)?;
    for src in extras {
        let arcname = format!("{BUNDLE_EXTRA_PREFIX}{}", src.arcname);
        append_tar_file(&mut tar, &arcname, &src.path)?;
    }

    let gz = tar
        .into_inner()
        .map_err(|e| Error::Backup(format!("finalize tar: {e}")))?;
    gz.finish()
        .map_err(|e| Error::Backup(format!("finalize gzip: {e}")))?
        .sync_all()
        .map_err(Error::Io)?;
    Ok(())
}

/// Import a workspace bundle: verify every entry's SHA-256 against the
/// manifest, stage the database for a crash-safe restore, and
/// atomically replace the requested sidecar files.
///
/// `extra_targets` maps archive sidecar names to on-disk destinations;
/// only the named targets present in the archive are written, and any
/// extra archive entries are ignored. The contained database is staged
/// (not applied) — the caller relaunches and [`apply_pending_restore`]
/// completes the swap at next boot.
pub fn import_bundle(
    bundle_path: &Path,
    db_path: &Path,
    extra_targets: &[BundleTarget],
    key: Option<&str>,
) -> Result<BundleImportReport> {
    if let Some(k) = key {
        validate_hex_key(k)?;
    }
    let manifest = read_bundle_manifest(bundle_path)?;
    if manifest.format_version != BUNDLE_FORMAT_VERSION {
        return Err(Error::Backup(format!(
            "unsupported bundle format version {} (expected {BUNDLE_FORMAT_VERSION})",
            manifest.format_version
        )));
    }

    // Extract every payload entry to a sibling staging directory,
    // verifying SHA-256 as we stream. Nothing on the live workspace is
    // touched until all digests check out.
    let staging_dir = bundle_staging_dir(db_path);
    let _ = fs::remove_dir_all(&staging_dir);
    fs::create_dir_all(&staging_dir).map_err(Error::Io)?;

    let result = (|| -> Result<BundleImportReport> {
        let extracted = extract_and_verify(bundle_path, &manifest, &staging_dir)?;

        let staged_db_src = extracted
            .get(BUNDLE_DB_ARCNAME)
            .ok_or_else(|| Error::Backup("bundle is missing its database entry".to_string()))?;
        // Validate the extracted database opens under the key and is
        // structurally sound before staging it for restore.
        validate_backup_file(staged_db_src, key)?;
        let staged_db = pending_restore_path(db_path);
        atomic_copy(staged_db_src, &staged_db)?;

        let mut restored_files = Vec::new();
        for target in extra_targets {
            let arcname = format!("{BUNDLE_EXTRA_PREFIX}{}", target.arcname);
            if let Some(src) = extracted.get(&arcname) {
                if let Some(parent) = target.path.parent() {
                    fs::create_dir_all(parent).map_err(Error::Io)?;
                }
                atomic_copy(src, &target.path)?;
                restored_files.push(path_to_string(&target.path)?);
            }
        }

        Ok(BundleImportReport {
            staged_db_path: path_to_string(&staged_db)?,
            restored_files,
        })
    })();

    let _ = fs::remove_dir_all(&staging_dir);
    result
}

/// Read and parse just the manifest entry from a bundle archive.
fn read_bundle_manifest(bundle_path: &Path) -> Result<BundleManifest> {
    let mut archive = open_bundle_archive(bundle_path)?;
    for entry in archive
        .entries()
        .map_err(|e| Error::Backup(format!("read bundle entries: {e}")))?
    {
        let mut entry = entry.map_err(|e| Error::Backup(format!("read bundle entry: {e}")))?;
        let path = entry
            .path()
            .map_err(|e| Error::Backup(format!("bundle entry path: {e}")))?;
        if path.to_str() == Some(BUNDLE_MANIFEST_ARCNAME) {
            let mut buf = Vec::new();
            bounded_read_to_end(&mut entry, &mut buf)?;
            return serde_json::from_slice(&buf)
                .map_err(|e| Error::Backup(format!("parse bundle manifest: {e}")));
        }
    }
    Err(Error::Backup(
        "bundle is missing its manifest.json".to_string(),
    ))
}

/// Extract every payload entry to `dest_dir`, verifying each against
/// its manifest SHA-256. Returns a map of arcname -> extracted path.
fn extract_and_verify(
    bundle_path: &Path,
    manifest: &BundleManifest,
    dest_dir: &Path,
) -> Result<std::collections::HashMap<String, PathBuf>> {
    use std::collections::HashMap;

    let mut expected: HashMap<&str, &BundleManifestEntry> = HashMap::new();
    for e in &manifest.entries {
        expected.insert(e.arcname.as_str(), e);
    }

    let mut out: HashMap<String, PathBuf> = HashMap::new();
    let mut archive = open_bundle_archive(bundle_path)?;
    for entry in archive
        .entries()
        .map_err(|e| Error::Backup(format!("read bundle entries: {e}")))?
    {
        let mut entry = entry.map_err(|e| Error::Backup(format!("read bundle entry: {e}")))?;
        let arcname = entry
            .path()
            .map_err(|e| Error::Backup(format!("bundle entry path: {e}")))?
            .to_string_lossy()
            .into_owned();
        if arcname == BUNDLE_MANIFEST_ARCNAME {
            continue;
        }
        let Some(meta) = expected.get(arcname.as_str()) else {
            // Entry not described by the manifest — refuse rather than
            // silently extracting an unverified file.
            return Err(Error::Backup(format!(
                "bundle entry {arcname} is absent from the manifest"
            )));
        };
        // Guard against path traversal: arcnames are flat names we
        // generated on export, never absolute or `..`-bearing.
        let safe_name = sanitize_arcname(&arcname)?;
        let dest = dest_dir.join(safe_name);
        if let Some(parent) = dest.parent() {
            fs::create_dir_all(parent).map_err(Error::Io)?;
        }

        let mut buf = Vec::new();
        bounded_read_to_end(&mut entry, &mut buf)?;
        let actual = sha256_bytes(&buf);
        if actual != meta.sha256 {
            return Err(Error::Backup(format!(
                "bundle entry {arcname} failed integrity check (sha256 mismatch)"
            )));
        }
        if buf.len() as u64 != meta.size_bytes {
            return Err(Error::Backup(format!(
                "bundle entry {arcname} size mismatch (manifest {}, actual {})",
                meta.size_bytes,
                buf.len()
            )));
        }
        fs::write(&dest, &buf).map_err(Error::Io)?;
        out.insert(arcname, dest);
    }
    Ok(out)
}

/// Open a `.tessera-backup` archive for reading (gzip → tar).
fn open_bundle_archive(
    bundle_path: &Path,
) -> Result<tar::Archive<flate2::read::GzDecoder<fs::File>>> {
    let file = fs::File::open(bundle_path)
        .map_err(|e| Error::Backup(format!("open bundle {}: {e}", bundle_path.display())))?;
    let gz = flate2::read::GzDecoder::new(file);
    Ok(tar::Archive::new(gz))
}

// --- Small helpers -----------------------------------------------------

/// Append in-memory bytes to a tar archive under `arcname`.
fn append_tar_bytes<W: Write>(
    tar: &mut tar::Builder<W>,
    arcname: &str,
    bytes: &[u8],
) -> Result<()> {
    let mut header = tar::Header::new_gnu();
    header.set_size(bytes.len() as u64);
    header.set_mode(0o600);
    header.set_mtime(Utc::now().timestamp().max(0) as u64);
    header.set_cksum();
    tar.append_data(&mut header, arcname, bytes)
        .map_err(|e| Error::Backup(format!("append {arcname} to tar: {e}")))
}

/// Append an on-disk file to a tar archive under `arcname`.
fn append_tar_file<W: Write>(tar: &mut tar::Builder<W>, arcname: &str, path: &Path) -> Result<()> {
    let mut file = fs::File::open(path)
        .map_err(|e| Error::Backup(format!("open {} for bundle: {e}", path.display())))?;
    tar.append_file(arcname, &mut file)
        .map_err(|e| Error::Backup(format!("append {arcname} to tar: {e}")))
}

/// Read an archive entry into `buf`, refusing entries larger than
/// [`MAX_BUNDLE_ENTRY_BYTES`] to bound memory use on a hostile archive.
fn bounded_read_to_end<R: Read>(reader: &mut R, buf: &mut Vec<u8>) -> Result<()> {
    let mut limited = reader.take(MAX_BUNDLE_ENTRY_BYTES + 1);
    limited.read_to_end(buf).map_err(Error::Io)?;
    if buf.len() as u64 > MAX_BUNDLE_ENTRY_BYTES {
        return Err(Error::Backup(format!(
            "bundle entry exceeds {MAX_BUNDLE_ENTRY_BYTES} byte limit"
        )));
    }
    Ok(())
}

/// Reject arcnames that are absolute or contain parent-dir components,
/// returning a flat, safe filename to use under the staging dir.
fn sanitize_arcname(arcname: &str) -> Result<String> {
    let candidate = Path::new(arcname);
    for comp in candidate.components() {
        match comp {
            std::path::Component::Normal(_) => {}
            _ => {
                return Err(Error::Backup(format!(
                    "unsafe bundle entry path: {arcname}"
                )))
            }
        }
    }
    // Flatten `extra/foo.json` -> `extra__foo.json` so the staging dir
    // stays one level deep and collisions across roles are impossible.
    Ok(arcname.replace('/', "__"))
}

/// Streaming SHA-256 of a file, returned as lowercase hex.
fn sha256_file(path: &Path) -> Result<String> {
    let mut file = fs::File::open(path).map_err(Error::Io)?;
    let mut hasher = Sha256::new();
    let mut buf = vec![0u8; COPY_BUF_LEN];
    loop {
        let n = file.read(&mut buf).map_err(Error::Io)?;
        if n == 0 {
            break;
        }
        hasher.update(&buf[..n]);
    }
    Ok(hex_lower(&hasher.finalize()))
}

/// SHA-256 of an in-memory buffer, returned as lowercase hex.
fn sha256_bytes(bytes: &[u8]) -> String {
    let mut hasher = Sha256::new();
    hasher.update(bytes);
    hex_lower(&hasher.finalize())
}

/// Lowercase hex-encode a byte slice without pulling in a hex crate.
fn hex_lower(bytes: &[u8]) -> String {
    use std::fmt::Write as _;
    let mut s = String::with_capacity(bytes.len() * 2);
    for b in bytes {
        let _ = write!(s, "{b:02x}");
    }
    s
}

/// Copy `src` to `dest` via a temp file + atomic rename so a reader of
/// `dest` never observes a partially-written file.
fn atomic_copy(src: &Path, dest: &Path) -> Result<()> {
    if let Some(parent) = dest.parent() {
        fs::create_dir_all(parent).map_err(Error::Io)?;
    }
    let tmp = dest.with_extension(format!(
        "{}.copytmp",
        dest.extension().and_then(|e| e.to_str()).unwrap_or("tmp")
    ));
    let _ = fs::remove_file(&tmp);
    fs::copy(src, &tmp).map_err(Error::Io)?;
    // Best-effort flush of the temp file before the rename so the
    // rename publishes durable bytes.
    if let Ok(f) = fs::File::open(&tmp) {
        let _ = f.sync_all();
    }
    fs::rename(&tmp, dest).map_err(|e| {
        let _ = fs::remove_file(&tmp);
        Error::Backup(format!(
            "atomic copy {} -> {} failed: {e}",
            src.display(),
            dest.display()
        ))
    })?;
    Ok(())
}

/// Remove the `-wal` and `-shm` sidecar files associated with a SQLite
/// database path. Best-effort: missing files are not an error.
fn remove_sqlite_sidecars(db_path: &Path) {
    for suffix in ["-wal", "-shm"] {
        let mut p = db_path.as_os_str().to_os_string();
        p.push(suffix);
        let _ = fs::remove_file(PathBuf::from(p));
    }
}

/// Sibling staging path for a pending restore of `db_path`.
fn pending_restore_path(db_path: &Path) -> PathBuf {
    let mut p = db_path.as_os_str().to_os_string();
    p.push(PENDING_RESTORE_SUFFIX);
    PathBuf::from(p)
}

/// Sibling staging directory used while extracting a bundle.
fn bundle_staging_dir(db_path: &Path) -> PathBuf {
    let mut p = db_path.as_os_str().to_os_string();
    p.push(".bundle-staging");
    PathBuf::from(p)
}

/// Whether `file_name` is a completed backup (correct prefix + ext,
/// not a `*.partial` temp).
fn is_backup_file_name(file_name: &str) -> bool {
    file_name.starts_with(BACKUP_FILE_PREFIX)
        && Path::new(file_name).extension().and_then(|e| e.to_str()) == Some(BACKUP_FILE_EXT)
}

/// Derive a backup's creation time. Prefer the timestamp embedded in
/// the filename; fall back to the filesystem modified time when the
/// name does not parse (e.g. a manually-renamed file).
fn backup_created_at_ms(file_name: &str, meta: &fs::Metadata) -> i64 {
    if let Some(ms) = parse_backup_ts_ms(file_name) {
        return ms;
    }
    meta.modified()
        .ok()
        .and_then(|t| t.duration_since(std::time::UNIX_EPOCH).ok())
        .map_or(0, |d| d.as_millis() as i64)
}

/// Parse the embedded `%Y%m%dT%H%M%S%3fZ` timestamp out of a backup
/// filename into epoch milliseconds.
fn parse_backup_ts_ms(file_name: &str) -> Option<i64> {
    let stem = file_name.strip_prefix(BACKUP_FILE_PREFIX)?;
    let stem = stem.strip_suffix(&format!(".{BACKUP_FILE_EXT}"))?;
    let naive = chrono::NaiveDateTime::parse_from_str(stem, BACKUP_TS_FMT).ok()?;
    Some(Utc.from_utc_datetime(&naive).timestamp_millis())
}

/// Convert a path to an owned `String`, erroring on non-UTF-8 paths
/// (Tessera's userData paths are always UTF-8 on every target).
fn path_to_string(path: &Path) -> Result<String> {
    path.to_str()
        .map(ToString::to_string)
        .ok_or_else(|| Error::Backup(format!("non-UTF-8 path: {}", path.display())))
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::open_shared_with_key;
    use rusqlite::params;

    const TEST_KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
    const WRONG_KEY: &str = "fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210";

    fn seed_db(path: &Path, key: Option<&str>, rows: &[(i64, &str)]) -> SharedConnection {
        let conn = open_shared_with_key(path.to_str().unwrap(), key).expect("open db");
        {
            let guard = conn.lock().unwrap();
            guard
                .execute_batch(
                    "CREATE TABLE IF NOT EXISTS notes (id INTEGER PRIMARY KEY, body TEXT)",
                )
                .unwrap();
            for (id, body) in rows {
                guard
                    .execute(
                        "INSERT INTO notes (id, body) VALUES (?1, ?2)",
                        params![id, body],
                    )
                    .unwrap();
            }
        }
        conn
    }

    fn count_rows(path: &Path, key: Option<&str>) -> i64 {
        let conn = open_shared_with_key(path.to_str().unwrap(), key).expect("open db");
        let guard = conn.lock().unwrap();
        guard
            .query_row("SELECT count(*) FROM notes", [], |r| r.get(0))
            .unwrap()
    }

    #[test]
    fn create_and_restore_round_trip_encrypted() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("tessera.db");
        let backup_dir = dir.path().join("backups");
        let conn = seed_db(&db_path, Some(TEST_KEY), &[(1, "alpha"), (2, "beta")]);

        let info = create_backup(&conn, Some(TEST_KEY), &backup_dir).expect("create");
        assert!(info.size_bytes > 0);
        assert!(Path::new(&info.path).is_file());
        assert_eq!(
            Path::new(&info.file_name)
                .extension()
                .and_then(|e| e.to_str()),
            Some(BACKUP_FILE_EXT)
        );

        // Mutate the live DB after the backup so we can prove the
        // restore reverts to the snapshot.
        {
            let guard = conn.lock().unwrap();
            guard
                .execute("INSERT INTO notes (id, body) VALUES (3, 'gamma')", [])
                .unwrap();
        }
        assert_eq!(count_rows(&db_path, Some(TEST_KEY)), 3);

        // Drop the live connection so the swap can replace the file.
        drop(conn);

        let staged = stage_restore(Path::new(&info.path), &db_path, Some(TEST_KEY)).expect("stage");
        assert!(Path::new(&staged).is_file());
        assert!(apply_pending_restore(&db_path).expect("apply"));
        assert!(!Path::new(&staged).exists());

        // Restored snapshot has the original two rows, not three.
        assert_eq!(count_rows(&db_path, Some(TEST_KEY)), 2);
    }

    #[test]
    fn backup_is_encrypted_at_rest() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("tessera.db");
        let backup_dir = dir.path().join("backups");
        let conn = seed_db(&db_path, Some(TEST_KEY), &[(1, "secret-body")]);
        let info = create_backup(&conn, Some(TEST_KEY), &backup_dir).expect("create");

        // The backup must NOT be plaintext SQLite, and the secret body
        // must not appear in the raw bytes.
        let bytes = fs::read(&info.path).unwrap();
        assert_ne!(&bytes[..16], b"SQLite format 3\0");
        assert!(!bytes.windows(11).any(|w| w == b"secret-body"));

        // Wrong key fails validation; correct key passes.
        assert!(validate_backup_file(Path::new(&info.path), Some(WRONG_KEY)).is_err());
        assert!(validate_backup_file(Path::new(&info.path), Some(TEST_KEY)).is_ok());
    }

    #[test]
    fn prune_keeps_newest_and_floor_of_one() {
        let dir = tempfile::tempdir().unwrap();
        let backup_dir = dir.path().join("backups");
        fs::create_dir_all(&backup_dir).unwrap();
        // Hand-create five backups with increasing timestamps.
        let names = [
            "tessera-backup-20260101T000000000Z.tdbak",
            "tessera-backup-20260102T000000000Z.tdbak",
            "tessera-backup-20260103T000000000Z.tdbak",
            "tessera-backup-20260104T000000000Z.tdbak",
            "tessera-backup-20260105T000000000Z.tdbak",
        ];
        for n in names {
            fs::write(backup_dir.join(n), b"x").unwrap();
        }
        // A partial temp must be ignored by listing.
        fs::write(
            backup_dir.join("tessera-backup-20260106T000000000Z.tdbak.partial"),
            b"x",
        )
        .unwrap();

        let listed = list_backups(&backup_dir).unwrap();
        assert_eq!(listed.len(), 5);
        // Newest first.
        assert_eq!(listed[0].file_name, names[4]);

        let removed = prune_backups(&backup_dir, 2).unwrap();
        assert_eq!(removed.len(), 3);
        let remaining = list_backups(&backup_dir).unwrap();
        assert_eq!(remaining.len(), 2);
        assert_eq!(remaining[0].file_name, names[4]);
        assert_eq!(remaining[1].file_name, names[3]);

        // keep == 0 is treated as 1 (never wipe everything).
        let removed2 = prune_backups(&backup_dir, 0).unwrap();
        assert_eq!(removed2.len(), 1);
        assert_eq!(list_backups(&backup_dir).unwrap().len(), 1);
    }

    #[test]
    fn list_backups_missing_dir_is_empty() {
        let dir = tempfile::tempdir().unwrap();
        let missing = dir.path().join("nope");
        assert!(list_backups(&missing).unwrap().is_empty());
    }

    #[test]
    fn bundle_export_import_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("tessera.db");
        let conn = seed_db(&db_path, Some(TEST_KEY), &[(1, "alpha"), (2, "beta")]);

        // Two sidecar files (model config + settings).
        let model_cfg = dir.path().join("model.json");
        let settings = dir.path().join("settings.json");
        fs::write(&model_cfg, br#"{"model":"local"}"#).unwrap();
        fs::write(&settings, br#"{"theme":"dark"}"#).unwrap();

        let extras = vec![
            BundleSource {
                role: "model-config".into(),
                arcname: "model.json".into(),
                path: model_cfg.clone(),
            },
            BundleSource {
                role: "settings".into(),
                arcname: "settings.json".into(),
                path: settings.clone(),
            },
        ];
        let out = dir.path().join("workspace.tessera-backup");
        let info = export_bundle(&conn, Some(TEST_KEY), &extras, &out).expect("export");
        assert_eq!(info.entry_count, 3);
        assert!(Path::new(&info.path).is_file());

        drop(conn);

        // Import into a fresh location.
        let new_db = dir.path().join("restored.db");
        let new_model = dir.path().join("restored-model.json");
        let new_settings = dir.path().join("restored-settings.json");
        let targets = vec![
            BundleTarget {
                arcname: "model.json".into(),
                path: new_model.clone(),
            },
            BundleTarget {
                arcname: "settings.json".into(),
                path: new_settings.clone(),
            },
        ];
        let report = import_bundle(&out, &new_db, &targets, Some(TEST_KEY)).expect("import");
        assert_eq!(report.restored_files.len(), 2);

        // Sidecars restored verbatim.
        assert_eq!(fs::read(&new_model).unwrap(), br#"{"model":"local"}"#);
        assert_eq!(fs::read(&new_settings).unwrap(), br#"{"theme":"dark"}"#);

        // Database is staged, not yet applied.
        assert!(Path::new(&report.staged_db_path).is_file());
        assert!(!new_db.exists());
        assert!(apply_pending_restore(&new_db).expect("apply"));
        assert_eq!(count_rows(&new_db, Some(TEST_KEY)), 2);
    }

    #[test]
    fn bundle_import_rejects_tampered_entry() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("tessera.db");
        let conn = seed_db(&db_path, Some(TEST_KEY), &[(1, "alpha")]);
        let out = dir.path().join("workspace.tessera-backup");
        export_bundle(&conn, Some(TEST_KEY), &[], &out).expect("export");
        drop(conn);

        // Corrupt a byte deep in the gzip stream; the SHA-256 verify
        // (or gzip CRC) must reject it rather than restoring garbage.
        let mut bytes = fs::read(&out).unwrap();
        let mid = bytes.len() / 2;
        bytes[mid] ^= 0xff;
        fs::write(&out, &bytes).unwrap();

        let new_db = dir.path().join("restored.db");
        assert!(import_bundle(&out, &new_db, &[], Some(TEST_KEY)).is_err());
        assert!(!pending_restore_path(&new_db).exists());
    }

    #[test]
    fn apply_pending_restore_noop_when_absent() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("tessera.db");
        assert!(!apply_pending_restore(&db_path).unwrap());
    }

    #[test]
    fn unencrypted_backup_round_trip() {
        let dir = tempfile::tempdir().unwrap();
        let db_path = dir.path().join("plain.db");
        let backup_dir = dir.path().join("backups");
        let conn = seed_db(&db_path, None, &[(1, "alpha")]);
        let info = create_backup(&conn, None, &backup_dir).expect("create");
        // An unencrypted source yields a plaintext SQLite backup.
        let bytes = fs::read(&info.path).unwrap();
        assert_eq!(&bytes[..16], b"SQLite format 3\0");
        drop(conn);
        stage_restore(Path::new(&info.path), &db_path, None).expect("stage");
        assert!(apply_pending_restore(&db_path).unwrap());
        assert_eq!(count_rows(&db_path, None), 1);
    }
}
