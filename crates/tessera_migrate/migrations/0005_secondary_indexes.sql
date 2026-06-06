-- Secondary indexes created AFTER the column-add migrations above so
-- legacy databases (where the columns did not exist when `0001` ran)
-- still get them. All `IF NOT EXISTS`, so re-running is a no-op.

-- Partial index over VLM-derived chunks only. `WHERE … IS NOT NULL`
-- keeps it dense; the sole access pattern is "delete all chunks
-- produced by the previously-installed vision model".
CREATE INDEX IF NOT EXISTS idx_chunks_extraction_model
    ON chunks(extraction_model_id)
    WHERE extraction_model_id IS NOT NULL;

-- Composite (source_type, path) index so idempotent KChat-channel
-- registration can locate an existing row in O(log n) instead of
-- scanning every source.
CREATE INDEX IF NOT EXISTS idx_sources_type_path
    ON sources(source_type, path);

-- Covering (hash, indexed_file_id) index so the hybrid-search
-- post-fusion fetch and the dedup-on-re-search guard resolve a chunk
-- row without a full-table scan on large corpora.
CREATE INDEX IF NOT EXISTS idx_chunks_hash_file
    ON chunks(hash, indexed_file_id);
