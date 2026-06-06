# Security Policy

## Supported versions

| Version | Supported |
|---|---|
| Latest `main` | Yes |
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

| Action | Timeline |
|---|---|
| Acknowledgment | Within 48 hours |
| Initial assessment | Within 7 days |
| Fix or mitigation plan | Within 30 days |
| Public disclosure | After fix is released (coordinated) |

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

All indexed content is stored in SQLCipher-encrypted databases. Encryption keys are derived per-scope and never leave the device. The knowledge substrate uses XChaCha20-Poly1305 AEAD for content encryption and BLAKE3 for content hashing. KChat post bodies are additionally protected by column-level AES-256-GCM with a per-source DEK; disconnecting a KChat source destroys the DEK and renders previously stored chunks unrecoverable. Every artifact and source **deletion** path runs under `PRAGMA secure_delete`, so freed pages are zero-filled and deleted titles, notes, and content cannot be recovered from the SQLite freelist.

### Safe renderer boundary

The Electron renderer (React UI) operates in a sandboxed context with:

- **`contextIsolation: true`** — renderer JavaScript cannot access Node.js APIs.
- **`nodeIntegration: false`** — no `require()` or `process` in the renderer.
- **Typed IPC only** — all communication between renderer and main process goes through a typed, validated IPC bridge exposed via `contextBridge`.
- **No direct file access** — the renderer cannot read files, access tokens, or interact with the database directly.
- **Content Security Policy** — a nonce-based CSP prevents inline scripts, eval, and unauthorized resource loading; `script-src`/`style-src-elem` carry a fresh per-session nonce instead of `'unsafe-inline'`, and all remaining wildcard origins have been removed from the policy.

### Strict process separation

| Process | Access |
|---|---|
| Renderer (React) | UI only — no file system, no tokens, no database |
| Main (Electron) | IPC routing, window management, OS integration |
| Rust core (N-API) | File indexing, storage, search, export, audit |
| Sidecar (llama-server) | Model inference on loopback only |

### Token and credential handling

- OAuth tokens for remote connectors are stored in the OS keychain (macOS Keychain, Windows Credential Manager, Linux libsecret / GNOME Keyring / KWallet) via Electron's `safeStorage`, never in plaintext files or the renderer.
- A **per-app keychain ACL** policy classifies the active `safeStorage` backend into a trust tier (`enforced-by-os` for macOS Keychain with a Code-Signing-pinned bundle ID; `user-scoped` for Windows DPAPI and Linux gnome-libsecret / kwallet; `none` for Linux `basic_text` fallback, which is XOR with a hardcoded key — *not* real encryption). When the active backend is `basic_text`, the policy refuses to encrypt secrets by default; in enforce mode it **blocks secret writes** outright, and mid-session backend drift (e.g. a kwallet daemon crash) is detected and logged before the refusal.
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

| Dependency | Purpose | Security note |
|---|---|---|
| SQLCipher (via rusqlite) | Encrypted local storage | AES-256 page-level encryption |
| BLAKE3 | Content hashing | Cryptographic hash function |
| Electron | Desktop shell | Chromium sandbox + process isolation |
| napi-rs | Rust ↔ Node.js bridge | No serialization vulnerabilities |

We monitor dependencies for known vulnerabilities and update promptly.
