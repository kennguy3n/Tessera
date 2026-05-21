use rusqlite::params;
use tessera_core::error::{Error, Result};
use tessera_core::{open_shared, open_shared_in_memory, ArtifactId, SharedConnection};

use crate::artifact::Artifact;

fn parse_datetime(s: &str) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map_or_else(|_| chrono::Utc::now(), |dt| dt.with_timezone(&chrono::Utc))
}

pub struct ArtifactStore {
    conn: SharedConnection,
}

impl ArtifactStore {
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
                "CREATE TABLE IF NOT EXISTS artifacts (
                    id TEXT PRIMARY KEY,
                    title TEXT NOT NULL,
                    artifact_type TEXT NOT NULL,
                    template_id TEXT,
                    content TEXT NOT NULL DEFAULT '',
                    citations TEXT NOT NULL DEFAULT '[]',
                    created_at TEXT NOT NULL,
                    updated_at TEXT NOT NULL,
                    version INTEGER NOT NULL DEFAULT 1
                );
                CREATE TABLE IF NOT EXISTS artifact_versions (
                    id INTEGER PRIMARY KEY AUTOINCREMENT,
                    artifact_id TEXT NOT NULL,
                    version_number INTEGER NOT NULL,
                    content_snapshot TEXT NOT NULL,
                    created_at TEXT NOT NULL,
                    FOREIGN KEY(artifact_id) REFERENCES artifacts(id) ON DELETE CASCADE
                );
                CREATE INDEX IF NOT EXISTS idx_versions_artifact ON artifact_versions(artifact_id, version_number);",
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(())
    }

    pub fn insert(&self, artifact: &Artifact) -> Result<()> {
        let citations_json = serde_json::to_string(&artifact.citations)
            .map_err(|e| Error::Database(e.to_string()))?;
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .execute(
                "INSERT INTO artifacts (id, title, artifact_type, template_id, content, citations, created_at, updated_at, version)
                 VALUES (?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9)",
                params![
                    artifact.id.to_string(),
                    artifact.title,
                    serde_json::to_string(&artifact.artifact_type).map_err(|e| Error::Database(e.to_string()))?,
                    artifact.template_id.map(|t| t.to_string()),
                    artifact.content,
                    citations_json,
                    artifact.created_at.to_rfc3339(),
                    artifact.updated_at.to_rfc3339(),
                    artifact.version,
                ],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(())
    }

    pub fn update(&self, artifact: &Artifact) -> Result<()> {
        let citations_json = serde_json::to_string(&artifact.citations)
            .map_err(|e| Error::Database(e.to_string()))?;
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .execute(
                "UPDATE artifacts SET title = ?1, content = ?2, citations = ?3, updated_at = ?4, version = ?5 WHERE id = ?6",
                params![
                    artifact.title,
                    artifact.content,
                    citations_json,
                    artifact.updated_at.to_rfc3339(),
                    artifact.version,
                    artifact.id.to_string(),
                ],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(())
    }

    pub fn get(&self, id: &ArtifactId) -> Result<Artifact> {
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .query_row(
                "SELECT id, title, artifact_type, template_id, content, citations, created_at, updated_at, version FROM artifacts WHERE id = ?1",
                params![id.to_string()],
                |row| {
                    let id_str: String = row.get(0)?;
                    let type_str: String = row.get(2)?;
                    let template_str: Option<String> = row.get(3)?;
                    let citations_str: String = row.get(5)?;
                    let created_str: String = row.get(6)?;
                    let updated_str: String = row.get(7)?;

                    let parsed_id = uuid::Uuid::parse_str(&id_str).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            0,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?;
                    let parsed_type: tessera_core::ArtifactType =
                        serde_json::from_str(&type_str).map_err(|e| {
                            rusqlite::Error::FromSqlConversionFailure(
                                2,
                                rusqlite::types::Type::Text,
                                Box::new(e),
                            )
                        })?;
                    let parsed_citations: Vec<tessera_core::CitationId> =
                        serde_json::from_str(&citations_str).map_err(|e| {
                            rusqlite::Error::FromSqlConversionFailure(
                                5,
                                rusqlite::types::Type::Text,
                                Box::new(e),
                            )
                        })?;
                    let parsed_template = match template_str {
                        Some(s) => Some(uuid::Uuid::parse_str(&s).map(tessera_core::TemplateId).map_err(|e| {
                            rusqlite::Error::FromSqlConversionFailure(
                                3,
                                rusqlite::types::Type::Text,
                                Box::new(e),
                            )
                        })?),
                        None => None,
                    };

                    Ok(Artifact {
                        id: ArtifactId(parsed_id),
                        title: row.get(1)?,
                        artifact_type: parsed_type,
                        template_id: parsed_template,
                        content: row.get(4)?,
                        citations: parsed_citations,
                        created_at: parse_datetime(&created_str),
                        updated_at: parse_datetime(&updated_str),
                        version: row.get(8)?,
                    })
                },
            )
            .map_err(|e| Error::ArtifactNotFound(e.to_string()))
    }

    pub fn list(&self) -> Result<Vec<Artifact>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT id, title, artifact_type, template_id, content, citations, created_at, updated_at, version FROM artifacts ORDER BY updated_at DESC",
            )
            .map_err(|e| Error::Database(e.to_string()))?;

        let artifacts = stmt
            .query_map([], |row| {
                let id_str: String = row.get(0)?;
                let type_str: String = row.get(2)?;
                let template_str: Option<String> = row.get(3)?;
                let citations_str: String = row.get(5)?;
                let created_str: String = row.get(6)?;
                let updated_str: String = row.get(7)?;

                let parsed_id = uuid::Uuid::parse_str(&id_str).map_err(|e| {
                    rusqlite::Error::FromSqlConversionFailure(
                        0,
                        rusqlite::types::Type::Text,
                        Box::new(e),
                    )
                })?;
                let parsed_type: tessera_core::ArtifactType = serde_json::from_str(&type_str)
                    .map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            2,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?;
                let parsed_citations: Vec<tessera_core::CitationId> =
                    serde_json::from_str(&citations_str).map_err(|e| {
                        rusqlite::Error::FromSqlConversionFailure(
                            5,
                            rusqlite::types::Type::Text,
                            Box::new(e),
                        )
                    })?;
                let parsed_template = match template_str {
                    Some(s) => Some(
                        uuid::Uuid::parse_str(&s)
                            .map(tessera_core::TemplateId)
                            .map_err(|e| {
                                rusqlite::Error::FromSqlConversionFailure(
                                    3,
                                    rusqlite::types::Type::Text,
                                    Box::new(e),
                                )
                            })?,
                    ),
                    None => None,
                };

                Ok(Artifact {
                    id: ArtifactId(parsed_id),
                    title: row.get(1)?,
                    artifact_type: parsed_type,
                    template_id: parsed_template,
                    content: row.get(4)?,
                    citations: parsed_citations,
                    created_at: parse_datetime(&created_str),
                    updated_at: parse_datetime(&updated_str),
                    version: row.get(8)?,
                })
            })
            .map_err(|e| Error::Database(e.to_string()))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| Error::Database(format!("corrupted row: {e}")))?;

        Ok(artifacts)
    }

    pub fn delete(&self, id: &ArtifactId) -> Result<()> {
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .execute(
                "DELETE FROM artifacts WHERE id = ?1",
                params![id.to_string()],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(())
    }

    pub fn save_version(
        &self,
        artifact_id: &ArtifactId,
        version_number: u32,
        content: &str,
    ) -> Result<()> {
        let now = chrono::Utc::now().to_rfc3339();
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .execute(
                "INSERT INTO artifact_versions (artifact_id, version_number, content_snapshot, created_at) VALUES (?1, ?2, ?3, ?4)",
                params![artifact_id.to_string(), version_number, content, now],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(())
    }

    pub fn list_versions(&self, artifact_id: &ArtifactId) -> Result<Vec<ArtifactVersion>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT version_number, content_snapshot, created_at FROM artifact_versions WHERE artifact_id = ?1 ORDER BY version_number DESC",
            )
            .map_err(|e| Error::Database(e.to_string()))?;

        let versions = stmt
            .query_map(params![artifact_id.to_string()], |row| {
                let created_str: String = row.get(2)?;
                Ok(ArtifactVersion {
                    version_number: row.get(0)?,
                    content_snapshot: row.get(1)?,
                    created_at: created_str,
                })
            })
            .map_err(|e| Error::Database(e.to_string()))?
            .collect::<std::result::Result<Vec<_>, _>>()
            .map_err(|e| Error::Database(format!("failed to read version row: {e}")))?;

        Ok(versions)
    }

    pub fn get_version(
        &self,
        artifact_id: &ArtifactId,
        version_number: u32,
    ) -> Result<ArtifactVersion> {
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .query_row(
                "SELECT version_number, content_snapshot, created_at FROM artifact_versions WHERE artifact_id = ?1 AND version_number = ?2",
                params![artifact_id.to_string(), version_number],
                |row| {
                    let created_str: String = row.get(2)?;
                    Ok(ArtifactVersion {
                        version_number: row.get(0)?,
                        content_snapshot: row.get(1)?,
                        created_at: created_str,
                    })
                },
            )
            .map_err(|e| Error::Database(e.to_string()))
    }
}

#[derive(Debug, Clone)]
pub struct ArtifactVersion {
    pub version_number: u32,
    pub content_snapshot: String,
    pub created_at: String,
}

#[cfg(test)]
mod tests {
    use super::*;
    use tessera_core::ArtifactType;

    #[test]
    fn insert_and_get_artifact() {
        let store = ArtifactStore::open_in_memory().unwrap();
        let artifact = Artifact::new("Test PRD".to_string(), ArtifactType::Document, None);
        store.insert(&artifact).unwrap();

        let loaded = store.get(&artifact.id).unwrap();
        assert_eq!(loaded.title, "Test PRD");
        assert_eq!(loaded.version, 1);
    }

    #[test]
    fn update_artifact() {
        let store = ArtifactStore::open_in_memory().unwrap();
        let mut artifact = Artifact::new("Test".to_string(), ArtifactType::Document, None);
        store.insert(&artifact).unwrap();

        artifact.update_content("Updated content".to_string());
        store.update(&artifact).unwrap();

        let loaded = store.get(&artifact.id).unwrap();
        assert_eq!(loaded.content, "Updated content");
        assert_eq!(loaded.version, 2);
    }

    #[test]
    fn list_artifacts() {
        let store = ArtifactStore::open_in_memory().unwrap();
        store
            .insert(&Artifact::new(
                "A".to_string(),
                ArtifactType::Document,
                None,
            ))
            .unwrap();
        store
            .insert(&Artifact::new("B".to_string(), ArtifactType::Sheet, None))
            .unwrap();

        let all = store.list().unwrap();
        assert_eq!(all.len(), 2);
    }

    #[test]
    fn delete_artifact() {
        let store = ArtifactStore::open_in_memory().unwrap();
        let artifact = Artifact::new("ToDelete".to_string(), ArtifactType::Document, None);
        store.insert(&artifact).unwrap();
        store.delete(&artifact.id).unwrap();

        let result = store.get(&artifact.id);
        assert!(result.is_err());
    }

    #[test]
    fn artifact_store_shares_database_with_clone() {
        // Two stores built on the same SharedConnection see the same
        // rows. Mirrors `audit_store_shares_database_with_clone` so the
        // shared-connection refactor is exercised per-crate.
        let conn = tessera_core::open_shared_in_memory().unwrap();
        let a = ArtifactStore::with_shared_conn(conn.clone()).unwrap();
        let b = ArtifactStore::with_shared_conn(conn).unwrap();
        let artifact = Artifact::new("Shared".to_string(), ArtifactType::Document, None);
        a.insert(&artifact).unwrap();
        let loaded = b.get(&artifact.id).unwrap();
        assert_eq!(loaded.title, "Shared");
    }
}
