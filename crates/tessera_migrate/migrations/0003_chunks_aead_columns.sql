-- Block C Task 2: chunk AEAD columns. All NULLable and
-- backwards-compatible with existing file-sourced rows.
--
--  - `kind` discriminates a `file_chunk` (extracted from a filesystem
--    artifact) from a `chat_post` (a KChat post body). Legacy rows read
--    as NULL and are interpreted as `file_chunk`.
--  - `content_aead` is the AES-256-GCM ciphertext of the chunk content
--    under the per-source DEK. Populated only on `chat_post` rows.
--  - `content_aead_nonce` is the 12-byte AES-GCM nonce that produced
--    `content_aead`. NULL when `content_aead` is.
ALTER TABLE chunks ADD COLUMN kind TEXT;
ALTER TABLE chunks ADD COLUMN content_aead BLOB;
ALTER TABLE chunks ADD COLUMN content_aead_nonce BLOB;
