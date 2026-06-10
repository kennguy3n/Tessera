//! Shared, scheme-aware per-source data-encryption-key (DEK) wrapping.
//!
//! # Why this lives in `tessera_core`
//!
//! Two crates need the exact same DEK wrap/unwrap construction:
//!
//! - `tessera_sources::kchat_crypto` wraps/unwraps DEKs on the ingest and
//!   retrieval hot paths.
//! - `tessera_migrate` re-wraps existing DEKs when upgrading an old database
//!   from the legacy crypto scheme to the post-quantum-ready one.
//!
//! `tessera_sources` already depends on `tessera_migrate`, so the shared
//! primitive cannot live in `tessera_sources` without creating a dependency
//! cycle. It lives here, the common ancestor of both.
//!
//! # Versioned, backward-compatible scheme
//!
//! Tessera shipped its first DEK layer using **AES-256-GCM** wrapping with an
//! **HKDF-SHA256** key-encryption-key (KEK) derived from the SQLCipher master
//! key (`tessera/kchat-source-dek/v1/<source_id>`). Session 7 upgrades the
//! primitives to the `knowledge` substrate's **XChaCha20-Poly1305** AEAD with
//! **HKDF-SHA256** derivation (`derive_key`, salt `knowledge-substrate-v1`).
//!
//! Both schemes wrap the *same* 32-byte DEK value, so existing content sealed
//! under a DEK stays readable after that DEK's wrapper is upgraded — only the
//! wrapper (KEK derivation + AEAD primitive) changes, never the DEK itself.
//!
//! ## Self-describing on-disk format
//!
//! The two AEADs have **different nonce lengths** — AES-GCM uses a 12-byte
//! nonce, XChaCha20-Poly1305 uses a 24-byte nonce — and both append a 16-byte
//! authentication tag to a 32-byte DEK (48-byte wrapped output). The nonce
//! length is therefore an unambiguous, zero-overhead scheme discriminator that
//! requires **no schema migration**: legacy rows already carry a 12-byte
//! nonce, new rows carry a 24-byte nonce. [`CryptoScheme::from_nonce_len`]
//! formalises this mapping and rejects any other length so a corrupt or
//! future-format row fails closed rather than silently mis-decrypting.

use hkdf::Hkdf;
use sha2::Sha256;
use zeroize::Zeroizing;

use crate::error::{Error, Result};
use crate::SourceId;

/// Length of a raw data-encryption-key (256 bits).
pub const DEK_LEN: usize = 32;

/// Length of a wrapped DEK ciphertext: a 32-byte DEK plus a 16-byte AEAD
/// tag. Identical for AES-256-GCM and XChaCha20-Poly1305 (both use a
/// 128-bit tag), so the wrapped length alone cannot distinguish the
/// schemes — the nonce length does.
pub const WRAPPED_DEK_LEN: usize = DEK_LEN + 16;

/// Length of an AES-256-GCM nonce (96 bits, per NIST SP 800-38D) — the
/// legacy (v1) wrapping nonce.
pub const AES_GCM_NONCE_LEN: usize = 12;

/// Length of an XChaCha20-Poly1305 nonce (192 bits) — the v2 wrapping
/// nonce. Re-exported from the `knowledge` crypto crate's constant so the
/// two never drift.
pub const XCHACHA_NONCE_LEN: usize = knowledge_crypto::AEAD_NONCE_LEN;

/// `info`/context prefix for the legacy (v1) HKDF KEK derivation. Frozen
/// as a wire contract: changing it would orphan every v1 wrapped DEK.
const KEK_V1_PREFIX: &str = "tessera/kchat-source-dek/v1/";

/// Context prefix for the v2 (XChaCha20-Poly1305) HKDF KEK derivation,
/// fed to [`knowledge_crypto::derive_key`].
const KEK_V2_PREFIX: &str = "tessera/kchat-source-dek/v2/";

/// Which generation of the DEK-wrapping construction produced a
/// [`WrappedDek`].
#[derive(Debug, Clone, Copy, PartialEq, Eq)]
pub enum CryptoScheme {
    /// Legacy: AES-256-GCM wrap, HKDF-SHA256 KEK (`info = v1/<source>`).
    /// Read-only going forward — never produced by [`wrap_dek`].
    AesGcmV1,
    /// Current: XChaCha20-Poly1305 wrap, HKDF-SHA256 KEK via
    /// [`knowledge_crypto::derive_key`] (`context = v2/<source>`).
    XChaCha20Poly1305V2,
}

impl CryptoScheme {
    /// Infer the scheme from a wrapping nonce's length.
    ///
    /// The 12-byte AES-GCM nonce and 24-byte XChaCha20 nonce are disjoint,
    /// so the length is an exact discriminator. Any other length is
    /// rejected so a corrupt/foreign row fails closed.
    pub fn from_nonce_len(len: usize) -> Result<Self> {
        match len {
            AES_GCM_NONCE_LEN => Ok(Self::AesGcmV1),
            XCHACHA_NONCE_LEN => Ok(Self::XChaCha20Poly1305V2),
            other => Err(Error::DatabaseState(format!(
                "crypto: unrecognised wrapping nonce length {other} \
                 (expected {AES_GCM_NONCE_LEN} for AES-GCM v1 or \
                 {XCHACHA_NONCE_LEN} for XChaCha20 v2)"
            ))),
        }
    }

    /// Stable, human-readable label used in migration reports and logs.
    pub fn label(self) -> &'static str {
        match self {
            Self::AesGcmV1 => "aes-256-gcm-v1",
            Self::XChaCha20Poly1305V2 => "xchacha20-poly1305-v2",
        }
    }
}

/// The 32-byte SQLCipher master key in raw form, used as input keying
/// material for per-source KEK derivation. Wrapped in [`Zeroizing`] so the
/// bytes are scrubbed on drop, and with a redacting [`std::fmt::Debug`] so
/// it can never be logged.
#[derive(Clone)]
pub struct MasterKey(Zeroizing<[u8; DEK_LEN]>);

impl std::fmt::Debug for MasterKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        f.write_str("MasterKey(<redacted; 32 bytes>)")
    }
}

impl MasterKey {
    /// Construct from a 64-hex-character key (the format
    /// `tessera_core::db::open_shared_with_key` validates). The
    /// length-and-charset check is duplicated here so a caller that skips
    /// the db-open path still gets the same guarantee.
    pub fn from_hex(hex: &str) -> Result<Self> {
        if hex.len() != DEK_LEN * 2 {
            return Err(Error::DatabaseState(format!(
                "MasterKey::from_hex: expected {} hex chars, got {}",
                DEK_LEN * 2,
                hex.len()
            )));
        }
        let mut bytes = [0u8; DEK_LEN];
        for (i, byte) in bytes.iter_mut().enumerate() {
            let hi = decode_hex_nibble(hex.as_bytes()[i * 2])?;
            let lo = decode_hex_nibble(hex.as_bytes()[i * 2 + 1])?;
            *byte = (hi << 4) | lo;
        }
        Ok(Self(Zeroizing::new(bytes)))
    }

    /// Construct directly from 32 raw bytes. Used by tests and the
    /// in-memory path where there is no SQLCipher master key file.
    pub fn from_bytes(bytes: [u8; DEK_LEN]) -> Self {
        Self(Zeroizing::new(bytes))
    }

    /// Borrow the raw key bytes. Crate-internal so the master key cannot
    /// leak past the crypto boundary.
    pub(crate) fn as_bytes(&self) -> &[u8; DEK_LEN] {
        &self.0
    }
}

fn decode_hex_nibble(b: u8) -> Result<u8> {
    match b {
        b'0'..=b'9' => Ok(b - b'0'),
        b'a'..=b'f' => Ok(b - b'a' + 10),
        b'A'..=b'F' => Ok(b - b'A' + 10),
        _ => Err(Error::DatabaseState(format!(
            "MasterKey::from_hex: non-hex byte 0x{b:02x}"
        ))),
    }
}

/// A wrapped DEK as persisted in `kchat_source_deks`: a wrapping nonce and
/// the KEK-encrypted DEK, tagged with the [`CryptoScheme`] that produced
/// them (derived from the nonce length).
///
/// Fields are `Vec<u8>` (rather than fixed arrays) so a single type can
/// carry either the 12-byte-nonce v1 form or the 24-byte-nonce v2 form;
/// `from_blobs` validates the lengths at the storage boundary.
#[derive(Debug, Clone)]
pub struct WrappedDek {
    scheme: CryptoScheme,
    wrap_nonce: Vec<u8>,
    wrapped: Vec<u8>,
}

impl WrappedDek {
    /// Reconstruct from the two BLOB columns SQLite stores, inferring the
    /// scheme from the nonce length and validating the wrapped length.
    ///
    /// Returns an error (rather than panicking or silently truncating) so
    /// a schema drift or corrupt row is caught at the boundary instead of
    /// producing garbage decryption downstream.
    pub fn from_blobs(wrap_nonce: &[u8], wrapped: &[u8]) -> Result<Self> {
        let scheme = CryptoScheme::from_nonce_len(wrap_nonce.len())?;
        if wrapped.len() != WRAPPED_DEK_LEN {
            return Err(Error::DatabaseState(format!(
                "WrappedDek::from_blobs: wrapped expected {WRAPPED_DEK_LEN} bytes, got {}",
                wrapped.len()
            )));
        }
        Ok(Self {
            scheme,
            wrap_nonce: wrap_nonce.to_vec(),
            wrapped: wrapped.to_vec(),
        })
    }

    /// The scheme this wrapped DEK was produced under.
    pub fn scheme(&self) -> CryptoScheme {
        self.scheme
    }

    /// The wrapping nonce bytes (12 for v1, 24 for v2).
    pub fn wrap_nonce(&self) -> &[u8] {
        &self.wrap_nonce
    }

    /// The wrapped (KEK-encrypted) DEK bytes (`WRAPPED_DEK_LEN`).
    pub fn wrapped(&self) -> &[u8] {
        &self.wrapped
    }
}

/// Derive the legacy (v1) per-source KEK: HKDF-SHA256 with an empty salt
/// and `info = "tessera/kchat-source-dek/v1/<source_id>"`. Reproduced
/// byte-for-byte from the original `kchat_crypto` implementation so v1
/// wrapped DEKs stay decryptable.
fn derive_kek_v1(master: &MasterKey, source_id: &SourceId) -> Zeroizing<[u8; DEK_LEN]> {
    let hk = Hkdf::<Sha256>::new(None, master.as_bytes());
    let info = format!("{KEK_V1_PREFIX}{source_id}");
    let mut okm = Zeroizing::new([0u8; DEK_LEN]);
    hk.expand(info.as_bytes(), okm.as_mut())
        .expect("HKDF-SHA256 expand of 32 bytes never fails");
    okm
}

/// Derive the v2 per-source KEK via the `knowledge` substrate's canonical
/// [`knowledge_crypto::derive_key`] (HKDF-SHA256, salt
/// `knowledge-substrate-v1`, `context = "tessera/kchat-source-dek/v2/<id>"`).
fn derive_kek_v2(master: &MasterKey, source_id: &SourceId) -> Result<Zeroizing<[u8; DEK_LEN]>> {
    let context = format!("{KEK_V2_PREFIX}{source_id}");
    let key = knowledge_crypto::derive_key(master.as_bytes(), context.as_bytes())
        .map_err(|e| Error::DatabaseState(format!("v2 KEK derivation failed: {e}")))?;
    Ok(Zeroizing::new(key))
}

/// Associated data bound into a DEK wrap, scoped per source and per scheme
/// so a wrapped DEK from one source/scheme cannot be substituted into
/// another's row.
fn wrap_aad(scheme: CryptoScheme, source_id: &SourceId) -> String {
    match scheme {
        CryptoScheme::AesGcmV1 => format!("{KEK_V1_PREFIX}wrap/{source_id}"),
        CryptoScheme::XChaCha20Poly1305V2 => format!("{KEK_V2_PREFIX}wrap/{source_id}"),
    }
}

/// Wrap a freshly-generated or rotated 32-byte `dek` under the v2
/// (XChaCha20-Poly1305) scheme. New writes always use v2.
pub fn wrap_dek(
    master: &MasterKey,
    source_id: &SourceId,
    dek: &[u8; DEK_LEN],
) -> Result<WrappedDek> {
    use rand::RngCore;

    let kek = derive_kek_v2(master, source_id)?;
    let mut nonce = [0u8; XCHACHA_NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let aad = wrap_aad(CryptoScheme::XChaCha20Poly1305V2, source_id);
    let wrapped = knowledge_crypto::encrypt_aead(&kek, &nonce, dek, aad.as_bytes())
        .map_err(|e| Error::DatabaseState(format!("DEK wrap (v2) failed: {e}")))?;
    if wrapped.len() != WRAPPED_DEK_LEN {
        return Err(Error::DatabaseState(format!(
            "DEK wrap (v2) produced {} bytes, expected {WRAPPED_DEK_LEN}",
            wrapped.len()
        )));
    }
    Ok(WrappedDek {
        scheme: CryptoScheme::XChaCha20Poly1305V2,
        wrap_nonce: nonce.to_vec(),
        wrapped,
    })
}

/// Unwrap a [`WrappedDek`] to its raw 32-byte DEK, dispatching on the
/// embedded scheme so both legacy (v1, AES-GCM) and current (v2, XChaCha20)
/// wrappers decrypt correctly. The returned key is zeroized on drop.
pub fn unwrap_dek(
    master: &MasterKey,
    source_id: &SourceId,
    wrapped: &WrappedDek,
) -> Result<Zeroizing<[u8; DEK_LEN]>> {
    let plain = match wrapped.scheme {
        CryptoScheme::AesGcmV1 => {
            use aes_gcm::aead::{Aead, KeyInit, Payload};
            use aes_gcm::{Aes256Gcm, Nonce};

            let kek = derive_kek_v1(master, source_id);
            let cipher = Aes256Gcm::new_from_slice(kek.as_ref())
                .map_err(|e| Error::DatabaseState(format!("v1 KEK init failed: {e}")))?;
            let nonce = Nonce::from_slice(&wrapped.wrap_nonce);
            let aad = wrap_aad(CryptoScheme::AesGcmV1, source_id);
            cipher
                .decrypt(
                    nonce,
                    Payload {
                        msg: &wrapped.wrapped,
                        aad: aad.as_bytes(),
                    },
                )
                .map_err(|e| Error::DatabaseState(format!("DEK unwrap (v1) failed: {e}")))?
        }
        CryptoScheme::XChaCha20Poly1305V2 => {
            let kek = derive_kek_v2(master, source_id)?;
            let mut nonce = [0u8; XCHACHA_NONCE_LEN];
            if wrapped.wrap_nonce.len() != XCHACHA_NONCE_LEN {
                return Err(Error::DatabaseState(format!(
                    "DEK unwrap (v2): nonce expected {XCHACHA_NONCE_LEN} bytes, got {}",
                    wrapped.wrap_nonce.len()
                )));
            }
            nonce.copy_from_slice(&wrapped.wrap_nonce);
            let aad = wrap_aad(CryptoScheme::XChaCha20Poly1305V2, source_id);
            knowledge_crypto::decrypt_aead(&kek, &nonce, &wrapped.wrapped, aad.as_bytes())
                .map_err(|e| Error::DatabaseState(format!("DEK unwrap (v2) failed: {e}")))?
        }
    };

    if plain.len() != DEK_LEN {
        return Err(Error::DatabaseState(format!(
            "DEK unwrap produced {} bytes, expected {DEK_LEN}",
            plain.len()
        )));
    }
    let mut dek = Zeroizing::new([0u8; DEK_LEN]);
    dek.copy_from_slice(&plain);
    Ok(dek)
}

/// Re-wrap a legacy (v1) DEK under the v2 scheme **without changing the DEK
/// value**, so content already sealed under it stays readable.
///
/// Returns `Ok(None)` when `wrapped` is already v2 (nothing to do), making
/// the upgrade migration idempotent. This is the core operation
/// `tessera_migrate` runs over every `kchat_source_deks` row.
pub fn rewrap_to_v2(
    master: &MasterKey,
    source_id: &SourceId,
    wrapped: &WrappedDek,
) -> Result<Option<WrappedDek>> {
    if wrapped.scheme == CryptoScheme::XChaCha20Poly1305V2 {
        return Ok(None);
    }
    let dek = unwrap_dek(master, source_id, wrapped)?;
    Ok(Some(wrap_dek(master, source_id, &dek)?))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed_master_key() -> MasterKey {
        let mut bytes = [0u8; DEK_LEN];
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(7).wrapping_add(13);
        }
        MasterKey::from_bytes(bytes)
    }

    /// Reproduce the original v1 AES-256-GCM wrap so tests can build
    /// authentic legacy rows to exercise the backward-compatible read and
    /// the migration re-wrap.
    fn wrap_dek_v1_for_test(
        master: &MasterKey,
        source_id: &SourceId,
        dek: &[u8; DEK_LEN],
    ) -> WrappedDek {
        use aes_gcm::aead::{Aead, KeyInit, Payload};
        use aes_gcm::{Aes256Gcm, Nonce};
        use rand::RngCore;

        let kek = derive_kek_v1(master, source_id);
        let cipher = Aes256Gcm::new_from_slice(kek.as_ref()).unwrap();
        let mut nonce_bytes = [0u8; AES_GCM_NONCE_LEN];
        rand::rngs::OsRng.fill_bytes(&mut nonce_bytes);
        let aad = wrap_aad(CryptoScheme::AesGcmV1, source_id);
        let wrapped = cipher
            .encrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: dek,
                    aad: aad.as_bytes(),
                },
            )
            .unwrap();
        WrappedDek {
            scheme: CryptoScheme::AesGcmV1,
            wrap_nonce: nonce_bytes.to_vec(),
            wrapped,
        }
    }

    #[test]
    fn scheme_inferred_from_nonce_length() {
        assert_eq!(
            CryptoScheme::from_nonce_len(AES_GCM_NONCE_LEN).unwrap(),
            CryptoScheme::AesGcmV1
        );
        assert_eq!(
            CryptoScheme::from_nonce_len(XCHACHA_NONCE_LEN).unwrap(),
            CryptoScheme::XChaCha20Poly1305V2
        );
        assert!(CryptoScheme::from_nonce_len(16).is_err());
    }

    #[test]
    fn v2_wrap_unwrap_round_trips() {
        let master = fixed_master_key();
        let source = SourceId::new();
        let mut dek = [0u8; DEK_LEN];
        for (i, b) in dek.iter_mut().enumerate() {
            *b = i as u8;
        }
        let wrapped = wrap_dek(&master, &source, &dek).unwrap();
        assert_eq!(wrapped.scheme(), CryptoScheme::XChaCha20Poly1305V2);
        assert_eq!(wrapped.wrap_nonce().len(), XCHACHA_NONCE_LEN);
        assert_eq!(wrapped.wrapped().len(), WRAPPED_DEK_LEN);
        let unwrapped = unwrap_dek(&master, &source, &wrapped).unwrap();
        assert_eq!(&*unwrapped, &dek);
    }

    #[test]
    fn v1_legacy_wrap_still_unwraps() {
        let master = fixed_master_key();
        let source = SourceId::new();
        let mut dek = [0u8; DEK_LEN];
        for (i, b) in dek.iter_mut().enumerate() {
            *b = (i as u8) ^ 0x5a;
        }
        let v1 = wrap_dek_v1_for_test(&master, &source, &dek);
        assert_eq!(v1.scheme(), CryptoScheme::AesGcmV1);
        let unwrapped = unwrap_dek(&master, &source, &v1).unwrap();
        assert_eq!(&*unwrapped, &dek);
    }

    #[test]
    fn rewrap_preserves_dek_and_is_idempotent() {
        let master = fixed_master_key();
        let source = SourceId::new();
        let mut dek = [0u8; DEK_LEN];
        for (i, b) in dek.iter_mut().enumerate() {
            *b = (i as u8).wrapping_add(3);
        }
        let v1 = wrap_dek_v1_for_test(&master, &source, &dek);

        // v1 -> v2 re-wrap yields the SAME DEK under a v2 wrapper.
        let v2 = rewrap_to_v2(&master, &source, &v1)
            .unwrap()
            .expect("v1 upgrades");
        assert_eq!(v2.scheme(), CryptoScheme::XChaCha20Poly1305V2);
        let unwrapped = unwrap_dek(&master, &source, &v2).unwrap();
        assert_eq!(&*unwrapped, &dek, "DEK value must be preserved");

        // Re-wrapping an already-v2 wrapper is a no-op.
        assert!(rewrap_to_v2(&master, &source, &v2).unwrap().is_none());
    }

    #[test]
    fn from_blobs_round_trips_through_storage_shape() {
        let master = fixed_master_key();
        let source = SourceId::new();
        let dek = [9u8; DEK_LEN];
        let wrapped = wrap_dek(&master, &source, &dek).unwrap();
        let restored = WrappedDek::from_blobs(wrapped.wrap_nonce(), wrapped.wrapped()).unwrap();
        assert_eq!(restored.scheme(), CryptoScheme::XChaCha20Poly1305V2);
        let unwrapped = unwrap_dek(&master, &source, &restored).unwrap();
        assert_eq!(&*unwrapped, &dek);
    }

    #[test]
    fn unwrap_fails_under_wrong_master_key() {
        let source = SourceId::new();
        let dek = [1u8; DEK_LEN];
        let wrapped = wrap_dek(&fixed_master_key(), &source, &dek).unwrap();
        let mut other = [0u8; DEK_LEN];
        for (i, b) in other.iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(11).wrapping_add(29);
        }
        let err = unwrap_dek(&MasterKey::from_bytes(other), &source, &wrapped).unwrap_err();
        assert!(matches!(err, Error::DatabaseState(_)));
    }

    #[test]
    fn from_blobs_rejects_wrong_lengths() {
        // Bad nonce length.
        assert!(WrappedDek::from_blobs(&[0u8; 8], &[0u8; WRAPPED_DEK_LEN]).is_err());
        // Good nonce, bad wrapped length.
        assert!(WrappedDek::from_blobs(&[0u8; XCHACHA_NONCE_LEN], &[0u8; 10]).is_err());
    }
}
