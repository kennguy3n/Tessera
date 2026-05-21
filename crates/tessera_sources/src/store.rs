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
            ",
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
        let conn = self.conn.lock().expect("connection mutex poisoned");
        {
            let mut stmt = conn
                .prepare(
                    "INSERT INTO chunks (indexed_file_id, chunk_index, byte_offset, content, hash)
                     VALUES (?1, ?2, ?3, ?4, ?5)",
                )
                .map_err(|e| Error::Database(e.to_string()))?;

            for chunk in chunks {
                stmt.execute(params![
                    indexed_file_id,
                    chunk.chunk_index as i64,
                    chunk.byte_offset as i64,
                    chunk.content,
                    chunk.hash,
                ])
                .map_err(|e| Error::Database(e.to_string()))?;
            }
        }

        conn.execute(
            "UPDATE indexed_files SET chunk_count = ?1 WHERE id = ?2",
            params![chunks.len() as i64, indexed_file_id],
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
        let mut stmt = conn
            .prepare(
                "SELECT c.content, c.hash, c.chunk_index, c.byte_offset, f.path,
                        f.source_id, rank
                 FROM chunks_fts fts
                 JOIN chunks c ON c.id = fts.rowid
                 JOIN indexed_files f ON f.id = c.indexed_file_id
                 WHERE chunks_fts MATCH ?1
                 ORDER BY rank
                 LIMIT ?2",
            )
            .map_err(|e| Error::Database(e.to_string()))?;

        let results = stmt
            .query_map(params![query, limit as i64], |row| {
                Ok(SearchHit {
                    content: row.get(0)?,
                    hash: row.get(1)?,
                    chunk_index: row.get::<_, i64>(2)? as usize,
                    byte_offset: row.get::<_, i64>(3)? as usize,
                    source_path: row.get(4)?,
                    source_id: row.get(5)?,
                    relevance: -row.get::<_, f64>(6)?,
                })
            })
            .map_err(|e| Error::Database(e.to_string()))?
            .filter_map(std::result::Result::ok)
            .collect();

        Ok(results)
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
    pub content: String,
    pub hash: String,
    pub chunk_index: usize,
    pub byte_offset: usize,
    pub source_path: String,
    pub source_id: String,
    pub relevance: f64,
}

#[derive(Debug, Clone)]
pub struct IndexedFile {
    pub path: String,
    pub hash: String,
    pub last_modified: String,
    pub chunk_count: u64,
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn store_add_and_list_sources() {
        let store = SourceStore::open_in_memory().unwrap();
        let source = Source::new_local_folder("/tmp/test".to_string());
        store.add_source(&source).unwrap();

        let sources = store.list_sources().unwrap();
        assert_eq!(sources.len(), 1);
        assert_eq!(sources[0].path, "/tmp/test");
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
            },
            crate::chunker::Chunk {
                source_path: "/tmp/test/doc.txt".to_string(),
                chunk_index: 1,
                byte_offset: 48,
                content: "It indexes local folders and files for search".to_string(),
                hash: "hash2".to_string(),
            },
        ];

        store.insert_chunks(file_id, &chunks).unwrap();

        let results = store.search_fts("productivity workspace", 10).unwrap();
        assert!(!results.is_empty());
        assert!(results[0].content.contains("productivity"));
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
}
