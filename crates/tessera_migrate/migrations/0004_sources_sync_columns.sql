-- KChat backfill cursor + connector sync-error resilience columns on
-- `sources`. All NULL / defaulted on legacy rows; the runtime treats
-- NULL as the "never walked" / "never failed" state.
--
--  - `kchat_backfill_oldest_post_id` — the oldest KChat post id ingested
--    so far; used as the `before=` cursor for the next page fetch.
--  - `kchat_backfill_completed_at` — RFC3339 timestamp set when the walk
--    reached the end; short-circuits future backfill runs.
--  - `last_sync_error` — JSON-encoded `PersistedSyncError` (kind + message).
--  - `retry_count` — consecutive transient failures since the last success.
--  - `failed_permanently` — sticky 0/1 bit cleared only by the user or a
--    proven-healthy sync.
ALTER TABLE sources ADD COLUMN kchat_backfill_oldest_post_id TEXT;
ALTER TABLE sources ADD COLUMN kchat_backfill_completed_at TEXT;
ALTER TABLE sources ADD COLUMN last_sync_error TEXT;
ALTER TABLE sources ADD COLUMN retry_count INTEGER NOT NULL DEFAULT 0;
ALTER TABLE sources ADD COLUMN failed_permanently INTEGER NOT NULL DEFAULT 0;
