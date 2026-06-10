//! Runtime upgrade of the per-source DEK **wrapping** scheme.
//!
//! The SQL migration `0006_kchat_crypto_scheme` only creates the
//! bookkeeping table — it cannot re-wrap keys, because re-wrapping needs
//! the SQLCipher master key, which is a runtime secret (held in the OS
//! keychain), not something a static `.sql` file can see. This module is
//! the runtime half of that migration: given the master key, it walks
//! `kchat_source_deks` and re-wraps every legacy (AES-256-GCM, v1) DEK
//! under the post-quantum-ready XChaCha20-Poly1305 (v2) scheme.
//!
//! # What it does and does NOT do
//!
//! - It **re-wraps** the per-source DEK: unwrap with the old scheme,
//!   wrap with the new one. The DEK *value* is unchanged, so every chunk
//!   already sealed under it stays readable — no content re-encryption.
//!   Re-encrypting chunk bodies would be O(total evidence) and could take
//!   minutes-to-hours on a large tenant database; re-wrapping is
//!   O(number of sources), typically < 100 rows.
//! - It is **idempotent**: rows already in v2 are skipped, so running it
//!   on every boot (or never) is safe.
//! - It is **atomic**: all re-wraps happen in one transaction, so a crash
//!   mid-upgrade leaves the database wholly in the pre-upgrade state
//!   (every DEK row still decrypts) rather than half-converted.
//!
//! # Lazy vs eager
//!
//! Reading is always backward-compatible (the reader auto-detects the
//! scheme from the nonce length), so this eager bulk upgrade is optional
//! — a tenant that never runs it keeps working. Running it lets an
//! operator *retire* the legacy AES-GCM read path for a database and get
//! a clean "all keys are post-quantum-wrapped" provenance signal.

use rusqlite::{params, Connection};
use tessera_core::crypto::{rewrap_to_v2, CryptoScheme, MasterKey, WrappedDek};
use tessera_core::error::{Error, Result};
use tessera_core::SourceId;

/// A census of the wrapping schemes currently present in
/// `kchat_source_deks`.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CryptoSchemeStatus {
    /// Total number of per-source DEK rows.
    pub total: usize,
    /// Rows still wrapped under the legacy AES-256-GCM (v1) scheme.
    pub v1_legacy: usize,
    /// Rows already wrapped under XChaCha20-Poly1305 (v2).
    pub v2_current: usize,
}

impl CryptoSchemeStatus {
    /// `true` when at least one DEK is still legacy-wrapped and an
    /// upgrade would do work.
    pub fn needs_upgrade(&self) -> bool {
        self.v1_legacy > 0
    }
}

/// Outcome of an [`upgrade_dek_wrapping`] run.
#[derive(Debug, Clone, Default, PartialEq, Eq)]
pub struct CryptoUpgradeReport {
    /// Number of DEK rows re-wrapped from v1 to v2 by this run.
    pub rewrapped: usize,
    /// Number of DEK rows already on v2 and left untouched.
    pub already_current: usize,
}

/// Inspect `kchat_source_deks` and classify each row's wrapping scheme by
/// its stored `wrap_nonce` length. Cheap (one table scan); does not need
/// the master key.
pub fn detect_scheme(conn: &Connection) -> Result<CryptoSchemeStatus> {
    if !dek_table_exists(conn)? {
        return Ok(CryptoSchemeStatus::default());
    }
    let mut stmt = conn.prepare("SELECT wrap_nonce FROM kchat_source_deks")?;
    let rows = stmt.query_map([], |row| row.get::<_, Vec<u8>>(0))?;

    let mut status = CryptoSchemeStatus::default();
    for row in rows {
        let nonce = row?;
        status.total += 1;
        match CryptoScheme::from_nonce_len(nonce.len())? {
            CryptoScheme::AesGcmV1 => status.v1_legacy += 1,
            CryptoScheme::XChaCha20Poly1305V2 => status.v2_current += 1,
        }
    }
    Ok(status)
}

/// Re-wrap every legacy (v1) DEK under the v2 scheme, atomically, and
/// update the `kchat_crypto_scheme` bookkeeping row.
///
/// `master` must be the same SQLCipher master key the DEKs were originally
/// wrapped under — otherwise the v1 unwrap fails closed and the whole
/// transaction rolls back (no partial upgrade, no data loss).
pub fn upgrade_dek_wrapping(
    conn: &mut Connection,
    master: &MasterKey,
) -> Result<CryptoUpgradeReport> {
    if !dek_table_exists(conn)? {
        return Ok(CryptoUpgradeReport::default());
    }

    let tx = conn.transaction()?;
    let mut report = CryptoUpgradeReport::default();

    // Collect the rows up front so the borrow on the prepared statement
    // is released before we issue UPDATEs on the same connection.
    let rows: Vec<(String, Vec<u8>, Vec<u8>)> = {
        let mut stmt =
            tx.prepare("SELECT source_id, wrap_nonce, wrapped_dek FROM kchat_source_deks")?;
        let mapped = stmt.query_map([], |row| {
            Ok((
                row.get::<_, String>(0)?,
                row.get::<_, Vec<u8>>(1)?,
                row.get::<_, Vec<u8>>(2)?,
            ))
        })?;
        mapped.collect::<rusqlite::Result<Vec<_>>>()?
    };

    for (source_id_str, wrap_nonce, wrapped_dek) in rows {
        let source_id: SourceId = source_id_str.parse().map_err(|e| {
            Error::DatabaseState(format!(
                "crypto_upgrade: malformed source_id {source_id_str:?} in kchat_source_deks: {e}"
            ))
        })?;
        let wrapped = WrappedDek::from_blobs(&wrap_nonce, &wrapped_dek)?;

        match rewrap_to_v2(master, &source_id, &wrapped)? {
            Some(upgraded) => {
                tx.execute(
                    "UPDATE kchat_source_deks
                     SET wrap_nonce = ?2, wrapped_dek = ?3
                     WHERE source_id = ?1",
                    params![source_id_str, upgraded.wrap_nonce(), upgraded.wrapped()],
                )
                .map_err(Error::Sqlite)?;
                report.rewrapped += 1;
            }
            None => report.already_current += 1,
        }
    }

    // Record the post-upgrade state for cheap provenance/status reads.
    // `v1_remaining` is 0 here because everything legacy was just
    // re-wrapped inside this same transaction.
    if crypto_scheme_table_exists(&tx)? {
        tx.execute(
            "UPDATE kchat_crypto_scheme
             SET wrap_scheme = 'xchacha20-poly1305-v2',
                 last_upgrade_at = ?1,
                 v1_remaining = 0
             WHERE id = 1",
            params![chrono::Utc::now().to_rfc3339()],
        )
        .map_err(Error::Sqlite)?;
    }

    tx.commit()?;
    Ok(report)
}

fn dek_table_exists(conn: &Connection) -> Result<bool> {
    table_exists(conn, "kchat_source_deks")
}

fn crypto_scheme_table_exists(conn: &Connection) -> Result<bool> {
    table_exists(conn, "kchat_crypto_scheme")
}

fn table_exists(conn: &Connection, table: &str) -> Result<bool> {
    use rusqlite::OptionalExtension;
    // `.optional()` maps the no-rows case (table absent) to `None`
    // while still propagating genuine query failures as errors, so a
    // real DB fault is never silently misread as "table missing".
    let found: Option<i64> = conn
        .query_row(
            "SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?1",
            params![table],
            |row| row.get(0),
        )
        .optional()?;
    Ok(found.is_some())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::Migrator;
    use tessera_core::crypto::{unwrap_dek, wrap_dek, DEK_LEN};

    /// Deterministic raw master-key bytes shared by the production
    /// `MasterKey` under test and the v1-wrap reproduction helper, so both
    /// derive the identical KEK.
    fn master_bytes() -> [u8; DEK_LEN] {
        let mut bytes = [0u8; DEK_LEN];
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(5).wrapping_add(1);
        }
        bytes
    }

    fn master() -> MasterKey {
        MasterKey::from_bytes(master_bytes())
    }

    /// Reproduce the legacy v1 AES-256-GCM DEK wrap so tests can seed an
    /// un-migrated database. Mirrors `tessera_core::crypto`'s internal v1
    /// construction (HKDF-SHA256 empty-salt KEK + AES-256-GCM, AAD
    /// `tessera/kchat-source-dek/v1/wrap/<source>`).
    fn wrap_v1(
        master: &[u8; DEK_LEN],
        source: &SourceId,
        dek: &[u8; DEK_LEN],
    ) -> (Vec<u8>, Vec<u8>) {
        use aes_gcm::aead::{Aead, KeyInit, Payload};
        use aes_gcm::{Aes256Gcm, Nonce};
        use hkdf::Hkdf;
        use rand::{rngs::OsRng, RngCore};
        use sha2::Sha256;

        let hk = Hkdf::<Sha256>::new(None, master);
        let info = format!("tessera/kchat-source-dek/v1/{source}");
        let mut kek = [0u8; DEK_LEN];
        hk.expand(info.as_bytes(), &mut kek).unwrap();

        let cipher = Aes256Gcm::new_from_slice(&kek).unwrap();
        let mut nonce = [0u8; 12];
        OsRng.fill_bytes(&mut nonce);
        let aad = format!("tessera/kchat-source-dek/v1/wrap/{source}");
        let wrapped = cipher
            .encrypt(
                Nonce::from_slice(&nonce),
                Payload {
                    msg: dek,
                    aad: aad.as_bytes(),
                },
            )
            .unwrap();
        (nonce.to_vec(), wrapped)
    }

    fn migrated_db() -> Connection {
        let mut conn = Connection::open_in_memory().unwrap();
        Migrator::new().run(&mut conn).unwrap();
        conn
    }

    fn insert_dek(conn: &Connection, source: &SourceId, nonce: &[u8], wrapped: &[u8]) {
        // `kchat_source_deks.source_id` is a FK into `sources(id)`, so seed
        // the parent row first to model a real database.
        let now = chrono::Utc::now().to_rfc3339();
        conn.execute(
            "INSERT INTO sources (id, source_type, path, status, created_at, file_count)
             VALUES (?1, 'kchat', '/test/channel', 'active', ?2, 0)",
            params![source.to_string(), now],
        )
        .unwrap();
        conn.execute(
            "INSERT INTO kchat_source_deks (source_id, wrap_nonce, wrapped_dek, created_at)
             VALUES (?1, ?2, ?3, ?4)",
            params![source.to_string(), nonce, wrapped, now],
        )
        .unwrap();
    }

    #[test]
    fn detect_scheme_on_empty_db_reports_nothing() {
        let conn = migrated_db();
        let status = detect_scheme(&conn).unwrap();
        assert_eq!(status, CryptoSchemeStatus::default());
        assert!(!status.needs_upgrade());
    }

    #[test]
    fn detect_scheme_counts_v1_and_v2() {
        let conn = migrated_db();
        let m = master();

        // One legacy v1 row.
        let s1 = SourceId::new();
        let (n1, w1) = wrap_v1(&master_bytes(), &s1, &[7u8; DEK_LEN]);
        insert_dek(&conn, &s1, &n1, &w1);

        // One current v2 row.
        let s2 = SourceId::new();
        let v2 = wrap_dek(&m, &s2, &[9u8; DEK_LEN]).unwrap();
        insert_dek(&conn, &s2, v2.wrap_nonce(), v2.wrapped());

        let status = detect_scheme(&conn).unwrap();
        assert_eq!(status.total, 2);
        assert_eq!(status.v1_legacy, 1);
        assert_eq!(status.v2_current, 1);
        assert!(status.needs_upgrade());
    }

    #[test]
    fn upgrade_rewraps_v1_preserving_dek_and_is_idempotent() {
        let mut conn = migrated_db();
        let m = master();

        let source = SourceId::new();
        let dek = [42u8; DEK_LEN];
        let (n1, w1) = wrap_v1(&master_bytes(), &source, &dek);
        insert_dek(&conn, &source, &n1, &w1);

        // First upgrade re-wraps the single v1 row.
        let report = upgrade_dek_wrapping(&mut conn, &m).unwrap();
        assert_eq!(report.rewrapped, 1);
        assert_eq!(report.already_current, 0);

        // The row is now v2 and still unwraps to the SAME dek.
        let status = detect_scheme(&conn).unwrap();
        assert_eq!(status.v1_legacy, 0);
        assert_eq!(status.v2_current, 1);

        let (nonce, wrapped): (Vec<u8>, Vec<u8>) = conn
            .query_row(
                "SELECT wrap_nonce, wrapped_dek FROM kchat_source_deks WHERE source_id = ?1",
                params![source.to_string()],
                |r| Ok((r.get(0)?, r.get(1)?)),
            )
            .unwrap();
        let restored = WrappedDek::from_blobs(&nonce, &wrapped).unwrap();
        assert_eq!(restored.scheme(), CryptoScheme::XChaCha20Poly1305V2);
        let recovered = unwrap_dek(&m, &source, &restored).unwrap();
        assert_eq!(&*recovered, &dek, "DEK value must survive the re-wrap");

        // Second run is a no-op.
        let report2 = upgrade_dek_wrapping(&mut conn, &m).unwrap();
        assert_eq!(report2.rewrapped, 0);
        assert_eq!(report2.already_current, 1);

        // Bookkeeping row records the upgrade.
        let (scheme, last_upgrade, v1_remaining): (String, Option<String>, i64) = conn
            .query_row(
                "SELECT wrap_scheme, last_upgrade_at, v1_remaining FROM kchat_crypto_scheme WHERE id = 1",
                [],
                |r| Ok((r.get(0)?, r.get(1)?, r.get(2)?)),
            )
            .unwrap();
        assert_eq!(scheme, "xchacha20-poly1305-v2");
        assert!(last_upgrade.is_some());
        assert_eq!(v1_remaining, 0);
    }

    #[test]
    fn upgrade_with_wrong_master_key_fails_and_rolls_back() {
        let mut conn = migrated_db();

        let source = SourceId::new();
        let dek = [3u8; DEK_LEN];
        let (n1, w1) = wrap_v1(&master_bytes(), &source, &dek);
        insert_dek(&conn, &source, &n1, &w1);

        // A different master key cannot unwrap the v1 DEK; the whole
        // transaction must roll back, leaving the row untouched (still v1).
        let mut wrong = [0u8; DEK_LEN];
        for (i, b) in wrong.iter_mut().enumerate() {
            *b = (i as u8).wrapping_add(99);
        }
        let err = upgrade_dek_wrapping(&mut conn, &MasterKey::from_bytes(wrong)).unwrap_err();
        assert!(matches!(err, Error::DatabaseState(_)));

        let status = detect_scheme(&conn).unwrap();
        assert_eq!(status.v1_legacy, 1, "row must remain legacy after rollback");
        assert_eq!(status.v2_current, 0);
    }
}
