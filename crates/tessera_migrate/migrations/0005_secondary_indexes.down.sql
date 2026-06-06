-- Rollback stub for 0005. Tessera migrations are forward-only in
-- production, but the runner supports an optional `<name>.down.sql`
-- companion so the mechanism exists for future use. Dropping these
-- secondary indexes is safe (they are pure query accelerators), which
-- makes 0005 a convenient demonstration of a reversible migration.
DROP INDEX IF EXISTS idx_chunks_hash_file;
DROP INDEX IF EXISTS idx_sources_type_path;
DROP INDEX IF EXISTS idx_chunks_extraction_model;
