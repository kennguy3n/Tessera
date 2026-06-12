/**
 * Unified connector IPC handlers for all six providers.
 *
 * Replaces the hard-coded `if (provider !== 'google_drive')` path in
 * the legacy `ipc.ts` with a single dispatch table keyed by provider
 * id. Each provider has:
 *
 *   - An OAuth config in `providerOAuth.PROVIDER_OAUTH_CONFIGS`.
 *   - A `sync(ctx)` function that pulls items into the local index.
 *   - A `disconnect(ctx)` function that removes the local cache +
 *     unhooks every source the connector created.
 *
 * `connectors:authenticate` runs the OAuth flow + persists tokens.
 * `connectors:sync`         dispatches to the per-provider sync impl.
 * `connectors:disconnect`   revokes the tokens, deletes the cache,
 *                            and removes the matching sources from
 *                            the index.
 * `connectors:status`       reports `{ connected, status, offline }`
 *                            so the UI can render the Offline badge.
 *
 * Additional guarantees layered on top of the dispatch table:
 *
 *   - Rate-limit `connectors:authenticate` to 1 / 5s per provider.
 *   - Rate-limit `connectors:sync` to 1 / 30s per provider.
 *   - Validate provider id against the registry on every call.
 *   - Surface a normalised "offline" status when fetch throws an
 *     EAI_AGAIN/ENOTFOUND/ETIMEDOUT.
 *   - All disconnect paths now run per-provider cleanup (not the
 *     gdrive-only path that left orphan local files for everyone
 *     else).
 */

import { idempotentHandle } from "../register";

import type { IpcContext } from "../context";
import { assertProvider, assertString } from "../validate";
import { RateLimitError } from "../rateLimiter";
import {
  applyFailureToState,
  emptySyncFailureState,
  loadSyncFailureState,
  saveSyncFailureState,
  clearSyncFailureState,
  type FailureKind,
  type SyncFailureState,
} from "../../connectorBackoff";
import {
  exchangeAuthorizationCode,
  generatePkcePair,
  getProviderOAuthConfig,
  getRedirectUri,
  getRedirectUriMap,
  refreshProviderToken,
  revokeProviderToken,
  runRedirectServer,
  type ProviderId,
} from "./providerOAuth";
import {
  MissingScopeError,
  assertScopesGranted,
  compareScopes,
  getRequestedScopes,
  type ScopeComparison,
} from "../../oauthScope";
import { ConnectorSyncQueue, SYNC_CONCURRENCY } from "./syncQueue";
import { loadConfig } from "../../config";
import { disconnectOneDrive, syncOneDrive } from "./onedrive";
import { disconnectNotion, syncNotion } from "./notion";
import { disconnectJira, syncJira } from "./jira";
import { disconnectConfluence, syncConfluence } from "./confluence";
import { disconnectFigma, syncFigma } from "./figma";
import { syncGoogleDrive, disconnectGoogleDrive } from "./gdrive";
import {
  runV2Sync,
  readV2State,
  readV2Pending,
  writeV2State,
  v2BridgeAvailable,
  disconnectV2Provider,
  type V2NativeBridge,
} from "./connectorsV2";

/**
 * The six providers that retain a hand-rolled in-process
 * (`tessera_connectors`-style) TS sync impl. The substrate-only
 * providers (HubSpot, Slack, Email, GitHub, Dropbox, Box, Linear,
 * Miro) are deliberately absent: they have no legacy fallback and are
 * reachable only through the v2 `connector_framework` bridge.
 */
type LegacyProviderId =
  | "google_drive"
  | "onedrive"
  | "notion"
  | "jira"
  | "confluence"
  | "figma";

// `satisfies` pins every id to a valid `LegacyProviderId` at compile
// time (a typo or stray provider here is a build error). The Set is
// typed `ReadonlySet<ProviderId>` — not `Set<LegacyProviderId>` — so
// callers can probe membership with a full `ProviderId`, since
// `Set<T>.has` requires its argument to be `T`.
const LEGACY_PROVIDER_IDS = [
  "google_drive",
  "onedrive",
  "notion",
  "jira",
  "confluence",
  "figma",
] as const satisfies readonly LegacyProviderId[];

const LEGACY_PROVIDERS: ReadonlySet<ProviderId> = new Set(LEGACY_PROVIDER_IDS);

/**
 * Whether the native addon reports `provider` as a feature-enabled v2
 * connector. Defensive: a `bridgeConnectorsV2Supported` that throws
 * (older/partial addon) is treated as "not supported" so the caller
 * falls back rather than crashing the sync.
 */
function isV2Supported(bridge: V2NativeBridge, provider: ProviderId): boolean {
  try {
    return bridge.bridgeConnectorsV2Supported?.(provider) ?? false;
  } catch {
    return false;
  }
}

/**
 * Drive one provider sync through the v2 `connector_framework` bridge:
 * load the keychain token, replay the persisted cursor, ingest fetched
 * documents into the local index, and persist the new cursor. Throws
 * `NotConnectedError` when the provider isn't authenticated (matching
 * the legacy path's precondition).
 */
async function runProviderV2Sync(
  ctx: IpcContext,
  provider: ProviderId,
  userDataDir: string,
): Promise<ConnectorSyncResult> {
  // Refresh-before-sync: unlike the legacy connectors, which call
  // `getValidAccessToken` at the top of every iteration of their hot
  // loop, the v2 path hands the Rust `connector_framework` a single
  // `OAuth2Token` snapshot for the whole `initial_sync`/`incremental_sync`
  // run — the framework does not refresh mid-call. To match the legacy
  // path's resilience we proactively refresh here: `getValidAccessToken`
  // is a no-op when >60s of lifetime remains and otherwise performs the
  // refresh-token exchange AND persists the rotated tokens back to the
  // vault. Reading `getTokens` *after* this guarantees the wire token we
  // build below starts the run with a full (~1h) lifetime, so a bounded
  // single run (capped by the Rust `max_fetch` budget) will not expire
  // part-way through. A pathological single run that itself outlives the
  // token would still need framework-level 401 refresh; that is bounded
  // by `max_fetch` and tracked as a substrate enhancement.
  await getValidAccessToken(ctx, provider);
  const tokens = ctx.tokenVault.getTokens(provider);
  if (!tokens) {
    throw new NotConnectedError(
      `${provider} is not connected — authenticate first`,
    );
  }
  const nativeBridge = ctx.requireBridge();
  const { result, nextCursor, warnings, pendingFetch } = await runV2Sync({
    provider,
    bridge: nativeBridge,
    hooks: bridgeHooks(ctx),
    tokens,
    userDataDir,
    stateJson: await readV2State(userDataDir, provider),
    // Deferred-fetch backlog from the previous run: documents whose
    // bodies the `max_fetch` budget could not materialise yet. The Rust
    // side drains these first, so a source larger than one budget is
    // indexed in full across successive syncs instead of losing the
    // overflow as the cursor advances past it.
    pending: await readV2Pending(userDataDir, provider),
    // Single-tenant desktop host: let the Rust side derive a stable
    // deterministic per-provider scope (see `parse_scope`).
    scopeId: null,
  });
  await writeV2State(userDataDir, provider, nextCursor, pendingFetch);
  if (warnings.length > 0) {
    ctx.log.warn("v2 connector sync produced non-fatal warnings", {
      provider,
      count: warnings.length,
      sample: warnings.slice(0, 5),
    });
  }
  if (pendingFetch.length > 0) {
    ctx.log.info("v2 connector sync deferred document bodies for retry", {
      provider,
      pending: pendingFetch.length,
    });
  }
  return result;
}

export interface ConnectorStatusInfo {
  provider: string;
  connected: boolean;
  status: string;
  /** True if the last operation hit a network failure. */
  offline?: boolean;
}

/**
 * explicit allowlist of providers whose
 * OAuth config legitimately uses `scope: ""`.
 *
 * Notion's "internal integration" token is bound to a workspace at
 * install time (the user selects which pages the integration can
 * access via the consent screen), and the OAuth response does NOT
 * include a `scope` field. Every other supported provider returns
 * a non-empty scope set, so an empty `scope` config for any
 * non-Notion provider is a misconfiguration that would silently
 * disable scope-narrowing checks. `runConnectorSync` logs a
 * structured warning on every sync for such providers so the gap
 * is loud rather than silent.
 *
 * Adding a new scope-less provider here should be paired with a
 * code-review note explaining WHY the provider is exempt (e.g.
 * "ProviderX uses an admin-installed app with workspace-bound
 * permissions; the OAuth token has no per-request scope dimension").
 */
const SCOPELESS_PROVIDERS = new Set<ProviderId>(["notion"]);

interface BridgeHooks {
  addLocalFile(localPath: string): { id: string; path: string };
  reindexSource(sourceId: string): void;
  removeSource(sourceId: string): void;
  listSources(): Array<{ id: string; path: string }>;
}

function bridgeHooks(ctx: IpcContext): BridgeHooks {
  return {
    addLocalFile: (p) => {
      const source = ctx.requireBridge().bridgeAddLocalFile(p);
      return { id: source.id, path: source.path };
    },
    reindexSource: (id) => {
      ctx.requireBridge().bridgeReindexSource(id);
    },
    removeSource: (id) => {
      ctx.requireBridge().bridgeRemoveSource(id);
    },
    listSources: () =>
      ctx.requireBridge().bridgeListSources().map((s) => ({ id: s.id, path: s.path })),
  };
}

/**
 * Best-effort audit helper used by every `connectors:*` handler.
 *
 * The audit pass-throughs on the bridge (`bridgeLogConnector*`) are
 * defined as no-throw on the Rust side — they swallow audit-store
 * write failures and return `Ok(())`. We still wrap each call in a
 * `try ... catch` here for two independent defence-in-depth
 * reasons:
 *
 *   1. The bridge itself may not be initialised yet — the Block-C
 *      boot sequence orders `registerIpcHandlers()` BEFORE
 *      `initAppState()`, so an audit call from `connectors:status`
 *      that fires during the brief window after IPC registration
 *      but before bridge init would throw "Native bridge not
 *      available" out of `ctx.requireBridge()`.
 *   2. An audit failure must never block the user-visible action.
 *      The connector flow has already committed at the point we
 *      log; rolling back would lose the user's work.
 *
 * The handler logs the audit failure via `ctx.log.warn` so an
 * operator can diagnose a chronically-failing audit pipeline
 * without it manifesting as a user-facing error.
 */
function safeAudit(ctx: IpcContext, fn: (b: ReturnType<IpcContext["requireBridge"]>) => void): void {
  try {
    fn(ctx.requireBridge());
  } catch (err) {
    ctx.log.warn("audit log failed (continuing)", {
      error: (err as Error).message,
    });
  }
}

/**
 * maps a `ProviderId` (the OAuth-layer label
 * used in this file) to the `sourceType` string the bridge
 * surfaces on each `SourceInfo` row (mirror of Rust
 * `SourceType` enum serialised as snake_case).
 *
 * Every `ProviderId` MUST have a `sourceType` entry: a missing
 * entry would silently skip failure-state updates for that
 * provider, which is exactly the class of bug Task 11 exists to
 * prevent.
 */
const PROVIDER_TO_SOURCE_TYPE: Record<ProviderId, string> = {
  google_drive: "google_drive",
  onedrive: "onedrive",
  notion: "notion",
  jira: "jira",
  confluence: "confluence",
  figma: "figma",
  hubspot: "hubspot",
  slack: "slack",
  email: "email",
  github: "github",
  dropbox: "dropbox",
  box: "box",
  linear: "linear",
  miro: "miro",
};

/**
 * classify a sync error as `transient` or
 * `permanent`. The decision matrix aligns with
 * `tessera_connectors::ConnectorError::failure_kind` for the canonical
 * cases (401, 403, 404, 410, network errors, rate-limit) so a finding
 * flagged Permanent on the Rust side is ALSO flagged Permanent here in
 * the same sync cycle — without this alignment a provider 404 or 403
 * would silently spend the full `MAX_RETRIES_BEFORE_PERMANENT` window
 * before flipping the sticky `failedPermanently` bit, leaving the user
 * staring at a fruitless retry loop for ~8 minutes.
 *
 * Divergence from the Rust matrix (intentional, pinned by
 * `connectorBackoff.test.ts`): the TS classifier sees raw `Error`
 * objects with HTTP-status-in-message rather than typed Rust variants,
 * so a generic 4xx (e.g. 400, 422 — anything other than 408/429) is
 * mapped to `permanent` here even though the Rust side would route the
 * same HTTP response through `ConnectorError::ProviderError` and call
 * it transient. The rationale is that a generic 4xx surfaced through
 * our per-connector wrappers almost always means the caller's request
 * shape is wrong (malformed payload, missing scope, removed field) —
 * looping on the same request will never succeed, so we'd rather flip
 * `failedPermanently` immediately and surface a "re-authorise / re-
 * configure" prompt than spend 8 retry attempts on a guaranteed
 * failure. If a connector ever needs the Rust semantics (treat a
 * specific 4xx as transient because the provider documents it as
 * recoverable), the connector should throw a structured error with
 * `isNetworkError: true` or `name: "RateLimitError"` rather than the
 * default "<provider> ... returned HTTP <status>" shape.
 *
 *  - `NotConnectedError` (the user is not authenticated, OR their
 *    refresh token was revoked → mirrors Rust `AuthenticationFailed`
 *    / `TokenRevoked`) → `permanent`. The retry loop would just hit
 *    the same auth wall on every attempt; the user has to
 *    re-authorise before any further progress.
 *  - HTTP `401`, `403`, `404`, `410` surfaced through the per-connector
 *    `throw new Error("<provider> ... returned HTTP <status>")`
 *    convention (see `notion.ts`, `onedrive.ts`, `drive.ts`) →
 *    `permanent`. These mirror Rust's `AuthenticationFailed` (401),
 *    `PermissionDenied` (403), `FileNotFound` (404 / 410) variants.
 *    Pattern-matching on the message text is necessary because the
 *    per-connector code path throws plain `Error` rather than a
 *    structured `HttpError` subclass; we are intentionally avoiding
 *    a larger refactor to introduce one. A future refactor could
 *    swap this for a duck-type check (`(err as { httpStatus?: number })`)
 *    without changing the classification matrix.
 *  - `isNetworkError(err) === true` (EAI_AGAIN / ENOTFOUND /
 *    ETIMEDOUT / ECONNRESET / etc., or any `NetworkError` instance)
 *    → `transient`. These are classic recoverable network blips
 *    that mirror Rust's `NetworkError` and `Io` variants.
 *  - `RateLimitError` (name match, mirrors Rust `RateLimited`) →
 *    `transient`. The provider explicitly asks us to back off; the
 *    next attempt after the backoff interval will likely succeed.
 *  - Anything else → `transient`. We deliberately bias toward
 *    `transient` here so a one-off provider 5xx doesn't flip the
 *    sticky `failedPermanently` bit; the
 *    `MAX_RETRIES_BEFORE_PERMANENT` clamp in `connectorBackoff` will
 *    still flip it to permanent after 8 consecutive failures, which
 *    is enough signal that the source is actually broken (not just
 *    intermittently flaky).
 */
export function classifyConnectorError(err: unknown): FailureKind {
  if (err == null) return "transient";
  if (typeof err === "object") {
    if ((err as { isNotConnectedError?: boolean }).isNotConnectedError === true) {
      return "permanent";
    }
    // `isNetworkError` flag is the explicit transient marker —
    // mirrors `Io`/`NetworkError` on the Rust side.
    if ((err as { isNetworkError?: boolean }).isNetworkError === true) {
      return "transient";
    }
    // RateLimitError is identified by name (the only thrown type
    // with that name in this codebase). Transient on both sides.
    if ((err as { name?: string }).name === "RateLimitError") {
      return "transient";
    }
    // MissingScopeError is permanent — the user explicitly narrowed
    // the OAuth grant during the consent flow (or the refresh
    // response narrowed it), so the only way to recover is to
    // re-authenticate and widen the grant. Retrying through the
    // 8-attempt transient backoff (~4 minutes total) before the
    // "needs re-auth" CTA finally surfaces is the wrong UX: the
    // first failed sync after a scope narrowing should immediately
    // flip the source-health badge to permanent so the renderer
    // can prompt re-auth on the spot.
    if (err instanceof MissingScopeError) {
      return "permanent";
    }
  }
  // Pattern-match plain `Error` messages thrown by per-connector
  // HTTP wrappers. The shape is stable across connectors:
  //   `<Provider> ... returned HTTP <status> — <details>`
  // We extract <status> via regex rather than substring matching
  // to avoid mis-classifying a 5xx body that happens to mention
  // "401" or "403" in its prose.
  const message =
    typeof err === "object" && err !== null
      ? String((err as Error).message ?? "")
      : String(err);
  const httpMatch = message.match(/returned HTTP (\d{3})\b/i);
  if (httpMatch) {
    const status = Number(httpMatch[1]);
    // 401 / 403 / 404 / 410 are the canonical permanent statuses
    // (these align row-for-row with the Rust matrix):
    //   401 → AuthenticationFailed (refresh path is exhausted)
    //   403 → PermissionDenied (scope dropped / item moved)
    //   404 / 410 → FileNotFound (resource really is gone)
    // Other 4xx (400, 422, etc.) DIVERGE from Rust: the Rust side
    // would surface these through `ProviderError` → transient, but
    // a generic 4xx from one of our connector wrappers almost
    // always means a malformed request and looping on it will
    // never succeed — see the doc-comment block above. We still
    // return permanent for the full 4xx range EXCEPT 408 (timeout)
    // and 429 (rate-limited), which are unambiguously transient.
    if (status === 408 || status === 429) return "transient";
    if (status >= 400 && status < 500) return "permanent";
    // 5xx is provider-side; mirror Rust `ProviderError` (transient).
    return "transient";
  }
  return "transient";
}

/**
 * stamp a successful sync onto every source
 * row that belongs to `provider`. Clearing per-source is
 * intentional — a single provider's sync may touch multiple
 * sources (e.g. multiple Drive folders), and any of them that
 * had a previous failure recorded must have its state cleared so
 * the UI's "permanently failed" badge disappears.
 *
 * Failures inside this helper are logged but NOT propagated:
 * recording success is observability, not correctness. The user
 * just saw their sync succeed — we must not turn that into a
 * thrown error because a downstream DB write hiccuped.
 */
function clearAllProviderFailureStates(ctx: IpcContext, provider: ProviderId): void {
  const targetType = PROVIDER_TO_SOURCE_TYPE[provider];
  if (targetType == null) return;
  try {
    const bridge = ctx.requireBridge();
    const sources = bridge.bridgeListSources();
    for (const src of sources) {
      if (src.sourceType !== targetType) continue;
      try {
        clearSyncFailureState(bridge, src.id);
      } catch (inner) {
        ctx.log.warn("clear sync-failure state failed (continuing)", {
          provider,
          sourceId: src.id,
          error: (inner as Error).message,
        });
      }
    }
  } catch (err) {
    ctx.log.warn("could not enumerate sources for failure-state clear", {
      provider,
      error: (err as Error).message,
    });
  }
}

/**
 * stamp a failed sync onto every source row
 * that belongs to `provider`, applying the policy in
 * `connectorBackoff` to the previous state to compute the new
 * `(retry_count, failed_permanently)` tuple.
 *
 * Same logging-not-throwing posture as `clearAllProviderFailureStates`
 * — recording is observability and must never override the
 * actual error the caller is about to surface.
 */
function recordAllProviderFailures(
  ctx: IpcContext,
  provider: ProviderId,
  err: unknown,
): void {
  const targetType = PROVIDER_TO_SOURCE_TYPE[provider];
  if (targetType == null) return;
  const kind = classifyConnectorError(err);
  const message =
    err instanceof Error ? err.message : typeof err === "string" ? err : String(err);
  try {
    const bridge = ctx.requireBridge();
    const sources = bridge.bridgeListSources();
    for (const src of sources) {
      if (src.sourceType !== targetType) continue;
      try {
        const prev: SyncFailureState = (() => {
          try {
            return loadSyncFailureState(bridge, src.id);
          } catch {
            return emptySyncFailureState();
          }
        })();
        const next = applyFailureToState(prev, { kind, message });
        saveSyncFailureState(bridge, src.id, next);
      } catch (inner) {
        ctx.log.warn("record sync-failure state failed (continuing)", {
          provider,
          sourceId: src.id,
          error: (inner as Error).message,
        });
      }
    }
  } catch (err2) {
    ctx.log.warn("could not enumerate sources for failure-state record", {
      provider,
      error: (err2 as Error).message,
    });
  }
}

// Network-error classification (NetworkError class, NotConnectedError
// class, isNetworkError function) lives in a dedicated
// `./networkErrors` module so per-connector sync files
// (`notion.ts`, `confluence.ts`, `figma.ts`, etc.) can import the
// classifier without forming an import cycle with this file. See the
// module-level docstring in `networkErrors.ts` for the full rationale.
// `handlers.ts` re-exports the public surface unchanged so existing
// imports (`import { NetworkError, isNetworkError } from "./handlers"`
// in tests and `ipc.ts`) continue to work without code churn.
import {
  NetworkError,
  NotConnectedError,
  isNetworkError,
} from "./networkErrors";
export { NetworkError, NotConnectedError, isNetworkError };

/**
 * per-provider in-flight refresh registry.
 *
 * When two concurrent connector syncs both observe an expired access
 * token they would each independently call `refreshProviderToken`,
 * producing two side-effects we don't want:
 *
 *   1. **Double network round-trip.** Both refresh exchanges hit
 *      the provider's token endpoint. Atlassian and OneDrive
 *      explicitly rotate the refresh token on every successful
 *      exchange, so the second request would arrive with the
 *      already-invalidated refresh token if the first finished
 *      before it sent — silently sign the user out of the connector.
 *      Google rotates the refresh token "sometimes" (undocumented),
 *      so the same hazard exists.
 *
 *   2. **Lost-update on the token vault.** Both refresh paths
 *      `ctx.tokenVault.storeTokens(provider, …)` with different
 *      access tokens (and potentially different rotated refresh
 *      tokens). Whichever call lands second wins, leaving the vault
 *      holding a token the provider may already have revoked.
 *
 * The fix is a per-provider promise registry: while a refresh is
 * in-flight for `provider`, any further `getValidAccessToken` call
 * for the same provider awaits the same Promise. After it resolves,
 * those waiters all see the fresh token in the vault and return it
 * without re-issuing a refresh.
 *
 * Lifetime: the entry is added before the network call and removed
 * in a `finally` after `storeTokens`. Two important properties:
 *
 *   - The registry is keyed by ProviderId, so a Drive refresh in
 *     flight does NOT block a concurrent Jira refresh.
 *   - On failure the entry is removed BEFORE the rejection
 *     propagates — a transient network error must NOT poison the
 *     next caller; they should be free to retry.
 */
const REFRESH_IN_FLIGHT = new Map<ProviderId, Promise<string>>();

/**
 * Exported for tests so the suite can introspect / clear the
 * in-flight registry between cases without poking module internals
 * through `as unknown`.
 *
 * Production code MUST NOT use this — the registry is meant to be
 * write-only outside of `getValidAccessToken`.
 */
export function __resetOAuthRefreshRegistryForTests(): void {
  REFRESH_IN_FLIGHT.clear();
}

/**
 * Resolve a fresh access token, refreshing via the refresh token if
 * the access token has expired (or is within 60s of expiry). Throws
 * a clear error if the connector is not connected.
 *
 * concurrent callers for the same provider share
 * the in-flight refresh — see `REFRESH_IN_FLIGHT` above.
 */
async function getValidAccessToken(
  ctx: IpcContext,
  provider: ProviderId,
): Promise<string> {
  const stored = ctx.tokenVault.getTokens(provider);
  if (!stored) {
    throw new NotConnectedError(
      `${provider} is not connected — authenticate first`,
    );
  }
  const config = getProviderOAuthConfig(provider);

  // If we have no refresh token stored — for ANY reason, regardless
  // of whether the provider config advertises `supportsRefresh: true`
  // — there is no point checking `expiresAt` and proactively
  // deleting the access token: we have nothing to refresh with.
  // The guard used to require BOTH `!supportsRefresh` AND
  // `!stored.refreshToken`, which silently force-disconnected users
  // whose stored tokens lacked a refresh token even when the provider
  // config said it supported refresh. This shows up in practice for
  // Figma (Figma's OAuth response sometimes omits `refresh_token`
  // depending on the app's grant configuration, even though the
  // provider supports them) and for any Atlassian flow whose initial
  // exchange returned only an access token (e.g. an older integration
  // upgraded mid-session).
  // The reasoning is the same as the original Notion-only carve-out:
  // proactively deleting a token we *believe* expired is strictly
  // worse than letting the upstream API tell us via a 401 if the
  // token is actually invalid, because:
  //   (a) we have no way to recover (no refresh token),
  //   (b) the only consequence of our guess being wrong is to forcibly
  //       sign the user out of a working integration.
  // So whenever we lack a refresh token, skip the expiry check
  // entirely and return the stored access token verbatim.
  if (!stored.refreshToken) {
    return stored.accessToken;
  }

  if (Date.now() < stored.expiresAt - 60_000) return stored.accessToken;

  // Reachability: the `!stored.refreshToken` early-return above means
  // `stored.refreshToken` is necessarily truthy here, so the only way
  // this guard can fire is `!config.supportsRefresh`. Keeping the
  // `!config.supportsRefresh` half explicit makes the intent obvious
  // and protects against a future code path that flips the early
  // return into a fall-through (e.g. a hypothetical "refresh token
  // is stored but provider config changed to supportsRefresh: false").
  if (!config.supportsRefresh) {
    ctx.tokenVault.deleteTokens(provider);
    throw new NotConnectedError(
      `${provider} access token expired and refresh is not available — re-authenticate`,
    );
  }
  if (!stored.clientId || !stored.clientSecret) {
    ctx.tokenVault.deleteTokens(provider);
    throw new NotConnectedError(
      `${provider} client credentials missing — re-authenticate`,
    );
  }
  // collapse concurrent refreshes for the same
  // provider onto a single in-flight Promise. If another caller is
  // already refreshing this provider's token, await their result and
  // return — we MUST NOT issue a second exchange against the
  // provider's token endpoint (Atlassian/OneDrive/Google may rotate
  // the refresh token and invalidate the second one's input).
  const existing = REFRESH_IN_FLIGHT.get(provider);
  if (existing) {
    return existing;
  }

  const refreshPromise = (async (): Promise<string> => {
    // Wrap the refresh-token exchange so a transport-level failure
    // (DNS, TCP refused, undici timeout, etc.) escapes via our
    // branded `NetworkError` rather than as a bare `fetch`
    // rejection. The outer `runConnectorSync` wrapper keys its
    // `{ status: "offline" }` fallback on `isNetworkError(err)`,
    // but `getValidAccessToken` runs OUTSIDE that wrapper's
    // try/catch (so we don't burn the rate-limit budget on
    // auth-state errors) — without this re-wrap, a refresh call
    // that fails because the user's wifi dropped would bubble out
    // as a raw fetch rejection and the renderer would surface a
    // confusing "fetch failed" error instead of the Offline badge.
    let refreshed: Awaited<ReturnType<typeof refreshProviderToken>>;
    try {
      refreshed = await refreshProviderToken(config, {
        refreshToken: stored.refreshToken!,
        clientId: stored.clientId!,
        clientSecret: stored.clientSecret!,
      });
    } catch (err) {
      if (isNetworkError(err)) {
        throw new NetworkError(
          `Network error while refreshing ${provider} access token: ${
            err instanceof Error ? err.message : String(err)
          }`,
          { cause: err },
        );
      }
      throw err;
    }
    // RFC 6749 allows the refresh response
    // to narrow scope (return a `scope` field listing a smaller
    // set). Trust the refresh response when present; fall back to
    // the previously-stored grant when the provider omits the
    // field (which is the common case for Microsoft / Google /
    // Atlassian since the grant cannot widen on refresh).
    ctx.tokenVault.storeTokens(provider, {
      accessToken: refreshed.accessToken,
      refreshToken: refreshed.refreshToken,
      expiresAt: Date.now() + refreshed.expiresIn * 1000,
      scopes: refreshed.grantedScopes ?? stored.scopes,
      clientId: stored.clientId,
      clientSecret: stored.clientSecret,
    });
    return refreshed.accessToken;
  })();

  REFRESH_IN_FLIGHT.set(provider, refreshPromise);
  try {
    return await refreshPromise;
  } finally {
    // Drop the registry entry regardless of success/failure. A
    // transient failure must NOT poison the next caller: they
    // should be free to retry. Success has stored fresh tokens so
    // the next caller will skip the refresh path entirely via the
    // `expiresAt` check at the top of this function.
    REFRESH_IN_FLIGHT.delete(provider);
  }
}

export function getValidAccessTokenForProvider(
  ctx: IpcContext,
  provider: ProviderId,
): Promise<string> {
  return getValidAccessToken(ctx, provider);
}

/**
 * Result shape returned by every per-provider sync. The `status`
 * field is `"synced"` on a normal run and `"offline"` when the
 * shared wrapper (`runConnectorSync` below) catches a network
 * failure on behalf of the caller. The renderer keys the Offline
 * badge on `status === "offline"`.
 */
export interface ConnectorSyncResult {
  added: number;
  modified: number;
  removed: number;
  status: string;
}

async function runSync(
  ctx: IpcContext,
  provider: ProviderId,
  accessToken: string,
  userDataDir: string,
  options?: { selectedFileIds?: string[] },
): Promise<ConnectorSyncResult> {
  const bridge = bridgeHooks(ctx);
  // Production refresh hook: each connector's hot loop calls this
  // per iteration so a long-running sync (>1h, the default OAuth
  // access-token lifetime for Google / Microsoft / Atlassian /
  // Notion / Figma) transparently refreshes via the stored refresh
  // token. `getValidAccessToken` already returns the cached value
  // when there's >60s left and only hits the network when truly
  // expired, so the per-iteration cost is a vault read + a
  // millisecond comparison in the common case.
  const getAccessToken = (): Promise<string> => getValidAccessToken(ctx, provider);

  // v2 path: when `useV2Connectors` is on (default) AND the native
  // addon exposes the v2 functions AND this provider is compiled into
  // the substrate build, serve the sync from the knowledge
  // `connector_framework`. This is the long-term replacement for the
  // hand-rolled per-provider TS sync below. A config-read failure must
  // never wedge sync, so it defaults to the v2 path (matching the
  // documented `.catch(true)` config fallback).
  let useV2: boolean;
  try {
    useV2 = loadConfig().useV2Connectors;
  } catch {
    useV2 = true;
  }

  // Selective sync is a legacy-only capability. The renderer's
  // `connectors:gdrive:sync` channel passes an explicit
  // `selectedFileIds` allowlist so the user can pull only the files
  // they picked. The knowledge `connector_framework` sync is
  // changefeed-based (`initial_sync`/`incremental_sync` emit whatever
  // the provider reports as changed) and Google Drive's only filter
  // hook is `auth_config_json.q` — a Drive search query that cannot
  // express an arbitrary file-id allowlist (`files.list` has no
  // `id in [...]` operator). There is therefore no faithful way to
  // honour an explicit selection through v2. Rather than silently
  // running a full sync and ignoring the user's choice, route the
  // selection-bearing call to the legacy connector (which fetches each
  // selected id directly). Only Google Drive ever supplies a
  // selection, and it is a legacy provider, so the legacy path is
  // always available. The dual sync directory this can create
  // (`gdrive-sync/` vs `google_drive-sync/`) is already reconciled by
  // `runDisconnect`, which purges both backends.
  const hasSelection = (options?.selectedFileIds?.length ?? 0) > 0;

  // A selection allowlist is only meaningful for a provider that has a
  // legacy connector able to fetch specific ids (today only Google
  // Drive's renderer sends one). A substrate-only provider (any
  // provider outside LEGACY_PROVIDERS) has no per-file fetch path, so a
  // selection cannot be honoured. Reject it explicitly with an accurate
  // message instead of falling through to the generic
  // `requires useV2Connectors=true` branch below, whose wording would be
  // misleading in this case (useV2 may well be true — the real problem
  // is the unsupported selection). Unreachable today, but a clear guard
  // for any future substrate provider that grows a selection UI.
  if (hasSelection && !LEGACY_PROVIDERS.has(provider)) {
    throw new Error(
      `${provider} does not support selective sync; selectedFileIds is ` +
        "only honoured by providers with a legacy connector (currently " +
        "Google Drive).",
    );
  }

  if (useV2 && !hasSelection) {
    const nativeBridge = ctx.requireBridge();
    if (v2BridgeAvailable(nativeBridge) && isV2Supported(nativeBridge, provider)) {
      return runProviderV2Sync(ctx, provider, userDataDir);
    }
    // Substrate-only providers have no legacy fallback. If the v2
    // bridge isn't available for them, that's a hard config error
    // rather than a silent degrade to a non-existent TS impl.
    if (!LEGACY_PROVIDERS.has(provider)) {
      throw new Error(
        `${provider} is only available via the v2 connector bridge, ` +
          "which is not present in this build.",
      );
    }
    // Otherwise fall through to the legacy TS sync for the original
    // six providers (e.g. an addon built without `connectors-v2`).
  } else if (!LEGACY_PROVIDERS.has(provider)) {
    throw new Error(
      `${provider} requires useV2Connectors=true; it has no legacy connector.`,
    );
  }

  switch (provider) {
    case "google_drive":
      return syncGoogleDrive({
        accessToken,
        getAccessToken,
        userDataDir,
        bridge,
        selectedFileIds: options?.selectedFileIds,
      });
    case "onedrive":
      return syncOneDrive({ accessToken, getAccessToken, userDataDir, bridge });
    case "notion":
      return syncNotion({ accessToken, getAccessToken, userDataDir, bridge });
    case "jira":
      return syncJira({ accessToken, getAccessToken, userDataDir, bridge });
    case "confluence":
      return syncConfluence({ accessToken, getAccessToken, userDataDir, bridge });
    case "figma":
      return syncFigma({ accessToken, getAccessToken, userDataDir, bridge });
    case "hubspot":
    case "slack":
    case "email":
    case "github":
    case "dropbox":
    case "box":
    case "linear":
    case "miro":
      // Substrate-only providers: reachable here only when the v2
      // path was unavailable; surfaced as a clear config error above,
      // but the explicit cases keep the exhaustiveness check honest.
      throw new Error(
        `${provider} is only available via the v2 connector bridge.`,
      );
    default: {
      // Exhaustiveness assertion. `ProviderId` is derived from the
      // `KNOWN_PROVIDERS` tuple in `validate.ts`, so a future 7th
      // provider added to that tuple without a matching
      // `case` in this switch fails the compile here — the `never`
      // assignment is the only place TypeScript will narrow `provider`
      // to a non-empty type if the switch is non-exhaustive. The
      // runtime `throw` is dead code today but is the only safe
      // behaviour if a downstream caller ever circumvents the validator
      // and routes an unknown provider id through to this function.
      // Without this branch a non-exhaustive switch returns `undefined`
      // at runtime and the IPC layer surfaces an opaque
      // "Cannot read properties of undefined (reading 'then')".
      const _exhaustive: never = provider;
      throw new Error(`runSync: unknown provider ${String(_exhaustive)}`);
    }
  }
}

/**
 * Shared rate-limit + offline-catch wrapper used by every connector
 * sync channel — both the new `connectors:sync` channel below and
 * the legacy `connectors:gdrive:sync` channel registered in
 * `ipc.ts`. Centralising this here means:
 *
 *   - Drive and the other five providers all get the same
 *     1-per-30-second per-provider rate limit (the legacy gdrive
 *     channel had no rate limit before this; a buggy renderer could
 *     hammer the Drive API on its behalf).
 *   - Network failures are surfaced as `{ status: "offline" }` for
 *     Drive too, instead of being thrown out of the handler and
 *     silently swallowed by the renderer's empty `catch {}` — that
 *     was why the Offline badge introduced for the other providers
 *     never lit up for Drive.
 *   - Auth-prerequisite errors (`NotConnectedError`) still propagate
 *     as hard errors so the UI can prompt re-authentication.
 */
/**
 * LW-6: process-wide gate that bounds how many connector syncs run at
 * once. Capacity is `SYNC_CONCURRENCY[resourceMode]` (1 lightweight, 3
 * performance), read live on each acquire so a Settings toggle applies
 * to the next sync. `loadConfig()` is wrapped defensively: a config
 * read failure must never wedge syncs, so we fall back to the
 * lightweight cap (the safest, lowest-footprint choice).
 *
 * A single shared instance is correct here — there is one main process
 * and one config — and it backs every sync entry point because they
 * all funnel through `runConnectorSync` (`connectors:sync` and the
 * legacy `connectors:gdrive:sync` handler both delegate here).
 */
const connectorSyncQueue = new ConnectorSyncQueue(() => {
  try {
    return SYNC_CONCURRENCY[loadConfig().resourceMode];
  } catch {
    return SYNC_CONCURRENCY.lightweight;
  }
});

/**
 * Public sync entry point. Serialises (lightweight) or lightly
 * parallelises (performance) connector syncs via `connectorSyncQueue`
 * so a multi-connector "Sync all" can't fan out heavy network + CPU +
 * disk work simultaneously. The actual sync logic lives in
 * `runConnectorSyncInner`; this wrapper only adds the concurrency gate
 * so the gate is impossible to bypass from any caller.
 */
export function runConnectorSync(
  ctx: IpcContext,
  provider: ProviderId,
  options?: { selectedFileIds?: string[] },
): Promise<ConnectorSyncResult> {
  return connectorSyncQueue.run(() =>
    runConnectorSyncInner(ctx, provider, options),
  );
}

async function runConnectorSyncInner(
  ctx: IpcContext,
  provider: ProviderId,
  options?: { selectedFileIds?: string[] },
): Promise<ConnectorSyncResult> {
  const offlineResult = (): ConnectorSyncResult => ({
    added: 0,
    modified: 0,
    removed: 0,
    status: "offline",
  });
  // Resolve the access token BEFORE consuming the rate-limit budget.
  // The token check is local (vault lookup + optional refresh-token
  // exchange) and short-circuits with `NotConnectedError` when the
  // user simply isn't authenticated — spending the 1/30s budget on
  // that case would mask the real "please re-authenticate" error
  // behind a generic "rate-limited" message on the next click.
  // The rate-limit is still consumed before any expensive per-
  // provider sync work (the actual API calls in `runSync`), which is
  // where defence-in-depth against a runaway renderer matters.
  let token: string;
  try {
    token = await getValidAccessToken(ctx, provider);
  } catch (err) {
    // Devin Review PR #69 follow-up: record the failure on
    // every provider source BEFORE we branch into the offline-return
    // or hard-throw paths. The original Task 11 wiring only recorded
    // failures from the `runSync` catch below, so a token-refresh
    // failure — whether the refresh-token exchange dropped on the
    // network (transient) or the provider revoked the refresh token
    // (NotConnectedError → permanent in classifyConnectorError) —
    // would silently bypass the retry-count bump and the
    // failed_permanently flip. The user would then click Sync forever
    // with no failure feedback on the source-health badge. Mirroring
    // the runSync catch closes the asymmetry: transient failures
    // still bump retry_count toward MAX_RETRIES_BEFORE_PERMANENT, and
    // a revoked refresh token immediately flips the source to
    // permanent so the renderer surfaces the re-auth CTA.
    //
    // The call is intentionally placed BEFORE the isNetworkError
    // branch so it runs on both the offline-degrade path AND the
    // hard-throw path; `recordAllProviderFailures` swallows its own
    // bridge errors so it cannot mask the user-facing error the
    // caller is about to surface.
    recordAllProviderFailures(ctx, provider, err);
    // A refresh-token exchange that fails because the network dropped
    // must still surface as "offline" to the renderer; otherwise the
    // user clicks Sync, sees a raw `fetch failed` and has no idea the
    // problem is transport, not auth. `getValidAccessToken` now wraps
    // its `refreshProviderToken` call so the rejection carries the
    // `NetworkError` brand isNetworkError() recognises. Keeping the
    // detection here too (rather than letting the brand survive
    // unwrapped) means non-network refresh errors (4xx from the
    // provider, missing credentials, etc.) still propagate as hard
    // errors so the UI can prompt re-authentication.
    if (isNetworkError(err)) {
      ctx.log.warn("token refresh hit network failure", {
        provider,
        error: (err as Error).message,
      });
      return offlineResult();
    }
    throw err;
  }
  // validate the user has granted every
  // required OAuth scope before we burn rate-limit budget and start
  // hitting provider APIs. A narrowed grant would otherwise surface
  // as opaque 403s deep inside the per-provider sync impl; here we
  // throw a structured `MissingScopeError` that carries the precise
  // missing-scope list to the renderer.
  //
  // Placement matters: AFTER `getValidAccessToken` (which silently
  // refreshes if needed; the refresh response may narrow the
  // persisted grant), and BEFORE `rateLimiter.consume` (a
  // permanent scope failure should not eat the 30s budget — the
  // user will re-authorize and immediately want to retry).
  const oauthConfig = getProviderOAuthConfig(provider);
  const requestedScopes = getRequestedScopes(oauthConfig);
  if (requestedScopes.length === 0) {
    // Only Notion's OAuth flow legitimately returns a scope-less
    // integration token (workspace-bound permission granted at
    // install time). Any other provider with `scope: ""` is a
    // misconfiguration that would silently bypass scope governance,
    // so emit a structured warning on every sync — visible enough
    // that an operator will notice before a security-relevant
    // provider ships with the wrong default.
    if (!SCOPELESS_PROVIDERS.has(provider)) {
      ctx.log.warn("connector has empty scope config; scope check skipped", {
        provider,
      });
    }
  } else {
    const storedTokens = ctx.tokenVault.getTokens(provider);
    const grantedScopes = storedTokens?.scopes ?? [];
    try {
      assertScopesGranted(provider, requestedScopes, grantedScopes);
    } catch (err) {
      if (err instanceof MissingScopeError) {
        ctx.log.warn("connector sync blocked by missing scopes", {
          provider,
          missing: err.missing,
          granted: err.granted,
        });
        // Record on every per-provider source so the source-health
        // badge reflects "needs re-auth" rather than "syncing".
        // `recordAllProviderFailures` swallows its own bridge errors.
        recordAllProviderFailures(ctx, provider, err);
      }
      throw err;
    }
  }
  try {
    ctx.rateLimiter.consume(`connectors:sync:${provider}`, {
      tokensPerInterval: 1,
      intervalMs: 30_000,
    });
  } catch (err) {
    if (err instanceof RateLimitError) {
      throw new Error(
        `Sync for ${provider} is rate-limited. Wait ${Math.ceil(
          err.retryAfterMs / 1000,
        )}s and try again.`,
      );
    }
    throw err;
  }
  try {
    const result = await runSync(ctx, provider, token, ctx.userDataDir(), options);
    // log the sync delta counts on the `"synced"`
    // path only. The `"offline"` status returned below reflects a
    // transient network failure (no actual sync work happened) so an
    // audit row for it would pollute reports with noise.
    //
    // This audit lives inside `runConnectorSync` — NOT inside the
    // individual IPC handlers — so EVERY caller is audited
    // automatically: the new `connectors:sync` handler in this file
    // AND the legacy `connectors:gdrive:sync` handler in
    // `connectorsLegacy.ts` (still reachable from the renderer via
    // `preload.ts`'s `gdrive:sync` channel), AND any future channel
    // that delegates to this shared wrapper.
    // Previously the audit lived in the
    // handler; moving it here closes it structurally instead of
    // requiring every future caller to remember to add the wrap.
    if (result.status === "synced") {
      safeAudit(ctx, (b) =>
        b.bridgeLogConnectorSynced(
          provider,
          result.added,
          result.modified,
          result.removed,
        ),
      );
      // a successful sync clears any previously
      // recorded failure state. Done AFTER the audit log emits so
      // a hypothetical race where the clear happens but the audit
      // does not still leaves the audit pipeline as the source of
      // truth — but well after the actual sync committed, so
      // there is no "phantom success" risk from clearing.
      clearAllProviderFailureStates(ctx, provider);
    }
    return result;
  } catch (err) {
    // record failure BEFORE the offline-result
    // branch returns. The renderer's source-health UI relies on
    // this to render the retry-count badge on every source the
    // provider owns. Even when we degrade to `{ status: "offline" }`
    // (transient network blip), we still bump retry_count so a
    // chronically offline source eventually flips to permanent.
    recordAllProviderFailures(ctx, provider, err);
    if (isNetworkError(err)) {
      ctx.log.warn("connector sync hit network failure", {
        provider,
        error: (err as Error).message,
      });
      return offlineResult();
    }
    throw err;
  }
}

/**
 * Per-provider cleanup for the six providers that have a hand-rolled
 * (`tessera_connectors`-style) TS sync impl. Each removes the sources
 * the legacy sync registered and purges that provider's legacy sync
 * directory. Note Google Drive's legacy code keys its directory and
 * manifest on the short name `"gdrive"` (→ `gdrive-sync/`), which is
 * distinct from the canonical `"google_drive"` id the v2 path uses
 * (→ `google_drive-sync/`); the two backends therefore never share a
 * directory for Google Drive.
 */
function runLegacyDisconnect(
  provider: LegacyProviderId,
  userDataDir: string,
  bridge: BridgeHooks,
): Promise<{ filesRemoved: number }> {
  switch (provider) {
    case "google_drive":
      return disconnectGoogleDrive(userDataDir, bridge);
    case "onedrive":
      return disconnectOneDrive(userDataDir, bridge);
    case "notion":
      return disconnectNotion(userDataDir, bridge);
    case "jira":
      return disconnectJira(userDataDir, bridge);
    case "confluence":
      return disconnectConfluence(userDataDir, bridge);
    case "figma":
      return disconnectFigma(userDataDir, bridge);
    default: {
      const _exhaustive: never = provider;
      throw new Error(
        `runLegacyDisconnect: non-legacy provider ${String(_exhaustive)}`,
      );
    }
  }
}

/**
 * Disconnect cleanup dispatch. Exported for the regression test that
 * verifies a Google Drive disconnect purges BOTH backends' sync
 * directories (the legacy `gdrive-sync/` and the v2
 * `google_drive-sync/`); not part of the IPC contract.
 */
export async function runDisconnect(
  ctx: IpcContext,
  provider: ProviderId,
  userDataDir: string,
): Promise<{ filesRemoved: number }> {
  const bridge = bridgeHooks(ctx);
  switch (provider) {
    case "google_drive":
    case "onedrive":
    case "notion":
    case "jira":
    case "confluence":
    case "figma": {
      // The active sync backend is selected at runtime (see `runSync`):
      // either the v2 `connector_framework` bridge or the legacy TS
      // impl. Disconnect must not assume which one produced the files,
      // because the choice can differ between a sync and a later
      // disconnect — e.g. `useV2Connectors` was toggled, the addon was
      // rebuilt without `connectors-v2`, or (for Google Drive) the two
      // backends simply use different directories (`gdrive-sync/` vs
      // `google_drive-sync/`). Cleaning ONLY the legacy path therefore
      // orphaned every v2-synced Google Drive file on disk.
      //
      // So we run BOTH cleanups. Each is best-effort and a no-op when
      // its directory/manifest is absent. For the five providers whose
      // legacy and v2 paths share a directory + manifest format, the
      // first pass purges it and the second finds nothing left; for
      // Google Drive the two distinct directories are each cleaned.
      const legacy = await runLegacyDisconnect(provider, userDataDir, bridge);
      const v2 = await disconnectV2Provider(provider, userDataDir, bridge);
      return { filesRemoved: legacy.filesRemoved + v2.filesRemoved };
    }
    case "hubspot":
    case "slack":
    case "email":
    case "github":
    case "dropbox":
    case "box":
    case "linear":
    case "miro":
      // Substrate-only providers: no legacy disconnect impl exists, so
      // reuse the generic v2 cleanup (unhook sources + purge sync dir
      // + delete manifest/cursor). Token revocation + vault deletion
      // happen in the shared disconnect handler before this is called,
      // identical to the legacy providers.
      return disconnectV2Provider(provider, userDataDir, bridge);
    default: {
      // Exhaustiveness assertion. Same architectural rationale as the
      // sibling `default` branch in `runSync` above: `ProviderId` is
      // derived from the `KNOWN_PROVIDERS` tuple in `validate.ts`, so
      // a future 7th provider added there without a matching `case`
      // in this switch fails the compile here. Without the assertion
      // `runDisconnect` would silently fall through and return `void`
      // — the user clicks Disconnect, the tokens are revoked and
      // deleted (the work above in the disconnect handler), but the
      // per-provider cleanup (purging the sync directory, unhooking
      // the bridge sources, deleting the local manifest) would never
      // run for the new provider. The orphaned files and stale source
      // index entries would persist until the user manually deletes
      // the sync directory — exactly the silent-failure mode the
      // sibling `runSync` exhaustiveness assertion was added to prevent.
      const _exhaustive: never = provider;
      throw new Error(`runDisconnect: unknown provider ${String(_exhaustive)}`);
    }
  }
}

export function registerConnectorHandlers(ctx: IpcContext): void {
  // Every `idempotentHandle(...)` below does its own
  // `ipcMain.removeHandler` first, so re-importing this module (test
  // harness or future hot-reload) no longer needs a separate
  // per-channel cleanup loop.
  idempotentHandle(
    "connectors:authenticate",
    // Electron IPC delivers every argument as `unknown` at runtime — the
    // `assertProvider` / `assertString` calls below are what produce a
    // narrowed `string`. Typing the handler parameters as `unknown`
    // matches that reality and keeps this module consistent with every
    // other refactored handler in the per-domain split.
    async (
      _event,
      providerRaw: unknown,
      clientIdRaw: unknown,
      clientSecretRaw: unknown,
    ): Promise<ConnectorStatusInfo> => {
      const provider = assertProvider(providerRaw, "provider");
      const clientId = assertString(clientIdRaw, "clientId", { maxLen: 512 });
      const clientSecret = assertString(clientSecretRaw, "clientSecret", {
        maxLen: 512,
        // Every provider supported today (Google Drive, OneDrive,
        // Notion, Jira, Confluence, Figma, HubSpot, Slack, Email,
        // GitHub) is registered as a confidential OAuth client and
        // therefore requires a non-empty `client_secret`. If a future
        // connector is added with a public / PKCE-only OAuth client,
        // special-case it here.
        allowEmpty: false,
      });
      try {
        ctx.rateLimiter.consume(`connectors:authenticate:${provider}`, {
          tokensPerInterval: 1,
          intervalMs: 5_000,
        });
      } catch (err) {
        if (err instanceof RateLimitError) {
          throw new Error(
            `Too many authentication attempts for ${provider}. Wait ${Math.ceil(
              err.retryAfterMs / 1000,
            )}s and try again.`,
          );
        }
        throw err;
      }

      const config = getProviderOAuthConfig(provider);
      const pkce = config.usePkce ? generatePkcePair() : null;
      const result = await runRedirectServer(config, {
        clientId,
        codeChallenge: pkce?.challenge,
      });
      const tokens = await exchangeAuthorizationCode(config, {
        code: result.code,
        clientId,
        clientSecret,
        codeVerifier: pkce?.verifier,
      });
      // persist the scopes the provider
      // actually granted (`tokens.grantedScopes`), not just the
      // scopes we requested. If the provider's response omitted the
      // `scope` field entirely (e.g. Notion integration tokens) we
      // fall back to the requested scopes so we still have a record
      // of what the connector is meant to be allowed to do.
      //
      // Use the canonical `getRequestedScopes(config)` helper so the
      // parse semantics here match every other call site
      // (`runConnectorSync` line 733, `connectors:inspectScopes`
      // line 1079, `parseGrantedScopes` in providerOAuth.ts:346).
      // The helper splits on `/[\s,]+/` so comma-delimited scopes
      // (Figma) are handled the same way at auth time, sync time,
      // and inspection time. An inline `.split(/\s+/)` here would
      // store the whole comma-joined string as a single scope and
      // every sync would flag false missing-scope errors.
      const requestedScopes = getRequestedScopes(config);
      const persistedScopes =
        tokens.grantedScopes ?? requestedScopes;
      ctx.tokenVault.storeTokens(provider, {
        accessToken: tokens.accessToken,
        refreshToken: tokens.refreshToken,
        expiresAt: Date.now() + tokens.expiresIn * 1000,
        scopes: persistedScopes,
        clientId,
        clientSecret,
      });
      // Warn (in the structured log) when the user narrowed
      // consent. The connector card surfaces the same diff in the
      // UI; this log line gives a forensic trail for support.
      //
      // Delegate the comparison to `compareScopes` rather than
      // re-implementing the set-diff inline. `compareScopes` strips
      // meta-scopes (`offline_access` etc., see `OAUTH_META_SCOPES`
      // in `oauthScope.ts`) from the *required* side before
      // computing `missing`. Meta-scopes are OAuth protocol
      // behaviours (controlling whether a refresh token is issued),
      // not API permissions, and providers routinely omit them from
      // the token response's `scope` field even when the refresh
      // token IS granted — Atlassian (Jira/Confluence) and
      // Microsoft (OneDrive) both do this. Before this delegation
      // the inline filter would log a false "scopes narrowed by
      // user" warning on every successful Jira/Confluence/OneDrive
      // auth (RFC 6749 § 3.3 only constrains API access scopes,
      // not meta-scopes). The sync-time `assertScopesGranted` /
      // inspectScopes paths already used the canonical helpers; this
      // path now matches.
      if (tokens.grantedScopes !== null) {
        const cmp = compareScopes(
          provider,
          requestedScopes,
          tokens.grantedScopes,
        );
        if (cmp.missing.length > 0) {
          ctx.log.warn("connector scopes narrowed by user", {
            provider,
            requested: cmp.requested,
            granted: cmp.granted,
            missing: cmp.missing,
          });
        }
      }
      ctx.log.info("connector authenticated", { provider });
      // log the connect event AFTER the tokens
      // have been written to the vault. A failed audit append must
      // not roll back the user's successful OAuth flow — `safeAudit`
      // swallows the failure and logs a warning instead.
      safeAudit(ctx, (b) => b.bridgeLogConnectorConnected(provider));
      return { provider, connected: true, status: "connected" };
    },
  );

  idempotentHandle(
    "connectors:disconnect",
    async (_event, providerRaw: unknown): Promise<ConnectorStatusInfo> => {
      const provider = assertProvider(providerRaw, "provider");
      let stored: ReturnType<typeof ctx.tokenVault.getTokens> = null;
      try {
        stored = ctx.tokenVault.getTokens(provider);
      } catch {
        // vault may be corrupted — proceed with cleanup
      }
      if (stored) {
        const config = getProviderOAuthConfig(provider);
        await revokeProviderToken(
          config,
          stored.refreshToken ?? stored.accessToken,
        ).catch(() => undefined);
      }
      try {
        ctx.tokenVault.deleteTokens(provider);
      } catch {
        // best-effort
      }
      // `runDisconnect` returns the count of bridge sources actually
      // removed from the index — the audit code plumbs this
      // count through to the `ConnectorDisconnected` audit event so
      // an auditor can see how much state each disconnect cleaned
      // up. On cleanup failure we still log the disconnect (the
      // user-visible action — token revocation — already
      // succeeded) but report `filesRemoved=0` rather than guess.
      let filesRemoved = 0;
      try {
        const result = await runDisconnect(ctx, provider, ctx.userDataDir());
        filesRemoved = result.filesRemoved;
      } catch (err) {
        ctx.log.warn("connector disconnect cleanup failed (continuing)", {
          provider,
          error: (err as Error).message,
        });
      }
      ctx.log.info("connector disconnected", { provider, filesRemoved });
      safeAudit(ctx, (b) => b.bridgeLogConnectorDisconnected(provider, filesRemoved));
      return { provider, connected: false, status: "disconnected" };
    },
  );

  idempotentHandle(
    "connectors:status",
    async (_event, providerRaw: unknown): Promise<ConnectorStatusInfo> => {
      const provider = assertProvider(providerRaw, "provider");
      const hasTokens = ctx.tokenVault.hasTokens(provider);
      return {
        provider,
        connected: hasTokens,
        status: hasTokens ? "connected" : "disconnected",
      };
    },
  );

  idempotentHandle(
    "connectors:getRedirectUri",
    async (_event, providerRaw: unknown): Promise<string> => {
      // Single source of truth for the loopback redirect URI: the
      // OAuth config in `providerOAuth.ts`. The Settings UI fetches
      // this via IPC so the URI it tells the user to register in the
      // provider's developer console cannot drift from the one the
      // OAuth flow actually sends in the authorize request. Drift
      // here caused a bug where the UI told users to register
      // `http://127.0.0.1:9876/callback` for Google Drive while the
      // OAuth flow sent `http://localhost:9876/callback`, producing
      // `redirect_uri_mismatch` on every connect attempt.
      const provider = assertProvider(providerRaw, "provider");
      const config = getProviderOAuthConfig(provider);
      return getRedirectUri(config);
    },
  );

  idempotentHandle(
    "connectors:getAllRedirectUris",
    async (): Promise<Record<string, string>> => {
      return getRedirectUriMap();
    },
  );

  idempotentHandle(
    "connectors:sync",
    async (_event, providerRaw: unknown): Promise<ConnectorSyncResult> => {
      const provider = assertProvider(providerRaw, "provider");
      // The audit row for successful syncs is emitted by
      // `runConnectorSync` itself so the legacy `connectors:gdrive:sync`
      // handler (also routed through `runConnectorSync`) gets audited
      // automatically. See the doc comment in `runConnectorSync`.
      return await runConnectorSync(ctx, provider);
    },
  );

  // surface the requested-vs-granted scope
  // diff to the renderer so the connector card can render a
  // "scopes narrowed" warning + reconnect CTA without the user
  // having to attempt a sync first.
  //
  // The handler is intentionally read-only: it inspects the stored
  // token's `scopes` field and the OAuth config's `scope`, returns
  // a structured `ScopeComparison`, and never touches the network
  // (no refresh, no provider API call). Renderers can poll cheaply.
  idempotentHandle(
    "connectors:inspectScopes",
    async (
      _event,
      providerRaw: unknown,
    ): Promise<ScopeComparison | null> => {
      const provider = assertProvider(providerRaw, "provider");
      const stored = ctx.tokenVault.getTokens(provider);
      if (!stored) return null;
      const config = getProviderOAuthConfig(provider);
      const requested = getRequestedScopes(config);
      return compareScopes(provider, requested, stored.scopes ?? []);
    },
  );
}
