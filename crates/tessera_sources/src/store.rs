use rusqlite::params;
use tessera_core::error::{Error, Result};
use tessera_core::{
    open_shared, open_shared_in_memory, SharedConnection, SourceId, SourceStatus, SourceType,
};

use crate::chunker::Chunk;
use crate::source::Source;

fn parse_datetime(s: &str) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map_or_else(|_| chrono::Utc::now(), |dt| dt.with_timezone(&chrono::Utc))
}

fn parse_datetime_opt(s: &str) -> Option<chrono::DateTime<chrono::Utc>> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map(|dt| dt.with_timezone(&chrono::Utc))
        .ok()
}

pub struct SourceStore {
    conn: SharedConnection,
}

impl SourceStore {
    pub fn open(path: &str) -> Result<Self> {
        Self::with_shared_conn(open_shared(path)?)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::with_shared_conn(open_shared_in_memory()?)
    }

    /// Build a store on top of a [`SharedConnection`] that is already
    /// shared with other stores. Used by the napi bridge.
    pub fn with_shared_conn(conn: SharedConnection) -> Result<Self> {
        let store = Self { conn };
        store.init_schema()?;
        Ok(store)
    }

    fn init_schema(&self) -> Result<()> {
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .execute_batch(
                "
            -- Re-assert PRAGMA foreign_keys = ON on this connection.
            -- The primary place this is set is `tessera_core::db::
            -- open_shared`, which applies it at construction time so
            -- every store inherits the setting regardless of which
            -- `init_schema` runs first. We re-assert it here as
            -- defence-in-depth: a future caller that constructs a
            -- `SourceStore` from a raw `rusqlite::Connection` via some
            -- yet-unwritten escape hatch would otherwise silently get
            -- a no-op CASCADE on `chunk_embeddings`. The pragma is
            -- idempotent, so applying it twice costs nothing.
            -- Note that SQLite scopes this pragma per-connection (not
            -- per-database); the per-connection nature is why the
            -- pragma cannot live solely in the schema migration.
            PRAGMA foreign_keys = ON;

            CREATE TABLE IF NOT EXISTS sources (
                id TEXT PRIMARY KEY,
                source_type TEXT NOT NULL,
                path TEXT NOT NULL,
                status TEXT NOT NULL,
                created_at TEXT NOT NULL,
                last_indexed TEXT,
                file_count INTEGER NOT NULL DEFAULT 0
            );

            CREATE TABLE IF NOT EXISTS indexed_files (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                source_id TEXT NOT NULL,
                path TEXT NOT NULL UNIQUE,
                hash TEXT NOT NULL,
                last_modified TEXT NOT NULL,
                chunk_count INTEGER NOT NULL DEFAULT 0,
                FOREIGN KEY (source_id) REFERENCES sources(id)
            );

            CREATE TABLE IF NOT EXISTS chunks (
                id INTEGER PRIMARY KEY AUTOINCREMENT,
                indexed_file_id INTEGER NOT NULL,
                chunk_index INTEGER NOT NULL,
                byte_offset INTEGER NOT NULL,
                content TEXT NOT NULL,
                hash TEXT NOT NULL,
                -- Provenance columns added by Block C (vision-powered
                -- indexing). NULL on legacy / native-extraction rows;
                -- set to the lower-snake-case `ExtractionMethod`
                -- discriminant and the manifest entry id of the
                -- vision model that produced VLM-derived rows. See
                -- `crate::chunker::ExtractionMethod` for the value
                -- catalogue.
                extraction_method TEXT,
                extraction_model_id TEXT,
                FOREIGN KEY (indexed_file_id) REFERENCES indexed_files(id)
            );

            CREATE VIRTUAL TABLE IF NOT EXISTS chunks_fts USING fts5(
                content,
                content='chunks',
                content_rowid='id'
            );

            CREATE TRIGGER IF NOT EXISTS chunks_ai AFTER INSERT ON chunks BEGIN
                INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
            END;

            CREATE TRIGGER IF NOT EXISTS chunks_ad BEFORE DELETE ON chunks BEGIN
                INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
            END;

            CREATE TRIGGER IF NOT EXISTS chunks_au AFTER UPDATE ON chunks BEGIN
                INSERT INTO chunks_fts(chunks_fts, rowid, content) VALUES('delete', old.id, old.content);
                INSERT INTO chunks_fts(rowid, content) VALUES (new.id, new.content);
            END;

            CREATE TABLE IF NOT EXISTS chunk_embeddings (
                chunk_id INTEGER NOT NULL,
                model_id TEXT NOT NULL,
                dim INTEGER NOT NULL,
                vec BLOB NOT NULL,
                PRIMARY KEY (chunk_id, model_id),
                FOREIGN KEY (chunk_id) REFERENCES chunks(id) ON DELETE CASCADE
            );

            CREATE INDEX IF NOT EXISTS idx_chunk_embeddings_model
                ON chunk_embeddings(model_id);

            CREATE TRIGGER IF NOT EXISTS chunks_ad_embeddings BEFORE DELETE ON chunks BEGIN
                DELETE FROM chunk_embeddings WHERE chunk_id = old.id;
            END;

            -- Block B Task 3 (Phase 11): per-channel ACL projection.
            -- The Node-side `KchatEventForwarder` calls
            -- `bridge_refresh_kchat_acl` after every membership
            -- change event (`user_added`, `user_removed`,
            -- `channel_updated`) with the authoritative member
            -- roster from `GET /channels/{id}/members`. The roster
            -- is persisted here so retrieval-side filters can
            -- enforce \"principal is still a member\" without a
            -- round-trip to the KChat server on every search.
            --
            -- The `kchat_principal` singleton (id='singleton') is
            -- the locally-authenticated KChat user id. It is set
            -- by `kchat:connect` after the `/users/me` probe
            -- succeeds and cleared by `kchat:disconnect`. A NULL
            -- principal means \"no KChat connection\" — the ACL
            -- projection logic treats refresh calls as no-ops in
            -- that state rather than auto-revoking every source.
            CREATE TABLE IF NOT EXISTS kchat_principal (
                id TEXT PRIMARY KEY,
                user_id TEXT NOT NULL,
                set_at TEXT NOT NULL
            );

            CREATE TABLE IF NOT EXISTS kchat_source_acl (
                source_id TEXT NOT NULL,
                member_user_id TEXT NOT NULL,
                role TEXT NOT NULL DEFAULT '',
                refreshed_at TEXT NOT NULL,
                PRIMARY KEY (source_id, member_user_id),
                FOREIGN KEY (source_id) REFERENCES sources(id) ON DELETE CASCADE
            );

            -- Indexed lookup for \"every source the principal is a
            -- member of\". Used by `is_principal_member` to answer
            -- the per-source ACL question in O(log n) rather than
            -- scanning the full ACL table.
            CREATE INDEX IF NOT EXISTS idx_kchat_source_acl_member
                ON kchat_source_acl(member_user_id);
            ",
            )
            .map_err(|e| Error::Database(e.to_string()))?;

        // Block C migration: databases created by earlier Tessera
        // builds have a `chunks` table WITHOUT the
        // `extraction_method` / `extraction_model_id` columns. The
        // CREATE TABLE above is a no-op against an existing table, so
        // we have to ALTER explicitly. SQLite has no
        // `ADD COLUMN IF NOT EXISTS`, so we make this idempotent by
        // querying `PRAGMA table_info` for the existing columns
        // FIRST and only issuing the ALTER for ones that don't
        // already exist. This is structurally robust — unlike the
        // "execute then match the rusqlite error string" approach
        // which would silently mis-detect a future rusqlite version
        // that reworded the duplicate-column message.
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let existing_columns: std::collections::HashSet<String> = {
            let mut stmt = conn
                .prepare("PRAGMA table_info(chunks)")
                .map_err(|e| Error::Database(format!("table_info(chunks): {e}")))?;
            let rows = stmt
                .query_map([], |row| row.get::<_, String>(1))
                .map_err(|e| Error::Database(format!("table_info(chunks) query: {e}")))?;
            rows.filter_map(std::result::Result::ok).collect()
        };
        for column in &["extraction_method", "extraction_model_id"] {
            if existing_columns.contains(*column) {
                continue;
            }
            let sql = format!("ALTER TABLE chunks ADD COLUMN {column} TEXT");
            conn.execute(&sql, [])
                .map_err(|e| Error::Database(format!("failed to add chunks.{column}: {e}")))?;
        }

        // Partial index on the new column. Created AFTER the ALTERs
        // above so legacy databases (where the column didn't exist
        // when the batch ran) still get the index. `WHERE … IS NOT
        // NULL` keeps the index dense — the index only holds rows
        // for VLM-derived chunks, which is the only access pattern
        // ("delete all chunks produced by the previously-installed
        // vision model so we can re-extract").
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_chunks_extraction_model
             ON chunks(extraction_model_id)
             WHERE extraction_model_id IS NOT NULL",
            [],
        )
        .map_err(|e| Error::Database(e.to_string()))?;

        // Composite index on (source_type, path) so the idempotent
        // KChat-channel registration in `SourceManager::add_kchat_channel`
        // can locate an existing row in O(log n) instead of scanning
        // every row in the table (tenth-pass Devin Review
        // ANALYSIS_0004). The hot path is `find_source_by_type_and_path`,
        // called once per channel sync; with hundreds of mixed-connector
        // sources the previous `list_sources()` linear scan was the
        // dominant cost on each re-sync. `source_type` is the leading
        // column so the same index also covers future "list all KChat
        // sources" / "list all Gmail sources" queries without a
        // separate index.
        conn.execute(
            "CREATE INDEX IF NOT EXISTS idx_sources_type_path
             ON sources(source_type, path)",
            [],
        )
        .map_err(|e| Error::Database(e.to_string()))?;

        Ok(())
    }

    pub fn add_source(&self, source: &Source) -> Result<()> {
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .execute(
                "INSERT INTO sources (id, source_type, path, status, created_at, last_indexed, file_count)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                params![
                    source.id.to_string(),
                    serde_json::to_string(&source.source_type)
                        .map_err(|e| Error::Database(e.to_string()))?,
                    source.path,
                    serde_json::to_string(&source.status)
                        .map_err(|e| Error::Database(e.to_string()))?,
                    source.created_at.to_rfc3339(),
                    source.last_indexed.map(|t| t.to_rfc3339()),
                    source.file_count as i64,
                ],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(())
    }

    pub fn remove_source(&self, source_id: &SourceId) -> Result<()> {
        let id_str = source_id.to_string();
        let conn = self.conn.lock().expect("connection mutex poisoned");

        let file_ids: Vec<i64> = conn
            .prepare("SELECT id FROM indexed_files WHERE source_id = ?1")
            .map_err(|e| Error::Database(e.to_string()))?
            .query_map(params![id_str], |row| row.get(0))
            .map_err(|e| Error::Database(e.to_string()))?
            .filter_map(std::result::Result::ok)
            .collect();

        for fid in &file_ids {
            conn.execute(
                "DELETE FROM chunks WHERE indexed_file_id = ?1",
                params![fid],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        }

        conn.execute(
            "DELETE FROM indexed_files WHERE source_id = ?1",
            params![id_str],
        )
        .map_err(|e| Error::Database(e.to_string()))?;

        conn.execute("DELETE FROM sources WHERE id = ?1", params![id_str])
            .map_err(|e| Error::Database(e.to_string()))?;

        Ok(())
    }

    pub fn list_sources(&self) -> Result<Vec<Source>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT id, source_type, path, status, created_at, last_indexed, file_count FROM sources",
            )
            .map_err(|e| Error::Database(e.to_string()))?;

        let sources = stmt
            .query_map([], |row| {
                let id_str: String = row.get(0)?;
                let source_type_str: String = row.get(1)?;
                let status_str: String = row.get(3)?;
                let created_at_str: String = row.get(4)?;
                let last_indexed_str: Option<String> = row.get(5)?;

                let parsed_id = uuid::Uuid::parse_str(&id_str).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?;
                let parsed_type: SourceType =
                    serde_json::from_str(&source_type_str).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            1,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?;
                let parsed_status: SourceStatus =
                    serde_json::from_str(&status_str).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            3,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?;

                Ok(Source {
                    id: SourceId(parsed_id),
                    source_type: parsed_type,
                    path: row.get(2)?,
                    status: parsed_status,
                    created_at: parse_datetime(&created_at_str),
                    last_indexed: last_indexed_str.as_deref().and_then(parse_datetime_opt),
                    file_count: row.get::<_, i64>(6)? as u64,
                })
            })
            .map_err(|e| Error::Database(e.to_string()))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| Error::Database(format!("corrupted row: {e}")))?;

        Ok(sources)
    }

    pub fn get_source(&self, source_id: &SourceId) -> Result<Source> {
        let id_str = source_id.to_string();
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .query_row(
                "SELECT id, source_type, path, status, created_at, last_indexed, file_count FROM sources WHERE id = ?1",
                params![id_str],
                |row| {
                    let id_s: String = row.get(0)?;
                    let source_type_str: String = row.get(1)?;
                    let status_str: String = row.get(3)?;
                    let created_at_str: String = row.get(4)?;
                    let last_indexed_str: Option<String> = row.get(5)?;

                    let parsed_id = uuid::Uuid::parse_str(&id_s).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(0, rusqlite::types::Type::Text, Box::new(e))
                    })?;
                    let parsed_type: SourceType = serde_json::from_str(&source_type_str).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(1, rusqlite::types::Type::Text, Box::new(e))
                    })?;
                    let parsed_status: SourceStatus = serde_json::from_str(&status_str).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(3, rusqlite::types::Type::Text, Box::new(e))
                    })?;

                    Ok(Source {
                        id: SourceId(parsed_id),
                        source_type: parsed_type,
                        path: row.get(2)?,
                        status: parsed_status,
                        created_at: parse_datetime(&created_at_str),
                        last_indexed: last_indexed_str.as_deref().and_then(parse_datetime_opt),
                        file_count: row.get::<_, i64>(6)? as u64,
                    })
                },
            )
            .map_err(|e| Error::Database(e.to_string()))
    }

    /// Find the source row (if any) whose `source_type` and `path`
    /// both match the given values. Used by
    /// `SourceManager::add_kchat_channel` to make channel
    /// registration idempotent on the cache-directory path in O(log n)
    /// rather than scanning the entire sources table on every re-sync
    /// (tenth-pass Devin Review ANALYSIS_0004).
    ///
    /// `source_type` is stored as its JSON discriminant in the
    /// `sources.source_type` column (e.g. `"\"Kchat\""`), so the SQL
    /// comparison is on the JSON-encoded form — caller passes a
    /// `SourceType` value and we serialise it the same way `add_source`
    /// does. The composite index `idx_sources_type_path` covers this
    /// query.
    ///
    /// Returns `Ok(None)` when no matching row exists; only genuine
    /// SQL/parse errors propagate as `Err`. This shape lets callers
    /// distinguish "first sync (insert + audit linked event)" from
    /// "re-sync (reindex existing row, suppress audit event)" without
    /// allocating on the not-found path.
    pub fn find_source_by_type_and_path(
        &self,
        source_type: &SourceType,
        path: &str,
    ) -> Result<Option<Source>> {
        let type_str =
            serde_json::to_string(source_type).map_err(|e| Error::Database(e.to_string()))?;
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT id, source_type, path, status, created_at, last_indexed, file_count
                 FROM sources
                 WHERE source_type = ?1 AND path = ?2
                 LIMIT 1",
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        let mut rows = stmt
            .query(params![type_str, path])
            .map_err(|e| Error::Database(e.to_string()))?;
        match rows.next().map_err(|e| Error::Database(e.to_string()))? {
            Some(row) => {
                let id_s: String = row.get(0).map_err(|e| Error::Database(e.to_string()))?;
                let source_type_str: String =
                    row.get(1).map_err(|e| Error::Database(e.to_string()))?;
                let status_str: String = row.get(3).map_err(|e| Error::Database(e.to_string()))?;
                let created_at_str: String =
                    row.get(4).map_err(|e| Error::Database(e.to_string()))?;
                let last_indexed_str: Option<String> =
                    row.get(5).map_err(|e| Error::Database(e.to_string()))?;

                let parsed_id = uuid::Uuid::parse_str(&id_s)
                    .map_err(|e| Error::Database(format!("corrupt source.id: {e}")))?;
                let parsed_type: SourceType = serde_json::from_str(&source_type_str)
                    .map_err(|e| Error::Database(format!("corrupt source.source_type: {e}")))?;
                let parsed_status: SourceStatus = serde_json::from_str(&status_str)
                    .map_err(|e| Error::Database(format!("corrupt source.status: {e}")))?;
                let row_path: String = row.get(2).map_err(|e| Error::Database(e.to_string()))?;
                let file_count: i64 = row.get(6).map_err(|e| Error::Database(e.to_string()))?;
                Ok(Some(Source {
                    id: SourceId(parsed_id),
                    source_type: parsed_type,
                    path: row_path,
                    status: parsed_status,
                    created_at: parse_datetime(&created_at_str),
                    last_indexed: last_indexed_str.as_deref().and_then(parse_datetime_opt),
                    file_count: file_count as u64,
                }))
            }
            None => Ok(None),
        }
    }

    pub fn update_source_status(
        &self,
        source_id: &SourceId,
        status: SourceStatus,
        file_count: Option<u64>,
    ) -> Result<()> {
        let id_str = source_id.to_string();
        let status_str =
            serde_json::to_string(&status).map_err(|e| Error::Database(e.to_string()))?;
        let now = chrono::Utc::now().to_rfc3339();

        let conn = self.conn.lock().expect("connection mutex poisoned");
        if let Some(count) = file_count {
            conn.execute(
                "UPDATE sources SET status = ?1, last_indexed = ?2, file_count = ?3 WHERE id = ?4",
                params![status_str, now, count as i64, id_str],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        } else {
            conn.execute(
                "UPDATE sources SET status = ?1 WHERE id = ?2",
                params![status_str, id_str],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        }
        Ok(())
    }

    /// Upsert the locally-authenticated KChat principal user id.
    ///
    /// The Node-side `kchat:connect` handler calls this with the
    /// `id` returned by `GET /users/me` so the substrate knows
    /// whose membership matters for ACL projection. Stored as a
    /// singleton (id='singleton') so concurrent calls don't
    /// accumulate rows. `set_at` carries the wall-clock for
    /// debug / audit.
    ///
    /// Block B Task 3 (Phase 11).
    pub fn set_kchat_principal(&self, user_id: &str) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .execute(
                "INSERT INTO kchat_principal (id, user_id, set_at)
                 VALUES ('singleton', ?1, ?2)
                 ON CONFLICT(id) DO UPDATE SET
                    user_id = excluded.user_id,
                    set_at  = excluded.set_at",
                params![user_id, now],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(())
    }

    /// Return the locally-authenticated KChat principal user id,
    /// or `None` when no `kchat:connect` has succeeded since the
    /// last `kchat:disconnect`. `refresh_kchat_acl` treats a
    /// missing principal as a no-op rather than auto-revoking
    /// every source: a brief window between substrate startup and
    /// the connect handler must not flap source statuses.
    pub fn get_kchat_principal(&self) -> Result<Option<String>> {
        match self
            .conn
            .lock()
            .expect("connection mutex poisoned")
            .query_row(
                "SELECT user_id FROM kchat_principal WHERE id = 'singleton'",
                [],
                |row| row.get::<_, String>(0),
            ) {
            Ok(user_id) => Ok(Some(user_id)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(Error::Database(e.to_string())),
        }
    }

    /// Clear the principal singleton on `kchat:disconnect`. The
    /// ACL roster rows are intentionally retained — a re-connect
    /// with the same user id reuses them without a refresh
    /// round-trip; a re-connect with a different user id will
    /// flip every linked source to `AccessRevoked` on the next
    /// refresh, which is the correct behaviour.
    pub fn clear_kchat_principal(&self) -> Result<()> {
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .execute("DELETE FROM kchat_principal WHERE id = 'singleton'", [])
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(())
    }

    /// Atomically replace the ACL roster for a single KChat source.
    ///
    /// `members` is the authoritative list returned by
    /// `GET /channels/{id}/members` (or
    /// `KchatClient.listChannelMembers`). All previously-cached
    /// rows for `source_id` are dropped and the supplied
    /// `(user_id, role)` pairs are inserted in their place inside
    /// a single SQLite transaction so concurrent retrieval queries
    /// can never observe a partial roster.
    ///
    /// `role` is the comma-separated KChat role list (e.g.
    /// `"channel_user channel_admin"`); the substrate does not
    /// interpret it but persists it for forensics + future
    /// per-role retrieval filters.
    pub fn replace_kchat_acl(
        &self,
        source_id: &SourceId,
        members: &[(String, String)],
    ) -> Result<()> {
        let id_str = source_id.to_string();
        let now = chrono::Utc::now().to_rfc3339();
        let mut conn = self.conn.lock().expect("connection mutex poisoned");
        let tx = conn
            .transaction()
            .map_err(|e| Error::Database(e.to_string()))?;
        tx.execute(
            "DELETE FROM kchat_source_acl WHERE source_id = ?1",
            params![id_str],
        )
        .map_err(|e| Error::Database(e.to_string()))?;
        {
            let mut stmt = tx
                .prepare(
                    "INSERT INTO kchat_source_acl
                       (source_id, member_user_id, role, refreshed_at)
                     VALUES (?1, ?2, ?3, ?4)
                     ON CONFLICT(source_id, member_user_id) DO UPDATE SET
                        role         = excluded.role,
                        refreshed_at = excluded.refreshed_at",
                )
                .map_err(|e| Error::Database(e.to_string()))?;
            for (user_id, role) in members {
                stmt.execute(params![id_str, user_id, role, now])
                    .map_err(|e| Error::Database(e.to_string()))?;
            }
        }
        tx.commit().map_err(|e| Error::Database(e.to_string()))?;
        Ok(())
    }

    /// Return `true` iff `user_id` is in the cached ACL roster for
    /// `source_id`. Backed by the `idx_kchat_source_acl_member`
    /// composite index so the call is O(log n) on the roster row
    /// count.
    pub fn is_kchat_member(&self, source_id: &SourceId, user_id: &str) -> Result<bool> {
        let id_str = source_id.to_string();
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .query_row(
                "SELECT 1 FROM kchat_source_acl
                 WHERE source_id = ?1 AND member_user_id = ?2",
                params![id_str, user_id],
                |row| row.get::<_, i64>(0),
            )
            .map(|_| true)
            .or_else(|e| match e {
                rusqlite::Error::QueryReturnedNoRows => Ok(false),
                other => Err(Error::Database(other.to_string())),
            })
    }

    /// List the cached ACL roster for `source_id`. Used by the
    /// renderer's source-detail surface (so an operator can see
    /// who else can read the channel) and by the cargo regression
    /// tests.
    pub fn list_kchat_acl(&self, source_id: &SourceId) -> Result<Vec<KchatAclRow>> {
        let id_str = source_id.to_string();
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT member_user_id, role, refreshed_at
                 FROM kchat_source_acl
                 WHERE source_id = ?1
                 ORDER BY member_user_id",
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        let rows = stmt
            .query_map(params![id_str], |row| {
                Ok(KchatAclRow {
                    member_user_id: row.get(0)?,
                    role: row.get(1)?,
                    refreshed_at: row.get(2)?,
                })
            })
            .map_err(|e| Error::Database(e.to_string()))?
            .filter_map(std::result::Result::ok)
            .collect();
        Ok(rows)
    }

    pub fn upsert_indexed_file(
        &self,
        source_id: &SourceId,
        path: &str,
        hash: &str,
        last_modified: &str,
    ) -> Result<i64> {
        let id_str = source_id.to_string();
        let conn = self.conn.lock().expect("connection mutex poisoned");

        let existing: Option<(i64, String)> = conn
            .query_row(
                "SELECT id, hash FROM indexed_files WHERE path = ?1",
                params![path],
                |row| Ok((row.get(0)?, row.get(1)?)),
            )
            .ok();

        if let Some((file_id, old_hash)) = existing {
            if old_hash == hash {
                return Ok(file_id);
            }
            conn.execute(
                "DELETE FROM chunks WHERE indexed_file_id = ?1",
                params![file_id],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
            conn.execute(
                "UPDATE indexed_files SET hash = ?1, last_modified = ?2, chunk_count = 0 WHERE id = ?3",
                params![hash, last_modified, file_id],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
            Ok(file_id)
        } else {
            conn.execute(
                "INSERT INTO indexed_files (source_id, path, hash, last_modified, chunk_count) VALUES (?1, ?2, ?3, ?4, 0)",
                params![id_str, path, hash, last_modified],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
            Ok(conn.last_insert_rowid())
        }
    }

    pub fn insert_chunks(&self, indexed_file_id: i64, chunks: &[Chunk]) -> Result<()> {
        self.insert_chunks_returning_ids(indexed_file_id, chunks)
            .map(|_| ())
    }

    /// Insert chunks and return the `(chunk_index, chunk_id)` pairs
    /// in the same order as the input slice. Used by the indexer to
    /// hand newly-created chunks off to the embedding pipeline
    /// without a follow-up SELECT.
    pub fn insert_chunks_returning_ids(
        &self,
        indexed_file_id: i64,
        chunks: &[Chunk],
    ) -> Result<Vec<i64>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut ids = Vec::with_capacity(chunks.len());
        {
            let mut stmt = conn
                .prepare(
                    "INSERT INTO chunks (
                        indexed_file_id, chunk_index, byte_offset, content, hash,
                        extraction_method, extraction_model_id
                     )
                     VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7)",
                )
                .map_err(|e| Error::Database(e.to_string()))?;

            for chunk in chunks {
                stmt.execute(params![
                    indexed_file_id,
                    chunk.chunk_index as i64,
                    chunk.byte_offset as i64,
                    chunk.content,
                    chunk.hash,
                    chunk
                        .extraction_method
                        .map(crate::chunker::ExtractionMethod::as_str),
                    chunk.extraction_model_id.as_deref(),
                ])
                .map_err(|e| Error::Database(e.to_string()))?;
                ids.push(conn.last_insert_rowid());
            }
        }

        conn.execute(
            "UPDATE indexed_files SET chunk_count = ?1 WHERE id = ?2",
            params![chunks.len() as i64, indexed_file_id],
        )
        .map_err(|e| Error::Database(e.to_string()))?;

        Ok(ids)
    }

    /// Return every chunk (including provenance columns) attached
    /// to the `indexed_files` row matching `path`, ordered by
    /// `chunk_index`. Used by tests + the renderer's per-file
    /// "show chunks" panel.
    ///
    /// The query joins `indexed_files` so callers can pass the
    /// canonical `source_path` they already have on hand (rather
    /// than threading the synthetic `indexed_file_id` through). The
    /// shape mirrors [`Chunk`] one-to-one — including the new Block
    /// C `extraction_method` / `extraction_model_id` columns — so
    /// callers can round-trip rows back into the chunker's data
    /// model.
    pub fn all_chunks_for_path(&self, path: &str) -> Result<Vec<Chunk>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT c.chunk_index, c.byte_offset, c.content, c.hash,
                        c.extraction_method, c.extraction_model_id
                 FROM chunks c
                 JOIN indexed_files f ON f.id = c.indexed_file_id
                 WHERE f.path = ?1
                 ORDER BY c.chunk_index ASC",
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        let rows = stmt
            .query_map(params![path], |row| {
                let extraction_method: Option<String> = row.get(4)?;
                let extraction_model_id: Option<String> = row.get(5)?;
                let chunk_index: i64 = row.get(0)?;
                let byte_offset: i64 = row.get(1)?;
                Ok(Chunk {
                    source_path: path.to_string(),
                    chunk_index: chunk_index as usize,
                    byte_offset: byte_offset as usize,
                    content: row.get(2)?,
                    hash: row.get(3)?,
                    extraction_method: extraction_method
                        .as_deref()
                        .and_then(crate::chunker::ExtractionMethod::from_wire),
                    extraction_model_id,
                })
            })
            .map_err(|e| Error::Database(e.to_string()))?
            .filter_map(std::result::Result::ok)
            .collect();
        Ok(rows)
    }

    /// Stamp a `partial:`-prefixed sentinel on the stored hash for
    /// `file_id` so the next `index_file` call's hash comparison
    /// is guaranteed to miss — forcing a full re-process of the
    /// file. Used by the PDF OCR + chart passes when the rate
    /// limiter cuts processing short partway through a multi-
    /// hundred-page document: without this, the file's real
    /// content hash would already be stamped on the row, and the
    /// next pass would short-circuit on hash match and the
    /// unprocessed pages would be permanently lost until the file
    /// content changes.
    ///
    /// The `partial:` prefix is collision-proof: BLAKE3 hex is 64
    /// lowercase hex chars (`[0-9a-f]`), and `:` is not a hex
    /// character. A real BLAKE3 hash can therefore never produce a
    /// string that matches a `partial:`-prefixed sentinel, so a
    /// `existing_hash == new_hash` comparison in
    /// [`upsert_indexed_file`] is guaranteed to miss and the row
    /// is re-processed (including a `DELETE FROM chunks` so the
    /// partial chunks from the previous attempt are discarded
    /// before the new pass writes its replacements).
    ///
    /// Idempotent: stamping twice keeps a single `partial:` prefix
    /// (we look at the current value and only prepend when it
    /// doesn't already start with the prefix). Without that guard,
    /// repeated partial passes on the same file would compound to
    /// `partial:partial:partial:…` and bloat the row.
    pub fn mark_file_needs_reindex(&self, file_id: i64) -> Result<()> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        conn.execute(
            "UPDATE indexed_files
             SET hash = CASE
                 WHEN hash LIKE 'partial:%' THEN hash
                 ELSE 'partial:' || hash
             END
             WHERE id = ?1",
            params![file_id],
        )
        .map_err(|e| Error::Database(e.to_string()))?;
        Ok(())
    }

    pub fn get_file_hash(&self, path: &str) -> Result<Option<String>> {
        let result = self
            .conn
            .lock()
            .expect("connection mutex poisoned")
            .query_row(
                "SELECT hash FROM indexed_files WHERE path = ?1",
                params![path],
                |row| row.get(0),
            )
            .ok();
        Ok(result)
    }

    pub fn remove_indexed_file(&self, path: &str) -> Result<()> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        if let Ok(file_id) = conn.query_row(
            "SELECT id FROM indexed_files WHERE path = ?1",
            params![path],
            |row| row.get::<_, i64>(0),
        ) {
            conn.execute(
                "DELETE FROM chunks WHERE indexed_file_id = ?1",
                params![file_id],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
            conn.execute("DELETE FROM indexed_files WHERE id = ?1", params![file_id])
                .map_err(|e| Error::Database(e.to_string()))?;
        }
        Ok(())
    }

    pub fn search_fts(&self, query: &str, limit: usize) -> Result<Vec<SearchHit>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        // Block B Task 3 (Phase 11): retrieval-side ACL filter.
        // The `JOIN sources s` + `WHERE s.status != ?3` clause
        // excludes chunks whose source row has been transitioned
        // to `SourceStatus::AccessRevoked` (the principal lost
        // KChat-channel membership, or the channel was archived
        // / deleted). Filtering BEFORE the LIMIT means revoked
        // chunks don't consume top-k slots — the FTS5 engine
        // still scores them but they're stripped before sorting
        // truncates to `limit`. The status comparison uses the
        // exact serde-JSON-stringified form (`SourceStatus::as_stored_json`)
        // so a future variant rename cannot drift this predicate
        // from the persistence layer.
        let mut stmt = conn
            .prepare(
                "SELECT c.id, c.content, c.hash, c.chunk_index, c.byte_offset, f.path,
                        f.source_id, rank
                 FROM chunks_fts fts
                 JOIN chunks c ON c.id = fts.rowid
                 JOIN indexed_files f ON f.id = c.indexed_file_id
                 JOIN sources s ON s.id = f.source_id
                 WHERE chunks_fts MATCH ?1
                   AND s.status != ?3
                 ORDER BY rank
                 LIMIT ?2",
            )
            .map_err(|e| Error::Database(e.to_string()))?;

        let results = stmt
            .query_map(
                params![
                    query,
                    limit as i64,
                    SourceStatus::AccessRevoked.as_stored_json(),
                ],
                |row| {
                    Ok(SearchHit {
                        chunk_id: row.get::<_, i64>(0)?,
                        content: row.get(1)?,
                        hash: row.get(2)?,
                        chunk_index: row.get::<_, i64>(3)? as usize,
                        byte_offset: row.get::<_, i64>(4)? as usize,
                        source_path: row.get(5)?,
                        source_id: row.get(6)?,
                        relevance: -row.get::<_, f64>(7)?,
                    })
                },
            )
            .map_err(|e| Error::Database(e.to_string()))?
            .filter_map(std::result::Result::ok)
            .collect();

        Ok(results)
    }

    /// Look up the contents of a set of chunks by id, preserving the
    /// input order. Used by the hybrid retrieval pipeline to hydrate
    /// the final ranked list with chunk text + source metadata after
    /// fusion has determined the order.
    ///
    /// Block B Task 3 (Phase 11) defence-in-depth: the BM25 path
    /// (`search_fts`) and the embedding-load path
    /// (`load_embeddings_for_model`) already filter
    /// `SourceStatus::AccessRevoked` chunks out before they reach
    /// the fusion stage, but a chunk id arriving here that
    /// belongs to a now-revoked source — e.g. a slow concurrent
    /// `refresh_kchat_acl` revoked the source between the candidate
    /// gather and this fetch — must still be dropped. The
    /// `WHERE s.status != ?` clause is the last gate before
    /// content text reaches the caller; revoked rows are simply
    /// omitted (the caller's input-order reorder loop skips them
    /// transparently).
    pub fn fetch_chunks_by_ids(&self, ids: &[i64]) -> Result<Vec<SearchHit>> {
        if ids.is_empty() {
            return Ok(Vec::new());
        }
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let placeholders = std::iter::repeat_n("?", ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT c.id, c.content, c.hash, c.chunk_index, c.byte_offset, f.path, f.source_id
             FROM chunks c
             JOIN indexed_files f ON f.id = c.indexed_file_id
             JOIN sources s ON s.id = f.source_id
             WHERE c.id IN ({placeholders})
               AND s.status != ?"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| Error::Database(e.to_string()))?;
        let mut id_params: Vec<rusqlite::types::Value> = ids
            .iter()
            .map(|&i| rusqlite::types::Value::Integer(i))
            .collect();
        // Bind the `s.status != ?` parameter at the end so its
        // placeholder index matches the SQL above.
        id_params.push(rusqlite::types::Value::Text(
            SourceStatus::AccessRevoked.as_stored_json().to_owned(),
        ));
        let rows: Vec<SearchHit> = stmt
            .query_map(rusqlite::params_from_iter(id_params.iter()), |row| {
                Ok(SearchHit {
                    chunk_id: row.get::<_, i64>(0)?,
                    content: row.get(1)?,
                    hash: row.get(2)?,
                    chunk_index: row.get::<_, i64>(3)? as usize,
                    byte_offset: row.get::<_, i64>(4)? as usize,
                    source_path: row.get(5)?,
                    source_id: row.get(6)?,
                    // relevance is filled in by the caller based on the
                    // hybrid-fusion score; we set 0.0 here as a sentinel.
                    relevance: 0.0,
                })
            })
            .map_err(|e| Error::Database(e.to_string()))?
            .filter_map(std::result::Result::ok)
            .collect();

        // Reorder to match the requested id sequence.
        let mut by_id: std::collections::HashMap<i64, SearchHit> =
            rows.into_iter().map(|h| (h.chunk_id, h)).collect();
        let ordered: Vec<SearchHit> = ids.iter().filter_map(|id| by_id.remove(id)).collect();
        Ok(ordered)
    }

    /// Upsert an embedding for a chunk. Replaces any existing row with
    /// the same `(chunk_id, model_id)` pair so re-embedding the same
    /// chunk doesn't accumulate duplicates.
    pub fn upsert_chunk_embedding(
        &self,
        chunk_id: i64,
        model_id: &str,
        dim: usize,
        vec_bytes: &[u8],
    ) -> Result<()> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        conn.execute(
            "INSERT INTO chunk_embeddings (chunk_id, model_id, dim, vec)
             VALUES (?1, ?2, ?3, ?4)
             ON CONFLICT(chunk_id, model_id) DO UPDATE SET
                dim = excluded.dim,
                vec = excluded.vec",
            params![chunk_id, model_id, dim as i64, vec_bytes],
        )
        .map_err(|e| Error::Database(e.to_string()))?;
        Ok(())
    }

    /// Load every embedding stored for a given model. Used by hybrid
    /// retrieval to scan for cosine similarity. For corpora large
    /// enough that an in-memory scan is slow (~100K+ chunks), this
    /// can be replaced with an sqlite-vec / sqlite-vss native index;
    /// the trait surface stays the same.
    ///
    /// Block B Task 3 (Phase 11): the join through
    /// `indexed_files → sources` and the `s.status != ?` filter
    /// keep embedding rows from `AccessRevoked` sources out of the
    /// candidate pool entirely, so the vector-cosine path matches
    /// the BM25 path's ACL enforcement. Without this filter, a
    /// revoked source's vectors would still rank in the cosine
    /// top-k and waste fusion slots even though `fetch_chunks_by_ids`
    /// would later drop them — wasting compute and risking
    /// information leakage via timing / size-of-result-set side
    /// channels.
    pub fn load_embeddings_for_model(&self, model_id: &str) -> Result<Vec<ChunkEmbeddingRow>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT ce.chunk_id, ce.model_id, ce.vec
                 FROM chunk_embeddings ce
                 JOIN chunks c       ON c.id = ce.chunk_id
                 JOIN indexed_files f ON f.id = c.indexed_file_id
                 JOIN sources s      ON s.id = f.source_id
                 WHERE ce.model_id = ?1
                   AND s.status != ?2",
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        let rows = stmt
            .query_map(
                params![model_id, SourceStatus::AccessRevoked.as_stored_json()],
                |row| {
                    let chunk_id: i64 = row.get(0)?;
                    let model_id: String = row.get(1)?;
                    let bytes: Vec<u8> = row.get(2)?;
                    let vector = crate::embedding::decode_vec(&bytes).unwrap_or_default();
                    Ok(ChunkEmbeddingRow {
                        chunk_id,
                        model_id,
                        vector,
                    })
                },
            )
            .map_err(|e| Error::Database(e.to_string()))?
            .filter_map(std::result::Result::ok)
            .filter(|r| !r.vector.is_empty())
            .collect();
        Ok(rows)
    }

    /// Find chunks that don't yet have an embedding for the given
    /// model. The indexer uses this to incrementally back-fill
    /// embeddings without re-processing every chunk on every run.
    pub fn chunks_missing_embedding(
        &self,
        model_id: &str,
        limit: usize,
    ) -> Result<Vec<(i64, String)>> {
        self.chunks_missing_embedding_excluding(model_id, limit, &[])
    }

    /// Variant of [`chunks_missing_embedding`] that filters out chunk
    /// IDs the caller has already attempted-and-failed this session.
    ///
    /// `backfill_embeddings` calls this with the running set of
    /// permanently-failing chunk IDs so the SQL query doesn't keep
    /// returning the same broken chunks on every iteration. Without
    /// this filter, a corpus with P passing chunks and F permanently-
    /// failing chunks at batch_size B requires `O(P * ⌈F/B⌉ / B)`
    /// iterations to converge — every batch reads F failures before
    /// finding the next B passes. With the filter, the failing set
    /// is paid for exactly once (the first time each failure is hit)
    /// and convergence is `O(P/B + F/B)`.
    ///
    /// SQLite's default `SQLITE_MAX_VARIABLE_NUMBER` is 32766 in modern
    /// builds, so callers can safely accumulate thousands of excludes
    /// before the prepared statement compiler complains; in practice
    /// backfill should bail via the in-loop stall detector long before
    /// the exclude list gets that large.
    pub fn chunks_missing_embedding_excluding(
        &self,
        model_id: &str,
        limit: usize,
        exclude_chunk_ids: &[i64],
    ) -> Result<Vec<(i64, String)>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        // Build the SQL with one `?` placeholder per excluded ID. We
        // can't bind a Vec to a single placeholder in rusqlite; the
        // canonical workaround is to construct the in-clause with the
        // matching number of placeholders. We could use a temp table
        // instead, but for the small exclude sets backfill produces
        // (bounded by `total_chunks - successfully_embedded`), in-line
        // binding is faster and simpler.
        let exclude_placeholders = if exclude_chunk_ids.is_empty() {
            String::new()
        } else {
            let placeholders: Vec<String> = (0..exclude_chunk_ids.len())
                .map(|i| format!("?{}", i + 3))
                .collect();
            format!(" AND c.id NOT IN ({})", placeholders.join(", "))
        };
        // `ORDER BY c.id` makes the iteration order deterministic
        // and stable across repeated calls with the same exclude set.
        // Correctness doesn't depend on the order — the upsert is
        // idempotent and successful embeddings drop out of the
        // left-join filter on the next pass — but pinning it serves
        // two real benefits:
        //
        //   1. **Debuggability.** A backfill stall logged with the
        //      first-batch chunk ids reproduces byte-for-byte across
        //      restarts; without ORDER BY the implicit rowid order
        //      can shift if a vacuum / autovacuum reshuffles the
        //      btree leaves, making "embed chunk 4711 keeps failing"
        //      bug reports impossible to reproduce.
        //
        //   2. **Stall detector tractability.** The in-loop
        //      stall detector in `backfill_embeddings` decides whether
        //      to bail by comparing the chunk-id set returned by
        //      successive iterations. Deterministic order means the
        //      set comparison reduces to a vec-equality check at
        //      worst — and to a "first id same?" check in the
        //      common case — instead of always paying the
        //      HashSet-build cost.
        //
        // ORDER BY happens *before* LIMIT, so the cost is bounded by
        // the index on `chunks.id` (the SQLite rowid alias) rather
        // than by the size of the corpus.
        let sql = format!(
            "SELECT c.id, c.content
             FROM chunks c
             LEFT JOIN chunk_embeddings e
                ON e.chunk_id = c.id AND e.model_id = ?1
             WHERE e.chunk_id IS NULL{exclude_placeholders}
             ORDER BY c.id ASC
             LIMIT ?2"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| Error::Database(e.to_string()))?;
        // Build the parameter list: ?1 = model_id, ?2 = limit,
        // ?3.. = exclude IDs in order.
        let mut params_vec: Vec<rusqlite::types::Value> =
            Vec::with_capacity(2 + exclude_chunk_ids.len());
        params_vec.push(rusqlite::types::Value::Text(model_id.to_string()));
        params_vec.push(rusqlite::types::Value::Integer(limit as i64));
        for id in exclude_chunk_ids {
            params_vec.push(rusqlite::types::Value::Integer(*id));
        }
        let params_iter = rusqlite::params_from_iter(params_vec.iter());
        let rows = stmt
            .query_map(params_iter, |row| {
                Ok((row.get::<_, i64>(0)?, row.get::<_, String>(1)?))
            })
            .map_err(|e| Error::Database(e.to_string()))?
            .filter_map(std::result::Result::ok)
            .collect();
        Ok(rows)
    }

    /// Cheap count of how many chunks are missing an embedding for
    /// the given `model_id`. Used by
    /// `SourceManager::backfill_embeddings_tracked` to seed the
    /// progress denominator before the long-running embed loop starts,
    /// so the renderer can show a determinate `embedded / total` bar
    /// from the first poll.
    ///
    /// Separate from [`chunks_missing_embedding`] (which materialises
    /// every chunk's content) because the count case only needs an
    /// index-only scan via `COUNT(*)` — for a 100k-chunk corpus this
    /// is ~100x cheaper than building a Vec of the same length.
    pub fn count_chunks_missing_embedding(&self, model_id: &str) -> Result<u64> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT COUNT(*)
                 FROM chunks c
                 LEFT JOIN chunk_embeddings e
                    ON e.chunk_id = c.id AND e.model_id = ?1
                 WHERE e.chunk_id IS NULL",
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        let count: i64 = stmt
            .query_row([model_id], |row| row.get(0))
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(count.max(0) as u64)
    }

    /// Look up `last_modified` ages in seconds (relative to `now`)
    /// for a list of chunk ids. Chunks whose `last_modified` cannot
    /// be parsed get age 0 (treated as fresh) — defensive choice so
    /// a malformed timestamp doesn't tank a result's ranking.
    pub fn ages_secs_for_chunks(&self, ids: &[i64]) -> Result<std::collections::HashMap<i64, f64>> {
        if ids.is_empty() {
            return Ok(std::collections::HashMap::new());
        }
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let placeholders = std::iter::repeat_n("?", ids.len())
            .collect::<Vec<_>>()
            .join(",");
        let sql = format!(
            "SELECT c.id, f.last_modified
             FROM chunks c
             JOIN indexed_files f ON f.id = c.indexed_file_id
             WHERE c.id IN ({placeholders})"
        );
        let mut stmt = conn
            .prepare(&sql)
            .map_err(|e| Error::Database(e.to_string()))?;
        let id_params: Vec<rusqlite::types::Value> = ids
            .iter()
            .map(|&i| rusqlite::types::Value::Integer(i))
            .collect();
        let now = chrono::Utc::now();
        let mut ages = std::collections::HashMap::new();
        let rows = stmt
            .query_map(rusqlite::params_from_iter(id_params.iter()), |row| {
                let id: i64 = row.get(0)?;
                let last_mod: String = row.get(1)?;
                Ok((id, last_mod))
            })
            .map_err(|e| Error::Database(e.to_string()))?;
        for r in rows.flatten() {
            let age_secs =
                parse_datetime_opt(&r.1).map_or(0.0, |dt| (now - dt).num_seconds().max(0) as f64);
            ages.insert(r.0, age_secs);
        }
        Ok(ages)
    }

    pub fn file_count_for_source(&self, source_id: &SourceId) -> Result<u64> {
        let id_str = source_id.to_string();
        let count: i64 = self
            .conn
            .lock()
            .expect("connection mutex poisoned")
            .query_row(
                "SELECT COUNT(*) FROM indexed_files WHERE source_id = ?1",
                params![id_str],
                |row| row.get(0),
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(count as u64)
    }

    pub fn get_chunk_contents_for_source(&self, source_id: &SourceId) -> Result<Vec<String>> {
        let id_str = source_id.to_string();
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT c.content FROM chunks c
                 INNER JOIN indexed_files f ON c.indexed_file_id = f.id
                 WHERE f.source_id = ?1
                 ORDER BY c.chunk_index",
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        let rows = stmt
            .query_map(params![id_str], |row| row.get::<_, String>(0))
            .map_err(|e| Error::Database(e.to_string()))?;
        let mut contents = Vec::new();
        for row in rows {
            contents.push(row.map_err(|e| Error::Database(e.to_string()))?);
        }
        Ok(contents)
    }

    pub fn get_current_file_hash(&self, file_path: &str) -> Result<Option<String>> {
        let result = self
            .conn
            .lock()
            .expect("connection mutex poisoned")
            .query_row(
                "SELECT hash FROM indexed_files WHERE path = ?1 ORDER BY rowid DESC LIMIT 1",
                params![file_path],
                |row| row.get::<_, String>(0),
            );
        match result {
            Ok(hash) => Ok(Some(hash)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(Error::Database(e.to_string())),
        }
    }

    pub fn list_indexed_files(&self, source_id: &SourceId) -> Result<Vec<IndexedFile>> {
        let id_str = source_id.to_string();
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT path, hash, last_modified, chunk_count FROM indexed_files WHERE source_id = ?1",
            )
            .map_err(|e| Error::Database(e.to_string()))?;

        let files = stmt
            .query_map(params![id_str], |row| {
                Ok(IndexedFile {
                    path: row.get(0)?,
                    hash: row.get(1)?,
                    last_modified: row.get(2)?,
                    chunk_count: row.get::<_, i64>(3)? as u64,
                })
            })
            .map_err(|e| Error::Database(e.to_string()))?
            .filter_map(std::result::Result::ok)
            .collect();

        Ok(files)
    }
}

#[derive(Debug, Clone)]
pub struct SearchHit {
    pub chunk_id: i64,
    pub content: String,
    pub hash: String,
    pub chunk_index: usize,
    pub byte_offset: usize,
    pub source_path: String,
    pub source_id: String,
    pub relevance: f64,
}

#[derive(Debug, Clone)]
pub struct ChunkEmbeddingRow {
    pub chunk_id: i64,
    pub model_id: String,
    pub vector: Vec<f32>,
}

#[derive(Debug, Clone)]
pub struct IndexedFile {
    pub path: String,
    pub hash: String,
    pub last_modified: String,
    pub chunk_count: u64,
}

/// One row of the cached ACL roster for a KChat-backed source.
///
/// Block B Task 3 (Phase 11): the substrate persists the
/// authoritative member list returned by
/// `GET /channels/{id}/members` so retrieval-side filters can
/// answer "is the locally-authenticated principal still a member
/// of this channel" without a round-trip to KChat on every search.
/// The roster is refreshed whenever the WS forwarder receives a
/// membership-change event (`user_added`, `user_removed`,
/// `channel_updated`).
#[derive(Debug, Clone)]
pub struct KchatAclRow {
    /// KChat user id (the same opaque `id` returned by
    /// `GET /users/me`). Stored verbatim — the substrate does
    /// not canonicalise or normalise.
    pub member_user_id: String,
    /// KChat role list as a single space-separated string (the
    /// wire form: `"channel_user channel_admin"`). Persisted for
    /// forensics + future per-role retrieval filters; the
    /// retrieval path itself only checks for the presence of a
    /// row, not the role contents.
    pub role: String,
    /// RFC3339 wall-clock at which the roster was last refreshed.
    pub refreshed_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::Arc;

    #[test]
    fn store_add_and_list_sources() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/test".to_string());
        store.add_source(&source).unwrap();

        let sources = store.list_sources().unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].path, "/tmp/test");
    }

    // Tenth-pass Devin Review ANALYSIS_0004: indexed equality lookup
    // by (source_type, path). Used by SourceManager::add_kchat_channel
    // for idempotent channel registration.
    #[test]
    fn find_source_by_type_and_path_locates_existing_kchat_row() {
        let store = SourceStore::open_in_memory().unwrap();
        let kchat = Source::new_kchat_channel("/tmp/kchat/channel-A".to_string());
        store.add_source(&kchat).unwrap();
        // Mix in some other-type and other-path rows to confirm the
        // query doesn't match them.
        let folder = Source::new_local_folder("/tmp/kchat/channel-A".to_string());
        store.add_source(&folder).unwrap();
        let kchat_other = Source::new_kchat_channel("/tmp/kchat/channel-B".to_string());
        store.add_source(&kchat_other).unwrap();

        let found = store
            .find_source_by_type_and_path(&SourceType::Kchat, "/tmp/kchat/channel-A")
            .unwrap()
            .expect("query should match the KChat row");
        assert_eq!(found.id, kchat.id);
        assert!(matches!(found.source_type, SourceType::Kchat));
        assert_eq!(found.path, "/tmp/kchat/channel-A");
    }

    #[test]
    fn find_source_by_type_and_path_returns_none_when_path_differs() {
        let store = SourceStore::open_in_memory().unwrap();
        let kchat = Source::new_kchat_channel("/tmp/kchat/channel-A".to_string());
        store.add_source(&kchat).unwrap();

        let found = store
            .find_source_by_type_and_path(&SourceType::Kchat, "/tmp/kchat/channel-Z")
            .unwrap();
        assert!(found.is_none(), "no row should match a different path");
    }

    #[test]
    fn find_source_by_type_and_path_returns_none_when_type_differs() {
        // A LocalFolder row at the same path must NOT be returned
        // when the caller asks for a Kchat source — the composite
        // index isolates the two namespaces.
        let store = SourceStore::open_in_memory().unwrap();
        let folder = Source::new_local_folder("/tmp/shared/path".to_string());
        store.add_source(&folder).unwrap();

        let found = store
            .find_source_by_type_and_path(&SourceType::Kchat, "/tmp/shared/path")
            .unwrap();
        assert!(
            found.is_none(),
            "LocalFolder rows must not be returned when caller asked for Kchat"
        );
    }

    #[test]
    fn store_remove_source() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/test".to_string());
        store.add_source(&source).unwrap();
        store.remove_source(&source.id).unwrap();

        let sources = store.list_sources().unwrap();
        assert!(sources.is_empty());
    }

    #[test]
    fn store_index_and_search() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/test".to_string());
        store.add_source(&source).unwrap();

        let file_id = store
            .upsert_indexed_file(&source.id, "/tmp/test/doc.txt", "abc123", "2026-01-01")
            .unwrap();

        let chunks = vec![
            crate::chunker::Chunk {
                source_path: "/tmp/test/doc.txt".to_string(),
                chunk_index: 0,
                byte_offset: 0,
                content: "Tessera is a local-first productivity workspace".to_string(),
                hash: "hash1".to_string(),
                extraction_method: None,
                extraction_model_id: None,
            },
            crate::chunker::Chunk {
                source_path: "/tmp/test/doc.txt".to_string(),
                chunk_index: 1,
                byte_offset: 48,
                content: "It indexes local folders and files for search".to_string(),
                hash: "hash2".to_string(),
                extraction_method: None,
                extraction_model_id: None,
            },
        ];

        store.insert_chunks(file_id, &chunks).unwrap();

        let results = store.search_fts("productivity workspace", 10).unwrap();
        assert!(!results.is_empty());
        assert!(results[0].content.contains("productivity"));
    }

    /// Block B Task 3 (Phase 11) retrieval-side ACL enforcement.
    ///
    /// `search_fts` joins through `indexed_files` to `sources` and
    /// rejects chunks whose source's `status` matches the
    /// stored-JSON form of `SourceStatus::AccessRevoked`. A
    /// regression here would surface a chunk from a channel the
    /// user has been removed from — exactly the failure mode the
    /// task is designed to prevent. The test exercises BOTH the
    /// "still indexed" → returned AND the "now revoked" → excluded
    /// paths so a refactor that silently drops the predicate is
    /// detected immediately rather than only at integration time.
    #[test]
    fn search_fts_excludes_chunks_whose_source_is_access_revoked() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_kchat_channel("/tmp/kchat-acl".to_string());
        store.add_source(&source).unwrap();

        let file_id = store
            .upsert_indexed_file(&source.id, "/tmp/kchat-acl/a.txt", "h1", "2026-01-01")
            .unwrap();
        store
            .insert_chunks(
                file_id,
                &[crate::chunker::Chunk {
                    source_path: "/tmp/kchat-acl/a.txt".to_string(),
                    chunk_index: 0,
                    byte_offset: 0,
                    content: "operator secret rotation plan".to_string(),
                    hash: "h-content".to_string(),
                    extraction_method: None,
                    extraction_model_id: None,
                }],
            )
            .unwrap();

        // Pre-condition: while the source is in its default state,
        // the chunk is searchable.
        let hits_before = store.search_fts("operator", 10).unwrap();
        assert_eq!(
            hits_before.len(),
            1,
            "control: chunk must be searchable before revocation"
        );

        // Revoke the source.
        store
            .update_source_status(&source.id, SourceStatus::AccessRevoked, None)
            .unwrap();

        // Post-condition: the same query returns no rows because
        // the source's status is now AccessRevoked.
        let hits_after = store.search_fts("operator", 10).unwrap();
        assert!(
            hits_after.is_empty(),
            "retrieval-side filter must exclude AccessRevoked sources \
             but got {} hit(s)",
            hits_after.len(),
        );
    }

    /// Companion to `search_fts_excludes_...` covering the
    /// `fetch_chunks_by_ids` defence-in-depth filter. A chunk
    /// might enter the candidate set via the cosine path even
    /// when the FTS predicate excluded it (e.g. if the
    /// `load_embeddings_for_model` filter ever regresses); the
    /// fetch-by-id boundary is the final gate.
    #[test]
    fn fetch_chunks_by_ids_excludes_chunks_whose_source_is_access_revoked() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_kchat_channel("/tmp/kchat-acl-fetch".to_string());
        store.add_source(&source).unwrap();
        let file_id = store
            .upsert_indexed_file(&source.id, "/tmp/kchat-acl-fetch/a.txt", "h1", "2026-01-01")
            .unwrap();
        store
            .insert_chunks(
                file_id,
                &[crate::chunker::Chunk {
                    source_path: "/tmp/kchat-acl-fetch/a.txt".to_string(),
                    chunk_index: 0,
                    byte_offset: 0,
                    content: "yetanother secret".to_string(),
                    hash: "h-fetch".to_string(),
                    extraction_method: None,
                    extraction_model_id: None,
                }],
            )
            .unwrap();
        // Grab the chunk id via the search path (already verified
        // above) while the source is still Indexable.
        let hit = store
            .search_fts("yetanother", 10)
            .unwrap()
            .into_iter()
            .next()
            .expect("control hit must exist before revoke");

        store
            .update_source_status(&source.id, SourceStatus::AccessRevoked, None)
            .unwrap();

        let fetched = store.fetch_chunks_by_ids(&[hit.chunk_id]).unwrap();
        assert!(
            fetched.is_empty(),
            "fetch_chunks_by_ids must filter AccessRevoked sources \
             but got {} chunk(s)",
            fetched.len(),
        );
    }

    /// Vector-cosine candidate generator must also drop revoked
    /// sources at the embedding-load boundary — otherwise the
    /// fusion ranker still considers them top-k candidates
    /// (wasting compute and risking a size-of-result-set side
    /// channel even after `fetch_chunks_by_ids` drops them).
    #[test]
    fn load_embeddings_for_model_excludes_chunks_whose_source_is_access_revoked() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_kchat_channel("/tmp/kchat-acl-emb".to_string());
        store.add_source(&source).unwrap();
        let file_id = store
            .upsert_indexed_file(&source.id, "/tmp/kchat-acl-emb/a.txt", "h1", "2026-01-01")
            .unwrap();
        store
            .insert_chunks(
                file_id,
                &[crate::chunker::Chunk {
                    source_path: "/tmp/kchat-acl-emb/a.txt".to_string(),
                    chunk_index: 0,
                    byte_offset: 0,
                    content: "vectoronly content".to_string(),
                    hash: "h-emb".to_string(),
                    extraction_method: None,
                    extraction_model_id: None,
                }],
            )
            .unwrap();
        // Look up the chunk_id via the search path while the
        // source is still in a non-revoked state.
        let probe = store
            .search_fts("vectoronly", 10)
            .unwrap()
            .into_iter()
            .next()
            .expect("control hit must exist before revoke");
        let chunk_id = probe.chunk_id;
        let vec = [0.1f32, 0.2, 0.3, 0.4];
        let vec_bytes = crate::embedding::encode_vec(&vec);
        store
            .upsert_chunk_embedding(chunk_id, "test-model", vec.len(), &vec_bytes)
            .unwrap();

        // Control: the embedding is loaded for an indexed source.
        let rows_before = store.load_embeddings_for_model("test-model").unwrap();
        assert_eq!(
            rows_before.len(),
            1,
            "control: embedding must be loaded before revoke"
        );

        store
            .update_source_status(&source.id, SourceStatus::AccessRevoked, None)
            .unwrap();
        let rows_after = store.load_embeddings_for_model("test-model").unwrap();
        assert!(
            rows_after.is_empty(),
            "load_embeddings_for_model must drop AccessRevoked rows \
             but got {} row(s)",
            rows_after.len(),
        );
    }

    #[test]
    fn store_dedup_by_hash() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/test".to_string());
        store.add_source(&source).unwrap();

        let file_id1 = store
            .upsert_indexed_file(&source.id, "/tmp/test/a.txt", "samehash", "2026-01-01")
            .unwrap();
        let file_id2 = store
            .upsert_indexed_file(&source.id, "/tmp/test/a.txt", "samehash", "2026-01-01")
            .unwrap();

        assert_eq!(file_id1, file_id2);
    }

    #[test]
    fn mark_file_needs_reindex_forces_next_pass_to_reprocess() {
        // The partial-OCR / partial-chart recovery contract: when
        // a VLM pass is cut short by the rate limiter, the indexer
        // stamps a `partial:` sentinel on the row so the next
        // `index_file` call's hash-equality check misses and the
        // file is fully re-processed. This test pins the
        // round-trip: upsert with hash H, mark partial, then call
        // upsert AGAIN with the same hash H — the second upsert
        // MUST see a mismatch (because the row now stores
        // `partial:H` not `H`), delete the existing chunks, and
        // stamp the row with the raw hash again.
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/test".to_string());
        store.add_source(&source).unwrap();

        let real_hash = "a".repeat(64); // realistic 64-hex-char BLAKE3
        let file_id = store
            .upsert_indexed_file(&source.id, "/tmp/test/big.pdf", &real_hash, "2026-01-01")
            .unwrap();

        // Insert two chunks so we can verify the re-process
        // actually deletes them.
        let chunks = vec![crate::chunker::Chunk {
            source_path: "/tmp/test/big.pdf".to_string(),
            chunk_index: 0,
            byte_offset: 0,
            content: "page 1 ocr text".to_string(),
            hash: "c1".to_string(),
            extraction_method: Some(crate::chunker::ExtractionMethod::VlmOcr),
            extraction_model_id: Some("test-vlm".to_string()),
        }];
        store.insert_chunks(file_id, &chunks).unwrap();
        assert_eq!(
            store
                .all_chunks_for_path("/tmp/test/big.pdf")
                .unwrap()
                .len(),
            1
        );

        // Stamp partial sentinel.
        store.mark_file_needs_reindex(file_id).unwrap();
        let stored = store.get_file_hash("/tmp/test/big.pdf").unwrap().unwrap();
        assert_eq!(stored, format!("partial:{real_hash}"));

        // Now upsert with the same real hash — must DETECT mismatch
        // (partial:H vs H) and delete the existing chunks.
        let file_id_after = store
            .upsert_indexed_file(&source.id, "/tmp/test/big.pdf", &real_hash, "2026-01-01")
            .unwrap();
        assert_eq!(file_id, file_id_after, "row identity must be preserved");
        // Hash is now the real one again.
        let stored_after = store.get_file_hash("/tmp/test/big.pdf").unwrap().unwrap();
        assert_eq!(stored_after, real_hash);
        // Previous partial chunks have been wiped.
        assert!(
            store
                .all_chunks_for_path("/tmp/test/big.pdf")
                .unwrap()
                .is_empty(),
            "upsert-after-partial MUST delete the partial chunks so the next pass writes a clean set"
        );
    }

    #[test]
    fn mark_file_needs_reindex_is_idempotent() {
        // Re-stamping a row that's already `partial:` must NOT
        // compound the prefix. Without the `WHEN hash LIKE 'partial:%'`
        // guard in the UPDATE statement, repeated partial passes
        // on the same file would produce `partial:partial:partial:HEX`
        // and bloat the row over time.
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/test".to_string());
        store.add_source(&source).unwrap();

        let real_hash = "b".repeat(64);
        let file_id = store
            .upsert_indexed_file(&source.id, "/tmp/test/big.pdf", &real_hash, "2026-01-01")
            .unwrap();

        // Stamp partial three times.
        store.mark_file_needs_reindex(file_id).unwrap();
        store.mark_file_needs_reindex(file_id).unwrap();
        store.mark_file_needs_reindex(file_id).unwrap();

        let stored = store.get_file_hash("/tmp/test/big.pdf").unwrap().unwrap();
        assert_eq!(
            stored,
            format!("partial:{real_hash}"),
            "repeated partial stamps must NOT compound: expected single `partial:` prefix, got `{stored}`"
        );
    }

    #[test]
    fn store_update_changed_file() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/test".to_string());
        store.add_source(&source).unwrap();

        let fid = store
            .upsert_indexed_file(&source.id, "/tmp/test/a.txt", "hash1", "2026-01-01")
            .unwrap();
        let chunks = vec![crate::chunker::Chunk {
            source_path: "/tmp/test/a.txt".to_string(),
            chunk_index: 0,
            byte_offset: 0,
            content: "old content".to_string(),
            hash: "oldhash".to_string(),
            extraction_method: None,
            extraction_model_id: None,
        }];
        store.insert_chunks(fid, &chunks).unwrap();

        let fid2 = store
            .upsert_indexed_file(&source.id, "/tmp/test/a.txt", "hash2", "2026-01-02")
            .unwrap();
        assert_eq!(fid, fid2);

        let results = store.search_fts("old content", 10).unwrap();
        assert!(results.is_empty());
    }

    #[test]
    fn store_file_count() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/test".to_string());
        store.add_source(&source).unwrap();

        store
            .upsert_indexed_file(&source.id, "/tmp/test/a.txt", "h1", "2026-01-01")
            .unwrap();
        store
            .upsert_indexed_file(&source.id, "/tmp/test/b.txt", "h2", "2026-01-01")
            .unwrap();

        let count = store.file_count_for_source(&source.id).unwrap();
        assert_eq!(count, 2);
    }

    #[test]
    fn source_store_shares_database_with_clone() {
        // Two stores built on the same SharedConnection see the same
        // rows. Mirrors `audit_store_shares_database_with_clone` so the
        // shared-connection refactor is exercised per-crate.
        let conn = tessera_core::open_shared_in_memory().unwrap();
        let a = SourceStore::with_shared_conn(conn.clone()).unwrap();
        let b = SourceStore::with_shared_conn(conn).unwrap();
        let source = Source::new_local_folder("/tmp/shared".to_string());
        a.add_source(&source).unwrap();
        let sources = b.list_sources().unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].path, "/tmp/shared");
    }

    #[test]
    fn pragma_foreign_keys_is_enabled_on_store_connection() {
        // Regression for the original finding that `chunk_embeddings`
        // had `ON DELETE CASCADE` but SQLite's default
        // `foreign_keys = OFF` silently turned the cascade into a
        // no-op. We now `PRAGMA foreign_keys = ON` in `init_schema()`
        // so the cascade actually fires. Pin that pragma stays ON
        // for the rest of the connection's lifetime — pragmas are
        // per-connection and could be silently flipped by any later
        // `execute_batch` that runs on the same connection.
        let store = SourceStore::open_in_memory().unwrap();
        let conn = store.conn.lock().expect("connection mutex poisoned");
        let fk_on: i64 = conn
            .query_row("PRAGMA foreign_keys", [], |row| row.get(0))
            .unwrap();
        assert_eq!(
            fk_on, 1,
            "PRAGMA foreign_keys must be ON for chunk_embeddings cascade to fire"
        );
    }

    #[test]
    fn chunk_embeddings_cascade_fires_when_parent_chunk_is_deleted() {
        // Defence-in-depth regression test: with
        // foreign_keys=ON, deleting a chunk must remove its
        // associated `chunk_embeddings` row via either the trigger
        // (belt) or the CASCADE clause (suspenders). We assert the
        // chunk_embeddings row disappears after the parent delete.
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/cascade-test".to_string());
        store.add_source(&source).unwrap();

        let dir = tempfile::tempdir().unwrap();
        std::fs::write(
            dir.path().join("doc.txt"),
            "alpha bravo charlie delta echo foxtrot golf",
        )
        .unwrap();

        // Index with an embedder so chunk_embeddings rows get populated.
        let embedder: Arc<dyn crate::embedding::EmbeddingProvider> =
            Arc::new(crate::embedding::HashTrickEmbedding::default_config());
        let indexer = crate::indexer::Indexer::default().with_embedder(Arc::clone(&embedder));
        indexer
            .index_folder(&source.id, dir.path(), &store)
            .unwrap();

        let embedding_count_before: i64 = {
            let conn = store.conn.lock().expect("connection mutex poisoned");
            conn.query_row("SELECT COUNT(*) FROM chunk_embeddings", [], |r| r.get(0))
                .unwrap()
        };
        assert!(
            embedding_count_before > 0,
            "expected the embedder to have populated chunk_embeddings"
        );

        // Delete a single chunk directly (not via remove_source, which
        // already deletes embeddings explicitly). The trigger +
        // CASCADE pair must remove the matching chunk_embeddings row.
        let chunk_id: i64 = {
            let conn = store.conn.lock().expect("connection mutex poisoned");
            conn.query_row("SELECT id FROM chunks LIMIT 1", [], |r| r.get(0))
                .unwrap()
        };
        {
            let conn = store.conn.lock().expect("connection mutex poisoned");
            conn.execute("DELETE FROM chunks WHERE id = ?1", params![chunk_id])
                .unwrap();
        }

        let leftover: i64 = {
            let conn = store.conn.lock().expect("connection mutex poisoned");
            conn.query_row(
                "SELECT COUNT(*) FROM chunk_embeddings WHERE chunk_id = ?1",
                params![chunk_id],
                |r| r.get(0),
            )
            .unwrap()
        };
        assert_eq!(
            leftover, 0,
            "deleting a chunk must cascade-remove its chunk_embeddings rows"
        );
    }

    #[test]
    fn chunks_missing_embedding_excluding_returns_ascending_chunk_id() {
        // Regression test: the SELECT in
        // `chunks_missing_embedding_excluding` previously had no
        // ORDER BY clause, relying on SQLite's implicit rowid order.
        // That ordering is an implementation detail and can shift
        // when the btree is reshuffled (autovacuum, page-split
        // rebalances), so a backfill stall reproducer logged with
        // the first-batch chunk ids would have been impossible to
        // reproduce on a later run.
        //
        // This test pins the contract: ascending `chunks.id`,
        // stable across repeated calls with the same exclude set.
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/ordering".to_string());
        store.add_source(&source).unwrap();

        let file_id = store
            .upsert_indexed_file(&source.id, "/tmp/ordering/doc.txt", "h", "2026-01-01")
            .unwrap();

        // Insert five chunks. SQLite will assign them rowids 1..=5
        // in insertion order; we intentionally do NOT sort the
        // input list — the ORDER BY in the query is what pins the
        // output order, not the insertion order.
        let chunks: Vec<_> = (0..5)
            .map(|i| crate::chunker::Chunk {
                source_path: "/tmp/ordering/doc.txt".to_string(),
                chunk_index: i,
                byte_offset: i * 100,
                content: format!("chunk body {i}"),
                hash: format!("hash{i}"),
                extraction_method: None,
                extraction_model_id: None,
            })
            .collect();
        store.insert_chunks(file_id, &chunks).unwrap();

        let model_id = "test-embed-v1";

        // First call: no excludes. Should return all 5 ids in
        // ascending order.
        let first = store
            .chunks_missing_embedding_excluding(model_id, 100, &[])
            .unwrap();
        let first_ids: Vec<i64> = first.iter().map(|(id, _)| *id).collect();
        assert_eq!(first_ids.len(), 5, "expected all 5 chunks unembedded");
        for w in first_ids.windows(2) {
            assert!(
                w[0] < w[1],
                "chunks_missing_embedding_excluding output must be ascending; saw {w:?}"
            );
        }

        // Repeat the same call 20 times to make sure the ordering
        // is truly stable, not just "happened to be ascending once".
        // Without ORDER BY this would still typically pass on a
        // freshly-built table, so the windowing assertion above is
        // the real meat — but pinning stability across iterations
        // catches any future "let's optimise this with a hash
        // join" regression that would shuffle the rows.
        for _ in 0..20 {
            let again = store
                .chunks_missing_embedding_excluding(model_id, 100, &[])
                .unwrap();
            let again_ids: Vec<i64> = again.iter().map(|(id, _)| *id).collect();
            assert_eq!(
                again_ids, first_ids,
                "chunks_missing_embedding_excluding must be order-stable across repeated calls"
            );
        }

        // With excludes: pulling out the middle chunk must keep
        // the remaining four in ascending order.
        let middle = first_ids[2];
        let with_excludes = store
            .chunks_missing_embedding_excluding(model_id, 100, &[middle])
            .unwrap();
        let with_exclude_ids: Vec<i64> = with_excludes.iter().map(|(id, _)| *id).collect();
        let expected: Vec<i64> = first_ids
            .iter()
            .copied()
            .filter(|id| *id != middle)
            .collect();
        assert_eq!(
            with_exclude_ids, expected,
            "exclude set must not perturb the ascending-id contract"
        );
    }

    #[test]
    fn count_chunks_missing_embedding_matches_vec_path() {
        // The count path uses a separate SQL statement (`SELECT
        // COUNT(*)` vs. `SELECT c.id, c.content`) so we explicitly
        // pin that it returns the same answer as the materialising
        // path. This is the contract the bridge layer relies on
        // to seed the progress denominator.
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/counts".to_string());
        store.add_source(&source).unwrap();

        let file_id = store
            .upsert_indexed_file(&source.id, "/tmp/counts/doc.txt", "h", "2026-01-01")
            .unwrap();

        // Insert 7 chunks; none have embeddings yet.
        let chunks: Vec<_> = (0..7)
            .map(|i| crate::chunker::Chunk {
                source_path: "/tmp/counts/doc.txt".to_string(),
                chunk_index: i,
                byte_offset: i * 100,
                content: format!("body {i}"),
                hash: format!("h{i}"),
                extraction_method: None,
                extraction_model_id: None,
            })
            .collect();
        store.insert_chunks(file_id, &chunks).unwrap();

        let model_id = "embed-test-v1";

        // Cross-check the count against the Vec path.
        let vec_len = store
            .chunks_missing_embedding(model_id, 1024)
            .unwrap()
            .len() as u64;
        let count = store.count_chunks_missing_embedding(model_id).unwrap();
        assert_eq!(count, 7);
        assert_eq!(count, vec_len);

        // Embed three of the seven chunks. The count must drop to 4
        // while the model_id we just used disappears from the
        // missing set; a *different* model_id still sees all 7.
        let materialised = store.chunks_missing_embedding(model_id, 3).unwrap();
        for (id, _content) in &materialised {
            store
                .upsert_chunk_embedding(*id, model_id, 4, &[0u8; 16])
                .unwrap();
        }
        let count_after = store.count_chunks_missing_embedding(model_id).unwrap();
        assert_eq!(count_after, 4);

        let other_count = store
            .count_chunks_missing_embedding("different-model-v1")
            .unwrap();
        assert_eq!(
            other_count, 7,
            "embeddings for one model must not satisfy the missing count for another"
        );
    }
}
