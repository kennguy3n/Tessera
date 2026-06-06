# 3. SQLCipher for encryption at rest

## Status

Accepted.

## Context

Tessera stores the user's entire knowledge corpus — indexed source
content, embeddings, generated artifacts, citations, tasks, automations,
and the audit trail — on the local disk (see
[ADR-0004](0004-local-first.md)). Because all of this lives on the
user's device rather than a managed server, the on-disk database must be
encrypted so that another process, a stolen laptop, or a backup leak
cannot read it.

The encryption must be transparent to the query layer (the stores issue
ordinary SQL), and key management must integrate with each OS's secure
storage.

## Decision

Use **SQLCipher** as the storage engine via rusqlite's
`bundled-sqlcipher-vendored-openssl` feature, so the bundled SQLite *is*
SQLCipher and no system library is required.

Key handling (`apps/desktop/electron/dbKey.ts` and
`crates/tessera_core/src/db.rs`):

- A 256-bit raw key is generated on first launch with
  `crypto.randomBytes(32)`.
- The key is wrapped via Electron `safeStorage` (Keychain on macOS,
  DPAPI on Windows, libsecret on Linux) and persisted at
  `<userData>/db.key`.
- At bridge init the raw key is passed to Rust and applied with
  `PRAGMA key = "x'<hex>'"`. The `x'...'` literal makes SQLCipher treat
  the 256-bit material as the raw cipher key, bypassing the KDF.
- Pre-encryption plaintext databases are detected and re-encrypted in
  place via `sqlcipher_export` on the first launch that supplies a key,
  so upgrades do not lose data.

When `safeStorage` cannot reach an OS keyring (e.g. headless Linux), a
password-vault fallback derives a key via PBKDF2-SHA256 (600 000
iterations) and wraps the DB key with AES-256-GCM
(`apps/desktop/electron/passwordVault.ts`).

## Consequences

- The corpus is encrypted at rest with a per-install random key that
  never leaves the OS keychain in plaintext form.
- Vendoring SQLCipher + OpenSSL keeps deployment self-contained (no
  reliance on a system SQLite) at the cost of longer build times and a
  larger binary.
- The encryption key must be available before any store opens, so DB key
  resolution is part of the startup critical path and a keychain failure
  must degrade gracefully (the password-vault fallback).
- Decrypted data exists only inside the main/Rust process; the renderer
  never sees the key, which reinforces the Electron boundary
  ([ADR-0002](0002-electron.md)).
