//! Experimental post-quantum key encapsulation for the SQLCipher key.
//!
//! **Feature-gated behind `pqc` (default OFF) and not yet wired into the
//! default database-open path.** The wire format below is not frozen and may
//! change before the feature is stabilised.
//!
//! # Threat model: harvest now, decrypt later
//!
//! Tessera databases are SQLCipher files encrypted under a 32-byte key held in
//! the OS keychain. An adversary who exfiltrates a database file today cannot
//! read it — but could archive the ciphertext and decrypt it years from now if
//! a cryptographically-relevant quantum computer breaks the classical key
//! exchange that protected the key in transit/backup. This module wraps the
//! raw SQLCipher key in a **hybrid X25519 + ML-KEM-768 KEM** envelope so that
//! recovering the key requires breaking *both* a classical (X25519) and a
//! lattice (ML-KEM-768) primitive.
//!
//! # Construction
//!
//! ```text
//!   recipient hybrid keypair  (X25519 sk/pk  +  ML-KEM-768 dk/ek)
//!                     │
//!   encap(recipient_pk) ─► (shared_secret[32], hybrid_ciphertext)
//!                     │
//!   AEAD key = HKDF(shared_secret, "tessera/pqc-dbkey-wrap/v1")
//!                     │
//!   sealed = XChaCha20-Poly1305(AEAD key, nonce, sqlcipher_key_hex)
//! ```
//!
//! The recipient stores their hybrid **secret** key in the OS keychain (the
//! same trust boundary that holds the raw SQLCipher key today) and keeps the
//! [`PqcWrappedDbKey`] envelope next to the database. Unwrapping decapsulates
//! the hybrid ciphertext, re-derives the AEAD key, and decrypts the envelope.
//!
//! All key material is `knowledge`-substrate-grade: the hybrid KEM combiner,
//! ML-KEM-768 backend, and XChaCha20-Poly1305 AEAD all come from the audited
//! `knowledge` crypto crate.

use zeroize::{Zeroize, Zeroizing};

use crate::error::{Error, Result};

/// HKDF context binding the KEM shared secret to this specific use (wrapping
/// a SQLCipher key), so the derived AEAD key can never be confused with a key
/// derived for any other purpose from the same shared secret.
const DBKEY_WRAP_CONTEXT: &[u8] = b"tessera/pqc-dbkey-wrap/v1";

/// AAD bound into the envelope so a sealed key produced for this purpose
/// cannot be replayed into a different AEAD context.
const DBKEY_WRAP_AAD: &[u8] = b"tessera/pqc-dbkey-wrap/v1/aad";

/// Serialized length of a hybrid public key: X25519 (32) + ML-KEM-768 ek.
pub const HYBRID_PUBLIC_KEY_LEN: usize = 32 + knowledge_crypto::KEM_PUBLIC_KEY_LEN;

/// Serialized length of a hybrid secret key: X25519 (32) + ML-KEM-768 dk.
pub const HYBRID_SECRET_KEY_LEN: usize = 32 + knowledge_crypto::KEM_SECRET_KEY_LEN;

/// Serialized length of a hybrid KEM ciphertext: X25519 eph pub (32) +
/// ML-KEM-768 ciphertext.
pub const HYBRID_CIPHERTEXT_LEN: usize = 32 + knowledge_crypto::KEM_CIPHERTEXT_LEN;

/// A hybrid recipient keypair, serialized to flat byte vectors for storage in
/// the OS keychain. The secret half is zeroized on drop.
pub struct PqcRecipientKeypair {
    /// Public key the wrapper encapsulates to (`HYBRID_PUBLIC_KEY_LEN` bytes).
    pub public_key: Vec<u8>,
    /// Secret key the unwrapper decapsulates with (`HYBRID_SECRET_KEY_LEN`
    /// bytes). Zeroized on drop.
    pub secret_key: Zeroizing<Vec<u8>>,
}

/// The envelope persisted next to a database: everything the recipient needs
/// (besides their secret key) to recover the SQLCipher key.
#[derive(Debug, Clone, PartialEq, Eq)]
pub struct PqcWrappedDbKey {
    /// Hybrid KEM ciphertext (`HYBRID_CIPHERTEXT_LEN` bytes).
    pub kem_ciphertext: Vec<u8>,
    /// XChaCha20-Poly1305 nonce used to seal the SQLCipher key.
    pub nonce: Vec<u8>,
    /// Sealed SQLCipher key (ciphertext + 16-byte tag).
    pub sealed_key: Vec<u8>,
}

fn split_public(bytes: &[u8]) -> Result<knowledge_crypto::HybridPublicKey> {
    if bytes.len() != HYBRID_PUBLIC_KEY_LEN {
        return Err(Error::DatabaseState(format!(
            "pqc: public key expected {HYBRID_PUBLIC_KEY_LEN} bytes, got {}",
            bytes.len()
        )));
    }
    let mut x25519 = [0u8; 32];
    x25519.copy_from_slice(&bytes[..32]);
    let mut mlkem768 = [0u8; knowledge_crypto::KEM_PUBLIC_KEY_LEN];
    mlkem768.copy_from_slice(&bytes[32..]);
    Ok(knowledge_crypto::HybridPublicKey { x25519, mlkem768 })
}

fn split_secret(bytes: &[u8]) -> Result<knowledge_crypto::HybridSecretKey> {
    if bytes.len() != HYBRID_SECRET_KEY_LEN {
        return Err(Error::DatabaseState(format!(
            "pqc: secret key expected {HYBRID_SECRET_KEY_LEN} bytes, got {}",
            bytes.len()
        )));
    }
    let mut x25519 = [0u8; 32];
    x25519.copy_from_slice(&bytes[..32]);
    let mut mlkem768 = [0u8; knowledge_crypto::KEM_SECRET_KEY_LEN];
    mlkem768.copy_from_slice(&bytes[32..]);
    // `[u8; N]` is `Copy`, so building the struct copies the secret bytes;
    // scrub the intermediate stack copies once the (zeroize-on-drop)
    // `HybridSecretKey` owns its own copy so they are not left on the stack.
    let sk = knowledge_crypto::HybridSecretKey { x25519, mlkem768 };
    x25519.zeroize();
    mlkem768.zeroize();
    Ok(sk)
}

/// Generate a fresh hybrid recipient keypair.
pub fn generate_recipient_keypair() -> Result<PqcRecipientKeypair> {
    let (pk, sk) = knowledge_crypto::hybrid_keypair()
        .map_err(|e| Error::DatabaseState(format!("pqc: keypair generation failed: {e}")))?;

    let mut public_key = Vec::with_capacity(HYBRID_PUBLIC_KEY_LEN);
    public_key.extend_from_slice(&pk.x25519);
    public_key.extend_from_slice(&pk.mlkem768);

    let mut secret_key = Vec::with_capacity(HYBRID_SECRET_KEY_LEN);
    secret_key.extend_from_slice(&sk.x25519);
    secret_key.extend_from_slice(&sk.mlkem768);

    Ok(PqcRecipientKeypair {
        public_key,
        secret_key: Zeroizing::new(secret_key),
    })
}

/// Wrap a raw SQLCipher key (the 64-hex-char string) under `recipient_public`
/// using the hybrid KEM. The recipient can later [`unwrap_db_key`] it with
/// their secret key.
pub fn wrap_db_key(recipient_public: &[u8], sqlcipher_key_hex: &str) -> Result<PqcWrappedDbKey> {
    use rand::RngCore;

    let pk = split_public(recipient_public)?;
    let (shared, ct) = knowledge_crypto::hybrid_kem_encap(&pk)
        .map_err(|e| Error::DatabaseState(format!("pqc: KEM encapsulation failed: {e}")))?;

    let aead_key = knowledge_crypto::derive_key(&shared, DBKEY_WRAP_CONTEXT)
        .map_err(|e| Error::DatabaseState(format!("pqc: AEAD key derivation failed: {e}")))?;

    let mut nonce = [0u8; knowledge_crypto::AEAD_NONCE_LEN];
    rand::rngs::OsRng.fill_bytes(&mut nonce);
    let sealed_key = knowledge_crypto::encrypt_aead(
        &aead_key,
        &nonce,
        sqlcipher_key_hex.as_bytes(),
        DBKEY_WRAP_AAD,
    )
    .map_err(|e| Error::DatabaseState(format!("pqc: sealing SQLCipher key failed: {e}")))?;

    let mut kem_ciphertext = Vec::with_capacity(HYBRID_CIPHERTEXT_LEN);
    kem_ciphertext.extend_from_slice(&ct.x25519_eph_pub);
    kem_ciphertext.extend_from_slice(&ct.mlkem768_ct);

    Ok(PqcWrappedDbKey {
        kem_ciphertext,
        nonce: nonce.to_vec(),
        sealed_key,
    })
}

/// Recover the SQLCipher key from a [`PqcWrappedDbKey`] using the recipient's
/// hybrid secret key. The returned hex string is zeroized on drop.
pub fn unwrap_db_key(
    recipient_secret: &[u8],
    wrapped: &PqcWrappedDbKey,
) -> Result<Zeroizing<String>> {
    let sk = split_secret(recipient_secret)?;

    if wrapped.kem_ciphertext.len() != HYBRID_CIPHERTEXT_LEN {
        return Err(Error::DatabaseState(format!(
            "pqc: KEM ciphertext expected {HYBRID_CIPHERTEXT_LEN} bytes, got {}",
            wrapped.kem_ciphertext.len()
        )));
    }
    let mut x25519_eph_pub = [0u8; 32];
    x25519_eph_pub.copy_from_slice(&wrapped.kem_ciphertext[..32]);
    let mut mlkem768_ct = [0u8; knowledge_crypto::KEM_CIPHERTEXT_LEN];
    mlkem768_ct.copy_from_slice(&wrapped.kem_ciphertext[32..]);
    let ct = knowledge_crypto::HybridCiphertext {
        x25519_eph_pub,
        mlkem768_ct,
    };

    let shared = knowledge_crypto::hybrid_kem_decap(&sk, &ct)
        .map_err(|e| Error::DatabaseState(format!("pqc: KEM decapsulation failed: {e}")))?;
    let aead_key = knowledge_crypto::derive_key(&shared, DBKEY_WRAP_CONTEXT)
        .map_err(|e| Error::DatabaseState(format!("pqc: AEAD key derivation failed: {e}")))?;

    if wrapped.nonce.len() != knowledge_crypto::AEAD_NONCE_LEN {
        return Err(Error::DatabaseState(format!(
            "pqc: nonce expected {} bytes, got {}",
            knowledge_crypto::AEAD_NONCE_LEN,
            wrapped.nonce.len()
        )));
    }
    let mut nonce = [0u8; knowledge_crypto::AEAD_NONCE_LEN];
    nonce.copy_from_slice(&wrapped.nonce);

    let plain =
        knowledge_crypto::decrypt_aead(&aead_key, &nonce, &wrapped.sealed_key, DBKEY_WRAP_AAD)
            .map_err(|e| {
                Error::DatabaseState(format!("pqc: unsealing SQLCipher key failed: {e}"))
            })?;

    let key_hex = String::from_utf8(plain)
        .map_err(|e| Error::DatabaseState(format!("pqc: recovered key is not valid UTF-8: {e}")))?;
    Ok(Zeroizing::new(key_hex))
}

#[cfg(test)]
mod tests {
    use super::*;

    const SAMPLE_KEY: &str = "0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef";

    #[test]
    fn wrap_unwrap_round_trips() {
        let kp = generate_recipient_keypair().unwrap();
        assert_eq!(kp.public_key.len(), HYBRID_PUBLIC_KEY_LEN);
        assert_eq!(kp.secret_key.len(), HYBRID_SECRET_KEY_LEN);

        let wrapped = wrap_db_key(&kp.public_key, SAMPLE_KEY).unwrap();
        assert_eq!(wrapped.kem_ciphertext.len(), HYBRID_CIPHERTEXT_LEN);
        assert_eq!(wrapped.nonce.len(), knowledge_crypto::AEAD_NONCE_LEN);

        let recovered = unwrap_db_key(&kp.secret_key, &wrapped).unwrap();
        assert_eq!(recovered.as_str(), SAMPLE_KEY);
    }

    #[test]
    fn unwrap_fails_under_wrong_recipient_key() {
        let kp = generate_recipient_keypair().unwrap();
        let other = generate_recipient_keypair().unwrap();
        let wrapped = wrap_db_key(&kp.public_key, SAMPLE_KEY).unwrap();
        // Decapsulating with a different secret key yields a different shared
        // secret, so the AEAD open fails closed.
        assert!(unwrap_db_key(&other.secret_key, &wrapped).is_err());
    }

    #[test]
    fn tampered_envelope_fails_auth() {
        let kp = generate_recipient_keypair().unwrap();
        let mut wrapped = wrap_db_key(&kp.public_key, SAMPLE_KEY).unwrap();
        let mid = wrapped.sealed_key.len() / 2;
        wrapped.sealed_key[mid] ^= 0x01;
        assert!(unwrap_db_key(&kp.secret_key, &wrapped).is_err());
    }

    #[test]
    fn rejects_malformed_key_lengths() {
        assert!(wrap_db_key(&[0u8; 8], SAMPLE_KEY).is_err());
        let kp = generate_recipient_keypair().unwrap();
        let wrapped = wrap_db_key(&kp.public_key, SAMPLE_KEY).unwrap();
        assert!(unwrap_db_key(&[0u8; 8], &wrapped).is_err());
    }
}
