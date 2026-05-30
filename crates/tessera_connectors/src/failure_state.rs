//! Phase 15 Task 11: per-source sync-failure resilience state.
//!
//! This module encodes the *between-sync-attempt* backoff schedule
//! and the persistent failure-counter that the connector sync loop
//! uses to decide:
//!
//!   1. When to schedule the next retry of a failing source
//!      (exponential backoff with jitter, capped at 5 minutes).
//!   2. When to give up and mark a source as
//!      `failed_permanently = true` so the renderer can surface a
//!      "re-authorize required" prompt instead of silently
//!      hammering the provider.
//!
//! This is **distinct from** the per-HTTP-request retry burst in
//! [`crate::retry`]. That module handles a single API call's 5xx /
//! 429 / transport-error recovery within the same sync attempt
//! (typically completes inside 30 seconds and is invisible to the
//! user). This module handles the next-level-up question — "the
//! whole sync attempt just failed, when should we try again?" —
//! which is user-visible because the UI shows "Syncing… last
//! synced 5 minutes ago" between attempts.
//!
//! ## Backoff parameters
//!
//! The defaults match the Phase 15 Task 11 specification:
//!
//!   * **Base interval**: 2 seconds. The first retry after a
//!     transient failure waits ~2s. This is short enough that a
//!     genuinely transient blip (DNS hiccup, momentary 503) is
//!     usually resolved by the time we re-attempt.
//!   * **Maximum interval**: 5 minutes. Beyond this we accept the
//!     "user must manually re-trigger" cost rather than burning
//!     more provider quota on what is increasingly likely a
//!     permanent failure.
//!   * **Multiplier**: 2.0. Doubles each attempt: 2s → 4s → 8s →
//!     16s → 32s → 64s → 128s → 256s → 300s (capped).
//!   * **Jitter**: ±25% of the computed backoff, uniformly
//!     distributed. Prevents the thundering-herd effect when
//!     many sources fail simultaneously (e.g. provider outage
//!     resolves and every Jira source retries at the exact same
//!     second).
//!   * **Max retries before permanent**: 8 attempts (so the
//!     backoff schedule reaches the 5-minute cap before we give
//!     up). After 8 transient failures, mark permanent. Any
//!     `Permanent`-classified failure (auth, 404) skips the
//!     counter and marks the source permanent immediately.
//!
//! ## On-disk shape
//!
//! [`SyncFailureState`] is the canonical Rust shape; the SourceStore
//! persists `last_sync_error` (JSON-encoded), `retry_count`
//! (INTEGER), and `failed_permanently` (INTEGER 0/1) on the
//! `sources` table. A successful sync clears all three back to
//! their fresh-install defaults.

use std::time::Duration;

use serde::{Deserialize, Serialize};

use crate::error::{ConnectorError, FailureKind};

/// Default backoff parameters per the Task 11 spec.
const DEFAULT_BASE_INTERVAL_SECS: u64 = 2;
const DEFAULT_MAX_INTERVAL_SECS: u64 = 5 * 60;
const DEFAULT_BACKOFF_MULTIPLIER: f64 = 2.0;
const DEFAULT_JITTER_FRACTION: f64 = 0.25;
const DEFAULT_MAX_RETRIES_BEFORE_PERMANENT: u32 = 8;

/// Parameters that govern the inter-attempt sync retry schedule.
///
/// Constructed via [`Self::default`] in production code. Tests
/// override to compress the schedule (zero jitter, tiny base, low
/// max-retries) so they don't have to sleep through real waits.
#[derive(Debug, Clone, Copy)]
pub struct SyncBackoffPolicy {
    /// Initial wait after the first transient failure.
    pub base_interval: Duration,
    /// Cap on a single backoff interval.
    pub max_interval: Duration,
    /// Multiplier applied to `base_interval` on each consecutive
    /// retry — 2.0 means 2s → 4s → 8s → ….
    pub multiplier: f64,
    /// Jitter as a fraction of the computed interval. 0.25 means
    /// the actual wait is uniformly distributed in
    /// `[interval * (1 - jitter), interval * (1 + jitter)]`.
    /// Pass 0.0 to disable jitter (tests).
    pub jitter_fraction: f64,
    /// Number of consecutive transient failures after which the
    /// source is marked permanently failed (regardless of
    /// classification). Prevents an infinite-retry loop on a
    /// genuinely broken provider that never returns a Permanent
    /// error code.
    pub max_retries_before_permanent: u32,
}

impl Default for SyncBackoffPolicy {
    fn default() -> Self {
        Self {
            base_interval: Duration::from_secs(DEFAULT_BASE_INTERVAL_SECS),
            max_interval: Duration::from_secs(DEFAULT_MAX_INTERVAL_SECS),
            multiplier: DEFAULT_BACKOFF_MULTIPLIER,
            jitter_fraction: DEFAULT_JITTER_FRACTION,
            max_retries_before_permanent: DEFAULT_MAX_RETRIES_BEFORE_PERMANENT,
        }
    }
}

impl SyncBackoffPolicy {
    /// Test-only policy: tiny intervals + no jitter so unit tests
    /// can assert exact backoff values without flakiness.
    pub fn aggressive_for_tests() -> Self {
        Self {
            base_interval: Duration::from_millis(10),
            max_interval: Duration::from_millis(100),
            multiplier: 2.0,
            jitter_fraction: 0.0,
            max_retries_before_permanent: 4,
        }
    }

    /// Compute the deterministic (un-jittered) backoff for the
    /// `attempt`-th consecutive failure. `attempt = 1` is the
    /// wait after the first failure, `attempt = 2` is the wait
    /// after the second consecutive failure, and so on.
    ///
    /// Saturated at `max_interval` so an exponential explosion
    /// can't overflow `Duration`'s u64 millisecond representation
    /// and can't surprise the user with a multi-hour wait.
    pub fn deterministic_backoff_for(&self, attempt: u32) -> Duration {
        if attempt == 0 {
            return Duration::ZERO;
        }
        let exponent = attempt.saturating_sub(1) as i32;
        // `f64::powi` is well-defined for negative + zero exponents;
        // a non-negative exponent on a non-negative base never
        // produces NaN, so we don't need to guard for it.
        let scale = self.multiplier.powi(exponent);
        let base_millis = self.base_interval.as_millis() as f64;
        let millis = base_millis * scale;
        let capped = millis.min(self.max_interval.as_millis() as f64);
        Duration::from_millis(capped as u64)
    }

    /// Apply jitter to a deterministic backoff. The result is
    /// uniformly distributed in `[interval * (1 - jitter),
    /// interval * (1 + jitter)]`. Caller-supplied `rand_unit`
    /// must be a uniformly-distributed f64 in `[0.0, 1.0)` — this
    /// keeps the function pure and deterministic for tests
    /// without pulling in the `rand` crate as a hard dependency.
    pub fn apply_jitter(&self, interval: Duration, rand_unit: f64) -> Duration {
        if self.jitter_fraction <= 0.0 {
            return interval;
        }
        let interval_millis = interval.as_millis() as f64;
        // Map [0, 1) -> [-jitter_fraction, +jitter_fraction).
        let signed_offset = (rand_unit * 2.0 - 1.0) * self.jitter_fraction;
        let jittered = interval_millis * (1.0 + signed_offset);
        // Clamp to [0, max_interval * (1 + jitter_fraction)] so a
        // pathological caller-supplied rand_unit can't produce a
        // negative duration or exceed the documented cap.
        let max_with_jitter = self.max_interval.as_millis() as f64 * (1.0 + self.jitter_fraction);
        let clamped = jittered.clamp(0.0, max_with_jitter);
        Duration::from_millis(clamped as u64)
    }
}

/// Persistent failure-state attached to one source row.
///
/// Round-trips through SQLite as three columns:
///
///   * `last_sync_error` — JSON-serialised [`PersistedSyncError`]
///     (kind discriminator + message). NULL when the source has
///     never failed or the last attempt succeeded.
///   * `retry_count` — INTEGER; consecutive transient failures
///     since the last successful sync. Resets to 0 on success.
///   * `failed_permanently` — INTEGER 0/1; sticky bit set when a
///     Permanent failure is observed OR when `retry_count`
///     exceeds `SyncBackoffPolicy::max_retries_before_permanent`.
///     Only the user can clear this (via "Retry now" /
///     "Re-authorize") so we never silently resume hammering a
///     broken provider.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct SyncFailureState {
    pub last_error: Option<PersistedSyncError>,
    pub retry_count: u32,
    pub failed_permanently: bool,
}

impl Default for SyncFailureState {
    fn default() -> Self {
        Self {
            last_error: None,
            retry_count: 0,
            failed_permanently: false,
        }
    }
}

/// On-disk shape of a persisted sync error. Captures enough
/// structured detail that the renderer can render an
/// internationalised, actionable status badge ("Permission denied —
/// re-authorize required") rather than just a raw `Display` string.
///
/// `kind` is the `FailureKind` discriminant so the renderer can
/// branch on it without re-classifying. `message` is the human-
/// readable detail from the original error's `Display`. We do NOT
/// persist the underlying connector-specific URL, request id, or
/// provider response body — that data is per-attempt and would
/// only confuse a user looking at a 4-hour-old failure.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq, Eq)]
pub struct PersistedSyncError {
    pub kind: PersistedFailureKind,
    pub message: String,
}

#[derive(Debug, Clone, Copy, Serialize, Deserialize, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum PersistedFailureKind {
    Transient,
    Permanent,
}

impl From<FailureKind> for PersistedFailureKind {
    fn from(value: FailureKind) -> Self {
        match value {
            FailureKind::Transient => PersistedFailureKind::Transient,
            FailureKind::Permanent => PersistedFailureKind::Permanent,
        }
    }
}

impl SyncFailureState {
    /// Apply a sync failure to the current state. Returns the
    /// updated state — callers persist the return value to the
    /// `sources` row.
    ///
    /// Rules:
    ///
    ///   * `Permanent`-classified failure → set
    ///     `failed_permanently = true` immediately (no further
    ///     retries) and stamp the error.
    ///   * `Transient`-classified failure → bump `retry_count`,
    ///     stamp the error, and only flip `failed_permanently` if
    ///     the new count exceeds the policy threshold.
    ///   * `failed_permanently` is sticky — once set, it does NOT
    ///     clear except via `record_success` (which a manual
    ///     "retry now" triggers).
    pub fn record_failure(&self, error: &ConnectorError, policy: &SyncBackoffPolicy) -> Self {
        let kind = error.failure_kind();
        let persisted = PersistedSyncError {
            kind: kind.into(),
            message: error.to_string(),
        };
        match kind {
            // Permanent failures do NOT consume a retry slot — the
            // sticky bit is flipped immediately and retries stop
            // until the user takes action (re-authorise, fix
            // config). Keeping `retry_count` unchanged means the
            // value continues to reflect "how many transient
            // failures in a row" rather than mixing transient and
            // permanent counts. This matches the TS-side mirror
            // (`connectorBackoff.ts::applyFailureToState`) exactly
            // so both sides agree on what each persisted state
            // means.
            FailureKind::Permanent => Self {
                last_error: Some(persisted),
                retry_count: self.retry_count,
                failed_permanently: true,
            },
            FailureKind::Transient => {
                let next_retry_count = self.retry_count.saturating_add(1);
                // `>=` so the threshold value itself trips the
                // sticky bit (8 transient failures => permanent,
                // not 9). Matches the TS mirror's documented
                // behaviour: `MAX_RETRIES_BEFORE_PERMANENT = 8`
                // covers exactly the cumulative
                // [2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s] schedule
                // listed in `connectorBackoff.ts`.
                let flip = next_retry_count >= policy.max_retries_before_permanent;
                Self {
                    last_error: Some(persisted),
                    retry_count: next_retry_count,
                    failed_permanently: self.failed_permanently || flip,
                }
            }
        }
    }

    /// Apply a sync success to the current state. Returns the
    /// fresh, all-clear state. Note: this DOES clear
    /// `failed_permanently` — a successful sync proves the
    /// source is back online and the user should not have to
    /// dismiss a stale "permanently failed" badge after a manual
    /// re-authorize successfully re-syncs.
    pub fn record_success(&self) -> Self {
        Self::default()
    }

    /// Compute the deterministic backoff before the next retry,
    /// given the current `retry_count`. The caller adds jitter via
    /// `policy.apply_jitter` separately so test code can pass a
    /// deterministic `rand_unit`.
    ///
    /// Returns `Duration::ZERO` when there has been no failure
    /// yet (defensive: a caller computing "next retry" before any
    /// failure is logged should not silently wait).
    pub fn next_backoff(&self, policy: &SyncBackoffPolicy) -> Duration {
        policy.deterministic_backoff_for(self.retry_count)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn default_policy_matches_phase15_task11_spec() {
        let p = SyncBackoffPolicy::default();
        assert_eq!(p.base_interval, Duration::from_secs(2));
        assert_eq!(p.max_interval, Duration::from_secs(5 * 60));
        assert!((p.multiplier - 2.0).abs() < f64::EPSILON);
        assert!((p.jitter_fraction - 0.25).abs() < f64::EPSILON);
        assert_eq!(p.max_retries_before_permanent, 8);
    }

    #[test]
    fn deterministic_backoff_doubles_then_caps_at_max() {
        let p = SyncBackoffPolicy::default();
        // attempt 0 → zero (nothing has failed yet)
        assert_eq!(p.deterministic_backoff_for(0), Duration::ZERO);
        // attempt 1 → 2s
        assert_eq!(p.deterministic_backoff_for(1), Duration::from_secs(2));
        // attempt 2 → 4s
        assert_eq!(p.deterministic_backoff_for(2), Duration::from_secs(4));
        // attempt 3 → 8s
        assert_eq!(p.deterministic_backoff_for(3), Duration::from_secs(8));
        // attempt 8 → 256s (under cap)
        assert_eq!(p.deterministic_backoff_for(8), Duration::from_secs(256));
        // attempt 9 → would be 512s; cap at 5 min = 300s.
        assert_eq!(p.deterministic_backoff_for(9), Duration::from_secs(300));
        // arbitrarily large attempts also stay at the cap.
        assert_eq!(p.deterministic_backoff_for(99), Duration::from_secs(300));
    }

    #[test]
    fn jitter_centered_on_interval_and_bounded_at_edges() {
        let p = SyncBackoffPolicy::default();
        let interval = Duration::from_secs(10);
        // rand_unit = 0.5 → zero offset → exact interval.
        assert_eq!(p.apply_jitter(interval, 0.5), Duration::from_secs(10));
        // rand_unit = 0.0 → -jitter_fraction → interval * 0.75.
        let lower = p.apply_jitter(interval, 0.0);
        assert!(lower >= Duration::from_millis(7_500));
        assert!(lower <= Duration::from_millis(7_501));
        // rand_unit ≈ 1.0 → +jitter_fraction → interval * 1.25.
        let upper = p.apply_jitter(interval, 0.9999);
        assert!(upper >= Duration::from_millis(12_499));
        assert!(upper <= Duration::from_millis(12_500));
    }

    #[test]
    fn jitter_clamps_negative_and_overflow_to_documented_range() {
        let p = SyncBackoffPolicy::default();
        // Pathological caller passes a value outside [0,1). Even
        // so, we clamp the output to non-negative and ≤ max with jitter.
        assert!(p.apply_jitter(Duration::from_secs(1), -100.0) >= Duration::ZERO);
        let pathological_upper = p.apply_jitter(Duration::from_secs(100_000), 100.0);
        let expected_cap = Duration::from_millis(
            (p.max_interval.as_millis() as f64 * (1.0 + p.jitter_fraction)) as u64,
        );
        assert!(pathological_upper <= expected_cap);
    }

    #[test]
    fn jitter_disabled_when_fraction_is_zero() {
        let p = SyncBackoffPolicy::aggressive_for_tests();
        // jitter_fraction = 0.0 — every rand_unit returns the exact
        // interval, no perturbation.
        for r in [0.0, 0.25, 0.5, 0.75, 0.999] {
            assert_eq!(p.apply_jitter(Duration::from_millis(42), r), Duration::from_millis(42));
        }
    }

    #[test]
    fn record_failure_permanent_flips_sticky_bit_immediately() {
        let state = SyncFailureState::default();
        let policy = SyncBackoffPolicy::default();
        let err = ConnectorError::AuthenticationFailed("expired refresh token".into());
        let next = state.record_failure(&err, &policy);
        // Permanent failures do NOT bump retry_count — the count
        // tracks transient retries only. See `record_failure` doc
        // and the TS mirror `connectorBackoff.ts::applyFailureToState`.
        assert_eq!(next.retry_count, 0);
        assert!(next.failed_permanently);
        let stamped = next.last_error.as_ref().expect("error must be stamped");
        assert_eq!(stamped.kind, PersistedFailureKind::Permanent);
        assert!(stamped.message.contains("expired refresh token"));
    }

    #[test]
    fn record_failure_transient_bumps_counter_without_marking_permanent() {
        let state = SyncFailureState::default();
        let policy = SyncBackoffPolicy::default();
        let err = ConnectorError::NetworkError("connection timed out".into());
        let next = state.record_failure(&err, &policy);
        assert_eq!(next.retry_count, 1);
        assert!(!next.failed_permanently);
        let stamped = next.last_error.as_ref().unwrap();
        assert_eq!(stamped.kind, PersistedFailureKind::Transient);
    }

    #[test]
    fn record_failure_transient_flips_permanent_at_threshold() {
        // The Nth transient failure (where N = max_retries_before_permanent)
        // flips the sticky bit. `>=` semantics aligned with the TS mirror.
        let policy = SyncBackoffPolicy::default();
        let mut state = SyncFailureState::default();
        let err = ConnectorError::NetworkError("flaky network".into());
        for i in 1..=policy.max_retries_before_permanent {
            state = state.record_failure(&err, &policy);
            // Permanent must remain false UNTIL we hit the threshold
            // value, then trip on the threshold itself.
            if i < policy.max_retries_before_permanent {
                assert!(
                    !state.failed_permanently,
                    "should NOT be permanent after only {i} transient failures (threshold = {})",
                    policy.max_retries_before_permanent,
                );
            } else {
                assert!(
                    state.failed_permanently,
                    "should flip permanent ON the {i}-th failure (threshold = {})",
                    policy.max_retries_before_permanent,
                );
            }
        }
        assert_eq!(state.retry_count, policy.max_retries_before_permanent);
    }

    #[test]
    fn record_success_clears_everything_including_permanent_bit() {
        let state = SyncFailureState {
            last_error: Some(PersistedSyncError {
                kind: PersistedFailureKind::Permanent,
                message: "x".into(),
            }),
            retry_count: 42,
            failed_permanently: true,
        };
        let after = state.record_success();
        assert!(after.last_error.is_none());
        assert_eq!(after.retry_count, 0);
        assert!(!after.failed_permanently);
    }

    #[test]
    fn next_backoff_returns_zero_before_any_failure_logged() {
        let state = SyncFailureState::default();
        let policy = SyncBackoffPolicy::default();
        assert_eq!(state.next_backoff(&policy), Duration::ZERO);
    }

    #[test]
    fn json_round_trip_preserves_failure_state() {
        let original = SyncFailureState {
            last_error: Some(PersistedSyncError {
                kind: PersistedFailureKind::Permanent,
                message: "Permission denied: missing scope drive.readonly".into(),
            }),
            retry_count: 5,
            failed_permanently: true,
        };
        let json = serde_json::to_string(&original).expect("serialise");
        let parsed: SyncFailureState = serde_json::from_str(&json).expect("deserialise");
        assert_eq!(original, parsed);
    }
}
