use serde::{Deserialize, Serialize};

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerateRequest {
    pub prompt: String,
    pub max_tokens: u32,
    pub temperature: f64,
    pub grammar: Option<String>,
    pub stop: Option<Vec<String>>,
    pub stream: bool,
}

impl GenerateRequest {
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

    pub fn with_grammar(mut self, grammar: String) -> Self {
        self.grammar = Some(grammar);
        self
    }

    pub fn with_max_tokens(mut self, max_tokens: u32) -> Self {
        self.max_tokens = max_tokens;
        self
    }

    pub fn with_temperature(mut self, temperature: f64) -> Self {
        self.temperature = temperature;
        self
    }

    pub fn non_streaming(mut self) -> Self {
        self.stream = false;
        self
    }
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct GenerateChunk {
    pub content: String,
    pub stop: bool,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct CompletionResponse {
    pub content: String,
    pub stop: bool,
    pub tokens_predicted: Option<u32>,
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
        .and_then(|v| v.as_bool())
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
