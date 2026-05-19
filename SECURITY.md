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

All user data is stored locally on the user's machine by default. No data leaves the device unless the user explicitly connects a remote source or enables an external provider. There is no cloud backend, no telemetry, and no analytics.

### Encrypted local storage

All indexed content is stored in SQLCipher-encrypted databases. Encryption keys are derived per-scope and never leave the device. The knowledge substrate uses XChaCha20-Poly1305 AEAD for content encryption and BLAKE3 for content hashing.

### Safe renderer boundary

The Electron renderer (React UI) operates in a sandboxed context with:

- **`contextIsolation: true`** — renderer JavaScript cannot access Node.js APIs.
- **`nodeIntegration: false`** — no `require()` or `process` in the renderer.
- **Typed IPC only** — all communication between renderer and main process goes through a typed, validated IPC bridge exposed via `contextBridge`.
- **No direct file access** — the renderer cannot read files, access tokens, or interact with the database directly.
- **Content Security Policy** — strict CSP headers prevent inline scripts, eval, and unauthorized resource loading.

### Strict process separation

| Process | Access |
|---|---|
| Renderer (React) | UI only — no file system, no tokens, no database |
| Main (Electron) | IPC routing, window management, OS integration |
| Rust core (N-API) | File indexing, storage, search, export, audit |
| Sidecar (llama-server) | Model inference on loopback only |

### Token and credential handling

- OAuth tokens for remote connectors are stored in the OS keychain (macOS Keychain, Windows Credential Manager), never in plaintext files or the renderer.
- Tokens are never exposed to the renderer process.
- Disconnect flows revoke tokens and delete local index data.

### Audit trail

All security-relevant actions are logged to an append-only audit trail:

- Source connections and disconnections
- Sync operations
- Artifact creation and export
- Settings changes
- Model runtime start/stop

---

## Scope

### In scope for security reports

- Renderer sandbox escapes (accessing Node.js APIs, file system, or tokens from the renderer).
- IPC message injection or spoofing.
- Encrypted storage bypass (reading SQLCipher data without the key).
- Token leakage (OAuth tokens exposed outside the OS keychain).
- Arbitrary code execution through crafted files (e.g., malicious PDF, DOCX).
- Model sidecar escaping loopback (accepting connections from outside localhost).
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
