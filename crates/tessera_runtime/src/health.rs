use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Health Response.
pub struct HealthResponse {
    /// Status.
    pub status: String,
    /// Slots idle.
    pub slots_idle: Option<u32>,
    /// Slots processing.
    pub slots_processing: Option<u32>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Model Props.
pub struct ModelProps {
    /// Model.
    pub model: Option<String>,
    /// Ctx size.
    pub ctx_size: Option<u32>,
    /// N predict.
    pub n_predict: Option<u32>,
}

#[derive(thiserror::Error, Debug)]
/// Health Error.
pub enum HealthError {
    #[error("Health check failed: {0}")]
    /// Health check failed.
    RequestFailed(String),
    #[error("Unhealthy: {0}")]
    /// Unhealthy.
    Unhealthy(String),
    #[error("Parse error: {0}")]
    /// Parse error.
    ParseError(String),
}

/// Result type alias.
pub type Result<T> = std::result::Result<T, HealthError>;

#[cfg(feature = "http")]
/// Check health.
pub async fn check_health(endpoint: &str) -> Result<HealthResponse> {
    let url = format!("{endpoint}/health");
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| HealthError::RequestFailed(e.to_string()))?;

    if !resp.status().is_success() {
        return Err(HealthError::Unhealthy(format!("HTTP {}", resp.status())));
    }

    let body = resp
        .text()
        .await
        .map_err(|e| HealthError::ParseError(e.to_string()))?;

    // llama.cpp /health returns {"status":"ok"} or {"status":"loading model"}
    serde_json::from_str(&body).map_err(|e| HealthError::ParseError(e.to_string()))
}

#[cfg(feature = "http")]
/// Get model info.
pub async fn get_model_info(endpoint: &str) -> Result<ModelProps> {
    let url = format!("{endpoint}/props");
    let resp = reqwest::get(&url)
        .await
        .map_err(|e| HealthError::RequestFailed(e.to_string()))?;

    let body = resp
        .text()
        .await
        .map_err(|e| HealthError::ParseError(e.to_string()))?;

    serde_json::from_str(&body).map_err(|e| HealthError::ParseError(e.to_string()))
}

/// Parse health response.
pub fn parse_health_response(json: &str) -> Result<HealthResponse> {
    serde_json::from_str(json).map_err(|e| HealthError::ParseError(e.to_string()))
}

/// Is healthy.
pub fn is_healthy(response: &HealthResponse) -> bool {
    response.status == "ok"
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_ok_response() {
        let resp = parse_health_response(r#"{"status":"ok","slots_idle":2,"slots_processing":0}"#)
            .unwrap();
        assert_eq!(resp.status, "ok");
        assert_eq!(resp.slots_idle, Some(2));
        assert_eq!(resp.slots_processing, Some(0));
        assert!(is_healthy(&resp));
    }

    #[test]
    fn parse_loading_response() {
        let resp = parse_health_response(
            r#"{"status":"loading model","slots_idle":0,"slots_processing":0}"#,
        )
        .unwrap();
        assert_eq!(resp.status, "loading model");
        assert!(!is_healthy(&resp));
    }

    #[test]
    fn parse_minimal_response() {
        let resp = parse_health_response(r#"{"status":"ok"}"#).unwrap();
        assert!(is_healthy(&resp));
        assert_eq!(resp.slots_idle, None);
    }

    #[test]
    fn parse_invalid_json() {
        let result = parse_health_response("not json");
        assert!(result.is_err());
    }
}
