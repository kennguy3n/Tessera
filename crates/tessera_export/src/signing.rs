//! ML-DSA-65 (FIPS 204) provenance signing for export artifacts.
//!
//! Every binary export Tessera produces — PDF, DOCX, XLSX, evidence
//! pack, or any text format — can be accompanied by a detached
//! `<file>.sig` sidecar so a recipient can prove the artifact was
//! produced by the holder of a known ML-DSA-65 key and has not been
//! altered since. The signature is post-quantum (lattice-based), so a
//! captured artifact + sidecar remains verifiable even against a
//! future quantum adversary.
//!
//! The signing primitive comes from the knowledge `crypto` substrate
//! ([`knowledge_crypto::signer_backend::MlDsa65Signer`]); this module
//! adds the Tessera-specific sidecar format, domain separation, and
//! file plumbing on top.
//!
//! ## Sidecar format
//!
//! The sidecar is UTF-8 JSON so it is human-inspectable and
//! forward-compatible (unknown fields are ignored on read). Example:
//!
//! ```json
//! {
//!   "format": "tessera-export-signature",
//!   "version": 1,
//!   "algorithm": "ML-DSA-65",
//!   "spec": "FIPS-204",
//!   "domain": "tessera/export-provenance/v1",
//!   "content_hash_algorithm": "BLAKE3-256",
//!   "content_hash_b64": "…",
//!   "signature_b64": "…",
//!   "verifying_key_b64": "…",
//!   "signed_at": "2026-06-10T14:11:00+00:00"
//! }
//! ```
//!
//! ## What is signed
//!
//! To stop an export signature from ever being replayed as a
//! signature over some other substrate message (e.g. a provenance
//! bundle), the signed message is domain-separated:
//!
//! ```text
//! message = DOMAIN_TAG || 0x00 || artifact_bytes
//! ```
//!
//! Verification reconstructs the same framing, so tampering with
//! either the artifact bytes or the domain tag fails the check.

use std::path::{Path, PathBuf};

use base64::engine::general_purpose::STANDARD as B64;
use base64::Engine;
use ml_dsa::{EncodedVerifyingKey, MlDsa65};
use serde::{Deserialize, Serialize};

use knowledge_crypto::signer_backend::{
    MlDsa65EncodedVerifyingKey, MlDsa65Signer, MlDsa65Verifier, SignerBackend,
};
use tessera_core::error::{Error, Result};

/// Domain-separation tag mixed into every export signature. Bump the
/// trailing version if the signed-message framing ever changes.
pub const EXPORT_PROVENANCE_DOMAIN: &[u8] = b"tessera/export-provenance/v1";

/// Stable `format` discriminator written into the sidecar.
const SIDECAR_FORMAT: &str = "tessera-export-signature";

/// Sidecar schema version. Readers reject versions they do not know.
const SIDECAR_VERSION: u32 = 1;

/// Conventional extension appended to the artifact path for its
/// detached signature (e.g. `report.pdf` → `report.pdf.sig`).
pub const SIGNATURE_EXTENSION: &str = "sig";

/// Build the domain-separated message that is actually signed.
///
/// `DOMAIN_TAG || 0x00 || content`. The `0x00` separator keeps the
/// fixed-length-free tag from colliding with any content prefix.
fn provenance_message(content: &[u8]) -> Vec<u8> {
    let mut msg = Vec::with_capacity(EXPORT_PROVENANCE_DOMAIN.len() + 1 + content.len());
    msg.extend_from_slice(EXPORT_PROVENANCE_DOMAIN);
    msg.push(0x00);
    msg.extend_from_slice(content);
    msg
}

/// The on-disk, JSON-serialised export signature sidecar.
#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ExportSignature {
    /// Always [`SIDECAR_FORMAT`]; distinguishes the file from other
    /// JSON sidecars.
    pub format: String,
    /// Sidecar schema version ([`SIDECAR_VERSION`]).
    pub version: u32,
    /// Signature algorithm identifier (`"ML-DSA-65"`).
    pub algorithm: String,
    /// Governing specification (`"FIPS-204"`).
    pub spec: String,
    /// Domain-separation tag used when signing, UTF-8 decoded.
    pub domain: String,
    /// Content-hash algorithm (`"BLAKE3-256"`).
    pub content_hash_algorithm: String,
    /// Base64 BLAKE3-256 hash of the artifact bytes (quick integrity
    /// check independent of the lattice signature).
    pub content_hash_b64: String,
    /// Base64 ML-DSA-65 signature over [`provenance_message`].
    pub signature_b64: String,
    /// Base64 encoded ML-DSA-65 verifying key (~2 kB) needed to check
    /// the signature.
    pub verifying_key_b64: String,
    /// RFC 3339 timestamp the signature was produced.
    pub signed_at: String,
}

impl ExportSignature {
    /// Serialise to pretty JSON bytes for writing to disk.
    pub fn to_json_bytes(&self) -> Result<Vec<u8>> {
        let mut bytes = serde_json::to_vec_pretty(self).map_err(Error::Json)?;
        bytes.push(b'\n');
        Ok(bytes)
    }

    /// Parse a sidecar from JSON bytes, rejecting unknown formats /
    /// versions early so a malformed or future-version sidecar fails
    /// loudly rather than silently mis-verifying.
    pub fn from_json_bytes(bytes: &[u8]) -> Result<Self> {
        let sig: ExportSignature = serde_json::from_slice(bytes).map_err(Error::Json)?;
        if sig.format != SIDECAR_FORMAT {
            return Err(Error::Export(format!(
                "unexpected signature sidecar format {:?} (want {SIDECAR_FORMAT:?})",
                sig.format
            )));
        }
        if sig.version != SIDECAR_VERSION {
            return Err(Error::Export(format!(
                "unsupported signature sidecar version {} (want {SIDECAR_VERSION})",
                sig.version
            )));
        }
        Ok(sig)
    }
}

/// Owns an ML-DSA-65 key pair and signs export artifacts with it.
///
/// The signer is cheap to hold but expensive-ish to generate; the
/// desktop app generates one per provenance identity, persists the
/// encoded key pair via the platform keystore, and reuses it across
/// exports.
pub struct ExportSigner {
    signer: MlDsa65Signer,
}

impl ExportSigner {
    /// Generate a fresh provenance identity from the OS RNG.
    pub fn generate() -> Self {
        Self {
            signer: MlDsa65Signer::generate(),
        }
    }

    /// Adopt an existing signer (e.g. one decoded from a persisted key
    /// pair via [`MlDsa65Signer::decode`]).
    pub fn from_signer(signer: MlDsa65Signer) -> Self {
        Self { signer }
    }

    /// Base64 of this identity's ML-DSA-65 verifying key — publish
    /// this so recipients can pin the provenance identity.
    pub fn verifying_key_b64(&self) -> String {
        B64.encode(verifying_key_bytes(&self.signer.verifier()))
    }

    /// Sign raw `content`, returning the populated [`ExportSignature`].
    pub fn sign_content(&self, content: &[u8]) -> Result<ExportSignature> {
        let message = provenance_message(content);
        let signature = self
            .signer
            .sign_bytes(&message)
            .map_err(|e| Error::Export(format!("ML-DSA-65 signing failed: {e}")))?;
        let content_hash = knowledge_crypto::content_hash(content);

        Ok(ExportSignature {
            format: SIDECAR_FORMAT.to_string(),
            version: SIDECAR_VERSION,
            algorithm: "ML-DSA-65".to_string(),
            spec: "FIPS-204".to_string(),
            domain: String::from_utf8_lossy(EXPORT_PROVENANCE_DOMAIN).into_owned(),
            content_hash_algorithm: "BLAKE3-256".to_string(),
            content_hash_b64: B64.encode(content_hash),
            signature_b64: B64.encode(&signature),
            verifying_key_b64: self.verifying_key_b64(),
            signed_at: chrono::Utc::now().to_rfc3339(),
        })
    }

    /// Sign the bytes already written at `artifact_path` and write the
    /// detached sidecar next to it (`<artifact_path>.sig`). Returns
    /// the sidecar path.
    pub fn sign_file(&self, artifact_path: &Path) -> Result<PathBuf> {
        let content = std::fs::read(artifact_path).map_err(Error::Io)?;
        let sig = self.sign_content(&content)?;
        let sidecar_path = signature_sidecar_path(artifact_path);
        std::fs::write(&sidecar_path, sig.to_json_bytes()?).map_err(Error::Io)?;
        Ok(sidecar_path)
    }
}

/// Compute the sidecar path for an artifact (`foo.pdf` →
/// `foo.pdf.sig`). The signature extension is *appended* rather than
/// replacing the existing one so the original type stays obvious and
/// two artifacts that differ only by extension never collide.
pub fn signature_sidecar_path(artifact_path: &Path) -> PathBuf {
    let mut name = artifact_path.as_os_str().to_os_string();
    name.push(".");
    name.push(SIGNATURE_EXTENSION);
    PathBuf::from(name)
}

/// Extract the raw encoded verifying-key bytes from a verifier.
///
/// `EncodedVerifyingKey<MlDsa65>` derefs to `[u8]`, so this needs no
/// `ml-dsa` type juggling beyond the deref.
fn verifying_key_bytes(verifier: &MlDsa65Verifier) -> Vec<u8> {
    verifier.encode().verifying_key.to_vec()
}

/// Rebuild a [`MlDsa65Verifier`] from raw encoded verifying-key bytes.
fn verifier_from_bytes(bytes: &[u8]) -> Result<MlDsa65Verifier> {
    let encoded = EncodedVerifyingKey::<MlDsa65>::try_from(bytes).map_err(|_| {
        Error::Export(format!(
            "invalid ML-DSA-65 verifying key: expected {} bytes, got {}",
            EncodedVerifyingKey::<MlDsa65>::default().len(),
            bytes.len()
        ))
    })?;
    Ok(MlDsa65Verifier::from_encoded(&MlDsa65EncodedVerifyingKey {
        verifying_key: encoded,
    }))
}

/// Verify `content` against its parsed sidecar.
///
/// Returns `Ok(true)` only when the embedded verifying key validates
/// the ML-DSA-65 signature over the domain-separated content *and* the
/// recorded BLAKE3 content hash matches. A cryptographically invalid
/// signature returns `Ok(false)`; malformed sidecar fields (bad
/// base64, wrong key length) return `Err`.
pub fn verify_content(content: &[u8], sig: &ExportSignature) -> Result<bool> {
    let signature = B64
        .decode(sig.signature_b64.as_bytes())
        .map_err(|e| Error::Export(format!("signature is not valid base64: {e}")))?;
    let vk_bytes = B64
        .decode(sig.verifying_key_b64.as_bytes())
        .map_err(|e| Error::Export(format!("verifying key is not valid base64: {e}")))?;

    // Cheap integrity gate before the (heavier) lattice verify.
    let expected_hash = B64
        .decode(sig.content_hash_b64.as_bytes())
        .map_err(|e| Error::Export(format!("content hash is not valid base64: {e}")))?;
    if knowledge_crypto::content_hash(content).as_slice() != expected_hash.as_slice() {
        return Ok(false);
    }

    let verifier = verifier_from_bytes(&vk_bytes)?;
    let message = provenance_message(content);
    verifier
        .verify_bytes(&message, &signature)
        .map_err(|e| Error::Export(format!("ML-DSA-65 verification error: {e}")))
}

/// Verify an artifact file against its detached sidecar file.
pub fn verify_file(artifact_path: &Path, sidecar_path: &Path) -> Result<bool> {
    let content = std::fs::read(artifact_path).map_err(Error::Io)?;
    let sidecar_bytes = std::fs::read(sidecar_path).map_err(Error::Io)?;
    let sig = ExportSignature::from_json_bytes(&sidecar_bytes)?;
    verify_content(&content, &sig)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn sign_and_verify_round_trip() {
        let signer = ExportSigner::generate();
        let content = b"the quick brown fox exported a report";
        let sig = signer.sign_content(content).expect("sign");
        assert!(verify_content(content, &sig).expect("verify"));
    }

    #[test]
    fn tampered_content_fails_verification() {
        let signer = ExportSigner::generate();
        let sig = signer.sign_content(b"original bytes").expect("sign");
        assert!(!verify_content(b"original bytez", &sig).expect("verify"));
    }

    #[test]
    fn tampered_signature_fails_verification() {
        let signer = ExportSigner::generate();
        let mut sig = signer.sign_content(b"payload").expect("sign");
        // Flip a byte in the decoded signature, re-encode.
        let mut raw = B64.decode(sig.signature_b64.as_bytes()).unwrap();
        raw[0] ^= 0xFF;
        sig.signature_b64 = B64.encode(&raw);
        assert!(!verify_content(b"payload", &sig).expect("verify"));
    }

    #[test]
    fn signature_from_other_key_fails() {
        let signer_a = ExportSigner::generate();
        let signer_b = ExportSigner::generate();
        let content = b"signed by A";
        let mut sig = signer_a.sign_content(content).expect("sign");
        // Swap in B's verifying key: signature no longer matches.
        sig.verifying_key_b64 = signer_b.verifying_key_b64();
        assert!(!verify_content(content, &sig).expect("verify"));
    }

    #[test]
    fn domain_separation_blocks_cross_protocol_reuse() {
        // A signature produced over the bare content (no domain tag)
        // must not verify under the domain-separated scheme.
        let signer = ExportSigner::generate();
        let content = b"domain matters";
        let bare_sig = signer.signer.sign_bytes(content).expect("raw sign");
        let mut sig = signer.sign_content(content).expect("sign");
        sig.signature_b64 = B64.encode(&bare_sig);
        assert!(!verify_content(content, &sig).expect("verify"));
    }

    #[test]
    fn sidecar_json_round_trips() {
        let signer = ExportSigner::generate();
        let sig = signer.sign_content(b"json round trip").expect("sign");
        let bytes = sig.to_json_bytes().expect("serialize");
        let parsed = ExportSignature::from_json_bytes(&bytes).expect("parse");
        assert!(verify_content(b"json round trip", &parsed).expect("verify"));
    }

    #[test]
    fn rejects_unknown_sidecar_version() {
        let signer = ExportSigner::generate();
        let mut sig = signer.sign_content(b"x").expect("sign");
        sig.version = 999;
        let bytes = serde_json::to_vec(&sig).unwrap();
        assert!(ExportSignature::from_json_bytes(&bytes).is_err());
    }

    #[test]
    fn sign_and_verify_file_on_disk() {
        let dir = tempfile::tempdir().unwrap();
        let artifact = dir.path().join("report.pdf");
        std::fs::write(&artifact, b"%PDF-1.7 fake export bytes").unwrap();

        let signer = ExportSigner::generate();
        let sidecar = signer.sign_file(&artifact).expect("sign file");
        assert_eq!(sidecar, dir.path().join("report.pdf.sig"));
        assert!(verify_file(&artifact, &sidecar).expect("verify file"));

        // Tamper with the artifact on disk → verification fails.
        std::fs::write(&artifact, b"%PDF-1.7 tampered export bytes").unwrap();
        assert!(!verify_file(&artifact, &sidecar).expect("verify file"));
    }
}
