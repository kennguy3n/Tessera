//! Request/response types for text generation against the runtime.

use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Generate Request.
pub struct GenerateRequest {
    /// Prompt.
    pub prompt: String,
    /// Max tokens.
    pub max_tokens: u32,
    /// Temperature.
    pub temperature: f64,
    /// Grammar.
    pub grammar: Option<String>,
    /// Stop.
    pub stop: Option<Vec<String>>,
    /// Stream.
    pub stream: bool,
}

impl GenerateRequest {
    /// Creates a new instance.
    pub fn new(prompt: String) -> Self {
        Self {
            prompt,
            max_tokens: 2048,
            temperature: 0.7,
            grammar: None,
            stop: None,
            stream: true,
        }
    }

    /// With grammar.
    pub fn with_grammar(mut self, grammar: String) -> Self {
        self.grammar = Some(grammar);
        self
    }

    /// With max tokens.
    pub fn with_max_tokens(mut self, max_tokens: u32) -> Self {
        self.max_tokens = max_tokens;
        self
    }

    /// With temperature.
    pub fn with_temperature(mut self, temperature: f64) -> Self {
        self.temperature = temperature;
        self
    }

    /// Non streaming.
    pub fn non_streaming(mut self) -> Self {
        self.stream = false;
        self
    }

    /// Attach a list of stop sequences. Empty input is treated the
    /// same as not calling this at all (the inner Option stays
    /// `None`) so the OpenAI body builder doesn't emit a
    /// zero-length `stop: []` array that the API rejects.
    pub fn with_stop(mut self, stop: Vec<String>) -> Self {
        self.stop = if stop.is_empty() { None } else { Some(stop) };
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Generate Chunk.
pub struct GenerateChunk {
    /// Content.
    pub content: String,
    /// Stop.
    pub stop: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
/// Completion Response.
pub struct CompletionResponse {
    /// Content.
    pub content: String,
    /// Stop.
    pub stop: bool,
    /// Tokens predicted.
    pub tokens_predicted: Option<u32>,
    /// Tokens evaluated.
    pub tokens_evaluated: Option<u32>,
}

#[derive(Debug, Clone, Serialize)]
struct LlamaCompletionBody {
    prompt: String,
    n_predict: u32,
    temperature: f64,
    stream: bool,
    #[serde(skip_serializing_if = "Option::is_none")]
    grammar: Option<String>,
    #[serde(skip_serializing_if = "Option::is_none")]
    stop: Option<Vec<String>>,
}

impl From<&GenerateRequest> for LlamaCompletionBody {
    fn from(req: &GenerateRequest) -> Self {
        Self {
            prompt: req.prompt.clone(),
            n_predict: req.max_tokens,
            temperature: req.temperature,
            stream: req.stream,
            grammar: req.grammar.clone(),
            stop: req.stop.clone(),
        }
    }
}

#[cfg(feature = "http")]
/// Generate.
pub async fn generate(
    endpoint: &str,
    request: &GenerateRequest,
) -> std::result::Result<CompletionResponse, String> {
    let url = format!("{endpoint}/completion");
    let body = LlamaCompletionBody::from(request);

    let client = reqwest::Client::new();
    let resp = client
        .post(&url)
        .json(&body)
        .send()
        .await
        .map_err(|e| e.to_string())?;

    if !resp.status().is_success() {
        let status = resp.status();
        let text = resp.text().await.unwrap_or_default();
        return Err(format!("HTTP {status}: {text}"));
    }

    let text = resp.text().await.map_err(|e| e.to_string())?;
    serde_json::from_str(&text).map_err(|e| format!("Parse error: {e}"))
}

/// Parse sse chunk.
pub fn parse_sse_chunk(line: &str) -> Option<GenerateChunk> {
    let data = line.strip_prefix("data: ")?;
    if data == "[DONE]" {
        return Some(GenerateChunk {
            content: String::new(),
            stop: true,
        });
    }
    let parsed: serde_json::Value = serde_json::from_str(data).ok()?;
    let content = parsed.get("content")?.as_str()?.to_string();
    let stop = parsed
        .get("stop")
        .and_then(serde_json::Value::as_bool)
        .unwrap_or(false);
    Some(GenerateChunk { content, stop })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn parse_sse_token() {
        let chunk = parse_sse_chunk(r#"data: {"content":"Hello","stop":false}"#).unwrap();
        assert_eq!(chunk.content, "Hello");
        assert!(!chunk.stop);
    }

    #[test]
    fn parse_sse_stop() {
        let chunk = parse_sse_chunk(r#"data: {"content":"","stop":true}"#).unwrap();
        assert_eq!(chunk.content, "");
        assert!(chunk.stop);
    }

    #[test]
    fn parse_sse_done() {
        let chunk = parse_sse_chunk("data: [DONE]").unwrap();
        assert!(chunk.stop);
    }

    #[test]
    fn parse_sse_invalid() {
        assert!(parse_sse_chunk("not sse data").is_none());
    }

    #[test]
    fn generate_request_builder() {
        let req = GenerateRequest::new("test prompt".into())
            .with_max_tokens(1024)
            .with_temperature(0.5)
            .with_grammar("root ::= [a-z]+".into())
            .non_streaming();

        assert_eq!(req.prompt, "test prompt");
        assert_eq!(req.max_tokens, 1024);
        assert!((req.temperature - 0.5).abs() < f64::EPSILON);
        assert_eq!(req.grammar.as_deref(), Some("root ::= [a-z]+"));
        assert!(!req.stream);
    }
}
