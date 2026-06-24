# Security Policy

## Supported versions

| Version        | Supported   |
| -------------- | ----------- |
| Latest `main`  | Yes         |
| Older releases | Best effort |

Tessera is pre-1.0 software. Security fixes are applied to the latest `main` branch. Once stable releases begin, this table will track supported release branches.

---

## Reporting vulnerabilities

**Do not open a public GitHub issue for security vulnerabilities.**

### Preferred: GitHub Security Advisories

1. Go to the [Security Advisories page](https://github.com/kennguy3n/Tessera/security/advisories).
2. Click **"Report a vulnerability"**.
3. Provide a detailed description of the vulnerability, steps to reproduce, and potential impact.

### Alternative: Email

Send a detailed report to **ken@uney.com** with:

- Description of the vulnerability.
- Steps to reproduce.
- Potential impact and severity assessment.
- Any suggested fixes or mitigations.

### Response timeline

| Action                 | Timeline                            |
| ---------------------- | ----------------------------------- |
| Acknowledgment         | Within 48 hours                     |
| Initial assessment     | Within 7 days                       |
| Fix or mitigation plan | Within 30 days                      |
| Public disclosure      | After fix is released (coordinated) |

---

## Responsible disclosure policy

We follow coordinated disclosure:

1. **Report privately** using the methods above.
2. **We acknowledge** your report within 48 hours.
3. **We assess** the severity and develop a fix.
4. **We release** the fix and credit you (unless you prefer anonymity).
5. **You may disclose** publicly after the fix is released.

We ask that you:

- Give us reasonable time to address the issue before public disclosure.
- Do not exploit the vulnerability beyond what is necessary to demonstrate it.
- Do not access or modify other users' data.

---

## Security design principles

Tessera is built around these security principles:

### Local-first data sovereignty

All user data is stored locally on the user's machine by default. No data leaves the device unless the user explicitly connects a remote source or enables an external provider. There is no cloud backend and no remote analytics. Tessera ships a **local-only** telemetry sink that is **off by default** and never opens a socket — when on, events are buffered in memory and flushed to a single on-disk JSONL file, and disabling truncates the file.

### Encrypted local storage

All indexed content is stored in SQLCipher-encrypted databases. Encryption keys are derived per-scope and never leave the device. The knowledge substrate uses XChaCha20-Poly1305 AEAD for content encryption and BLAKE3 for content hashing. KChat post bodies are additionally protected by column-level AEAD with a per-source DEK (Data Encryption Key) that is itself wrapped under an app master key; disconnecting a KChat source destroys the DEK and renders previously stored chunks unrecoverable (cryptoshredding). Every artifact and source **deletion** path runs under `PRAGMA secure_delete`, so freed pages are zero-filled and deleted titles, notes, and content cannot be recovered from the SQLite freelist.

See [Post-quantum cryptography](#post-quantum-cryptography) below for the AEAD scheme upgrade (XChaCha20-Poly1305), its backward-compatible migration, the optional hybrid post-quantum KEM, and ML-DSA-65 export provenance signatures.

### Post-quantum cryptography

Tessera integrates the knowledge `crypto` substrate (FIPS 203 ML-KEM-768, FIPS 204 ML-DSA-65, XChaCha20-Poly1305 AEAD, hybrid X25519 + ML-KEM-768 KEM) to harden encryption-at-rest against "harvest-now, decrypt-later" adversaries. The integration is **backward-compatible**: existing databases continue to open and read unchanged, and the stronger primitives apply to newly written data with a tested lazy migration for the rest.

#### Per-source DEK wrapping (XChaCha20-Poly1305)

The per-source DEK is wrapped under the app master key with an authenticated, scheme-versioned envelope. The scheme is self-describing via the wrap **nonce length**, which doubles as a zero-overhead discriminator — no extra version column is needed:

| Scheme         | AEAD                             | Wrap nonce | Status                     |
| -------------- | -------------------------------- | ---------- | -------------------------- |
| `v1` (legacy)  | AES-256-GCM + HKDF-SHA256        | 12 bytes   | read-only, decrypt-only    |
| `v2` (current) | XChaCha20-Poly1305 + HKDF-SHA256 | 24 bytes   | default for all new writes |

- **New DEKs** are always wrapped with `v2`.
- **Reads** dispatch on the stored nonce length, so legacy `v1` DEKs and `v1` chunk ciphertext keep decrypting with no user action.
- Chunk content AEAD is likewise scheme-versioned; the associated data binds both the `source_id` and the scheme version so ciphertext cannot be transplanted between sources or reinterpreted under a different scheme.

#### Lazy, content-preserving migration

`tessera_migrate` provides `detect_scheme()` and `upgrade_dek_wrapping()` (migration `0006_kchat_crypto_scheme`). The upgrade:

- **Re-wraps** each legacy `v1` DEK envelope to `v2` under the same master key, inside a single transaction (atomic; rolls back on any failure, e.g. wrong master key).
- Does **not** re-encrypt stored content. The DEK _value_ is unchanged — only its wrapper is upgraded — so existing chunks remain readable while large databases avoid an O(total-evidence) rewrite. Re-wrapping is O(number of sources), typically completing in milliseconds.
- Records progress in the `kchat_crypto_scheme` bookkeeping row and is idempotent (re-running is a no-op once all rows are `v2`).

#### Optional hybrid post-quantum KEM (`pqc` feature, experimental)

`tessera_core` exposes a hybrid **X25519 + ML-KEM-768** KEM (concatenate-then-KDF combiner over HKDF-SHA256) that can wrap the SQLCipher database key, so a captured database file is protected against future quantum decryption of the wrapped key. This is gated behind the `pqc` cargo feature and is **OFF by default** (experimental). When the feature is disabled there is no behavioural or on-disk change. The hybrid construction means security holds as long as _either_ X25519 _or_ ML-KEM-768 remains unbroken.

#### Export provenance signatures (ML-DSA-65)

Export artifacts (PDF, DOCX, XLSX, evidence packs, and text formats) can be signed with **ML-DSA-65** (FIPS 204) lattice signatures via `tessera_export::signing`. Each signed export writes a detached `<file>.sig` JSON sidecar containing the algorithm identifier, a BLAKE3 content hash, the base64 ML-DSA-65 signature, the base64 verifying key, and an RFC 3339 timestamp. The signed message is domain-separated (`tessera/export-provenance/v1`) to prevent cross-protocol signature reuse. A recipient who pins the publisher's verifying key can prove both the **origin** and the **integrity** of an exported artifact; any post-export tampering fails verification.

### Safe renderer boundary

The Electron renderer (React UI) operates in a sandboxed context with:

- **`contextIsolation: true`** — renderer JavaScript cannot access Node.js APIs.
- **`nodeIntegration: false`** — no `require()` or `process` in the renderer.
- **Typed IPC only** — all communication between renderer and main process goes through a typed, validated IPC bridge exposed via `contextBridge`.
- **No direct file access** — the renderer cannot read files, access tokens, or interact with the database directly.
- **Content Security Policy** — a nonce-based CSP prevents inline scripts, eval, and unauthorized resource loading; `script-src`/`style-src-elem` carry a fresh per-session nonce instead of `'unsafe-inline'`, and all remaining wildcard origins have been removed from the policy.

### Strict process separation

| Process                | Access                                           |
| ---------------------- | ------------------------------------------------ |
| Renderer (React)       | UI only — no file system, no tokens, no database |
| Main (Electron)        | IPC routing, window management, OS integration   |
| Rust core (N-API)      | File indexing, storage, search, export, audit    |
| Sidecar (llama-server) | Model inference on loopback only                 |

### Token and credential handling

- OAuth tokens for remote connectors are stored in the OS keychain (macOS Keychain, Windows Credential Manager, Linux libsecret / GNOME Keyring / KWallet) via Electron's `safeStorage`, never in plaintext files or the renderer.
- A **per-app keychain ACL** policy classifies the active `safeStorage` backend into a trust tier (`enforced-by-os` for macOS Keychain with a Code-Signing-pinned bundle ID; `user-scoped` for Windows DPAPI and Linux gnome-libsecret / kwallet; `none` for Linux `basic_text` fallback, which is XOR with a hardcoded key — _not_ real encryption). When the active backend is `basic_text`, the policy refuses to encrypt secrets by default; in enforce mode it **blocks secret writes** outright, and mid-session backend drift (e.g. a kwallet daemon crash) is detected and logged before the refusal.
- On headless Linux or any environment without a reachable keyring, Tessera falls back to a **password vault** that derives a 256-bit key from a user passphrase via PBKDF2-SHA256 (600 000 iterations) and wraps the DB key + OAuth tokens + API keys with AES-256-GCM.
- Tokens are never exposed to the renderer process.
- **OAuth scope governance**: granted scopes are inspected on every connector sync. If the consent screen has been narrowed since the last grant, the renderer receives a precise list of missing scopes and a re-auth CTA instead of opaque 403s.
- Disconnect flows revoke tokens and delete local index data.

### Audit trail

All security-relevant actions are logged to an append-only audit trail:

- Source connections and disconnections
- Sync operations
- Artifact creation and export
- Settings changes
- Model runtime start/stop

The audit log rotates at 100 K rows to compressed `audit-archive-<ts>.jsonl.gz` archives, surfaced through `audit:getArchives`.

### App-lock (PIN + biometric + FIDO2)

Optional. When enabled, Tessera requires a PIN to unlock the app at startup. The PIN is hashed with scrypt (`N = 2^14`, per-PIN salt, key length 64) and stored vault-encrypted at rest, with the scrypt parameters stored alongside so a future parameter bump doesn't lock anyone out. Failed attempts trigger exponential backoff (30 s → 1 h cap). Biometric unlock dispatches to TouchID (macOS) or Windows Hello (WinRT `UserConsentVerifier`). A third method, **FIDO2/WebAuthn**, registers a hardware or platform authenticator and verifies a signed challenge (TTL-bounded) to unlock; removing the last FIDO2 credential demotes the lock mode so a user can never be locked out. Every app-lock IPC channel shares a token-bucket rate limiter so a compromised renderer can't side-step throttling by alternating channels.

### Auto-updater signature verification

Update artifacts are verified against a hardcoded `UPDATER_TRUST_ANCHORS` array of Ed25519 public keys before `electron-updater` is allowed to call `quitAndInstall`. Multi-anchor support lets a new pubkey ship alongside the old one for an overlap window during key rotation. The release tool `release-tool/signUpdateArtifact.ts` signs artifacts server-side.

### Supply-chain integrity

CI enforces two supply-chain gates on every pull request: `cargo vet` audits the Rust dependency tree against a curated trust store, and `npm audit --audit-level=high` fails the build on high/critical advisories in the Node dependency graph. Both run with no `continue-on-error` legs, so a supply-chain regression blocks merge.

---

## Scope

### In scope for security reports

- Renderer sandbox escapes (accessing Node.js APIs, file system, or tokens from the renderer).
- IPC message injection or spoofing.
- Encrypted storage bypass (reading SQLCipher data without the key).
- Token leakage (OAuth tokens exposed outside the OS keychain).
- Arbitrary code execution through crafted files (e.g., malicious PDF, DOCX).
- Model sidecar escaping loopback (accepting connections from outside localhost).
- Loopback KChat HTTP API auth bypass (Host-header SSRF, bearer-token forgery, body-cap bypass).
- Auto-updater signature bypass (installing an artifact whose signature does not verify against any `UPDATER_TRUST_ANCHORS` entry).
- App-lock bypass (unlocking the app without the correct PIN, biometric, or FIDO2/WebAuthn verification).
- Telemetry exfiltration (the telemetry sink opening a socket or shipping data off-device).
- Audit log tampering.

### Out of scope

- Vulnerabilities in upstream dependencies (report these to the upstream project).
- Issues requiring physical access to an unlocked machine (this is a desktop app; physical access implies full access).
- Social engineering attacks.
- Denial of service against the local application (crashing your own app is not a security issue).
- Issues in the model runtime (llama.cpp) that don't affect Tessera's security boundary.

---

## Dependencies

Tessera uses well-maintained dependencies with known security properties:

| Dependency               | Purpose                       | Security note                                                        |
| ------------------------ | ----------------------------- | -------------------------------------------------------------------- |
| SQLCipher (via rusqlite) | Encrypted local storage       | AES-256 page-level encryption                                        |
| BLAKE3                   | Content hashing               | Cryptographic hash function                                          |
| knowledge `crypto`       | DEK wrapping, KEM, signatures | XChaCha20-Poly1305 AEAD, ML-KEM-768 (FIPS 203), ML-DSA-65 (FIPS 204) |
| Electron                 | Desktop shell                 | Chromium sandbox + process isolation                                 |
| napi-rs                  | Rust ↔ Node.js bridge         | No serialization vulnerabilities                                     |

We monitor dependencies for known vulnerabilities and update promptly.
