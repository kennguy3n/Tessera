//! N-API surface for the local backup & recovery system.
//!
//! These functions are thin adapters over [`tessera_core::backup`]:
//! they translate the JS-facing string/array shapes into the core
//! types, run the operation against the live shared connection (for
//! hot copies) or the filesystem (for listing / pruning / staging),
//! and translate the result back. All cryptographic and atomicity
//! guarantees live in the core module; nothing here touches the
//! SQLCipher key beyond forwarding the one captured at `init_bridge`.

use std::fs;
use std::path::{Path, PathBuf};

use napi_derive::napi;
use serde::{Deserialize, Serialize};
use tessera_core::backup as core_backup;
use tessera_core::SharedConnection;
use tessera_substrate::{
    substrate_sibling_entries, SubstrateManager, SUBSTRATE_CONCEPTS_ARCNAME,
    SUBSTRATE_EVIDENCE_ARCNAME,
};

use crate::{BridgeError, BridgeResult};

/// RAII guard that best-effort removes a substrate-snapshot staging
/// directory when it goes out of scope. The freshly-produced snapshots
/// are either packed into a bundle or moved beside a `.tdbak` before the
/// guard drops, so removal is pure hygiene — failures are swallowed and
/// the next snapshot clears any stale file itself.
struct StagingDirGuard(PathBuf);

impl Drop for StagingDirGuard {
    fn drop(&mut self) {
        let _ = fs::remove_dir_all(&self.0);
    }
}

/// Per-operation staging directory for substrate snapshots, kept a
/// sibling of the target file so the produced snapshots land on the same
/// filesystem (making the later rename into place atomic, never a
/// cross-device copy).
fn substrate_staging_dir(anchor_path: &str) -> PathBuf {
    PathBuf::from(format!("{anchor_path}.substrate-staging"))
}

/// `<live_sibling>.pending-restore` as a string, mirroring
/// `tessera_core::backup`'s private `pending_restore_path` via the
/// public suffix constant. Substrate siblings restore here (a fresh
/// file, safe to write while the live sibling is open) and are swapped
/// into place at next boot by [`apply_pending_restore`].
fn pending_restore_string(live_sibling: &Path) -> String {
    format!(
        "{}{}",
        live_sibling.display(),
        core_backup::PENDING_RESTORE_SUFFIX
    )
}

/// Hot-copy sidecar path for one substrate sibling beside a `.tdbak`
/// backup file: `<backup>.tdbak.substrate-evidence.db`. The `.db`
/// extension keeps these out of [`core_backup::list_backups`], which
/// only matches the `.tdbak` extension.
fn hotcopy_sidecar(backup_path: &str, arcname: &str) -> PathBuf {
    PathBuf::from(format!("{backup_path}.{arcname}"))
}

/// Produce consistent `VACUUM INTO` snapshots of the substrate siblings
/// and move them beside the just-written `.tdbak` as
/// `<backup>.<arcname>` sidecars. Best-effort: returns the error string
/// for the caller to log without failing the main database backup.
fn attach_substrate_sidecars(mgr: &SubstrateManager, backup_path: &str) -> Result<(), String> {
    let staging = substrate_staging_dir(backup_path);
    let _cleanup = StagingDirGuard(staging.clone());
    let snapshots = mgr.snapshot_into(&staging).map_err(|e| e.to_string())?;
    for snap in snapshots {
        let dest = hotcopy_sidecar(backup_path, &snap.arcname);
        // VACUUM INTO already refused a present destination in `staging`;
        // clear any stale sidecar from a previous backup at this slot so
        // the rename always lands.
        let _ = fs::remove_file(&dest);
        fs::rename(&snap.path, &dest).map_err(|e| {
            format!(
                "move substrate snapshot {} -> {}: {e}",
                snap.path.display(),
                dest.display()
            )
        })?;
    }
    Ok(())
}

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

/// Hot-copy the live database to a new timestamped file in `backup_dir`,
/// then attach consistent snapshots of the substrate siblings beside it.
///
/// The substrate snapshot is **best-effort**: the main `.tdbak` is the
/// critical artifact, and a substrate snapshot failure (or degraded
/// `None` substrate) is logged but never fails the backup. Substrate
/// content re-derives from indexed sources, and a restore that finds no
/// sidecar simply leaves the live siblings untouched.
pub fn create(
    conn: &SharedConnection,
    key: Option<&str>,
    backup_dir: &str,
    substrate: Option<&SubstrateManager>,
) -> BridgeResult<BackupInfo> {
    let info = core_backup::create_backup(conn, key, Path::new(backup_dir))?;
    if let Some(mgr) = substrate {
        if let Err(e) = attach_substrate_sidecars(mgr, &info.path) {
            eprintln!(
                "[substrate] hot-copy snapshot failed; backup {} has no substrate sidecars: {e}",
                info.path
            );
        }
    }
    Ok(info.into())
}

/// List existing backups in `backup_dir`, newest first.
pub fn list(backup_dir: &str) -> BridgeResult<Vec<BackupInfo>> {
    let infos = core_backup::list_backups(Path::new(backup_dir))?;
    Ok(infos.into_iter().map(Into::into).collect())
}

/// Delete old backups beyond the `keep` most recent (floor of 1), and
/// remove each pruned backup's substrate sidecars so they cannot
/// outlive the `.tdbak` they belong to. Sidecar removal is best-effort
/// (a missing sidecar is normal when the substrate was degraded at
/// backup time).
pub fn prune(backup_dir: &str, keep: u32) -> BridgeResult<Vec<String>> {
    let removed = core_backup::prune_backups(Path::new(backup_dir), keep as usize)?;
    for backup_path in &removed {
        for arcname in [SUBSTRATE_EVIDENCE_ARCNAME, SUBSTRATE_CONCEPTS_ARCNAME] {
            let _ = fs::remove_file(hotcopy_sidecar(backup_path, arcname));
        }
    }
    Ok(removed)
}

/// Validate a backup decrypts, then stage it for the next launch.
/// Returns the staged `*.pending-restore` path of the main database.
///
/// If the backup carries substrate sidecars (`<backup>.<arcname>`), each
/// is staged to its live sibling's `*.pending-restore` slot as well, so
/// the boot-time swap restores the substrate alongside the main DB. The
/// main database is the validated gate (wrong key / corruption is caught
/// there); sidecars are copied verbatim and a sibling that later fails
/// to re-open degrades on its own without affecting the core restore.
pub fn stage_restore(backup_path: &str, db_path: &str, key: Option<&str>) -> BridgeResult<String> {
    let staged = core_backup::stage_restore(Path::new(backup_path), Path::new(db_path), key)?;
    for entry in substrate_sibling_entries(db_path) {
        let sidecar = hotcopy_sidecar(backup_path, &entry.arcname);
        if sidecar.is_file() {
            if let Err(e) = core_backup::stage_pending_restore(&sidecar, &entry.path) {
                eprintln!(
                    "[substrate] failed to stage sidecar {} for restore: {e}",
                    sidecar.display()
                );
            }
        }
    }
    Ok(staged)
}

/// Apply a previously-staged restore by swapping the pending file into
/// place. Returns `true` when a swap occurred. Safe to call on every
/// boot before the database is opened.
pub fn apply_pending_restore(db_path: &str) -> BridgeResult<bool> {
    let applied = core_backup::apply_pending_restore(Path::new(db_path))?;
    // Swap any staged substrate siblings too. These are deterministic
    // functions of `db_path`, so this works at startup before any bridge
    // state exists. A sibling swap failure is logged but never blocks the
    // main DB restore — the substrate simply opens degraded next.
    for entry in substrate_sibling_entries(db_path) {
        if let Err(e) = core_backup::apply_pending_restore(&entry.path) {
            eprintln!(
                "[substrate] failed to apply staged sibling {}: {e}",
                entry.path.display()
            );
        }
    }
    Ok(applied)
}

/// Export a full workspace bundle (hot DB copy + caller sidecars + the
/// substrate siblings) to `out_path`.
///
/// The substrate siblings are folded in here, Rust-side, rather than
/// passed down from the renderer: their on-disk paths and SQLCipher key
/// must never cross the IPC boundary (the same privacy rule the app
/// config sidecar already follows). When a substrate is present, two
/// consistent `VACUUM INTO` snapshots are produced into a temp staging
/// dir and packed under their stable arcnames; a snapshot failure (or
/// degraded `None` substrate) is logged and the bundle is written
/// without substrate entries, preserving backward compatibility.
pub fn export_bundle(
    conn: &SharedConnection,
    key: Option<&str>,
    extras: Vec<BundleFileEntry>,
    out_path: &str,
    substrate: Option<&SubstrateManager>,
) -> BridgeResult<BundleInfo> {
    let mut sources: Vec<core_backup::BundleSource> = extras
        .into_iter()
        .map(|e| core_backup::BundleSource {
            role: e.role,
            arcname: e.arcname,
            path: PathBuf::from(e.path),
        })
        .collect();

    // Snapshots live in this staging dir until `core_backup::export_bundle`
    // has read them into the archive; the guard removes the dir on every
    // exit path. Declared before the export call so it outlives it.
    let staging = substrate_staging_dir(out_path);
    let _cleanup = StagingDirGuard(staging.clone());
    if let Some(mgr) = substrate {
        match mgr.snapshot_into(&staging) {
            Ok(snapshots) => {
                for snap in snapshots {
                    sources.push(core_backup::BundleSource {
                        role: snap.role,
                        arcname: snap.arcname,
                        path: snap.path,
                    });
                }
            }
            Err(e) => {
                eprintln!("[substrate] bundle snapshot failed; exporting without substrate: {e}");
            }
        }
    }

    let info = core_backup::export_bundle(conn, key, &sources, Path::new(out_path))?;
    Ok(info.into())
}

/// Import a workspace bundle: verify digests, stage the DB, and restore
/// the matched sidecar files.
///
/// Substrate restore targets are appended here, Rust-side, for the same
/// privacy reason as export: each substrate sibling in the bundle is
/// routed to its live sibling's `*.pending-restore` slot (a fresh file,
/// safe to write while the live sibling is still open) and swapped into
/// place at next boot by [`apply_pending_restore`]. Targets whose
/// arcname is absent from the archive are ignored by the core importer,
/// so a legacy bundle without substrate entries restores exactly as
/// before — the live siblings are left untouched.
pub fn import_bundle(
    bundle_path: &str,
    db_path: &str,
    targets: Vec<BundleRestoreTarget>,
    key: Option<&str>,
) -> BridgeResult<BundleImportReport> {
    let mut core_targets: Vec<core_backup::BundleTarget> = targets
        .into_iter()
        .map(|t| core_backup::BundleTarget {
            arcname: t.arcname,
            path: PathBuf::from(t.path),
        })
        .collect();
    for entry in substrate_sibling_entries(db_path) {
        core_targets.push(core_backup::BundleTarget {
            arcname: entry.arcname,
            path: PathBuf::from(pending_restore_string(&entry.path)),
        });
    }
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

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::open_shared_with_key;

    const KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    fn chunks() -> Vec<String> {
        vec![
            "@Sara please loop in Acme on the Migration project.".to_string(),
            "TODO: draft the launch RFC by Friday.".to_string(),
            "We decided to ship the launch on Friday.".to_string(),
        ]
    }

    /// Open an empty encrypted main DB and a populated substrate beside
    /// it, returning the manager and the main-DB path string.
    fn workspace(dir: &Path, name: &str) -> (SubstrateManager, String) {
        let db_path = dir.join(name);
        let db_path_str = db_path.to_str().unwrap().to_string();
        // Materialize the main DB file so backup has something to copy.
        drop(open_shared_with_key(&db_path_str, Some(KEY)).expect("open main"));
        let mut mgr = SubstrateManager::open(&db_path_str, Some(KEY)).expect("open substrate");
        let n = mgr
            .extract_observations("11111111-1111-4111-8111-111111111111", &chunks())
            .expect("extract");
        assert!(n > 0, "fixture must extract memories");
        (mgr, db_path_str)
    }

    #[test]
    fn hotcopy_attaches_and_restores_substrate_sidecars() {
        let tmp = tempfile::tempdir().unwrap();
        let backup_dir = tmp.path().join("backups");
        let (mgr, db_path) = workspace(tmp.path(), "tessera.db");
        let baseline = mgr.list_memories(None).unwrap().len();

        let conn = open_shared_with_key(&db_path, Some(KEY)).expect("reopen conn");
        let info = create(&conn, Some(KEY), backup_dir.to_str().unwrap(), Some(&mgr))
            .expect("create backup");

        // Both substrate sidecars are written beside the `.tdbak` and are
        // excluded from the backup listing (only `.tdbak` is a backup).
        let ev = hotcopy_sidecar(&info.path, SUBSTRATE_EVIDENCE_ARCNAME);
        let cn = hotcopy_sidecar(&info.path, SUBSTRATE_CONCEPTS_ARCNAME);
        assert!(ev.is_file() && cn.is_file(), "sidecars written");
        assert_eq!(list(backup_dir.to_str().unwrap()).unwrap().len(), 1);

        // Restore: stage main + siblings, then (with everything closed)
        // swap them into place and prove the substrate reopens intact.
        let staged = stage_restore(&info.path, &db_path, Some(KEY)).expect("stage");
        assert!(Path::new(&staged).is_file());
        for entry in substrate_sibling_entries(&db_path) {
            assert!(
                Path::new(&pending_restore_string(&entry.path)).is_file(),
                "sibling {} staged",
                entry.arcname
            );
        }
        drop(conn);
        drop(mgr);

        assert!(apply_pending_restore(&db_path).expect("apply"));
        let restored = SubstrateManager::open(&db_path, Some(KEY)).expect("reopen substrate");
        assert_eq!(restored.list_memories(None).unwrap().len(), baseline);
    }

    #[test]
    fn bundle_round_trip_restores_substrate_into_fresh_workspace() {
        let tmp = tempfile::tempdir().unwrap();
        let (mgr, src_db) = workspace(tmp.path(), "source.db");
        let baseline = mgr.list_memories(None).unwrap().len();
        let bundle = tmp.path().join("workspace.tessera-backup");

        let conn = open_shared_with_key(&src_db, Some(KEY)).expect("reopen conn");
        export_bundle(
            &conn,
            Some(KEY),
            vec![],
            bundle.to_str().unwrap(),
            Some(&mgr),
        )
        .expect("export");
        drop(conn);
        drop(mgr);
        // Staging dir is cleaned up after export.
        assert!(!substrate_staging_dir(bundle.to_str().unwrap()).exists());

        // Import into a brand-new workspace path (no siblings yet).
        let dst_db = tmp.path().join("restored.db");
        let dst = dst_db.to_str().unwrap().to_string();
        let report =
            import_bundle(bundle.to_str().unwrap(), &dst, vec![], Some(KEY)).expect("import");
        assert!(report
            .staged_db_path
            .ends_with(core_backup::PENDING_RESTORE_SUFFIX));
        for entry in substrate_sibling_entries(&dst) {
            assert!(Path::new(&pending_restore_string(&entry.path)).is_file());
        }

        assert!(apply_pending_restore(&dst).expect("apply"));
        let restored = SubstrateManager::open(&dst, Some(KEY)).expect("reopen substrate");
        assert_eq!(restored.list_memories(None).unwrap().len(), baseline);
    }

    #[test]
    fn prune_removes_pruned_backups_sidecars_only() {
        let tmp = tempfile::tempdir().unwrap();
        let backup_dir = tmp.path().join("backups");
        let (mgr, db_path) = workspace(tmp.path(), "tessera.db");
        let conn = open_shared_with_key(&db_path, Some(KEY)).expect("reopen conn");

        let mut paths = Vec::new();
        for _ in 0..3 {
            // Distinct timestamps in the backup file name.
            std::thread::sleep(std::time::Duration::from_millis(1100));
            let info =
                create(&conn, Some(KEY), backup_dir.to_str().unwrap(), Some(&mgr)).expect("create");
            paths.push(info.path);
        }

        let removed = prune(backup_dir.to_str().unwrap(), 1).expect("prune");
        assert_eq!(removed.len(), 2);
        // The newest keeps its sidecars; the pruned ones lose theirs.
        let newest = paths.last().unwrap();
        assert!(hotcopy_sidecar(newest, SUBSTRATE_EVIDENCE_ARCNAME).is_file());
        for old in &paths[..2] {
            assert!(!hotcopy_sidecar(old, SUBSTRATE_EVIDENCE_ARCNAME).exists());
            assert!(!hotcopy_sidecar(old, SUBSTRATE_CONCEPTS_ARCNAME).exists());
        }
    }

    #[test]
    fn degraded_substrate_produces_plain_backup_and_bundle() {
        let tmp = tempfile::tempdir().unwrap();
        let backup_dir = tmp.path().join("backups");
        let db_path = tmp.path().join("tessera.db");
        let db = db_path.to_str().unwrap().to_string();
        let conn = open_shared_with_key(&db, Some(KEY)).expect("open");

        // `None` substrate (degraded mode): main artifacts still produced,
        // no substrate sidecars/entries, no error.
        let info = create(&conn, Some(KEY), backup_dir.to_str().unwrap(), None).expect("create");
        assert!(!hotcopy_sidecar(&info.path, SUBSTRATE_EVIDENCE_ARCNAME).exists());

        let bundle = tmp.path().join("ws.tessera-backup");
        let out = export_bundle(&conn, Some(KEY), vec![], bundle.to_str().unwrap(), None)
            .expect("export");
        // Only the main DB is packed (no extras, no substrate entries).
        assert_eq!(out.entry_count, 1);
    }
}
