//! Per-source data-encryption-key (DEK) layer for KChat chat-body
//! evidence.
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
//! This module adds the second layer: a per-source AEAD encryption
//! key whose **destruction alone** renders any surviving ciphertext
//! bytes unrecoverable, even if a forensic recovery of the SQLCipher
//! pages succeeds AND the SQLCipher master key later leaks. On
//! cryptoshred the existing DELETE wipes the content columns AND
//! `forget_dek` + the deleted `kchat_source_deks` row destroy the DEK,
//! so any leaked backup holding the AEAD ciphertext for this source is
//! permanently undecryptable.
//!
//! # Session 7 upgrade: XChaCha20-Poly1305 + post-quantum-ready KDF
//!
//! The wrap/unwrap and chunk-seal primitives are now supplied by the
//! `knowledge` substrate's audited `crypto` crate:
//!
//! - **DEK wrapping** is delegated to [`tessera_core::crypto`], which
//!   wraps the per-source DEK with **XChaCha20-Poly1305** under an
//!   **HKDF-SHA256**-derived KEK (`knowledge_crypto::derive_key`). The
//!   wrapping is *versioned*: legacy databases carry AES-256-GCM (v1)
//!   wrapped DEKs (12-byte nonce) and stay readable; new writes use
//!   XChaCha20-Poly1305 (v2, 24-byte nonce). The scheme is inferred
//!   from the nonce length, so no schema change is required.
//!
//! - **Chunk-content sealing** mirrors that versioning here. New
//!   chunks are sealed with XChaCha20-Poly1305 (24-byte nonce);
//!   existing AES-256-GCM-sealed chunks (12-byte nonce) keep
//!   decrypting via the legacy path. [`KchatCrypto::open_chunk`]
//!   dispatches on the stored nonce length.
//!
//! Crucially, the **DEK value never changes** across the upgrade — only
//! its wrapper and the chunk AEAD primitive do — so content sealed
//! before the upgrade stays readable after a key re-wrap (see
//! `tessera_migrate`'s crypto-upgrade migration).
//!
//! # Key hierarchy
//!
//! ```text
//!     SQLCipher master key (32-byte, stored in OS keychain)
//!                              │
//!                              │ HKDF-SHA256 (knowledge_crypto::derive_key)
//!                              │   context = "tessera/kchat-source-dek/v2/<id>"
//!                              ▼
//!                  Per-source KEK (32-byte)
//!                              │
//!                              │ XChaCha20-Poly1305 wrap of a 32-byte
//!                              │ randomly-generated DEK
//!                              ▼
//!                Wrapped DEK + 24-byte nonce
//!                  (rows in `kchat_source_deks`)
//! ```
//!
//! The KEK is **never persisted** — it is derived on demand from the
//! SQLCipher master key and the source id. The DEK is what actually
//! encrypts chunk content; it is randomly generated once on first
//! ingest and rotated on key-rotation events (future).
//!
//! # Why XChaCha20-Poly1305
//!
//! - **192-bit nonce**: the extended-nonce ChaCha variant lets us pick
//!   nonces at random with a negligible collision probability across
//!   the lifetime of a source (vs AES-GCM's 96-bit nonce, where random
//!   nonces become a concern past ~2^32 messages). This removes the
//!   need for a stateful nonce counter.
//! - **Software-constant-time**: ChaCha20 has no table lookups, so it
//!   avoids the cache-timing pitfalls of software AES on hosts without
//!   AES-NI — relevant for the heterogeneous SME desktops Tessera runs
//!   on.
//! - **Audited shared implementation**: routing through the
//!   `knowledge` crypto crate means the substrate and Tessera share one
//!   reviewed AEAD construction rather than maintaining two.
//!
//! # Defense-in-depth notes
//!
//! - The associated-data (AAD) of every chunk-content seal binds the
//!   source_id (and scheme version) so a chunk encrypted under source A
//!   cannot be forge-substituted into the chunks row of source B, and a
//!   v1 ciphertext cannot be reinterpreted under the v2 AAD.
//! - All key material in this module is wrapped in
//!   [`zeroize::Zeroizing`] so the bytes are scrubbed on drop. The
//!   `unsafe_code = "forbid"` lint is enforced workspace-wide.

use std::sync::Mutex;

use rand::{rngs::OsRng, RngCore};
use tessera_core::crypto::{self, DEK_LEN};
use tessera_core::error::{Error, Result};
use tessera_core::SourceId;
use zeroize::Zeroizing;

/// Re-exported so existing callers (`manager`, `store`,
/// `tessera_migrate`) keep importing these from `kchat_crypto`. The
/// scheme-aware wrap/unwrap logic itself lives in `tessera_core::crypto`
/// because `tessera_migrate` needs the same primitive without depending
/// on `tessera_sources`.
pub use tessera_core::crypto::{CryptoScheme, MasterKey, WrappedDek};

/// Length of an AES-GCM nonce (12 bytes) — the legacy (v1) chunk-seal
/// nonce length. Only referenced by the backward-compatibility tests
/// that synthesise authentic v1 ciphertext; the production read path
/// detects the scheme via [`CryptoScheme::from_nonce_len`].
#[cfg(test)]
const AES_GCM_NONCE_LEN: usize = crypto::AES_GCM_NONCE_LEN;

/// Length of an XChaCha20-Poly1305 nonce (24 bytes) — the v2 chunk-seal
/// nonce length used for all new writes.
const XCHACHA_NONCE_LEN: usize = crypto::XCHACHA_NONCE_LEN;

/// `aad` prefix bound into every **v1 (legacy)** chunk-content seal.
/// Retained verbatim so existing AES-GCM-sealed chunks keep
/// authenticating on the read path.
const CHUNK_AAD_V1_PREFIX: &str = "tessera/kchat-post-chunk/v1/";

/// `aad` prefix bound into every **v2** chunk-content seal
/// (XChaCha20-Poly1305). Mixes the source_id so a chunk's ciphertext
/// from source A cannot be substituted into source B's chunks row.
const CHUNK_AAD_V2_PREFIX: &str = "tessera/kchat-post-chunk/v2/";

/// Raw 32-byte data-encryption-key. Always wrapped in `Zeroizing` so the
/// bytes are scrubbed on drop.
type DekBytes = Zeroizing<[u8; DEK_LEN]>;

/// A KChat-post chunk's content encrypted under a per-source DEK.
///
/// The `nonce` length identifies the AEAD scheme that produced the
/// ciphertext: 12 bytes → legacy AES-256-GCM (v1), 24 bytes →
/// XChaCha20-Poly1305 (v2). New seals are always v2.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct SealedChunk {
    /// AEAD nonce used to seal this chunk (12 bytes for legacy v1,
    /// 24 bytes for v2).
    pub nonce: Vec<u8>,
    /// Chunk ciphertext: plaintext length plus a 16-byte AEAD tag.
    pub ciphertext: Vec<u8>,
}

/// The facade callers use to encrypt/decrypt chunk content. Holds the
/// master key and a small in-memory cache of unwrapped DEKs keyed by
/// source_id. The cache is bounded by the number of concurrently-active
/// KChat sources, which is small (a typical Tessera workspace has < 100
/// linked channels).
pub struct KchatCrypto {
    master: MasterKey,
    // Mutex<...> because the cache is read-modify-write. The DEK is cloned
    // out from under the lock (a cheap 32-byte `Zeroizing` copy) so the AEAD
    // seal/open never runs while the mutex is held; concurrent ops on
    // distinct sources therefore don't serialise on each other's crypto work.
    dek_cache: Mutex<std::collections::HashMap<String, DekBytes>>,
}

impl KchatCrypto {
    /// Builds the crypto facade from a master key, with an empty DEK
    /// cache.
    pub fn new(master: MasterKey) -> Self {
        Self {
            master,
            dek_cache: Mutex::new(std::collections::HashMap::new()),
        }
    }

    /// Generate a fresh 32-byte DEK, wrap it under the per-source KEK
    /// (XChaCha20-Poly1305, v2), and return the wrapped form to persist.
    /// Also populates the in-memory cache with the raw DEK so the
    /// immediately-following `seal_chunk` does not have to unwrap a copy
    /// of the same bytes the caller is about to persist.
    pub fn generate_and_wrap_dek(&self, source_id: &SourceId) -> Result<WrappedDek> {
        let mut dek = Zeroizing::new([0u8; DEK_LEN]);
        OsRng.fill_bytes(dek.as_mut());

        let wrapped = crypto::wrap_dek(&self.master, source_id, &dek)?;

        self.dek_cache
            .lock()
            .expect("dek_cache mutex poisoned")
            .insert(source_id.to_string(), dek);

        Ok(wrapped)
    }

    /// Unwrap a wrapped DEK (legacy v1 or current v2, auto-detected) and
    /// cache it. Called by the store the first time a chunk needs to be
    /// unsealed for a source whose DEK isn't already in cache.
    pub fn unwrap_dek(&self, source_id: &SourceId, wrapped: &WrappedDek) -> Result<()> {
        let dek = crypto::unwrap_dek(&self.master, source_id, wrapped)?;
        self.dek_cache
            .lock()
            .expect("dek_cache mutex poisoned")
            .insert(source_id.to_string(), dek);
        Ok(())
    }

    /// Clone the cached DEK for `source_id` out from under the cache lock so
    /// the AEAD seal/open runs without the mutex held. The returned copy is
    /// `Zeroizing`, so it is scrubbed when the calling operation finishes.
    fn cached_dek(&self, source_id: &SourceId) -> Option<DekBytes> {
        self.dek_cache
            .lock()
            .expect("dek_cache mutex poisoned")
            .get(&source_id.to_string())
            .cloned()
    }

    /// Encrypt chunk content under the per-source DEK with
    /// XChaCha20-Poly1305 (v2). The associated-data binds source_id and
    /// the scheme version.
    pub fn seal_chunk(&self, source_id: &SourceId, plaintext: &[u8]) -> Result<SealedChunk> {
        let dek = self.cached_dek(source_id).ok_or_else(|| {
            Error::DatabaseState(format!(
                "seal_chunk: DEK for source {source_id} not loaded; call generate_and_wrap_dek or unwrap_dek first"
            ))
        })?;

        let mut nonce = [0u8; XCHACHA_NONCE_LEN];
        OsRng.fill_bytes(&mut nonce);
        let aad = chunk_aad(CryptoScheme::XChaCha20Poly1305V2, source_id);
        let ciphertext = knowledge_crypto::encrypt_aead(&dek, &nonce, plaintext, aad.as_bytes())
            .map_err(|e| Error::DatabaseState(format!("chunk seal failed: {e}")))?;

        Ok(SealedChunk {
            nonce: nonce.to_vec(),
            ciphertext,
        })
    }

    /// Decrypt chunk content, dispatching on the stored nonce length so
    /// both legacy AES-256-GCM (v1) and current XChaCha20-Poly1305 (v2)
    /// ciphertext decrypt correctly. Errors if the AEAD tag does not
    /// verify (tampered ciphertext, wrong DEK, wrong source_id AAD).
    pub fn open_chunk(&self, source_id: &SourceId, sealed: &SealedChunk) -> Result<Vec<u8>> {
        let scheme = CryptoScheme::from_nonce_len(sealed.nonce.len())?;
        let dek = self.cached_dek(source_id).ok_or_else(|| {
            Error::DatabaseState(format!(
                "open_chunk: DEK for source {source_id} not loaded; call unwrap_dek first"
            ))
        })?;
        let aad = chunk_aad(scheme, source_id);

        match scheme {
            CryptoScheme::AesGcmV1 => {
                use aes_gcm::aead::{Aead, KeyInit, Payload};
                use aes_gcm::{Aes256Gcm, Nonce};

                let cipher = Aes256Gcm::new_from_slice(dek.as_ref())
                    .map_err(|e| Error::DatabaseState(format!("DEK init failed: {e}")))?;
                let nonce = Nonce::from_slice(&sealed.nonce);
                cipher
                    .decrypt(
                        nonce,
                        Payload {
                            msg: &sealed.ciphertext,
                            aad: aad.as_bytes(),
                        },
                    )
                    .map_err(|e| Error::DatabaseState(format!("chunk open (v1) failed: {e}")))
            }
            CryptoScheme::XChaCha20Poly1305V2 => {
                let mut nonce = [0u8; XCHACHA_NONCE_LEN];
                nonce.copy_from_slice(&sealed.nonce);
                knowledge_crypto::decrypt_aead(&dek, &nonce, &sealed.ciphertext, aad.as_bytes())
                    .map_err(|e| Error::DatabaseState(format!("chunk open (v2) failed: {e}")))
            }
        }
    }

    /// Drop the cached DEK for `source_id` and overwrite the bytes in
    /// place. Called by `cryptoshred_kchat_source_evidence` so the
    /// in-memory copy of the DEK is gone immediately after the SQLite row
    /// is deleted. Idempotent — calling on a source whose DEK was never
    /// loaded is a no-op (no error).
    pub fn forget_dek(&self, source_id: &SourceId) {
        // The DekBytes Drop impl runs Zeroize unconditionally so simply
        // removing the entry scrubs the bytes before the heap slot is
        // freed.
        self.dek_cache
            .lock()
            .expect("dek_cache mutex poisoned")
            .remove(&source_id.to_string());
    }

    /// Test-only: number of DEKs currently held in the in-memory cache.
    #[cfg(test)]
    pub fn cache_size(&self) -> usize {
        self.dek_cache
            .lock()
            .expect("dek_cache mutex poisoned")
            .len()
    }

    /// Return `true` when a DEK for `source_id` is currently held in the
    /// in-memory cache. Used by the ingest path as a fast-path guard to skip
    /// the DB read + KEK derivation + AEAD unwrap when the DEK is already
    /// loaded, and by post-ingest tests to assert that `forget_dek` evicts the
    /// cache slot in addition to dropping the on-disk wrapped row.
    pub fn has_dek(&self, source_id: &SourceId) -> bool {
        self.dek_cache
            .lock()
            .expect("dek_cache mutex poisoned")
            .contains_key(&source_id.to_string())
    }
}

/// Associated data bound into a chunk-content seal, scoped per source
/// and per scheme version.
fn chunk_aad(scheme: CryptoScheme, source_id: &SourceId) -> String {
    match scheme {
        CryptoScheme::AesGcmV1 => format!("{CHUNK_AAD_V1_PREFIX}{source_id}"),
        CryptoScheme::XChaCha20Poly1305V2 => format!("{CHUNK_AAD_V2_PREFIX}{source_id}"),
    }
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

    /// Seal a chunk under the *legacy* v1 AES-256-GCM scheme so the
    /// backward-compatible read path can be exercised. Mirrors the
    /// original pre-Session-7 `seal_chunk`.
    fn seal_chunk_v1_for_test(
        crypto: &KchatCrypto,
        source_id: &SourceId,
        plaintext: &[u8],
    ) -> SealedChunk {
        use aes_gcm::aead::{Aead, KeyInit, Payload};
        use aes_gcm::{Aes256Gcm, Nonce};

        let guard = crypto.dek_cache.lock().unwrap();
        let dek = guard.get(&source_id.to_string()).unwrap();
        let cipher = Aes256Gcm::new_from_slice(dek.as_ref()).unwrap();
        let mut nonce_bytes = [0u8; AES_GCM_NONCE_LEN];
        OsRng.fill_bytes(&mut nonce_bytes);
        let aad = chunk_aad(CryptoScheme::AesGcmV1, source_id);
        let ciphertext = cipher
            .encrypt(
                Nonce::from_slice(&nonce_bytes),
                Payload {
                    msg: plaintext,
                    aad: aad.as_bytes(),
                },
            )
            .unwrap();
        SealedChunk {
            nonce: nonce_bytes.to_vec(),
            ciphertext,
        }
    }

    #[test]
    fn dek_wrap_then_unwrap_is_identity_and_caches() {
        let crypto = KchatCrypto::new(fixed_master_key());
        let source = SourceId::new();
        let wrapped = crypto.generate_and_wrap_dek(&source).unwrap();
        assert_eq!(wrapped.scheme(), CryptoScheme::XChaCha20Poly1305V2);
        assert_eq!(wrapped.wrap_nonce().len(), XCHACHA_NONCE_LEN);
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
            assert_eq!(sealed.nonce.len(), XCHACHA_NONCE_LEN, "new seals are v2");
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
    fn legacy_v1_sealed_chunk_still_opens() {
        // Backward compatibility: a chunk sealed under the pre-upgrade
        // AES-256-GCM scheme (12-byte nonce) must still decrypt via the
        // nonce-length-dispatched read path.
        let crypto = KchatCrypto::new(fixed_master_key());
        let source = SourceId::new();
        crypto.generate_and_wrap_dek(&source).unwrap();
        let v1 = seal_chunk_v1_for_test(&crypto, &source, b"legacy secret body");
        assert_eq!(v1.nonce.len(), AES_GCM_NONCE_LEN);
        let open = crypto.open_chunk(&source, &v1).unwrap();
        assert_eq!(open, b"legacy secret body");
    }

    #[test]
    fn cross_source_aad_substitution_fails_to_decrypt() {
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
        let mid = sealed.ciphertext.len() / 2;
        sealed.ciphertext[mid] ^= 0x01;
        let err = crypto.open_chunk(&source, &sealed).unwrap_err();
        assert!(matches!(err, Error::DatabaseState(_)));
    }

    #[test]
    fn open_chunk_rejects_unknown_nonce_length() {
        let crypto = KchatCrypto::new(fixed_master_key());
        let source = SourceId::new();
        crypto.generate_and_wrap_dek(&source).unwrap();
        let bad = SealedChunk {
            nonce: vec![0u8; 16],
            ciphertext: vec![0u8; 16],
        };
        let err = crypto.open_chunk(&source, &bad).unwrap_err();
        assert!(matches!(err, Error::DatabaseState(_)));
    }

    #[test]
    fn unwrap_fails_under_wrong_master_key() {
        let crypto_a = KchatCrypto::new(fixed_master_key());
        let source = SourceId::new();
        let wrapped = crypto_a.generate_and_wrap_dek(&source).unwrap();

        let mut other = [0u8; DEK_LEN];
        for (i, b) in other.iter_mut().enumerate() {
            *b = (i as u8).wrapping_mul(11).wrapping_add(29);
        }
        let crypto_b = KchatCrypto::new(MasterKey::from_bytes(other));
        let err = crypto_b.unwrap_dek(&source, &wrapped).unwrap_err();
        assert!(matches!(err, Error::DatabaseState(_)));
    }
}
