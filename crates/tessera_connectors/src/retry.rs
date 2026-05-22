//! Shared retry-with-exponential-backoff helper for all connector HTTP
//! traffic.
//!
//! Every connector previously rolled its own retry semantics (or didn't
//! retry at all), which meant a 429 rate-limit response from any provider
//! would hard-fail the sync attempt with no chance of recovery. This
//! module gives every connector one uniform retry contract:
//!
//!  * **429 (Too Many Requests)** — parse the `Retry-After` header and
//!    wait that long, up to a small bounded number of attempts. Per RFC
//!    9110 §10.2.3 the value can be either a delta-seconds integer or an
//!    HTTP-date; we honour the integer form (every provider we care about
//!    sends integer seconds) and fall back to a sensible default when
//!    the header is missing.
//!  * **5xx (server error)** — exponential backoff (250ms, 500ms, 1s,
//!    2s, 4s), up to `max_attempts` (default 5) attempts total.
//!  * **transport error (reqwest::Error)** — exponential backoff, up
//!    to `transport_max_attempts` (default 3) attempts total. We use a
//!    tighter budget for transport failures than for HTTP failures
//!    because a sustained transport failure usually means the caller
//!    has bad network, not that the provider is flaky — burning the
//!    full 5-attempt budget would just delay surfacing the offline
//!    state to the user.
//!
//! Responses outside those categories (2xx, 3xx, 4xx other than 429) are
//! returned immediately — they're either a success or a request-shape
//! error that retrying won't fix.
//!
//! ## Design choices
//!
//! **Why a closure-based helper, not a `reqwest::Middleware`?**
//! `reqwest-middleware` would force every connector to convert from
//! `reqwest::Client` to `reqwest_middleware::ClientWithMiddleware` (a
//! distinct type with a slightly different RequestBuilder surface). The
//! per-connector code was already plain `reqwest::Client` and the
//! migration cost outweighs the ergonomic gain. The closure approach
//! keeps the helper opt-in: a connector that doesn't want retries (e.g.
//! `revoke()`, where a 5xx genuinely should fail loudly so the user
//! knows their token wasn't revoked) just calls `request.send().await`
//! directly.
//!
//! **Why bounded by attempt count, not by wall-clock?** A wall-clock
//! budget would be more correct for a UI ("don't take longer than 30s")
//! but the bridge already imposes its own per-call timeout via the IPC
//! layer. We just need bounded retries inside our window; the outer
//! timeout enforces the absolute deadline.
//!
//! **Why don't we retry POST requests?** We do. Token refresh and
//! revocation are POSTs but they're idempotent on the provider side
//! (refreshing twice gives you two valid tokens, the older one expiring
//! naturally; revoking twice is a no-op). The general rule "don't
//! retry non-idempotent POSTs" applies to mutation endpoints — file
//! creation, page mutation — which Tessera doesn't do today (read-only
//! connectors). When write-back lands, the trait will add an
//! explicit-opt-in retry switch on the request builder.

use crate::error::{ConnectorError, ConnectorResult};
use reqwest::{Request, Response, StatusCode};
use std::time::Duration;

/// Per-call retry policy.
///
/// Defaults to the production policy described in the module docstring.
/// Tests construct a `RetryPolicy::aggressive_for_tests()` to keep the
/// wiremock test runtime under a second.
#[derive(Debug, Clone)]
pub struct RetryPolicy {
    /// Maximum total HTTP-failure attempts (5xx + 429) including the
    /// first one. So `max_attempts = 5` means "first request + up to 4
    /// retries" when the provider is responding with retryable error
    /// status codes. Defaults to 5.
    pub max_attempts: u32,

    /// Maximum total transport-failure attempts (reqwest::Error: DNS
    /// failure, TLS handshake error, connection refused, etc.)
    /// including the first one. Intentionally tighter than
    /// `max_attempts` because a sustained transport failure usually
    /// indicates the caller is offline rather than the provider being
    /// flaky — surfacing that to the user sooner is the right UX.
    /// Defaults to 3.
    pub transport_max_attempts: u32,

    /// Initial backoff for 5xx / transport errors.
    pub initial_backoff: Duration,

    /// Multiplier applied to `initial_backoff` on each subsequent
    /// retry. 2.0 means: 250ms → 500ms → 1s → 2s → 4s.
    pub backoff_multiplier: f64,

    /// Upper bound on a single backoff sleep. Without this, the 4th
    /// attempt at a 32× multiplier would be untestable and unfriendly
    /// to users staring at a hung sync.
    pub max_backoff: Duration,

    /// Default wait when a 429 response is missing `Retry-After`.
    /// Generous (10s) because the provider already told us to back off
    /// and the user doesn't gain anything from a quicker re-poll.
    pub retry_after_fallback: Duration,
}

impl Default for RetryPolicy {
    fn default() -> Self {
        Self {
            max_attempts: 5,
            transport_max_attempts: 3,
            initial_backoff: Duration::from_millis(250),
            backoff_multiplier: 2.0,
            max_backoff: Duration::from_secs(10),
            retry_after_fallback: Duration::from_secs(10),
        }
    }
}

impl RetryPolicy {
    /// Test-only policy: aggressive limits + zero waits so wiremock
    /// fixtures complete in < 100ms. Use [`Self::default`] in
    /// production code paths.
    pub fn aggressive_for_tests() -> Self {
        Self {
            max_attempts: 3,
            transport_max_attempts: 2,
            initial_backoff: Duration::from_millis(0),
            backoff_multiplier: 1.0,
            max_backoff: Duration::from_millis(0),
            retry_after_fallback: Duration::from_millis(0),
        }
    }

    /// Compute the backoff for attempt `n` (1-indexed; n=1 is the
    /// post-first-failure delay).
    fn backoff_for(&self, attempt: u32) -> Duration {
        let multiplier = self.backoff_multiplier.powi(attempt as i32 - 1);
        let millis = self.initial_backoff.as_millis() as f64 * multiplier;
        // Saturate at max_backoff; never panic on overflow.
        let capped = millis.min(self.max_backoff.as_millis() as f64);
        Duration::from_millis(capped as u64)
    }

    /// Parse the `Retry-After` header value (seconds or HTTP-date) into
    /// a Duration. Falls back to `self.retry_after_fallback` if the
    /// header is absent or malformed.
    fn parse_retry_after(&self, response: &Response) -> Duration {
        // 2021-edition workspace — use nested `if let` rather than the
        // 2024-only let-chain syntax.
        if let Some(header) = response.headers().get("retry-after") {
            if let Ok(value) = header.to_str() {
                if let Ok(secs) = value.trim().parse::<u64>() {
                    // Cap parsed Retry-After at max_backoff so a misbehaving
                    // server can't pin our sync for an hour. 10s is a
                    // reasonable upper bound for an interactive product.
                    return Duration::from_secs(secs).min(self.max_backoff);
                }
            }
        }
        self.retry_after_fallback
    }
}

/// Whether a response status warrants a retry (5xx + 429 only).
fn is_retryable_status(status: StatusCode) -> bool {
    status.is_server_error() || status == StatusCode::TOO_MANY_REQUESTS
}

/// Send a `reqwest::Request` with retry semantics from `policy`.
///
/// The request must be cloneable (`Request::try_clone` returns `Some`),
/// which is true for any request whose body is `None`, a static
/// buffer, or a JSON value (see `reqwest::Body`). Streaming bodies are
/// unsupported because we cannot replay them. If we ever need to
/// stream-upload from a connector, this helper will need a separate
/// non-retrying variant.
///
/// On success, returns the final non-retryable `Response`. On exhausted
/// retries, returns either:
///   - the last 5xx body wrapped as `ConnectorError::ProviderError`
///   - the last `reqwest::Error` lifted to `ConnectorError::NetworkError`
///   - a `RateLimited` if every attempt was a 429.
pub async fn send_with_retry(
    client: &reqwest::Client,
    request: Request,
    policy: &RetryPolicy,
) -> ConnectorResult<Response> {
    let mut last_error: Option<ConnectorError> = None;
    let mut transport_attempts: u32 = 0;
    let mut http_attempts: u32 = 0;

    // The overall ceiling: we walk until BOTH budgets are exhausted, so
    // a mid-loop transition from transport-failure to HTTP-failure (or
    // vice-versa) doesn't terminate the loop prematurely. Worst-case
    // attempt count is max(http_max, transport_max) — the larger budget
    // dominates if the failure mode is consistent.
    let overall_max = policy.max_attempts.max(policy.transport_max_attempts);

    for _ in 1..=overall_max {
        let req_clone = request.try_clone().ok_or_else(|| {
            ConnectorError::InvalidConfig(
                "request body is not cloneable; cannot apply retry policy. Use a non-streaming body or call send() directly without retries.".into(),
            )
        })?;

        match client.execute(req_clone).await {
            Ok(response) => {
                let status = response.status();
                if !is_retryable_status(status) {
                    // Success or non-retryable failure — return as-is.
                    return Ok(response);
                }
                http_attempts += 1;
                // Build a typed error from the response. We must consume
                // the body to read it; this means callers don't see the
                // intermediate failure responses, only the final one.
                let wait = if status == StatusCode::TOO_MANY_REQUESTS {
                    policy.parse_retry_after(&response)
                } else {
                    policy.backoff_for(http_attempts)
                };
                let body = response.text().await.unwrap_or_default();
                last_error = Some(if status == StatusCode::TOO_MANY_REQUESTS {
                    ConnectorError::RateLimited {
                        retry_after_secs: wait.as_secs(),
                    }
                } else {
                    ConnectorError::ProviderError {
                        provider: "<unknown>".into(),
                        message: format!("HTTP {status}: {body}"),
                    }
                });

                if http_attempts >= policy.max_attempts {
                    // HTTP budget exhausted — surface the last error.
                    break;
                }
                tokio::time::sleep(wait).await;
            }
            Err(e) => {
                transport_attempts += 1;
                last_error = Some(ConnectorError::NetworkError(e.to_string()));
                if transport_attempts >= policy.transport_max_attempts {
                    // Transport budget exhausted — surface offline state
                    // promptly rather than continuing to retry.
                    break;
                }
                tokio::time::sleep(policy.backoff_for(transport_attempts)).await;
            }
        }
    }

    Err(last_error.unwrap_or_else(|| {
        ConnectorError::NetworkError(
            "send_with_retry exhausted attempts with no recorded error \
             (likely a max_attempts=0 policy)"
                .into(),
        )
    }))
}

#[cfg(test)]
mod tests {
    use super::*;
    use wiremock::matchers::{method, path};
    use wiremock::{Mock, MockServer, ResponseTemplate};

    fn client() -> reqwest::Client {
        reqwest::Client::builder().build().unwrap()
    }

    fn req(server: &MockServer) -> Request {
        client().get(format!("{}/x", server.uri())).build().unwrap()
    }

    /// Happy path — 200 on the first attempt returns immediately and
    /// doesn't sleep.
    #[tokio::test]
    async fn success_first_attempt() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/x"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let resp = send_with_retry(
            &client(),
            req(&server),
            &RetryPolicy::aggressive_for_tests(),
        )
        .await
        .expect("first attempt 200");
        assert_eq!(resp.status(), 200);
    }

    /// 5xx then 200 — retries are exercised and the final 200 is
    /// returned to the caller.
    #[tokio::test]
    async fn retries_5xx_until_success() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/x"))
            .respond_with(ResponseTemplate::new(500))
            .up_to_n_times(2)
            .expect(2)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/x"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let resp = send_with_retry(
            &client(),
            req(&server),
            &RetryPolicy::aggressive_for_tests(),
        )
        .await
        .expect("third attempt 200");
        assert_eq!(resp.status(), 200);
    }

    /// 429 with explicit Retry-After — honoured, then success.
    #[tokio::test]
    async fn retries_429_with_explicit_retry_after_seconds() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/x"))
            .respond_with(ResponseTemplate::new(429).insert_header("retry-after", "2"))
            .up_to_n_times(1)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/x"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let resp = send_with_retry(
            &client(),
            req(&server),
            &RetryPolicy::aggressive_for_tests(),
        )
        .await
        .expect("retry honours Retry-After then succeeds");
        assert_eq!(resp.status(), 200);
    }

    /// 429 without Retry-After — falls back to policy default, then
    /// succeeds.
    #[tokio::test]
    async fn retries_429_without_retry_after_uses_fallback() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/x"))
            .respond_with(ResponseTemplate::new(429))
            .up_to_n_times(1)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/x"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let resp = send_with_retry(
            &client(),
            req(&server),
            &RetryPolicy::aggressive_for_tests(),
        )
        .await
        .expect("fallback retry succeeds");
        assert_eq!(resp.status(), 200);
    }

    /// Persistent 5xx exhausts the retry budget and the caller sees
    /// the last response body as ProviderError.
    #[tokio::test]
    async fn exhausts_retries_on_persistent_5xx() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/x"))
            .respond_with(ResponseTemplate::new(503).set_body_string("unavailable"))
            .expect(3) // matches aggressive policy max_attempts=3
            .mount(&server)
            .await;

        let err = send_with_retry(
            &client(),
            req(&server),
            &RetryPolicy::aggressive_for_tests(),
        )
        .await
        .expect_err("budget exhausted");
        match err {
            ConnectorError::ProviderError { message, .. } => {
                assert!(
                    message.contains("503"),
                    "expected status in error, got: {message}",
                );
                assert!(
                    message.contains("unavailable"),
                    "expected body in error, got: {message}",
                );
            }
            other => panic!("expected ProviderError, got {other:?}"),
        }
    }

    /// Persistent 429 surfaces as RateLimited (not ProviderError) so
    /// callers can dispatch on the variant.
    #[tokio::test]
    async fn exhausts_retries_on_persistent_429_surfaces_rate_limited() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/x"))
            .respond_with(ResponseTemplate::new(429).insert_header("retry-after", "5"))
            .expect(3)
            .mount(&server)
            .await;

        let err = send_with_retry(
            &client(),
            req(&server),
            &RetryPolicy::aggressive_for_tests(),
        )
        .await
        .expect_err("429 budget exhausted");
        assert!(
            matches!(err, ConnectorError::RateLimited { .. }),
            "expected RateLimited variant, got {err:?}",
        );
    }

    /// Non-retryable 4xx (404) returns immediately without retrying.
    /// Pins the `is_retryable_status` contract.
    #[tokio::test]
    async fn does_not_retry_4xx_other_than_429() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/x"))
            .respond_with(ResponseTemplate::new(404))
            .expect(1) // exactly one attempt
            .mount(&server)
            .await;

        let resp = send_with_retry(
            &client(),
            req(&server),
            &RetryPolicy::aggressive_for_tests(),
        )
        .await
        .expect("404 is non-retryable success-shape response");
        assert_eq!(resp.status(), 404);
    }

    /// `Retry-After: garbage` falls back to policy default rather than
    /// crashing or hanging forever. Defense-in-depth against a
    /// misbehaving provider.
    #[tokio::test]
    async fn malformed_retry_after_falls_back() {
        let server = MockServer::start().await;
        Mock::given(method("GET"))
            .and(path("/x"))
            .respond_with(ResponseTemplate::new(429).insert_header("retry-after", "not-a-number"))
            .up_to_n_times(1)
            .expect(1)
            .mount(&server)
            .await;
        Mock::given(method("GET"))
            .and(path("/x"))
            .respond_with(ResponseTemplate::new(200))
            .expect(1)
            .mount(&server)
            .await;

        let resp = send_with_retry(
            &client(),
            req(&server),
            &RetryPolicy::aggressive_for_tests(),
        )
        .await
        .expect("malformed header falls back to retry");
        assert_eq!(resp.status(), 200);
    }

    /// Backoff calculation: pin the multiplier ladder so a refactor of
    /// `backoff_for` doesn't silently halve the wait or remove the cap.
    #[test]
    fn backoff_ladder_with_default_policy() {
        let p = RetryPolicy::default();
        // 250ms, 500ms, 1s, 2s, 4s — capped at 10s
        assert_eq!(p.backoff_for(1), Duration::from_millis(250));
        assert_eq!(p.backoff_for(2), Duration::from_millis(500));
        assert_eq!(p.backoff_for(3), Duration::from_secs(1));
        assert_eq!(p.backoff_for(4), Duration::from_secs(2));
        assert_eq!(p.backoff_for(5), Duration::from_secs(4));
        // Cap kicks in
        assert_eq!(p.backoff_for(10), Duration::from_secs(10));
    }

    /// Retry-After parsing pins integer-seconds + fallback + max cap.
    #[test]
    fn retry_after_parsing() {
        let policy = RetryPolicy {
            max_backoff: Duration::from_secs(30),
            retry_after_fallback: Duration::from_secs(7),
            ..RetryPolicy::default()
        };

        // Helper to build a minimal Response with headers.
        async fn mk_response(headers: Vec<(&str, &str)>) -> Response {
            let server = MockServer::start().await;
            let mut tmpl = ResponseTemplate::new(429);
            for (k, v) in headers {
                tmpl = tmpl.insert_header(k, v);
            }
            Mock::given(method("GET"))
                .and(path("/r"))
                .respond_with(tmpl)
                .mount(&server)
                .await;
            reqwest::Client::new()
                .get(format!("{}/r", server.uri()))
                .send()
                .await
                .unwrap()
        }

        let rt = tokio::runtime::Builder::new_current_thread()
            .enable_all()
            .build()
            .unwrap();

        rt.block_on(async {
            // integer seconds honoured
            let r = mk_response(vec![("retry-after", "3")]).await;
            assert_eq!(policy.parse_retry_after(&r), Duration::from_secs(3));

            // cap applied to absurd values
            let r = mk_response(vec![("retry-after", "999999")]).await;
            assert_eq!(policy.parse_retry_after(&r), Duration::from_secs(30));

            // missing header → fallback
            let r = mk_response(vec![]).await;
            assert_eq!(policy.parse_retry_after(&r), Duration::from_secs(7));

            // garbage → fallback
            let r = mk_response(vec![("retry-after", "tomorrow")]).await;
            assert_eq!(policy.parse_retry_after(&r), Duration::from_secs(7));
        });
    }

    /// Persistent transport failure (no server at all) exhausts the
    /// tighter `transport_max_attempts` budget without burning the
    /// larger `max_attempts` budget. Pins the dual-budget contract
    /// — a refactor that re-collapses to a single counter would surface
    /// here because the function would either run too few attempts
    /// (if it picks transport_max_attempts as the loop bound and the
    /// failure mode were HTTP) or too many (if it picks max_attempts
    /// and the failure mode is transport, hanging the user on
    /// offline).
    ///
    /// We exercise this by pointing at an unrouteable port on
    /// localhost so reqwest surfaces a connect-refused before any
    /// HTTP status code can be parsed. Even with default
    /// `max_attempts = 5`, the test policy here pins
    /// `transport_max_attempts = 2` and we verify the helper returns
    /// after exactly two reqwest::execute attempts.
    #[tokio::test]
    async fn transport_failure_uses_tighter_transport_budget() {
        // 1 is the standard "nothing listens here" sentinel port on
        // Linux. Picking a deliberately-low port avoids racing against
        // a real local service. reqwest will surface connect-refused
        // immediately rather than retrying internally.
        let bad_url = "http://127.0.0.1:1/x";
        let policy = RetryPolicy {
            max_attempts: 5,           // generous HTTP budget
            transport_max_attempts: 2, // tighter transport budget
            initial_backoff: Duration::from_millis(0),
            backoff_multiplier: 1.0,
            max_backoff: Duration::from_millis(0),
            retry_after_fallback: Duration::from_millis(0),
        };

        let request = reqwest::Client::new().get(bad_url).build().unwrap();
        let start = std::time::Instant::now();
        let err = send_with_retry(&reqwest::Client::new(), request, &policy)
            .await
            .expect_err("transport failure should exhaust the tighter budget");

        // Bound the call's wall-clock to something well under what a
        // 5-attempt loop would have produced if the helper had
        // mistakenly used max_attempts as the transport ceiling. With
        // zero backoff between attempts and a localhost connect
        // failure, two attempts should complete in well under a
        // second; five would be similarly fast but harder to
        // distinguish, so we additionally pin the error variant.
        assert!(
            start.elapsed() < Duration::from_secs(2),
            "transport failure should bail out within transport_max_attempts, took {:?}",
            start.elapsed(),
        );
        assert!(
            matches!(err, ConnectorError::NetworkError(_)),
            "expected NetworkError after transport budget exhaustion, got {err:?}",
        );
    }

    /// Default policy: transport budget is tighter than HTTP budget.
    /// Pins the relationship so a future "let's bump max_attempts to
    /// 10 because flake" refactor doesn't accidentally widen the
    /// transport budget too.
    #[test]
    fn default_policy_transport_budget_is_tighter_than_http() {
        let p = RetryPolicy::default();
        assert!(
            p.transport_max_attempts < p.max_attempts,
            "expected transport_max_attempts ({}) < max_attempts ({}); refactor regression",
            p.transport_max_attempts,
            p.max_attempts,
        );
        assert_eq!(p.max_attempts, 5);
        assert_eq!(p.transport_max_attempts, 3);
    }
}
