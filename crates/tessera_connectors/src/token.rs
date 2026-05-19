use crate::error::{ConnectorError, ConnectorResult};
use crate::types::StoredTokens;

/// Abstraction for secure token storage. Implementations back onto OS keychains.
pub trait TokenStore: Send + Sync {
    fn store_tokens(&self, provider: &str, tokens: &StoredTokens) -> ConnectorResult<()>;
    fn get_tokens(&self, provider: &str) -> ConnectorResult<Option<StoredTokens>>;
    fn delete_tokens(&self, provider: &str) -> ConnectorResult<()>;
    fn has_tokens(&self, provider: &str) -> ConnectorResult<bool>;
}

/// In-memory token store for testing.
pub struct InMemoryTokenStore {
    tokens: std::sync::Mutex<std::collections::HashMap<String, StoredTokens>>,
}

impl InMemoryTokenStore {
    pub fn new() -> Self {
        Self {
            tokens: std::sync::Mutex::new(std::collections::HashMap::new()),
        }
    }
}

impl Default for InMemoryTokenStore {
    fn default() -> Self {
        Self::new()
    }
}

impl TokenStore for InMemoryTokenStore {
    fn store_tokens(&self, provider: &str, tokens: &StoredTokens) -> ConnectorResult<()> {
        let mut map = self
            .tokens
            .lock()
            .map_err(|e| ConnectorError::StorageError(e.to_string()))?;
        map.insert(provider.to_string(), tokens.clone());
        Ok(())
    }

    fn get_tokens(&self, provider: &str) -> ConnectorResult<Option<StoredTokens>> {
        let map = self
            .tokens
            .lock()
            .map_err(|e| ConnectorError::StorageError(e.to_string()))?;
        Ok(map.get(provider).cloned())
    }

    fn delete_tokens(&self, provider: &str) -> ConnectorResult<()> {
        let mut map = self
            .tokens
            .lock()
            .map_err(|e| ConnectorError::StorageError(e.to_string()))?;
        map.remove(provider);
        Ok(())
    }

    fn has_tokens(&self, provider: &str) -> ConnectorResult<bool> {
        let map = self
            .tokens
            .lock()
            .map_err(|e| ConnectorError::StorageError(e.to_string()))?;
        Ok(map.contains_key(provider))
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use chrono::Utc;

    #[test]
    fn in_memory_store_crud() {
        let store = InMemoryTokenStore::new();
        let tokens = StoredTokens {
            access_token: "ya29.test".into(),
            refresh_token: Some("1//refresh".into()),
            expiry: Some(Utc::now()),
            scopes: vec!["drive.readonly".into()],
        };

        assert!(!store.has_tokens("google_drive").unwrap());
        assert!(store.get_tokens("google_drive").unwrap().is_none());

        store.store_tokens("google_drive", &tokens).unwrap();
        assert!(store.has_tokens("google_drive").unwrap());

        let retrieved = store.get_tokens("google_drive").unwrap().unwrap();
        assert_eq!(retrieved.access_token, "ya29.test");
        assert_eq!(retrieved.refresh_token.as_deref(), Some("1//refresh"));

        store.delete_tokens("google_drive").unwrap();
        assert!(!store.has_tokens("google_drive").unwrap());
    }

    #[test]
    fn in_memory_store_overwrite() {
        let store = InMemoryTokenStore::new();
        let tokens1 = StoredTokens {
            access_token: "token1".into(),
            refresh_token: None,
            expiry: None,
            scopes: vec![],
        };
        let tokens2 = StoredTokens {
            access_token: "token2".into(),
            refresh_token: None,
            expiry: None,
            scopes: vec![],
        };

        store.store_tokens("provider", &tokens1).unwrap();
        store.store_tokens("provider", &tokens2).unwrap();
        let retrieved = store.get_tokens("provider").unwrap().unwrap();
        assert_eq!(retrieved.access_token, "token2");
    }

    #[test]
    fn in_memory_store_multiple_providers() {
        let store = InMemoryTokenStore::new();
        let gdrive = StoredTokens {
            access_token: "gdrive-token".into(),
            refresh_token: None,
            expiry: None,
            scopes: vec![],
        };
        let onedrive = StoredTokens {
            access_token: "onedrive-token".into(),
            refresh_token: None,
            expiry: None,
            scopes: vec![],
        };

        store.store_tokens("google_drive", &gdrive).unwrap();
        store.store_tokens("one_drive", &onedrive).unwrap();

        assert_eq!(
            store
                .get_tokens("google_drive")
                .unwrap()
                .unwrap()
                .access_token,
            "gdrive-token"
        );
        assert_eq!(
            store
                .get_tokens("one_drive")
                .unwrap()
                .unwrap()
                .access_token,
            "onedrive-token"
        );

        store.delete_tokens("google_drive").unwrap();
        assert!(!store.has_tokens("google_drive").unwrap());
        assert!(store.has_tokens("one_drive").unwrap());
    }
}
