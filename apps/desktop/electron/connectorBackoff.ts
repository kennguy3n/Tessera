/**
 * connector sync error resilience.
 *
 * Mirror of `tessera_connectors::failure_state` in TypeScript.
 * The Rust module is the canonical reference (and is exercised by
 * Rust-side unit tests in `failure_state::tests`), but the
 * production connector sync code lives in TypeScript
 * (`apps/desktop/electron/ipc/connectors/handlers.ts`), so the
 * policy decision — given a previous state and a freshly-observed
 * error, what should the next persisted state be? — is computed
 * here and the resulting tuple is written back via the bridge
 * (`bridgeRecordSourceSyncFailure` / `bridgeRecordSourceSyncSuccess`).
 *
 * The shape of the persisted state matches the Rust module
 * byte-for-byte so renderer code (and any future Rust-side
 * reader) sees the same JSON discriminator:
 *
 *     { "kind": "transient" | "permanent", "message": string }
 *
 * Why these values:
 *
 *  - `BASE_INTERVAL_MS = 2_000` — 2 seconds is well above human
 *    perception of "instant retry" so a transient hiccup doesn't
 *    hammer the provider, but still short enough that the
 *    "syncing…" UI never feels stuck.
 *
 *  - `MAX_INTERVAL_MS = 300_000` — 5 minutes is the upper cap so
 *    a long-running outage doesn't pile up retries that take
 *    hours to complete; once the user reopens the app the next
 *    retry happens promptly.
 *
 *  - `MULTIPLIER = 2.0` — doubling per attempt is the textbook
 *    exponential schedule.
 *
 *  - `JITTER_FRACTION = 0.25` — ±25% randomness around the
 *    computed interval prevents the thundering-herd pattern when
 *    many clients are retrying the same failing endpoint.
 *
 *  - `MAX_RETRIES_BEFORE_PERMANENT = 8` — covers
 *    `[2s, 4s, 8s, 16s, 32s, 64s, 128s, 256s]` cumulative ~8.5
 *    minutes (capped by MAX_INTERVAL after attempt 8 anyway). A
 *    failure that persists past 8 transient retries is treated
 *    as effectively permanent; the source row is flagged so the
 *    UI can prompt the user to re-authorise or investigate.
 *
 * These constants are deliberately NOT renderer-configurable —
 * tuning per-user would risk masking real failures behind
 * generous retries. The Rust reference module exposes the same
 * defaults via `SyncBackoffPolicy::default()`.
 */

import type { NativeBridge } from "./appState";

/**
 * Re-exported alias so call sites can import a stable name even
 * if `appState.ts` ever renames the interface.
 * surfaces both spellings (`NativeBridge`, the original; and
 * `TesseraBridge`, the convention used elsewhere in
 * docs / tests) to avoid churn across phases.
 */
export type TesseraBridge = NativeBridge;

/**
 * Policy constants. Kept as `as const` so a typo in a constant
 * value is a TS error rather than a silent number coercion.
 */
export const BACKOFF_POLICY = {
  baseIntervalMs: 2_000,
  maxIntervalMs: 300_000,
  multiplier: 2.0,
  jitterFraction: 0.25,
  maxRetriesBeforePermanent: 8,
} as const;

/**
 * Persisted error kind. JSON discriminator matches the Rust
 * `PersistedFailureKind` enum (snake_case via serde).
 *
 *  - `transient` — auto-recoverable: network blip, 429, 503,
 *    socket timeout, refresh-token race. The sync will be
 *    re-attempted automatically after the next backoff interval.
 *  - `permanent` — needs user intervention: 401, 403, 404,
 *    invalid config, revoked OAuth token. The sticky
 *    `failedPermanently` flag is set, the UI surfaces a
 *    "re-authorize required" badge, and retries stop until the
 *    user takes action.
 */
export type FailureKind = "transient" | "permanent";

/**
 * JSON payload persisted in the `last_sync_error` column.
 * Identical shape to `tessera_connectors::PersistedSyncError`.
 */
export interface PersistedSyncError {
  kind: FailureKind;
  message: string;
}

/**
 * In-memory shape mirroring `tessera_connectors::SyncFailureState`.
 * The fields map 1:1 to the three new columns added
 * Task 11 (`last_sync_error`, `retry_count`, `failed_permanently`).
 */
export interface SyncFailureState {
  lastError: PersistedSyncError | null;
  retryCount: number;
  failedPermanently: boolean;
}

/**
 * Default "pristine" state used as a fallback when a row has
 * never failed before.
 */
export function emptySyncFailureState(): SyncFailureState {
  return {
    lastError: null,
    retryCount: 0,
    failedPermanently: false,
  };
}

/**
 * Compute the next persisted state from `prev` after observing a
 * freshly-classified `(kind, message)` error.
 *
 * Rules (must match `SyncFailureState::record_failure` in Rust):
 *
 *   1. A `permanent` error always flips `failedPermanently = true`
 *      immediately, regardless of retry count. The user MUST take
 *      action (re-authorise, fix config) to clear it.
 *   2. A `transient` error bumps `retryCount` by 1 and keeps the
 *      sticky bit at its previous value, UNLESS retryCount has
 *      now reached `MAX_RETRIES_BEFORE_PERMANENT`, in which case
 *      the sticky bit flips on too (effectively-permanent after
 *      8 consecutive transient failures).
 *   3. `lastError` is always replaced with the new error.
 *
 * Pure function — does not touch the bridge.
 */
export function applyFailureToState(
  prev: SyncFailureState,
  error: PersistedSyncError,
): SyncFailureState {
  if (error.kind === "permanent") {
    return {
      lastError: error,
      retryCount: prev.retryCount,
      failedPermanently: true,
    };
  }
  const nextRetry = prev.retryCount + 1;
  const flipPermanent = nextRetry >= BACKOFF_POLICY.maxRetriesBeforePermanent;
  return {
    lastError: error,
    retryCount: nextRetry,
    failedPermanently: prev.failedPermanently || flipPermanent,
  };
}

/**
 * Deterministic (no-jitter) backoff interval for `attempt`
 * (1-indexed). Returns 0 for attempt 0 — "no failures yet, retry
 * immediately when the user clicks Sync again".
 *
 *   attempt | interval
 *      1    |   2 s
 *      2    |   4 s
 *      3    |   8 s
 *      4    |  16 s
 *      5    |  32 s
 *      6    |  64 s
 *      7    | 128 s
 *      8    | 256 s
 *      9+   | 300 s (clamped)
 */
export function deterministicBackoffMs(attempt: number): number {
  if (attempt <= 0) return 0;
  // Use `Math.pow` and clamp; bias against using `**` because the
  // exponent here is a small integer and `**` semantics on JS
  // numbers can produce platform-different rounding for large
  // exponents (n/a for our values but worth pinning).
  const raw =
    BACKOFF_POLICY.baseIntervalMs *
    Math.pow(BACKOFF_POLICY.multiplier, attempt - 1);
  return Math.min(raw, BACKOFF_POLICY.maxIntervalMs);
}

/**
 * Apply ±`jitterFraction` randomness to `intervalMs`. `randUnit`
 * is a `[0, 1)` value, which the caller usually obtains from
 * `Math.random()` — passed in as a parameter so tests can pin a
 * deterministic value without monkey-patching Math.random.
 *
 * Maps `randUnit` from `[0, 1)` to `[-jitterFraction, +jitterFraction]`
 * and applies it multiplicatively. Clamps to >= 0 to defend
 * against pathological inputs (negative or NaN `randUnit`).
 */
export function applyJitter(intervalMs: number, randUnit: number): number {
  // The current policy uses a non-zero jitter fraction, but the
  // formula is implemented to fall back to a no-op when the
  // fraction is 0 (so a future policy tweak can disable jitter
  // safely). Skip the check at the type level since the literal
  // 0.25 cannot equal 0 — TypeScript flags that as dead code.
  const safeRand = Number.isFinite(randUnit)
    ? Math.max(0, Math.min(randUnit, 1))
    : 0;
  const offset = (safeRand * 2 - 1) * BACKOFF_POLICY.jitterFraction;
  return Math.max(0, intervalMs * (1 + offset));
}

/**
 * Convenience: jittered backoff for `attempt` using
 * `Math.random()` as the entropy source.
 */
export function nextBackoffMs(attempt: number): number {
  return applyJitter(deterministicBackoffMs(attempt), Math.random());
}

/**
 * Read the persisted state for `sourceId` via the bridge,
 * parsing the JSON-encoded `last_sync_error` column back into a
 * structured `PersistedSyncError`. A malformed JSON column is
 * treated as `lastError = null` rather than throwing — the
 * persistence layer should never corrupt this column, but if a
 * future code path does, the renderer's source-health UI should
 * degrade gracefully rather than 500.
 */
export function loadSyncFailureState(
  bridge: TesseraBridge,
  sourceId: string,
): SyncFailureState {
  const raw = bridge.bridgeGetSourceSyncFailureState(sourceId);
  let lastError: PersistedSyncError | null = null;
  if (raw.lastErrorJson != null) {
    try {
      const parsed = JSON.parse(raw.lastErrorJson) as unknown;
      if (
        parsed != null &&
        typeof parsed === "object" &&
        "kind" in parsed &&
        "message" in parsed
      ) {
        const candidate = parsed as { kind: unknown; message: unknown };
        if (
          (candidate.kind === "transient" || candidate.kind === "permanent") &&
          typeof candidate.message === "string"
        ) {
          lastError = {
            kind: candidate.kind,
            message: candidate.message,
          };
        }
      }
    } catch {
      // Fall through to null — see rustdoc above.
    }
  }
  return {
    lastError,
    retryCount: raw.retryCount,
    failedPermanently: raw.failedPermanently,
  };
}

/**
 * Persist `state` for `sourceId` via the bridge. The bridge's
 * column write is atomic across the three columns so a
 * concurrent reader can never observe a half-written state.
 */
export function saveSyncFailureState(
  bridge: TesseraBridge,
  sourceId: string,
  state: SyncFailureState,
): void {
  const json =
    state.lastError == null
      ? "{}"
      : JSON.stringify({
          kind: state.lastError.kind,
          message: state.lastError.message,
        });
  bridge.bridgeRecordSourceSyncFailure(
    sourceId,
    json,
    state.retryCount,
    state.failedPermanently,
  );
}

/**
 * Convenience: clear the failure state on success. Routes
 * through the bridge's `bridgeRecordSourceSyncSuccess` rather
 * than calling `saveSyncFailureState(empty)` so the
 * SQL-statement difference (NULL vs `{}` string) is preserved
 * and visible in the audit log.
 */
export function clearSyncFailureState(
  bridge: TesseraBridge,
  sourceId: string,
): void {
  bridge.bridgeRecordSourceSyncSuccess(sourceId);
}

/**
 * End-to-end: classify `err` as `(kind, message)`, read the
 * previous state, compute the new one with the policy, persist
 * it back. Returns the new state so the caller can surface it in
 * the same handler turn (e.g. to schedule the next retry).
 *
 * `classifier` is supplied by the caller because the connectors
 * layer already has `isNetworkError`, `NotConnectedError`,
 * `RateLimitError`, etc. — the policy here doesn't need to know
 * about those types, only the final boolean classification.
 */
export function recordConnectorFailure(
  bridge: TesseraBridge,
  sourceId: string,
  err: unknown,
  classifier: (e: unknown) => FailureKind,
): SyncFailureState {
  const message = errorMessage(err);
  const next = applyFailureToState(
    loadSyncFailureState(bridge, sourceId),
    { kind: classifier(err), message },
  );
  saveSyncFailureState(bridge, sourceId, next);
  return next;
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "string") return err;
  try {
    return JSON.stringify(err);
  } catch {
    return String(err);
  }
}
