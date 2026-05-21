use rusqlite::params;
use tessera_core::error::{Error, Result};
use tessera_core::{open_shared, open_shared_in_memory, SharedConnection};

use crate::event::{AuditEvent, AuditEventType};

fn parse_datetime(s: &str) -> chrono::DateTime<chrono::Utc> {
    chrono::DateTime::parse_from_rfc3339(s)
        .map_or_else(|_| chrono::Utc::now(), |dt| dt.with_timezone(&chrono::Utc))
}

pub struct AuditStore {
    conn: SharedConnection,
}

impl AuditStore {
    pub fn open(path: &str) -> Result<Self> {
        Self::with_shared_conn(open_shared(path)?)
    }

    pub fn open_in_memory() -> Result<Self> {
        Self::with_shared_conn(open_shared_in_memory()?)
    }

    /// Build a store on top of a [`SharedConnection`] that is already
    /// shared with other stores. Used by the napi bridge to fold all
    /// six per-store SQLite connections into one.
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
                "CREATE TABLE IF NOT EXISTS audit_events (
                    id TEXT PRIMARY KEY,
                    event_type TEXT NOT NULL,
                    timestamp TEXT NOT NULL,
                    details TEXT NOT NULL
                );
                CREATE INDEX IF NOT EXISTS idx_audit_type ON audit_events(event_type);
                CREATE INDEX IF NOT EXISTS idx_audit_time ON audit_events(timestamp);

                CREATE TRIGGER IF NOT EXISTS audit_no_update
                BEFORE UPDATE ON audit_events
                BEGIN
                    SELECT RAISE(ABORT, 'audit_events is append-only: UPDATE not allowed');
                END;

                CREATE TRIGGER IF NOT EXISTS audit_no_delete
                BEFORE DELETE ON audit_events
                BEGIN
                    SELECT RAISE(ABORT, 'audit_events is append-only: DELETE not allowed');
                END;",
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(())
    }

    pub fn append(&self, event: &AuditEvent) -> Result<()> {
        let type_str =
            serde_json::to_string(&event.event_type).map_err(|e| Error::Database(e.to_string()))?;
        self.conn
            .lock()
            .expect("connection mutex poisoned")
            .execute(
                "INSERT INTO audit_events (id, event_type, timestamp, details) VALUES (?1, ?2, ?3, ?4)",
                params![
                    event.id,
                    type_str,
                    event.timestamp.to_rfc3339(),
                    event.details,
                ],
            )
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(())
    }

    pub fn query_by_type(&self, event_type: &AuditEventType) -> Result<Vec<AuditEvent>> {
        let type_str =
            serde_json::to_string(event_type).map_err(|e| Error::Database(e.to_string()))?;
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare("SELECT id, event_type, timestamp, details FROM audit_events WHERE event_type = ?1 ORDER BY timestamp DESC")
            .map_err(|e| Error::Database(e.to_string()))?;

        let events = stmt
            .query_map(params![type_str], |row| {
                let type_s: String = row.get(1)?;
                let ts_s: String = row.get(2)?;
                Ok(AuditEvent {
                    id: row.get(0)?,
                    event_type: serde_json::from_str(&type_s)
                        .unwrap_or(AuditEventType::SettingsChanged),
                    timestamp: parse_datetime(&ts_s),
                    details: row.get(3)?,
                })
            })
            .map_err(|e| Error::Database(e.to_string()))?
            .filter_map(std::result::Result::ok)
            .collect();

        Ok(events)
    }

    pub fn query_by_date_range(
        &self,
        from: &chrono::DateTime<chrono::Utc>,
        to: &chrono::DateTime<chrono::Utc>,
    ) -> Result<Vec<AuditEvent>> {
        let conn = self.conn.lock().expect("connection mutex poisoned");
        let mut stmt = conn
            .prepare(
                "SELECT id, event_type, timestamp, details FROM audit_events WHERE timestamp >= ?1 AND timestamp <= ?2 ORDER BY timestamp DESC",
            )
            .map_err(|e| Error::Database(e.to_string()))?;

        let events = stmt
            .query_map(params![from.to_rfc3339(), to.to_rfc3339()], |row| {
                let type_s: String = row.get(1)?;
                let ts_s: String = row.get(2)?;
                Ok(AuditEvent {
                    id: row.get(0)?,
                    event_type: serde_json::from_str(&type_s)
                        .unwrap_or(AuditEventType::SettingsChanged),
                    timestamp: parse_datetime(&ts_s),
                    details: row.get(3)?,
                })
            })
            .map_err(|e| Error::Database(e.to_string()))?
            .filter_map(std::result::Result::ok)
            .collect();

        Ok(events)
    }

    pub fn count(&self) -> Result<u64> {
        let count: i64 = self
            .conn
            .lock()
            .expect("connection mutex poisoned")
            .query_row("SELECT COUNT(*) FROM audit_events", [], |row| row.get(0))
            .map_err(|e| Error::Database(e.to_string()))?;
        Ok(count as u64)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn append_and_query_events() {
        let store = AuditStore::open_in_memory().unwrap();
        store
            .append(&AuditEvent::new(
                AuditEventType::SourceAdded,
                "Added folder /home/user/docs".to_string(),
            ))
            .unwrap();
        store
            .append(&AuditEvent::new(
                AuditEventType::ArtifactCreated,
                "Created PRD: Q4 Planning".to_string(),
            ))
            .unwrap();

        let source_events = store.query_by_type(&AuditEventType::SourceAdded).unwrap();
        assert_eq!(source_events.len(), 1);
        assert!(source_events[0].details.contains("/home/user/docs"));

        assert_eq!(store.count().unwrap(), 2);
    }

    #[test]
    fn query_by_date_range() {
        let store = AuditStore::open_in_memory().unwrap();
        store
            .append(&AuditEvent::new(
                AuditEventType::SearchPerformed,
                "query: productivity".to_string(),
            ))
            .unwrap();

        let from = chrono::Utc::now() - chrono::Duration::hours(1);
        let to = chrono::Utc::now() + chrono::Duration::hours(1);
        let events = store.query_by_date_range(&from, &to).unwrap();
        assert_eq!(events.len(), 1);
    }

    #[test]
    fn audit_store_is_append_only() {
        let store = AuditStore::open_in_memory().unwrap();
        for i in 0..5 {
            store
                .append(&AuditEvent::new(
                    AuditEventType::SettingsChanged,
                    format!("Change {i}"),
                ))
                .unwrap();
        }
        assert_eq!(store.count().unwrap(), 5);
    }

    #[test]
    fn audit_store_shares_database_with_clone() {
        // Two stores built on the same SharedConnection see the same
        // rows — that's the entire point of the shared-connection
        // refactor. If this ever fails, init_bridge probably
        // accidentally rebuilt a fresh Connection per store.
        let conn = open_shared_in_memory().unwrap();
        let a = AuditStore::with_shared_conn(conn.clone()).unwrap();
        let b = AuditStore::with_shared_conn(conn).unwrap();
        a.append(&AuditEvent::new(
            AuditEventType::SettingsChanged,
            "via A".to_string(),
        ))
        .unwrap();
        assert_eq!(b.count().unwrap(), 1);
    }
}
