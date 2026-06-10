//! N-API surface for the local backup & recovery system.
//!
//! These functions are thin adapters over [`tessera_core::backup`]:
//! they translate the JS-facing string/array shapes into the core
//! types, run the operation against the live shared connection (for
//! hot copies) or the filesystem (for listing / pruning / staging),
//! and translate the result back. All cryptographic and atomicity
//! guarantees live in the core module; nothing here touches the
//! SQLCipher key beyond forwarding the one captured at `init_bridge`.

use std::path::{Path, PathBuf};

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use tessera_core::backup as core_backup;
use tessera_core::SharedConnection;

use crate::{BridgeError, BridgeResult};

/// JS-facing view of a single backup file on disk.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct BackupInfo {
    /// Absolute path to the backup file.
    pub path: String,
    /// Bare filename (no directory component).
    pub file_name: String,
    /// Creation time in milliseconds since the Unix epoch.
    pub created_at_ms: i64,
    /// Size of the backup file in bytes.
    pub size_bytes: i64,
}

impl From<core_backup::BackupInfo> for BackupInfo {
    fn from(b: core_backup::BackupInfo) -> Self {
        Self {
            path: b.path,
            file_name: b.file_name,
            created_at_ms: b.created_at_ms,
            size_bytes: b.size_bytes,
        }
    }
}

/// JS-facing result of a bundle export.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct BundleInfo {
    /// Absolute path to the written `.tessera-backup` archive.
    pub path: String,
    /// Size of the archive in bytes.
    pub size_bytes: i64,
    /// Number of entries (database + sidecars) packed.
    pub entry_count: u32,
}

impl From<core_backup::BundleInfo> for BundleInfo {
    fn from(b: core_backup::BundleInfo) -> Self {
        Self {
            path: b.path,
            size_bytes: b.size_bytes,
            entry_count: b.entry_count,
        }
    }
}

/// JS-facing outcome of a bundle import.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct BundleImportReport {
    /// Absolute path of the staged `*.pending-restore` database file
    /// that will be swapped in at next launch.
    pub staged_db_path: String,
    /// Absolute paths of the sidecar files replaced on disk.
    pub restored_files: Vec<String>,
}

impl From<core_backup::BundleImportReport> for BundleImportReport {
    fn from(r: core_backup::BundleImportReport) -> Self {
        Self {
            staged_db_path: r.staged_db_path,
            restored_files: r.restored_files,
        }
    }
}

/// A sidecar file to fold into a bundle on export. Mirrors
/// [`core_backup::BundleSource`] with string paths for the JS side.
#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct BundleFileEntry {
    /// Logical role tag recorded in the manifest (e.g. `"model-config"`).
    pub role: String,
    /// Stable name used inside the archive (no directory component).
    pub arcname: String,
    /// Absolute path of the file to read.
    pub path: String,
}

/// A sidecar file target to restore on import, matched by arcname.
/// Mirrors [`core_backup::BundleTarget`].
#[derive(Debug, Clone, Serialize, Deserialize)]
#[napi(object)]
pub struct BundleRestoreTarget {
    /// Archive name to look for (matches a [`BundleFileEntry::arcname`]).
    pub arcname: String,
    /// Absolute path the file is written to (atomically) on import.
    pub path: String,
}

/// Hot-copy the live database to a new timestamped file in `backup_dir`.
pub fn create(
    conn: &SharedConnection,
    key: Option<&str>,
    backup_dir: &str,
) -> BridgeResult<BackupInfo> {
    let info = core_backup::create_backup(conn, key, Path::new(backup_dir))?;
    Ok(info.into())
}

/// List existing backups in `backup_dir`, newest first.
pub fn list(backup_dir: &str) -> BridgeResult<Vec<BackupInfo>> {
    let infos = core_backup::list_backups(Path::new(backup_dir))?;
    Ok(infos.into_iter().map(Into::into).collect())
}

/// Delete old backups beyond the `keep` most recent (floor of 1).
pub fn prune(backup_dir: &str, keep: u32) -> BridgeResult<Vec<String>> {
    let removed = core_backup::prune_backups(Path::new(backup_dir), keep as usize)?;
    Ok(removed)
}

/// Validate a backup decrypts, then stage it for the next launch.
/// Returns the staged `*.pending-restore` path.
pub fn stage_restore(backup_path: &str, db_path: &str, key: Option<&str>) -> BridgeResult<String> {
    let staged = core_backup::stage_restore(Path::new(backup_path), Path::new(db_path), key)?;
    Ok(staged)
}

/// Apply a previously-staged restore by swapping the pending file into
/// place. Returns `true` when a swap occurred. Safe to call on every
/// boot before the database is opened.
pub fn apply_pending_restore(db_path: &str) -> BridgeResult<bool> {
    let applied = core_backup::apply_pending_restore(Path::new(db_path))?;
    Ok(applied)
}

/// Export a full workspace bundle (hot DB copy + sidecars) to `out_path`.
pub fn export_bundle(
    conn: &SharedConnection,
    key: Option<&str>,
    extras: Vec<BundleFileEntry>,
    out_path: &str,
) -> BridgeResult<BundleInfo> {
    let sources: Vec<core_backup::BundleSource> = extras
        .into_iter()
        .map(|e| core_backup::BundleSource {
            role: e.role,
            arcname: e.arcname,
            path: PathBuf::from(e.path),
        })
        .collect();
    let info = core_backup::export_bundle(conn, key, &sources, Path::new(out_path))?;
    Ok(info.into())
}

/// Import a workspace bundle: verify digests, stage the DB, and
/// atomically restore the matched sidecar files.
pub fn import_bundle(
    bundle_path: &str,
    db_path: &str,
    targets: Vec<BundleRestoreTarget>,
    key: Option<&str>,
) -> BridgeResult<BundleImportReport> {
    let core_targets: Vec<core_backup::BundleTarget> = targets
        .into_iter()
        .map(|t| core_backup::BundleTarget {
            arcname: t.arcname,
            path: PathBuf::from(t.path),
        })
        .collect();
    let report = core_backup::import_bundle(
        Path::new(bundle_path),
        Path::new(db_path),
        &core_targets,
        key,
    )?;
    Ok(report.into())
}

/// Map a [`BridgeError`] to a napi rejection message. Kept here so the
/// napi_exports wrappers stay one-liners.
pub(crate) fn to_napi(e: BridgeError) -> napi::Error {
    napi::Error::from_reason(e.to_string())
}
