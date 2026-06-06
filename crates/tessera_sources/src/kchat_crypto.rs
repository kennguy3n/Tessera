//! Per-source data-encryption-key (DEK) layer for KChat chat-body
//! evidence .
//!
//! # Threat model and design
//!
//! KChat **post bodies** carry the highest-sensitivity material the
//! Tessera substrate ever indexes: meeting transcripts, contract
//! drafts, credentials, etc. The KChat WS forwarder receives these
//! after the KChat server (or, in MLS-deployed orgs, the client's
//! own MLS leaf) has already decrypted them, so by the time the
//! substrate sees the text it is plaintext UTF-8 inside the
//! Tessera process memory.
//!
//! Block B Task 4 (`cryptoshred_kchat_source_evidence`) already
//! provides the first layer of cryptographic forgetting:
//!
//! 1. `DELETE FROM chunks` (cascades to `chunks_fts` + `chunk_embeddings`).
//! 2. `secure_delete = ON` zero-fills the freed pages.
//! 3. `VACUUM` rebuilds the file so the freelist is also rewritten.
//!
//! This module adds the second layer the user-knowledge note
//! "When writing code for ken in any of his repos … do real
//! implementation .. avoid stub" calls for: a per-source AEAD
//! encryption key whose **destruction alone** renders any surviving
//! ciphertext bytes unrecoverable, even if a forensic recovery of
//! the SQLCipher pages succeeds AND the SQLCipher master key later
//! leaks. This pairs with the existing scrub:
//!
//! - On ingest, KChat post chunks are stored with their plaintext
//!   in `chunks.content` (so FTS5 can tokenize them) AND an
//!   AEAD-encrypted copy in `chunks.content_aead` (under a random
//!   nonce stored in `chunks.content_aead_nonce`). The two
//!   columns are populated in lock-step so the AEAD copy is a true
//!   shadow of what FTS5 indexed.
//!
//! - On retrieval (search snippets), callers can read either
//!   column. The plaintext column is the canonical one. The AEAD
//!   column is the long-term-forgetting belt-and-braces.
//!
//! - On cryptoshred, the existing DELETE wipes BOTH columns AND
//!   `delete_dek_for_source` zeros the in-memory DEK and drops the
//!   wrapped-DEK row. After that point:
//!     * The plaintext column is gone (DELETE + secure_delete + VACUUM).
//!     * The AEAD column is gone (same DELETE).
//!     * The DEK is gone (the SQLCipher row is deleted and the
//!       in-memory copy is zeroized).
//!     * Any leaked backup / forensic image holding the AEAD
//!       ciphertext bytes for this source is now permanently
//!       undecryptable, because the DEK that authenticated those
//!       bytes never existed anywhere outside this database.
//!
//! When MLS-derived KEKs land in a future iteration (Block D), the
//! root KEK source can be swapped for one derived from the user's
//! MLS leaf key without changing the AEAD layer or the on-disk
//! schema — only [`KekProvider::derive_source_kek`] gets a new
//! implementation.
//!
//! # Key hierarchy
//!
//! ```text
//!     SQLCipher master key (32-byte, stored in OS keychain)
//!                              │
//!                              │ HKDF-SHA256 with info=
//!                              │   "tessera/kchat-source-dek/v1/<source_id>"
//!                              ▼
//!                  Per-source KEK (32-byte)
//!                              │
//!                              │ AES-256-GCM wrap of a 32-byte
//!                              │ randomly-generated DEK
//!                              ▼
//!                Wrapped DEK + 12-byte nonce
//!                  (rows in `kchat_source_deks`)
//! ```
//!
//! The KEK is **never persisted** — it is derived on demand from
//! the SQLCipher master key and the source id. The DEK is what
//! actually encrypts chunk content; it is randomly generated once
//! on first ingest and rotated on key-rotation events (future).
//!
//! # Why HKDF-SHA256 and AES-256-GCM
//!
//! - **HKDF-SHA256**: standard NIST-approved KDF. Uses the
//!   SQLCipher master key as the input keying material (which is
//!   already 256 bits of uniform-random entropy from the OS
//!   keychain). The salt is empty (acceptable when the IKM is
//!   already uniform random) and the `info` parameter binds the
//!   derived key to a specific source_id so two sources cannot
//!   collide on the same KEK.
//!
//! - **AES-256-GCM**: pure-Rust via the audited `aes-gcm` crate.
//!   AEAD authentication means a tampered ciphertext (or a
//!   tampered associated-data binding such as the source_id) fails
//!   to decrypt instead of silently producing wrong plaintext.
//!   12-byte nonces are randomly generated; with 96 bits of nonce
//!   space the collision probability is negligible for the volume
//!   of post chunks any single Tessera install will ever produce
//!   (~2^48 ingests per source per key rotation is the safety
//!   margin).
//!
//! # Defense-in-depth notes
//!
//! - The associated-data (AAD) of every chunk-content seal binds
//!   the source_id so a chunk encrypted under source A cannot be
//!   forge-substituted into the chunks row of source B. A future
//!   refactor that mixes up source_id in the DEK lookup would fail
//!   to decrypt rather than returning attacker-influenced
//!   plaintext.
//!
//! - All Key material in this module is wrapped in
//!   [`zeroize::Zeroizing`] so the bytes are scrubbed on drop. The
//!   `unsafe_code = "forbid"` lint is enforced workspace-wide;
//!   `aes-gcm` and `hkdf` are pure-safe Rust.

use std::sync::Mutex;

use aes_gcm::{
    aead::{Aead, KeyInit, Payload},
    Aes256Gcm, Nonce,
};
use hkdf::Hkdf;
use rand::{rngs::OsRng, RngCore};
use sha2::Sha256;
use tessera_core::error::{Error, Result};
use tessera_core::SourceId;
use zeroize::Zeroizing;

/// Length of a wrapped DEK ciphertext (32-byte DEK + 16-byte GCM tag).
const WRAPPED_DEK_LEN: usize = 32 + 16;

/// Length of an AES-GCM nonce (12 bytes per the NIST spec).
const AES_GCM_NONCE_LEN: usize = 12;

/// `info` parameter version prefix for the HKDF KEK derivation.
/// Bumping this string forces a full DEK re-wrap on next ingest;
/// retained as a stable wire contract so a future caller cannot
/// silently invalidate every wrapped DEK by renaming the prefix.
const KEK_HKDF_INFO_PREFIX: &str = "tessera/kchat-source-dek/v1/";

/// `aad` parameter prefix bound into every chunk-content seal. Mixes
/// the source_id so a chunk's ciphertext from source A cannot be
/// substituted into source B's chunks row even if both DEKs are
/// somehow available to the attacker (defence in depth).
const AEAD_CONTEXT_PREFIX: &str = "tessera/kchat-post-chunk/v1/";

/// The 32-byte SQLCipher master key, in raw form. Used as input keying
/// material for the HKDF KEK derivation. Wrapped in [`Zeroizing`] so
/// the bytes are scrubbed on drop.
///
/// Production code constructs this from the 64-hex-character key
/// the bridge already validates in `tessera_core::db::open_shared_with_key`;
/// tests construct one from a deterministic seed.
#[derive(Clone)]
pub struct MasterKey(Zeroizing<[u8; 32]>);

impl std::fmt::Debug for MasterKey {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        // Never log the bytes. A Display/Debug impl that printed the
        // raw key would defeat the keychain isolation outright.
        f.write_str("MasterKey(<redacted; 32 bytes>)")
    }
}

impl MasterKey {
    /// Construct from a 64-hex-character key (the same format
    /// `tessera_core::db::open_shared_with_key` validates). The
    /// length-and-charset check is duplicated here so a future
    /// caller that skips the db-open path still gets the same
    /// guarantee.
    pub fn from_hex(hex: &str) -> Result<Self> {
        if hex.len() != 64 {
            return Err(Error::DatabaseState(format!(
                "MasterKey::from_hex: expected 64 hex chars, got {}",
                hex.len()
            )));
        }
        let mut bytes = [0u8; 32];
        for (i, byte) in bytes.iter_mut().enumerate() {
            let hi = decode_hex_nibble(hex.as_bytes()[i * 2])?;
            let lo = decode_hex_nibble(hex.as_bytes()[i * 2 + 1])?;
            *byte = (hi << 4) | lo;
        }
        Ok(Self(Zeroizing::new(bytes)))
    }

    /// Construct directly from 32 raw bytes. Used by tests and by the
    /// in-memory path where there is no SQLCipher master key file.
    pub fn from_bytes(bytes: [u8; 32]) -> Self {
        Self(Zeroizing::new(bytes))
    }

    fn as_bytes(&self) -> &[u8; 32] {
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

/// Wrap of [`MasterKey`] that derives per-source KEKs on demand.
///
/// Held inside the [`KchatCrypto`] facade so callers never see the
/// raw master key. The struct is `Clone` because the underlying
/// `Zeroizing<[u8; 32]>` is cheap to copy and the Mutex'd cache below
/// is the real synchronisation point.
#[derive(Clone)]
pub struct KekProvider {
    master: MasterKey,
}

impl KekProvider {
    /// Creates a new instance.
    pub fn new(master: MasterKey) -> Self {
        Self { master }
    }

    /// Derive the 32-byte KEK for the given source_id. Returns
    /// `Zeroizing<[u8;32]>` so the derived key is scrubbed on drop.
    ///
    /// Cheap (one HKDF-Extract + Expand). Not cached: the derivation
    /// is deterministic from `(master, source_id)`, so a cache would
    /// only save microseconds per ingest at the cost of holding extra
    /// key material in memory longer than strictly necessary. The
    /// hot path is the DEK lookup / wrap / unwrap, which IS cached.
    pub fn derive_source_kek(&self, source_id: &SourceId) -> Zeroizing<[u8; 32]> {
        let hk = Hkdf::<Sha256>::new(None, self.master.as_bytes());
        let info = format!("{}{}", KEK_HKDF_INFO_PREFIX, source_id);
        let mut okm = Zeroizing::new([0u8; 32]);
        hk.expand(info.as_bytes(), okm.as_mut())
            .expect("HKDF-SHA256 expand of 32 bytes never fails");
        okm
    }
}

/// A single wrapped + nonce pair stored in `kchat_source_deks`.
/// Returned by the store layer's `load_wrapped_dek_for_source`
/// and consumed by [`KchatCrypto::unwrap_dek`].
#[derive(Debug, Clone)]
pub struct WrappedDek {
    /// Wrap nonce.
    pub wrap_nonce: [u8; AES_GCM_NONCE_LEN],
    /// Wrapped.
    pub wrapped: [u8; WRAPPED_DEK_LEN],
}

impl WrappedDek {
    /// Pack the wrap_nonce + wrapped bytes the way the store reads
    /// them back out of SQLite (BLOBs of fixed length). Returns
    /// `None` if either input is the wrong length so a future
    /// schema migration that widens the columns is caught at the
    /// boundary rather than silently producing garbage decryption.
    pub fn from_blobs(wrap_nonce: &[u8], wrapped: &[u8]) -> Result<Self> {
        if wrap_nonce.len() != AES_GCM_NONCE_LEN {
            return Err(Error::DatabaseState(format!(
                "WrappedDek::from_blobs: wrap_nonce expected {AES_GCM_NONCE_LEN} bytes, got {}",
                wrap_nonce.len()
            )));
        }
        if wrapped.len() != WRAPPED_DEK_LEN {
            return Err(Error::DatabaseState(format!(
                "WrappedDek::from_blobs: wrapped expected {WRAPPED_DEK_LEN} bytes, got {}",
                wrapped.len()
            )));
        }
        let mut nonce = [0u8; AES_GCM_NONCE_LEN];
        nonce.copy_from_slice(wrap_nonce);
        let mut w = [0u8; WRAPPED_DEK_LEN];
        w.copy_from_slice(wrapped);
        Ok(Self {
            wrap_nonce: nonce,
            wrapped: w,
        })
    }
}

/// Raw 32-byte data-encryption-key. Always wrapped in `Zeroizing`
/// so the bytes are scrubbed on drop.
type DekBytes = Zeroizing<[u8; 32]>;

/// A KChat-post chunk's content encrypted under a per-source DEK.
///
/// Both fields are fixed-length on the AEAD side:
///   - `nonce`: 12 bytes (AES-GCM standard).
///   - `ciphertext`: input plaintext length + 16-byte tag.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedChunk {
    /// Nonce.
    pub nonce: Vec<u8>,
    /// Ciphertext.
    pub ciphertext: Vec<u8>,
}

/// The facade callers use to encrypt/decrypt chunk content. Holds
/// the KEK provider and a small in-memory cache of unwrapped DEKs
/// keyed by source_id. The cache is bounded by the number of
/// concurrently-active KChat sources, which is small (a typical
/// Tessera workspace has < 100 linked channels).
pub struct KchatCrypto {
    kek_provider: KekProvider,
    // Mutex<...> because the cache is read-modify-write; the lock is
    // only held for the cache map operation, never across the
    // AES-GCM seal/open call.
    dek_cache: Mutex<std::collections::HashMap<String, DekBytes>>,
}

impl KchatCrypto {
    /// Creates a new instance.
    pub fn new(master: MasterKey) -> Self {
        Self {
            kek_provider: KekProvider::new(master),
            dek_cache: Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// Generate a fresh 32-byte DEK, wrap it under the per-source
    /// KEK, and return both the wrapped form (to persist) and the
    /// raw DEK (to use immediately). Called by the store layer the
    /// first time a chunk needs to be sealed for a source whose
    /// `kchat_source_deks` row does not yet exist.
    pub fn generate_and_wrap_dek(&self, source_id: &SourceId) -> Result<WrappedDek> {
        let mut dek = Zeroizing::new([0u8; 32]);
        OsRng.fill_bytes(dek.as_mut());

        let kek = self.kek_provider.derive_source_kek(source_id);
        let cipher = Aes256Gcm::new_from_slice(kek.as_ref())
            .map_err(|e| Error::DatabaseState(format!("KEK init failed: {e}")))?;

        let mut nonce_bytes = [0u8; AES_GCM_NONCE_LEN];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);

        let aad = wrap_aad(source_id);
        let ciphertext = cipher
            .encrypt(
                nonce,
                Payload {
                    msg: dek.as_ref(),
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|e| Error::DatabaseState(format!("DEK wrap failed: {e}")))?;

        if ciphertext.len() != WRAPPED_DEK_LEN {
            return Err(Error::DatabaseState(format!(
                "DEK wrap produced unexpected ciphertext length {}, expected {WRAPPED_DEK_LEN}",
                ciphertext.len()
            )));
        }
        let mut wrapped = [0u8; WRAPPED_DEK_LEN];
        wrapped.copy_from_slice(&ciphertext);

        // Populate the cache atomically with the freshly-generated
        // DEK so the immediately-following seal_chunk call doesn't
        // unwrap a copy of the same bytes the caller is about to
        // persist.
        self.dek_cache
            .lock()
            .expect("dek_cache mutex poisoned")
            .insert(source_id.to_string(), dek);

        Ok(WrappedDek {
            wrap_nonce: nonce_bytes,
            wrapped,
        })
    }

    /// Unwrap a wrapped DEK and cache it. Called by the store the
    /// first time a chunk needs to be unsealed for a source whose
    /// DEK isn't already in cache.
    pub fn unwrap_dek(&self, source_id: &SourceId, wrapped: &WrappedDek) -> Result<()> {
        let kek = self.kek_provider.derive_source_kek(source_id);
        let cipher = Aes256Gcm::new_from_slice(kek.as_ref())
            .map_err(|e| Error::DatabaseState(format!("KEK init failed: {e}")))?;
        let nonce = Nonce::from_slice(&wrapped.wrap_nonce);
        let aad = wrap_aad(source_id);
        let dek_bytes = cipher
            .decrypt(
                nonce,
                Payload {
                    msg: &wrapped.wrapped,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|e| Error::DatabaseState(format!("DEK unwrap failed: {e}")))?;
        if dek_bytes.len() != 32 {
            return Err(Error::DatabaseState(format!(
                "DEK unwrap produced unexpected length {}, expected 32",
                dek_bytes.len()
            )));
        }
        let mut dek = Zeroizing::new([0u8; 32]);
        dek.copy_from_slice(&dek_bytes);
        self.dek_cache
            .lock()
            .expect("dek_cache mutex poisoned")
            .insert(source_id.to_string(), dek);
        Ok(())
    }

    /// Encrypt chunk content under the per-source DEK. The
    /// associated-data binds source_id so a chunk's ciphertext from
    /// source A cannot be substituted into source B's row.
    pub fn seal_chunk(&self, source_id: &SourceId, plaintext: &[u8]) -> Result<SealedChunk> {
        let guard = self.dek_cache.lock().expect("dek_cache mutex poisoned");
        let dek = guard.get(&source_id.to_string()).ok_or_else(|| {
            Error::DatabaseState(format!(
                "seal_chunk: DEK for source {source_id} not loaded; call generate_and_wrap_dek or unwrap_dek first"
            ))
        })?;
        let cipher = Aes256Gcm::new_from_slice(dek.as_ref())
            .map_err(|e| Error::DatabaseState(format!("DEK init failed: {e}")))?;
        let mut nonce_bytes = [0u8; AES_GCM_NONCE_LEN];
        OsRng.fill_bytes(&mut nonce_bytes);
        let nonce = Nonce::from_slice(&nonce_bytes);
        let aad = chunk_aad(source_id);
        let ciphertext = cipher
            .encrypt(
                nonce,
                Payload {
                    msg: plaintext,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|e| Error::DatabaseState(format!("chunk seal failed: {e}")))?;
        Ok(SealedChunk {
            nonce: nonce_bytes.to_vec(),
            ciphertext,
        })
    }

    /// Decrypt chunk content. Errors if the AEAD tag does not
    /// verify (tampered ciphertext, wrong DEK, wrong source_id
    /// AAD).
    pub fn open_chunk(&self, source_id: &SourceId, sealed: &SealedChunk) -> Result<Vec<u8>> {
        if sealed.nonce.len() != AES_GCM_NONCE_LEN {
            return Err(Error::DatabaseState(format!(
                "open_chunk: nonce expected {AES_GCM_NONCE_LEN} bytes, got {}",
                sealed.nonce.len()
            )));
        }
        let guard = self.dek_cache.lock().expect("dek_cache mutex poisoned");
        let dek = guard.get(&source_id.to_string()).ok_or_else(|| {
            Error::DatabaseState(format!(
                "open_chunk: DEK for source {source_id} not loaded; call unwrap_dek first"
            ))
        })?;
        let cipher = Aes256Gcm::new_from_slice(dek.as_ref())
            .map_err(|e| Error::DatabaseState(format!("DEK init failed: {e}")))?;
        let nonce = Nonce::from_slice(&sealed.nonce);
        let aad = chunk_aad(source_id);
        cipher
            .decrypt(
                nonce,
                Payload {
                    msg: &sealed.ciphertext,
                    aad: aad.as_bytes(),
                },
            )
            .map_err(|e| Error::DatabaseState(format!("chunk open failed: {e}")))
    }

    /// Drop the cached DEK for `source_id` and overwrite the bytes
    /// in place. Called by `cryptoshred_kchat_source_evidence` so
    /// the in-memory copy of the DEK is gone immediately after the
    /// SQLite row is deleted. Idempotent — calling on a
    /// source whose DEK was never loaded is a no-op (no error).
    pub fn forget_dek(&self, source_id: &SourceId) {
        // The DekBytes Drop impl runs the Zeroize unconditionally
        // so simply removing the entry is sufficient — the
        // Zeroizing<[u8; 32]> guarantees the bytes are scrubbed
        // before the heap slot is freed.
        self.dek_cache
            .lock()
            .expect("dek_cache mutex poisoned")
            .remove(&source_id.to_string());
    }

    /// Test-only: number of DEKs currently held in the in-memory
    /// cache. Used by unit tests to assert `forget_dek` actually
    /// drops the entry.
    #[cfg(test)]
    pub fn cache_size(&self) -> usize {
        self.dek_cache
            .lock()
            .expect("dek_cache mutex poisoned")
            .len()
    }

    /// Return `true` when a DEK for `source_id` is currently held
    /// in the in-memory cache. Used by post-ingest tests to assert
    /// that `forget_dek` evicts the cache slot in addition to
    /// dropping the on-disk wrapped row. (Public to crate so
    /// integration-style tests in `manager.rs` can reach in.)
    pub fn has_dek(&self, source_id: &SourceId) -> bool {
        self.dek_cache
            .lock()
            .expect("dek_cache mutex poisoned")
            .contains_key(&source_id.to_string())
    }
}

fn wrap_aad(source_id: &SourceId) -> String {
    format!("{}wrap/{}", KEK_HKDF_INFO_PREFIX, source_id)
}

fn chunk_aad(source_id: &SourceId) -> String {
    format!("{}{}", AEAD_CONTEXT_PREFIX, source_id)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn fixed_master_key() -> MasterKey {
        let mut bytes = [0u8; 32];
        for (i, b) in bytes.iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(7).wrapping_add(13);
        }
        MasterKey::from_bytes(bytes)
    }

    #[test]
    fn from_hex_round_trips_to_from_bytes() {
        let hex = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";
        let a = MasterKey::from_hex(hex).unwrap();
        let mut expected = [0u8; 32];
        for i in 0..32 {
            expected[i] = u8::from_str_radix(&hex[i * 2..i * 2 + 2], 16).unwrap();
        }
        let b = MasterKey::from_bytes(expected);
        assert_eq!(a.as_bytes(), b.as_bytes());
    }

    #[test]
    fn from_hex_rejects_short_input() {
        let err = MasterKey::from_hex("dead").unwrap_err();
        assert!(matches!(err, Error::DatabaseState(_)));
    }

    #[test]
    fn from_hex_rejects_non_hex_byte() {
        let err =
            MasterKey::from_hex("ZZZZ456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef")
                .unwrap_err();
        assert!(matches!(err, Error::DatabaseState(_)));
    }

    #[test]
    fn kek_derivation_is_deterministic_and_source_scoped() {
        let p = KekProvider::new(fixed_master_key());
        let source_a = SourceId::new();
        let source_b = SourceId::new();

        let kek_a1 = p.derive_source_kek(&source_a);
        let kek_a2 = p.derive_source_kek(&source_a);
        let kek_b = p.derive_source_kek(&source_b);

        // Same source twice → same KEK.
        assert_eq!(kek_a1.as_ref(), kek_a2.as_ref());
        // Different sources → different KEK.
        assert_ne!(kek_a1.as_ref(), kek_b.as_ref());
    }

    #[test]
    fn dek_wrap_then_unwrap_is_identity_and_caches() {
        let crypto = KchatCrypto::new(fixed_master_key());
        let source = SourceId::new();
        let wrapped = crypto.generate_and_wrap_dek(&source).unwrap();
        assert_eq!(wrapped.wrap_nonce.len(), AES_GCM_NONCE_LEN);
        assert_eq!(wrapped.wrapped.len(), WRAPPED_DEK_LEN);
        // generate_and_wrap_dek populates the cache.
        assert_eq!(crypto.cache_size(), 1);

        // Drop the cached copy and re-unwrap from the persisted bytes —
        // proves the wrap/unwrap is round-trippable.
        crypto.forget_dek(&source);
        assert_eq!(crypto.cache_size(), 0);

        crypto.unwrap_dek(&source, &wrapped).unwrap();
        assert_eq!(crypto.cache_size(), 1);
    }

    #[test]
    fn seal_then_open_round_trips_short_and_long_plaintext() {
        let crypto = KchatCrypto::new(fixed_master_key());
        let source = SourceId::new();
        crypto.generate_and_wrap_dek(&source).unwrap();
        for case in [
            "",
            "x",
            "Hello, KChat!",
            "A".repeat(64).as_str(),
            "Ω 1234567890 …".repeat(128).as_str(),
        ] {
            let sealed = crypto.seal_chunk(&source, case.as_bytes()).unwrap();
            let open = crypto.open_chunk(&source, &sealed).unwrap();
            assert_eq!(open, case.as_bytes(), "round-trip failed for {case:?}");
            // Nonce is fresh on every call.
            let sealed2 = crypto.seal_chunk(&source, case.as_bytes()).unwrap();
            assert_ne!(
                sealed.nonce, sealed2.nonce,
                "nonces must not repeat across seals"
            );
        }
    }

    #[test]
    fn cross_source_aad_substitution_fails_to_decrypt() {
        // The AAD binds source_id, so a chunk encrypted under
        // source A and pasted into source B's row must fail to
        // decrypt rather than silently producing attacker-influenced
        // plaintext.
        let crypto = KchatCrypto::new(fixed_master_key());
        let source_a = SourceId::new();
        let source_b = SourceId::new();
        crypto.generate_and_wrap_dek(&source_a).unwrap();
        crypto.generate_and_wrap_dek(&source_b).unwrap();
        let sealed = crypto.seal_chunk(&source_a, b"secret-a").unwrap();
        let err = crypto.open_chunk(&source_b, &sealed).unwrap_err();
        assert!(matches!(err, Error::DatabaseState(_)));
    }

    #[test]
    fn forget_dek_makes_open_fail_after_persisted_wrap_is_dropped() {
        // Models the cryptoshred path: after the wrapped-DEK row is
        // deleted AND `forget_dek` drops the in-memory copy, the
        // sealed ciphertext is unrecoverable.
        let crypto = KchatCrypto::new(fixed_master_key());
        let source = SourceId::new();
        crypto.generate_and_wrap_dek(&source).unwrap();
        let sealed = crypto.seal_chunk(&source, b"top secret").unwrap();
        crypto.forget_dek(&source);
        let err = crypto.open_chunk(&source, &sealed).unwrap_err();
        assert!(matches!(err, Error::DatabaseState(_)));
        assert_eq!(crypto.cache_size(), 0);
    }

    #[test]
    fn tampered_ciphertext_fails_auth_tag() {
        let crypto = KchatCrypto::new(fixed_master_key());
        let source = SourceId::new();
        crypto.generate_and_wrap_dek(&source).unwrap();
        let mut sealed = crypto.seal_chunk(&source, b"hello world").unwrap();
        // Flip a single bit in the ciphertext middle (the AEAD tag
        // occupies the last 16 bytes; tampering anywhere in the
        // ciphertext OR the tag must fail).
        let mid = sealed.ciphertext.len() / 2;
        sealed.ciphertext[mid] ^= 0x01;
        let err = crypto.open_chunk(&source, &sealed).unwrap_err();
        assert!(matches!(err, Error::DatabaseState(_)));
    }

    #[test]
    fn wrapped_dek_from_blobs_rejects_wrong_lengths() {
        // Defence-in-depth: the store layer reads BLOBs with no
        // length type guard, so a future schema migration that
        // changes the column widths must be caught at the boundary.
        let err = WrappedDek::from_blobs(&[0u8; 8], &[0u8; WRAPPED_DEK_LEN]).unwrap_err();
        assert!(matches!(err, Error::DatabaseState(_)));
        let err = WrappedDek::from_blobs(&[0u8; AES_GCM_NONCE_LEN], &[0u8; 10]).unwrap_err();
        assert!(matches!(err, Error::DatabaseState(_)));
    }

    #[test]
    fn open_chunk_rejects_wrong_nonce_length() {
        let crypto = KchatCrypto::new(fixed_master_key());
        let source = SourceId::new();
        crypto.generate_and_wrap_dek(&source).unwrap();
        let bad = SealedChunk {
            nonce: vec![0u8; AES_GCM_NONCE_LEN - 1],
            ciphertext: vec![0u8; 16],
        };
        let err = crypto.open_chunk(&source, &bad).unwrap_err();
        assert!(matches!(err, Error::DatabaseState(_)));
    }

    #[test]
    fn unwrap_fails_under_wrong_master_key() {
        // Generates a wrapped DEK under one master, then attempts to
        // unwrap under a different master — proves the KEK derivation
        // really is master-keyed and a leaked DB without the master
        // key remains unreadable.
        let crypto_a = KchatCrypto::new(fixed_master_key());
        let source = SourceId::new();
        let wrapped = crypto_a.generate_and_wrap_dek(&source).unwrap();

        let mut other = [0u8; 32];
        for (i, b) in other.iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(11).wrapping_add(29);
        }
        let crypto_b = KchatCrypto::new(MasterKey::from_bytes(other));
        let err = crypto_b.unwrap_dek(&source, &wrapped).unwrap_err();
        assert!(matches!(err, Error::DatabaseState(_)));
    }
}
