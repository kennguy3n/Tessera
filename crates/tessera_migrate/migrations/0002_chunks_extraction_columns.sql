-- Block C (vision-powered indexing) provenance columns on `chunks`.
--
-- Databases created by builds predating the vision-indexing work have
-- a `chunks` table WITHOUT these columns. On a fresh database the
-- `0001` CREATE already includes them, so the runner detects the
-- columns are present and skips these statements (idempotent
-- `ADD COLUMN`); on a legacy database the columns are added here.
ALTER TABLE chunks ADD COLUMN extraction_method TEXT;
ALTER TABLE chunks ADD COLUMN extraction_model_id TEXT;
