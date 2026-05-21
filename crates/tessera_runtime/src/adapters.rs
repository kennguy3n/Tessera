//! Generation adapter chain.
//!
//! PROPOSAL.md line 287–289 describes the order Tessera prefers
//! local generation over the optional external provider:
//!
//! ```text
//! MLXAdapter → LlamaCppAdapter → ExternalAdapter → Fallback
//! ```
//!
//! On Apple Silicon the MLX backend serves Ternary-Bonsai MLX
//! weights directly; on other platforms (or when MLX isn't
//! installed) we use `llama-server` against the GGUF weights. When
//! both local options are unavailable AND the user has explicitly
//! enabled the External Provider in Settings, we fall through to
//! the configured external endpoint via
//! [`crate::external_provider::generate`]. The final "Fallback"
//! step returns a clear error so the renderer can surface a
//! user-friendly empty state rather than hanging.
//!
//! This module implements the chain's *decision logic* and a tiny
//! [`AdapterChain::generate`] entry point. Each adapter is a
//! lightweight enum variant; the heavy lifting (HTTP, process
//! management, weights loading) stays in the existing modules.

use serde::{Deserialize, Serialize};

use crate::external_provider::{ExternalGenerateInputs, ExternalProviderConfig};
use crate::generation::{CompletionResponse, GenerateRequest};

/// Which adapter satisfied a given generation call. The bridge
/// layer surfaces this back to the UI so users can see whether
/// their last completion came from the local model or the
/// configured external provider.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, Deserialize)]
#[serde(rename_all = "snake_case")]
pub enum AdapterKind {
    Mlx,
    LlamaCpp,
    External,
    Fallback,
}

impl AdapterKind {
    pub fn as_str(&self) -> &'static str {
        match self {
            Self::Mlx => "mlx",
            Self::LlamaCpp => "llama_cpp",
            Self::External => "external",
            Self::Fallback => "fallback",
        }
    }
}

/// Runtime-visible availability flags. The bridge layer fills
/// these in from real state checks (is the local llama-server
/// process running? is the MLX weights file present?). The
/// adapter chain consults them — it does NOT decide whether MLX
/// is "available" on its own.
#[derive(Debug, Clone, Default)]
pub struct AdapterAvailability {
    pub mlx_available: bool,
    pub llamacpp_available: bool,
}

/// Inputs for a chain-driven generation call. The external
/// provider config and the API key (from the OS keychain) are
/// optional — when missing or disabled the chain skips the
/// External step entirely.
pub struct ChainInputs<'a> {
    pub availability: AdapterAvailability,
    pub external: Option<&'a ExternalProviderConfig>,
    pub external_key: Option<&'a str>,
    pub request: &'a GenerateRequest,
    /// HTTP endpoint of the running local llama-server, if any.
    /// `None` means the local path is skipped.
    pub local_endpoint: Option<&'a str>,
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct ChainResult {
    pub adapter: AdapterKind,
    pub response: CompletionResponse,
}

/// Pure planner: returns the ordered list of adapter kinds the
/// chain will try, top to bottom. Useful for diagnostics and tests.
pub fn plan_chain(inputs: &ChainInputs<'_>) -> Vec<AdapterKind> {
    let mut chain = Vec::with_capacity(4);
    if inputs.availability.mlx_available {
        chain.push(AdapterKind::Mlx);
    }
    if inputs.availability.llamacpp_available {
        chain.push(AdapterKind::LlamaCpp);
    }
    if inputs
        .external
        .is_some_and(|c| c.is_usable() && inputs.external_key.is_some())
    {
        chain.push(AdapterKind::External);
    }
    chain.push(AdapterKind::Fallback);
    chain
}

/// Run the chain. Each step is attempted in turn — on transient
/// failure (HTTP timeout, process down, …) the chain moves to the
/// next step. The Fallback step always returns an error so the
/// caller can surface "no model available".
///
/// Note: the local steps (MLX, LlamaCpp) are not implemented here.
/// They share the same HTTP wire format as llama-server and reuse
/// [`crate::generation::generate`] under the hood via the
/// `local_endpoint` parameter. When `local_endpoint` is `None` we
/// skip both local adapters even if the availability flags say
/// they're up — the caller is responsible for keeping these
/// consistent.
#[cfg(feature = "http")]
pub async fn run_chain(inputs: ChainInputs<'_>) -> Result<ChainResult, String> {
    use crate::external_provider;
    use crate::generation;

    let plan = plan_chain(&inputs);
    let mut last_err = String::new();

    for adapter in plan {
        match adapter {
            AdapterKind::Mlx | AdapterKind::LlamaCpp => {
                let Some(endpoint) = inputs.local_endpoint else {
                    last_err = format!("{adapter:?} skipped: no local endpoint");
                    continue;
                };
                match generation::generate(endpoint, inputs.request).await {
                    Ok(response) => {
                        return Ok(ChainResult { adapter, response });
                    }
                    Err(e) => {
                        last_err = format!("{adapter:?} failed: {e}");
                        continue;
                    }
                }
            }
            AdapterKind::External => {
                let (Some(cfg), Some(key)) = (inputs.external, inputs.external_key) else {
                    last_err = "external adapter missing config or key".to_string();
                    continue;
                };
                let ext_inputs = ExternalGenerateInputs {
                    config: cfg,
                    api_key: key,
                    request: inputs.request,
                };
                match external_provider::generate(ext_inputs).await {
                    Ok(response) => {
                        return Ok(ChainResult {
                            adapter: AdapterKind::External,
                            response,
                        });
                    }
                    Err(e) => {
                        last_err = format!("external adapter failed: {e}");
                        continue;
                    }
                }
            }
            AdapterKind::Fallback => {
                return Err(if last_err.is_empty() {
                    "no available generation adapter".to_string()
                } else {
                    format!("no available generation adapter (last error: {last_err})")
                });
            }
        }
    }
    Err("adapter chain exhausted without reaching Fallback (this is a bug)".to_string())
}

#[cfg(not(feature = "http"))]
pub async fn run_chain(_inputs: ChainInputs<'_>) -> Result<ChainResult, String> {
    Err("runtime built without `http` feature; cannot dispatch to any adapter".to_string())
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::external_provider::ExternalProviderType;

    fn empty_request() -> GenerateRequest {
        GenerateRequest::new("hi".to_string())
    }

    fn external_cfg(enabled: bool) -> ExternalProviderConfig {
        ExternalProviderConfig {
            enabled,
            provider_type: ExternalProviderType::OpenAICompatible,
            api_url: "http://localhost".to_string(),
            api_key_ref: "ref".to_string(),
            model_name: "m".to_string(),
            max_tokens: 32,
            temperature: 0.5,
            timeout_secs: 5,
            max_retries: 0,
        }
    }

    #[test]
    fn plan_prefers_mlx_then_llamacpp_then_external_then_fallback() {
        let cfg = external_cfg(true);
        let req = empty_request();
        let inputs = ChainInputs {
            availability: AdapterAvailability {
                mlx_available: true,
                llamacpp_available: true,
            },
            external: Some(&cfg),
            external_key: Some("k"),
            request: &req,
            local_endpoint: Some("http://localhost:8384"),
        };
        assert_eq!(
            plan_chain(&inputs),
            vec![
                AdapterKind::Mlx,
                AdapterKind::LlamaCpp,
                AdapterKind::External,
                AdapterKind::Fallback,
            ]
        );
    }

    #[test]
    fn plan_skips_unavailable_local_adapters() {
        let cfg = external_cfg(true);
        let req = empty_request();
        let inputs = ChainInputs {
            availability: AdapterAvailability::default(),
            external: Some(&cfg),
            external_key: Some("k"),
            request: &req,
            local_endpoint: None,
        };
        assert_eq!(
            plan_chain(&inputs),
            vec![AdapterKind::External, AdapterKind::Fallback]
        );
    }

    #[test]
    fn plan_skips_external_when_disabled() {
        let cfg = external_cfg(false);
        let req = empty_request();
        let inputs = ChainInputs {
            availability: AdapterAvailability {
                mlx_available: true,
                llamacpp_available: false,
            },
            external: Some(&cfg),
            external_key: Some("k"),
            request: &req,
            local_endpoint: Some("http://localhost:8384"),
        };
        assert_eq!(
            plan_chain(&inputs),
            vec![AdapterKind::Mlx, AdapterKind::Fallback]
        );
    }

    #[test]
    fn plan_skips_external_when_key_missing() {
        let cfg = external_cfg(true);
        let req = empty_request();
        let inputs = ChainInputs {
            availability: AdapterAvailability::default(),
            external: Some(&cfg),
            external_key: None,
            request: &req,
            local_endpoint: None,
        };
        assert_eq!(plan_chain(&inputs), vec![AdapterKind::Fallback]);
    }

    #[test]
    fn adapter_kind_string_round_trip() {
        for kind in [
            AdapterKind::Mlx,
            AdapterKind::LlamaCpp,
            AdapterKind::External,
            AdapterKind::Fallback,
        ] {
            let s = serde_json::to_string(&kind).unwrap();
            let parsed: AdapterKind = serde_json::from_str(&s).unwrap();
            assert_eq!(parsed, kind);
        }
    }

    #[tokio::test]
    #[cfg(feature = "http")]
    async fn fallback_returns_error_when_chain_empty() {
        let req = empty_request();
        let inputs = ChainInputs {
            availability: AdapterAvailability::default(),
            external: None,
            external_key: None,
            request: &req,
            local_endpoint: None,
        };
        let err = run_chain(inputs).await.unwrap_err();
        assert!(err.contains("no available generation adapter"));
    }
}
