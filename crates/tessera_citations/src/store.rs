//! SQLite persistence for citations.

use rusqlite::params;
use tessera_core::error::{Error, Result};
use tessera_core::{
    open_shared, open_shared_in_memory, ArtifactId, CitationId, SharedConnection, SourceId,
    SourceType,
};

use crate::citation::Citation;

fn parse_datetime(s: &str) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map_or_else(|_| chrono::Utc::now(), |dt| dt.with_timezone(&chrono::Utc))
}

/// Citation Store.
pub struct CitationStore {
    conn: SharedConnection,
}

impl CitationStore {
    /// Open.
    pub fn open(path: &str) -> Result<Self> {
        Self::with_shared_conn(open_shared(path)?)
    }

    /// Open in memory.
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
                "CREATE TABLE IF NOT EXISTS citations (
                    citation_id TEXT PRIMARY KEY,
                    artifact_id TEXT NOT NULL,
                    source_id TEXT NOT NULL,
                    source_type TEXT NOT NULL,
                    source_title TEXT NOT NULL,
                    source_uri TEXT NOT NULL,
                    chunk_hash TEXT NOT NULL,
                    source_file_hash TEXT NOT NULL DEFAULT '',
                    page INTEGER,
                    confidence REAL NOT NULL,
                    used_for TEXT NOT NULL,
                    created_at TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_citations_artifact
                    ON citations(artifact_id);",
            )
            .map_err(Error::Sqlite)?;
        Ok(())
    }

    /// Insert.
    pub fn insert(&self, artifact_id: &ArtifactId, citation: &Citation) -> Result<()> {
        let source_type_str = serde_json::to_value(citation.source_type)
            .map_err(Error::Json)?
            .as_str()
            .unwrap_or("LocalFile")
            .to_string();

        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .execute(
                "INSERT OR REPLACE INTO citations
                    (citation_id, artifact_id, source_id, source_type, source_title,
                     source_uri, chunk_hash, source_file_hash, page, confidence, used_for, created_at)
                VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9, ?10, ?11, ?12)",
                params![
                    citation.citation_id.0.to_string(),
                    artifact_id.0.to_string(),
                    citation.source_id.0.to_string(),
                    source_type_str,
                    citation.source_title,
                    citation.source_uri,
                    citation.chunk_hash,
                    citation.source_file_hash,
                    citation.page.map(|p| p as i64),
                    citation.confidence,
                    citation.used_for,
                    citation.created_at.to_rfc3339(),
                ],
            )
            .map_err(Error::Sqlite)?;
        Ok(())
    }

    /// Remove.
    pub fn remove(&self, citation_id: &CitationId) -> Result<()> {
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .execute(
                "DELETE FROM citations WHERE citation_id = ?1",
                params![citation_id.0.to_string()],
            )
            .map_err(Error::Sqlite)?;
        Ok(())
    }

    /// Update the source-pointing fields of an existing citation,
    /// preserving the original `citation_id`, `artifact_id`,
    /// `used_for`, and `created_at` so the citation continues to
    /// refer to the same artifact section. Returns
    /// [`Error::DatabaseState`] with a `"not found"` message when the
    /// citation does not exist.
    #[allow(clippy::too_many_arguments)]
    pub fn replace_source(
        &self,
        citation_id: &CitationId,
        source_id: &SourceId,
        source_type: SourceType,
        source_title: &str,
        source_uri: &str,
        chunk_hash: &str,
        source_file_hash: &str,
        page: Option<u32>,
        confidence: f64,
    ) -> Result<()> {
        let source_type_str = serde_json::to_value(source_type)
            .map_err(Error::Json)?
            .as_str()
            .unwrap_or("LocalFile")
            .to_string();

        let updated = self
            .conn
            .lock()
            .expect("connection mutex poisoned")
            .execute(
                "UPDATE citations
                    SET source_id = ?1,
                        source_type = ?2,
                        source_title = ?3,
                        source_uri = ?4,
                        chunk_hash = ?5,
                        source_file_hash = ?6,
                        page = ?7,
                        confidence = ?8
                  WHERE citation_id = ?9",
                params![
                    source_id.0.to_string(),
                    source_type_str,
                    source_title,
                    source_uri,
                    chunk_hash,
                    source_file_hash,
                    page.map(|p| p as i64),
                    confidence,
                    citation_id.0.to_string(),
                ],
            )
            .map_err(Error::Sqlite)?;

        if updated == 0 {
            return Err(Error::DatabaseState(format!(
                "citation not found: {}",
                citation_id.0
            )));
        }
        Ok(())
    }

    /// Get.
    pub fn get(&self, citation_id: &CitationId) -> Result<Option<Citation>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT citation_id, source_id, source_type, source_title, source_uri,
                        chunk_hash, source_file_hash, page, confidence, used_for, created_at
                 FROM citations WHERE citation_id = ?1",
            )
            .map_err(Error::Sqlite)?;

        let result = stmt
            .query_row(params![citation_id.0.to_string()], |row| {
                Ok(Self::row_to_citation(row))
            })
            .optional()
            .map_err(Error::Sqlite)?;

        match result {
            Some(c) => Ok(Some(c?)),
            None => Ok(None),
        }
    }

    /// List for artifact.
    pub fn list_for_artifact(&self, artifact_id: &ArtifactId) -> Result<Vec<Citation>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT citation_id, source_id, source_type, source_title, source_uri,
                        chunk_hash, source_file_hash, page, confidence, used_for, created_at
                 FROM citations WHERE artifact_id = ?1
                 ORDER BY created_at ASC",
            )
            .map_err(Error::Sqlite)?;

        let rows = stmt
            .query_map(params![artifact_id.0.to_string()], |row| {
                Ok(Self::row_to_citation(row))
            })
            .map_err(Error::Sqlite)?;

        let mut citations = Vec::new();
        for row in rows {
            // `row` is `Result<Result<Citation, Error>, rusqlite::Error>`:
            // the outer `?` surfaces a row-iteration failure (wrapped as
            // `Error::Sqlite`), the inner `?` surfaces a
            // `row_to_citation` decode failure (already an `Error`).
            let citation = row.map_err(Error::Sqlite)??;
            citations.push(citation);
        }
        Ok(citations)
    }

    /// Count.
    pub fn count(&self) -> Result<usize> {
        let count: i64 = self
            .conn
            .lock()
            .expect("connection mutex poisoned")
            .query_row("SELECT COUNT(*) FROM citations", [], |row| row.get(0))
            .map_err(Error::Sqlite)?;
        Ok(count as usize)
    }

    /// Return the artifact id this citation was attached to, or
    /// `None` if the citation does not exist.
    pub fn artifact_for(
        &self,
        citation_id: &CitationId,
    ) -> Result<Option<tessera_core::ArtifactId>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare("SELECT artifact_id FROM citations WHERE citation_id = ?1")
            .map_err(Error::Sqlite)?;
        let row: std::result::Result<String, rusqlite::Error> =
            stmt.query_row(params![citation_id.0.to_string()], |row| row.get(0));
        match row {
            Ok(s) => {
                let uuid = uuid::Uuid::parse_str(&s)
                    .map_err(|e| Error::DatabaseState(format!("Invalid artifact UUID: {e}")))?;
                Ok(Some(tessera_core::ArtifactId(uuid)))
            }
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(Error::Sqlite(e)),
        }
    }

    fn row_to_citation(row: &rusqlite::Row) -> Result<Citation> {
        let cid_str: String = row.get(0).map_err(Error::Sqlite)?;
        let sid_str: String = row.get(1).map_err(Error::Sqlite)?;
        let stype_str: String = row.get(2).map_err(Error::Sqlite)?;
        let source_title: String = row.get(3).map_err(Error::Sqlite)?;
        let source_uri: String = row.get(4).map_err(Error::Sqlite)?;
        let chunk_hash: String = row.get(5).map_err(Error::Sqlite)?;
        let source_file_hash: String = row.get(6).map_err(Error::Sqlite)?;
        let page: Option<i64> = row.get(7).map_err(Error::Sqlite)?;
        let confidence: f64 = row.get(8).map_err(Error::Sqlite)?;
        let used_for: String = row.get(9).map_err(Error::Sqlite)?;
        let created_at_str: String = row.get(10).map_err(Error::Sqlite)?;

        let citation_id = uuid::Uuid::parse_str(&cid_str)
            .map_err(|e| Error::DatabaseState(format!("Invalid citation UUID: {e}")))?;
        let source_id = uuid::Uuid::parse_str(&sid_str)
            .map_err(|e| Error::DatabaseState(format!("Invalid source UUID: {e}")))?;
        let source_type: SourceType = serde_json::from_str(&format!("\"{stype_str}\""))
            .map_err(|e| Error::DatabaseState(format!("Invalid source type: {e}")))?;

        Ok(Citation {
            citation_id: CitationId(citation_id),
            source_id: SourceId(source_id),
            source_type,
            source_title,
            source_uri,
            chunk_hash,
            source_file_hash,
            page: page.map(|p| p as u32),
            confidence,
            used_for,
            created_at: parse_datetime(&created_at_str),
        })
    }
}

trait OptionalRow {
    fn optional(self) -> std::result::Result<Option<Result<Citation>>, rusqlite::Error>;
}

impl OptionalRow for std::result::Result<Result<Citation>, rusqlite::Error> {
    fn optional(self) -> std::result::Result<Option<Result<Citation>>, rusqlite::Error> {
        match self {
            Ok(v) => Ok(Some(v)),
            Err(rusqlite::Error::QueryReturnedNoRows) => Ok(None),
            Err(e) => Err(e),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::citation::Citation;

    fn make_citation() -> Citation {
        Citation::new(
            SourceId::new(),
            SourceType::LocalFile,
            "test.pdf".to_string(),
            "file:///test.pdf".to_string(),
            "chunk_abc".to_string(),
            "file_hash_xyz".to_string(),
            "Introduction".to_string(),
            0.9,
        )
    }

    #[test]
    fn store_insert_and_get() {
        let store = CitationStore::open_in_memory().unwrap();
        let aid = ArtifactId::new();
        let citation = make_citation();
        let cid = citation.citation_id;

        store.insert(&aid, &citation).unwrap();
        let loaded = store.get(&cid).unwrap().unwrap();
        assert_eq!(loaded.citation_id, cid);
        assert_eq!(loaded.source_title, "test.pdf");
        assert_eq!(loaded.source_file_hash, "file_hash_xyz");
    }

    #[test]
    fn store_list_for_artifact() {
        let store = CitationStore::open_in_memory().unwrap();
        let aid = ArtifactId::new();

        store.insert(&aid, &make_citation()).unwrap();
        store.insert(&aid, &make_citation()).unwrap();

        let list = store.list_for_artifact(&aid).unwrap();
        assert_eq!(list.len(), 2);
    }

    #[test]
    fn store_remove() {
        let store = CitationStore::open_in_memory().unwrap();
        let aid = ArtifactId::new();
        let citation = make_citation();
        let cid = citation.citation_id;

        store.insert(&aid, &citation).unwrap();
        store.remove(&cid).unwrap();
        assert!(store.get(&cid).unwrap().is_none());
    }

    #[test]
    fn store_count() {
        let store = CitationStore::open_in_memory().unwrap();
        let aid = ArtifactId::new();
        store.insert(&aid, &make_citation()).unwrap();
        store.insert(&aid, &make_citation()).unwrap();
        assert_eq!(store.count().unwrap(), 2);
    }

    #[test]
    fn citation_store_shares_database_with_clone() {
        // Two stores built on the same SharedConnection see the same
        // rows. Mirrors `audit_store_shares_database_with_clone` so the
        // shared-connection refactor is exercised per-crate.
        let conn = tessera_core::open_shared_in_memory().unwrap();
        let a = CitationStore::with_shared_conn(conn.clone()).unwrap();
        let b = CitationStore::with_shared_conn(conn).unwrap();
        let aid = ArtifactId::new();
        a.insert(&aid, &make_citation()).unwrap();
        assert_eq!(b.count().unwrap(), 1);
    }
}
