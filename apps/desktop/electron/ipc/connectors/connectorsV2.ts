/**
 * v2 connector adapter — bridges Tessera's connector IPC surface onto
 * the knowledge substrate's `connector_framework` via the Rust bridge
 * (`crates/tessera_bridge/src/connectors_v2_napi.rs`).
 *
 * Responsibilities:
 *
 *   1. Build the provider-specific `auth_config` JSON the Rust side
 *      needs (token endpoint, client credentials, scope) from the
 *      proven `PROVIDER_OAUTH_CONFIGS` source of truth plus the
 *      keychain-stored client credentials.
 *   2. Translate Tessera's `StoredTokens` (keychain shape) to/from the
 *      Rust `TokenWire` JSON contract.
 *   3. Run a sync pass through the substrate connector and ingest the
 *      fetched documents into the local search index using the SAME
 *      per-provider sync-directory primitives the legacy connectors
 *      use (`syncDir.ts`), so the renderer's source list, disconnect
 *      cleanup, and re-index behaviour are identical regardless of
 *      which backend produced the files.
 *
 * Design boundaries (why this lives in TS, not Rust):
 *
 *   - OAuth *token acquisition* (browser redirect + code exchange +
 *     refresh) stays in the existing, well-tested TS OAuth layer
 *     (`providerOAuth.ts`). The substrate connector only consumes a
 *     valid access token. This keeps the migration additive: the v2
 *     path swaps the *content traversal* (the substantive value of
 *     `connector_framework`) without re-implementing the keychain /
 *     refresh machinery the rest of Tessera depends on.
 *   - The Rust side owns the *evidence pipeline* seam
 *     (`EvidenceSink`); document bodies are also returned here so the
 *     local search index is populated even before Session 1's
 *     `tessera_substrate` evidence ingest is wired in.
 *
 * Security & privacy (5000 SME tenants):
 *
 *   - Client secrets and tokens are read from the OS keychain vault on
 *     demand for a single operation and never logged or persisted in
 *     plaintext outside the vault. The `auth_config` JSON is built in
 *     memory per call and discarded.
 *   - `scopeId` is a stable per-installation tenant scope; the Rust
 *     side derives a deterministic connector-instance id from it so a
 *     tenant's sync state never collides with another's.
 */

import * as fsp from "fs/promises";
import * as path from "path";

import type { NativeBridge } from "../../appState";
import type { StoredTokens } from "../../tokenVault";
import { authConfigFields } from "../../../shared/connectorConfig";
import {
  getProviderOAuthConfig,
  type ProviderId,
} from "./providerOAuth";
import { getRequestedScopes } from "../../oauthScope";
import {
  SourcePathIndex,
  purgeSyncDir,
  readManifest,
  sanitiseRemoteId,
  syncDirFor,
  writeManifest,
  type SyncManifest,
  type SyncManifestEntry,
} from "./syncDir";
import { NetworkError } from "./networkErrors";
import type { ConnectorSyncResult } from "./handlers";

/**
 * Re-brand a network/transport failure surfaced by the Rust bridge as
 * the host's {@link NetworkError} so it is classified deterministically.
 *
 * The bridge flattens `connector_framework` errors to
 * `"{category}: {message}"` with a stable, machine-readable category
 * (see `ConnectorV2Error` in `crates/tessera_bridge/src/connectors_v2.rs`).
 * The `transport` category is the framework's AUTHORITATIVE signal that
 * the failure was a transport fault — a reqwest DNS-resolution error,
 * connection refused/reset, TLS reset, or timeout. Unlike the legacy
 * connectors (which wrap every `fetch` failure in `NetworkError`), the
 * napi bridge throws a plain `Error` whose message is reqwest's own
 * phrasing (e.g. `"transport: error sending request … dns error"`).
 * That phrasing does not reliably match the host's English
 * `NETWORK_MESSAGE_PATTERNS`, so a v2 network failure could otherwise
 * surface as a hard error instead of the Offline badge — the exact
 * inconsistency flagged in review. Mapping the `transport` category to
 * the branded class makes `isNetworkError` return `true` regardless of
 * the underlying transport library's wording.
 *
 * Always throws; declared `never` so callers can treat it as terminal.
 */
function rethrowV2BridgeError(provider: ProviderId, err: unknown): never {
  if (err instanceof Error && /^transport:/i.test(err.message)) {
    throw new NetworkError(
      `Network error during ${provider} v2 sync: ${err.message}`,
      { cause: err },
    );
  }
  throw err;
}

/**
 * Token shape exchanged with the Rust bridge (`TokenWire`). Field
 * names match the serde contract on the Rust struct exactly.
 */
export interface TokenWire {
  access_token: string;
  refresh_token?: string | null;
  /** RFC3339 expiry timestamp. */
  expires_at: string;
  scope: string;
  token_type: string;
}

/** One fetched document returned by a v2 sync (`FetchedDocV2`). */
export interface FetchedDocV2 {
  document_id: string;
  event_kind: "created" | "updated" | "deleted" | "permission_changed";
  title?: string | null;
  mime_type?: string | null;
  source_url?: string | null;
  /** Base64-encoded body; absent for deletions / metadata-only events. */
  body_base64?: string | null;
  metadata?: unknown;
}

/** Result of one v2 sync run (`SyncOutcome`). */
export interface SyncOutcome {
  created: number;
  updated: number;
  deleted: number;
  permission_changed: number;
  next_cursor?: string | null;
  documents: FetchedDocV2[];
  warnings?: string[];
  /**
   * Source-side document ids whose body was not materialised this run
   * (the per-run `max_fetch` budget was exhausted, or a transient fetch
   * error occurred) and must be re-fetched on a future run. The host
   * persists this list and feeds it back as the next run's `pending`
   * backlog so the cursor advancing past them never loses their content.
   */
  pending_fetch?: string[];
}

/**
 * Bridge hooks the adapter needs to materialise fetched documents into
 * the local index. Mirrors the `BridgeHooks` the legacy connectors
 * use, kept structural so tests can supply an in-memory fake.
 */
export interface V2BridgeHooks {
  addLocalFile(localPath: string): { id: string; path: string };
  reindexSource(sourceId: string): void;
  removeSource(sourceId: string): void;
  listSources(): Array<{ id: string; path: string }>;
}

/**
 * The subset of {@link NativeBridge} the adapter calls. Declared
 * structurally (not by importing the optional methods directly) so a
 * caller can pass any object exposing these, and so the presence check
 * in {@link v2BridgeAvailable} is the single gate.
 */
export type V2NativeBridge = Pick<
  NativeBridge,
  | "bridgeConnectorsV2List"
  | "bridgeConnectorsV2Supported"
  | "bridgeConnectorsV2Authenticate"
  | "bridgeConnectorsV2Refresh"
  | "bridgeConnectorsV2Sync"
  | "bridgeConnectorsV2Probe"
>;

/**
 * Tessera-owned v2 sync-state file shape. The connector's opaque
 * `SyncState` fields (`connector`/`mode`/`cursor`/`last_synced_at`/
 * `status`/`last_error`) are the contract the Rust side reads; the
 * `tessera_`-prefixed fields are host-private and ignored by the Rust
 * deserialiser (`SyncState` does not deny unknown fields), so the two
 * concerns share one file without a second on-disk format.
 */
interface V2StateFile {
  cursor: string | null;
  /** Deferred-fetch backlog (document ids) carried across runs. */
  tessera_pending_fetch?: string[];
  [key: string]: unknown;
}

/**
 * Whether the native addon in this build exposes the v2 connector
 * functions. A `tessera_bridge` compiled without the `connectors-v2`
 * feature (or an older shipped addon) will not, and the caller must
 * fall back to the legacy path.
 */
export function v2BridgeAvailable(bridge: V2NativeBridge): boolean {
  return (
    typeof bridge.bridgeConnectorsV2Sync === "function" &&
    typeof bridge.bridgeConnectorsV2Supported === "function"
  );
}

/**
 * Translate keychain `StoredTokens` into the Rust `TokenWire` JSON
 * contract. `expiresAt` is epoch-millis in the vault; `TokenWire`
 * wants an RFC3339 string.
 */
export function storedToWire(tokens: StoredTokens): TokenWire {
  return {
    access_token: tokens.accessToken,
    refresh_token: tokens.refreshToken ?? null,
    expires_at: new Date(tokens.expiresAt).toISOString(),
    scope: tokens.scopes.join(" "),
    token_type: "Bearer",
  };
}

/**
 * Merge a refreshed/issued `TokenWire` back onto the existing keychain
 * record, preserving the client credentials (which `TokenWire` does
 * not carry) and healing a missing refresh token to the prior value.
 */
export function wireToStored(
  wire: TokenWire,
  previous: StoredTokens | null,
): StoredTokens {
  const expiresAtMs = Date.parse(wire.expires_at);
  return {
    accessToken: wire.access_token,
    refreshToken: wire.refresh_token ?? previous?.refreshToken ?? null,
    expiresAt: Number.isFinite(expiresAtMs) ? expiresAtMs : Date.now(),
    scopes: wire.scope.length > 0 ? wire.scope.split(/\s+/) : (previous?.scopes ?? []),
    clientId: previous?.clientId,
    clientSecret: previous?.clientSecret,
    // A refresh/exchange never re-collects per-target config, so carry
    // the previously-stored bag (Asana project, Teams team/channel, …)
    // forward unchanged.
    connectorConfig: previous?.connectorConfig,
  };
}

/**
 * Build the provider-specific `auth_config` object the Rust connector
 * needs. Pulls the OAuth endpoint + scope from the canonical
 * `PROVIDER_OAUTH_CONFIGS` and the client credentials from the
 * keychain-stored token record. Never includes the access/refresh
 * token — those travel separately as `TokenWire`.
 *
 * Per-target / non-OAuth2 providers (Asana, GitLab, Teams, Trello)
 * additionally inject their connect-time config (`connectorConfig`) into
 * the bag under the exact `auth_config_json` field names the upstream
 * connector reads (e.g. Trello `key`/`board_id`, GitLab `project_id`,
 * Asana `project`, Teams `team_id`/`channel_id`). The field that carries
 * the credential for a `connectMethod: "token"` provider (GitLab's PAT,
 * Trello's user token) is deliberately NOT injected here — it travels as
 * the access token in `TokenWire` instead — so `authConfigFields`
 * filters it out. Empty/absent values are skipped so the connector's
 * own "field is required" validation produces the clear error rather
 * than receiving an empty string.
 */
export function buildAuthConfig(
  provider: ProviderId,
  tokens: StoredTokens | null,
): Record<string, unknown> {
  const oauth = getProviderOAuthConfig(provider);
  const bag: Record<string, unknown> = {
    provider,
    token_url: oauth.tokenUrl,
    auth_url: oauth.authUrl,
    // Full requested scope set (API scopes + `offline_access` when the
    // provider declares `requestOfflineAccess`), so the Rust connector's
    // own refresh exchange asks for the same scopes the browser grant did.
    scope: getRequestedScopes(oauth).join(" "),
    client_id: tokens?.clientId ?? "",
    // The Rust side prefers a registered ClientSecretResolver; the
    // secret is included here only as the dev/standalone fallback and
    // is never logged.
    client_secret: tokens?.clientSecret ?? "",
    redirect_uri: `http://${oauth.redirectHost ?? "127.0.0.1"}:${oauth.redirectPort}/callback`,
  };
  const config = tokens?.connectorConfig;
  if (config) {
    for (const field of authConfigFields(provider)) {
      const value = config[field.key];
      if (typeof value === "string" && value.length > 0) {
        bag[field.key] = value;
      }
    }
  }
  return bag;
}

/**
 * Choose a file extension for a fetched document from its MIME type,
 * defaulting to `.md` (the local indexer treats unknown text as
 * Markdown). Kept deliberately small — the substrate normalises most
 * provider content to Markdown/plain text before returning it.
 */
function extensionForMime(mime: string | null | undefined): string {
  switch (mime) {
    case "text/html":
      return ".html";
    case "text/plain":
      return ".txt";
    case "application/json":
      return ".json";
    case "application/pdf":
      return ".pdf";
    case "text/csv":
      return ".csv";
    case "text/markdown":
    case "text/x-markdown":
    default:
      return ".md";
  }
}

/**
 * Ingest a single fetched document into the local index: write the
 * decoded body to the provider's sync directory, register/re-index it
 * as a local-file source, and return the manifest entry. Returns
 * `null` for documents with no body (e.g. metadata-only events).
 */
async function ingestDocument(
  provider: ProviderId,
  dir: string,
  doc: FetchedDocV2,
  hooks: V2BridgeHooks,
  sourceIndex: SourcePathIndex,
): Promise<SyncManifestEntry | null> {
  if (!doc.body_base64) return null;
  const ext = extensionForMime(doc.mime_type);
  const fileName = `${sanitiseRemoteId(doc.document_id)}${ext}`;
  const localPath = path.join(dir, fileName);
  const body = Buffer.from(doc.body_base64, "base64");
  await fsp.writeFile(localPath, body);

  const existing = sourceIndex.get(localPath);
  if (existing) {
    hooks.reindexSource(existing.id);
  } else {
    const source = hooks.addLocalFile(localPath);
    sourceIndex.add({ id: source.id, path: source.path });
  }

  return {
    localPath,
    remoteId: doc.document_id,
    remoteModifiedAt: null,
    contentHash: undefined,
  };
}

/**
 * Path of the opaque v2 sync-state file for a provider. Separate from
 * the legacy connectors' `state.json` so the two backends never read
 * each other's cursor format.
 */
export function v2StatePath(userDataDir: string, provider: ProviderId): string {
  return path.join(syncDirFor(userDataDir, provider), "v2-state.json");
}

/**
 * Read the persisted v2 sync-state JSON for the provider, or `null`
 * when none exists yet (first sync). Returned verbatim as a string —
 * the Rust side is the only component that interprets the cursor.
 */
export async function readV2State(
  userDataDir: string,
  provider: ProviderId,
): Promise<string | null> {
  try {
    const raw = await fsp.readFile(v2StatePath(userDataDir, provider), "utf8");
    return raw.trim().length > 0 ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Read the deferred-fetch backlog (document ids) persisted alongside the
 * cursor in the v2-state file. Returns an empty array when there is no
 * state yet, the file is unreadable, or it carries no backlog. The Rust
 * side drains these first on the next run (see
 * {@link SyncOutcome.pending_fetch}).
 */
export async function readV2Pending(
  userDataDir: string,
  provider: ProviderId,
): Promise<string[]> {
  try {
    const raw = await fsp.readFile(v2StatePath(userDataDir, provider), "utf8");
    if (raw.trim().length === 0) return [];
    const parsed = JSON.parse(raw) as V2StateFile;
    const pending = parsed.tessera_pending_fetch;
    return Array.isArray(pending)
      ? pending.filter((id): id is string => typeof id === "string")
      : [];
  } catch {
    return [];
  }
}

/**
 * Persist the connector sync-state for the next incremental run.
 *
 * Initial-vs-incremental contract with the Rust side: the Rust
 * `run_sync` decides whether to call `initial_sync` or
 * `incremental_sync` purely from the state it reads (see
 * `crates/tessera_bridge/src/connectors_v2.rs` — `is_initial` is
 * `mode == Full && cursor.is_none() && last_synced_at.is_none()`).
 *
 *   - On the very first sync, {@link readV2State} returns `null`, the
 *     Rust side constructs a fresh `SyncState::new` (`mode: Full`,
 *     no cursor, no timestamp) and runs the INITIAL sync.
 *   - Every run thereafter reads the state written here. Because this
 *     writer always emits `mode: "incremental"` and a `last_synced_at`,
 *     `is_initial` is false and the Rust side runs an INCREMENTAL sync.
 *
 * So a persisted state file is itself the "initial sync already
 * happened" marker; deleting it (e.g. on disconnect via
 * {@link purgeSyncDir}) correctly forces the next sync back to initial.
 *
 * The `connector` field is a placeholder all-zero UUID: the Rust `sync`
 * entry point pins it to the deterministically-resolved instance id on
 * every call, so only `cursor` / `mode` / `last_synced_at` carry
 * forward meaningfully.
 *
 * `pendingFetch` is the deferred-fetch backlog returned by the run
 * (document ids whose bodies were not materialised yet). It is stored
 * under the host-private `tessera_pending_fetch` key — the Rust
 * `SyncState` deserialiser ignores unknown fields, so it round-trips
 * harmlessly through the state the Rust side reads back as `state_json`,
 * while the host passes it explicitly as the next run's `pending`
 * backlog. An empty backlog omits the key entirely.
 */
export async function writeV2State(
  userDataDir: string,
  provider: ProviderId,
  nextCursor: string | null,
  pendingFetch: string[] = [],
): Promise<void> {
  const dir = syncDirFor(userDataDir, provider);
  await fsp.mkdir(dir, { recursive: true });
  const state: V2StateFile & Record<string, unknown> = {
    connector: "00000000-0000-0000-0000-000000000000",
    mode: "incremental" as const,
    cursor: nextCursor,
    last_synced_at: new Date().toISOString(),
    status: "succeeded" as const,
    last_error: null,
  };
  if (pendingFetch.length > 0) {
    state.tessera_pending_fetch = pendingFetch;
  }
  await fsp.writeFile(
    v2StatePath(userDataDir, provider),
    JSON.stringify(state),
    "utf8",
  );
}

/**
 * Run one v2 sync pass for `provider` and ingest the results into the
 * local index. Returns the renderer-facing {@link ConnectorSyncResult}
 * (the same shape the legacy connectors return) plus the cursor to
 * persist for the next incremental run.
 *
 * `state` carries the connector's persisted sync state JSON (cursor +
 * mode) from the previous run; `null` triggers an initial sync.
 */
export async function runV2Sync(args: {
  provider: ProviderId;
  bridge: V2NativeBridge;
  hooks: V2BridgeHooks;
  tokens: StoredTokens;
  userDataDir: string;
  /** Persisted connector sync-state JSON, or null for first sync. */
  stateJson: string | null;
  scopeId: string | null;
  fetchContent?: boolean;
  maxFetch?: number;
  /**
   * Deferred-fetch backlog (document ids) from the previous run. The
   * Rust side drains these first within the `maxFetch` budget; defaults
   * to empty.
   */
  pending?: string[];
}): Promise<{
  result: ConnectorSyncResult;
  nextCursor: string | null;
  warnings: string[];
  /** Updated deferred-fetch backlog for the host to persist. */
  pendingFetch: string[];
}> {
  const { provider, bridge, hooks, tokens, userDataDir } = args;
  if (typeof bridge.bridgeConnectorsV2Sync !== "function") {
    throw new Error(
      `v2 connector bridge unavailable for ${provider}; ` +
        "rebuild tessera_bridge with the connectors-v2 feature or " +
        "set useV2Connectors=false to use the legacy path.",
    );
  }

  const authConfig = buildAuthConfig(provider, tokens);
  const wire = storedToWire(tokens);

  let outcomeJson: string;
  try {
    // The bridge returns a Promise (napi `AsyncTask`): the blocking
    // HTTP sync runs on a libuv worker thread so the main process
    // event loop stays responsive. `await` here also unifies error
    // handling — both a synchronous throw during the call and a
    // rejected promise land in this `catch`.
    outcomeJson = await bridge.bridgeConnectorsV2Sync(
      provider,
      JSON.stringify(authConfig),
      JSON.stringify(wire),
      args.stateJson,
      args.scopeId,
      args.fetchContent ?? true,
      args.maxFetch ?? null,
      JSON.stringify(args.pending ?? []),
    );
  } catch (err) {
    // Map an authoritative `transport:` framework error to the branded
    // NetworkError so the shared `runConnectorSync` wrapper degrades to
    // the Offline badge instead of a hard error. Non-transport errors
    // (auth, parse, sync) propagate unchanged.
    rethrowV2BridgeError(provider, err);
  }
  const outcome = JSON.parse(outcomeJson) as SyncOutcome;

  const dir = syncDirFor(userDataDir, provider);
  await fsp.mkdir(dir, { recursive: true });

  const priorManifest = await readManifest(userDataDir, provider);
  const sourceIndex = SourcePathIndex.fromBridge(hooks);

  const newEntries: SyncManifestEntry[] = [];
  const seenRemoteIds = new Set<string>();
  let added = 0;
  let modified = 0;
  let removed = 0;

  const priorById = new Map<string, SyncManifestEntry>();
  for (const e of priorManifest.entries) priorById.set(e.remoteId, e);

  for (const doc of outcome.documents) {
    if (doc.event_kind === "deleted") {
      const prior = priorById.get(doc.document_id);
      if (prior) {
        const src = sourceIndex.get(prior.localPath);
        if (src) {
          hooks.removeSource(src.id);
          sourceIndex.remove(prior.localPath);
        }
        await fsp.rm(prior.localPath, { force: true });
        removed += 1;
      }
      seenRemoteIds.add(doc.document_id);
      continue;
    }

    const prior = priorById.get(doc.document_id);
    const entry = await ingestDocument(provider, dir, doc, hooks, sourceIndex);
    if (entry) {
      // MIME-change orphan cleanup: the local filename is derived from
      // the document id + an extension chosen from its MIME type. If a
      // document's MIME type changes between syncs (e.g. text/markdown
      // → text/plain), the new body lands at a DIFFERENT path. Without
      // this, the old file and its bridge source would linger until
      // disconnect — `ingestDocument` keys the source index on the new
      // path and so registers a second source, never reclaiming the
      // first. Remove the stale source + file now; the manifest entry
      // itself is already replaced below (the new entry is pushed and
      // the remote id marked seen, so the old entry is not carried
      // forward).
      if (prior && prior.localPath !== entry.localPath) {
        const staleSrc = sourceIndex.get(prior.localPath);
        if (staleSrc) {
          try {
            hooks.removeSource(staleSrc.id);
          } catch {
            // best-effort: a source the user already removed manually
            // must not abort the rest of the sync.
          }
          sourceIndex.remove(prior.localPath);
        }
        await fsp.rm(prior.localPath, { force: true });
      }
      newEntries.push(entry);
      seenRemoteIds.add(doc.document_id);
      if (prior) modified += 1;
      else added += 1;
    }
  }

  // Carry forward prior manifest entries that this (incremental) pass
  // did not touch, so a partial sync never drops still-valid index
  // entries. Entries explicitly deleted above are excluded.
  for (const prior of priorManifest.entries) {
    if (!seenRemoteIds.has(prior.remoteId)) newEntries.push(prior);
  }

  const manifest: SyncManifest = {
    version: 1,
    provider,
    entries: newEntries,
  };
  await writeManifest(userDataDir, manifest);

  return {
    result: { added, modified, removed, status: "synced" },
    nextCursor: outcome.next_cursor ?? null,
    warnings: outcome.warnings ?? [],
    pendingFetch: outcome.pending_fetch ?? [],
  };
}

/** Outcome of a read-only connection probe (`ProbeOutcome`). */
export interface ProbeOutcome {
  /**
   * Number of change events the connector surfaced on its first
   * authenticated read — a reachability/authorisation signal (the token
   * + target resolved and the provider answered), NOT a census of the
   * account. Document bodies are never fetched during a probe.
   */
  observed_events: number;
}

/**
 * Run a read-only connection probe for `provider` using a candidate
 * token + connect config, WITHOUT persisting anything. Backs the
 * `connectors:test` IPC: the host builds a {@link StoredTokens}-shaped
 * credential from the values the user just entered (never yet written
 * to the vault), and this confirms they can reach the provider — and,
 * for per-target connectors, the configured project/board/channel —
 * before the user commits to connecting.
 *
 * The probe reuses the SAME `auth_config` + `TokenWire` translation as
 * {@link runV2Sync} (via {@link buildAuthConfig} / {@link storedToWire})
 * so a successful probe is a faithful predictor of a successful sync.
 * It is a general capability of the connector layer — not a per-provider
 * hack — because it delegates to the upstream connector's own
 * authenticated read path on the Rust side.
 *
 * Transport failures are re-branded as {@link NetworkError} (mirroring
 * {@link runV2Sync}) so the caller can distinguish "couldn't reach the
 * network" from "the provider rejected the credentials".
 */
export async function runV2Probe(args: {
  provider: ProviderId;
  bridge: V2NativeBridge;
  tokens: StoredTokens;
  scopeId: string | null;
}): Promise<ProbeOutcome> {
  const { provider, bridge, tokens, scopeId } = args;
  if (typeof bridge.bridgeConnectorsV2Probe !== "function") {
    throw new Error(
      `v2 connector bridge unavailable for ${provider}; ` +
        "rebuild tessera_bridge with the connectors-v2 feature to use " +
        "the connection probe.",
    );
  }
  const authConfig = buildAuthConfig(provider, tokens);
  const wire = storedToWire(tokens);
  let outcomeJson: string;
  try {
    outcomeJson = await bridge.bridgeConnectorsV2Probe(
      provider,
      JSON.stringify(authConfig),
      JSON.stringify(wire),
      scopeId,
    );
  } catch (err) {
    rethrowV2BridgeError(provider, err);
  }
  return JSON.parse(outcomeJson) as ProbeOutcome;
}

/**
 * Disconnect cleanup for a v2 provider: unhook every bridge source the
 * provider registered (matched by the manifest's local paths), then
 * purge the provider's sync directory (files + manifest + v2 state).
 * Mirrors the legacy `disconnect<Provider>` helpers so the renderer's
 * disconnect UX is identical regardless of backend.
 *
 * Returns the count of bridge sources actually removed (not the
 * manifest length) so the caller can include it in the
 * `ConnectorDisconnected` audit event.
 */
export async function disconnectV2Provider(
  provider: ProviderId,
  userDataDir: string,
  hooks: V2BridgeHooks,
): Promise<{ filesRemoved: number }> {
  const manifest = await readManifest(userDataDir, provider);
  const localPaths = new Set(manifest.entries.map((e) => e.localPath));
  let filesRemoved = 0;
  for (const source of hooks.listSources()) {
    if (localPaths.has(source.path)) {
      try {
        hooks.removeSource(source.id);
        filesRemoved += 1;
      } catch {
        // best-effort: a source the user already removed manually
        // must not abort the rest of the cleanup.
      }
    }
  }
  await purgeSyncDir(userDataDir, provider);
  return { filesRemoved };
}
