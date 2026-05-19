use rusqlite::{params, Connection};
use tessera_core::error::{Error, Result};
use tessera_core::ArtifactId;

use crate::artifact::Artifact;

fn parse_datetime(s: &str) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map_or_else(|_| chrono::Utc::now(), |dt| dt.with_timezone(&chrono::Utc))
}

pub struct ArtifactStore {
    conn: Connection,
}

impl ArtifactStore {
    pub fn open(path: &str) -> Result<Self> {
        let conn = Connection::open(path).map_err(|e| Error::Database(e.to_string()))?;
        let store = Self { conn };
        store.init_schema()?;
        Ok(store)
    }

    pub fn open_in_memory() -> Result<Self> {
        let conn = Connection::open_in_memory().map_err(|e| Error::Database(e.to_string()))?;
        let store = Self { conn };
        store.init_schema()?;
        Ok(store)
    }

    fn init_schema(&self) -> Result<()> {
        self.conn
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
                );",
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(())
    }

    pub fn insert(&self, artifact: &Artifact) -> Result<()> {
        let citations_json = serde_json::to_string(&artifact.citations)
            .map_err(|e| Error::Database(e.to_string()))?;
        self.conn
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

                    Ok(Artifact {
                        id: ArtifactId(uuid::Uuid::parse_str(&id_str).unwrap_or_default()),
                        title: row.get(1)?,
                        artifact_type: serde_json::from_str(&type_str).unwrap_or(tessera_core::ArtifactType::Document),
                        template_id: template_str.and_then(|s| uuid::Uuid::parse_str(&s).ok().map(tessera_core::TemplateId)),
                        content: row.get(4)?,
                        citations: serde_json::from_str(&citations_str).unwrap_or_default(),
                        created_at: parse_datetime(&created_str),
                        updated_at: parse_datetime(&updated_str),
                        version: row.get(8)?,
                    })
                },
            )
            .map_err(|e| Error::ArtifactNotFound(e.to_string()))
    }

    pub fn list(&self) -> Result<Vec<Artifact>> {
        let mut stmt = self
            .conn
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

                Ok(Artifact {
                    id: ArtifactId(uuid::Uuid::parse_str(&id_str).unwrap_or_default()),
                    title: row.get(1)?,
                    artifact_type: serde_json::from_str(&type_str)
                        .unwrap_or(tessera_core::ArtifactType::Document),
                    template_id: template_str
                        .and_then(|s| uuid::Uuid::parse_str(&s).ok().map(tessera_core::TemplateId)),
                    content: row.get(4)?,
                    citations: serde_json::from_str(&citations_str).unwrap_or_default(),
                    created_at: parse_datetime(&created_str),
                    updated_at: parse_datetime(&updated_str),
                    version: row.get(8)?,
                })
            })
            .map_err(|e| Error::Database(e.to_string()))?
            .filter_map(std::result::Result::ok)
            .collect();

        Ok(artifacts)
    }

    pub fn delete(&self, id: &ArtifactId) -> Result<()> {
        self.conn
            .execute(
                "DELETE FROM artifacts WHERE id = ?1",
                params![id.to_string()],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(())
    }
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
}
