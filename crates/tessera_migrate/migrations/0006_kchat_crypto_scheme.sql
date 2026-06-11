-- Session 7 (Post-Quantum Crypto Upgrade): bookkeeping for the
-- per-source DEK wrapping scheme.
--
-- The wrapped DEK rows in `kchat_source_deks` are self-describing — the
-- `wrap_nonce` length distinguishes the legacy AES-256-GCM scheme (12
-- bytes, "v1") from the XChaCha20-Poly1305 scheme (24 bytes, "v2"). This
-- table does NOT change how a DEK is read; it records the outcome of the
-- one-time bulk re-wrap (`tessera_migrate::crypto_upgrade`) so the app can
-- surface crypto provenance ("all per-source keys re-wrapped under
-- XChaCha20-Poly1305 on <date>") and so a partially-upgraded database can
-- be detected cheaply without rescanning every row on each boot.
--
-- A single-row table (CHECK id = 1) is the simplest durable place to keep
-- this scalar state. `wrap_scheme` is the scheme NEW writes use, which is
-- always v2 once this migration has run. `last_upgrade_at` is NULL until
-- the runtime re-wrap has been executed at least once; `v1_remaining` is
-- the count of legacy-wrapped DEK rows observed at that last run (0 means
-- fully upgraded).
CREATE TABLE IF NOT EXISTS kchat_crypto_scheme (
    id              INTEGER PRIMARY KEY CHECK (id = 1),
    wrap_scheme     TEXT NOT NULL,
    last_upgrade_at TEXT,
    v1_remaining    INTEGER NOT NULL DEFAULT 0
);

INSERT OR IGNORE INTO kchat_crypto_scheme (id, wrap_scheme, last_upgrade_at, v1_remaining)
VALUES (1, 'xchacha20-poly1305-v2', NULL, 0);
