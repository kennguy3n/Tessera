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
import {
  getProviderOAuthConfig,
  type ProviderId,
} from "./providerOAuth";
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
import type { ConnectorSyncResult } from "./handlers";

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
>;

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
  };
}

/**
 * Build the provider-specific `auth_config` object the Rust connector
 * needs. Pulls the OAuth endpoint + scope from the canonical
 * `PROVIDER_OAUTH_CONFIGS` and the client credentials from the
 * keychain-stored token record. Never includes the access/refresh
 * token — those travel separately as `TokenWire`.
 */
export function buildAuthConfig(
  provider: ProviderId,
  tokens: StoredTokens | null,
): Record<string, unknown> {
  const oauth = getProviderOAuthConfig(provider);
  return {
    provider,
    token_url: oauth.tokenUrl,
    auth_url: oauth.authUrl,
    scope: oauth.scope,
    client_id: tokens?.clientId ?? "",
    // The Rust side prefers a registered ClientSecretResolver; the
    // secret is included here only as the dev/standalone fallback and
    // is never logged.
    client_secret: tokens?.clientSecret ?? "",
    redirect_uri: `http://${oauth.redirectHost ?? "127.0.0.1"}:${oauth.redirectPort}/callback`,
  };
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
 */
export async function writeV2State(
  userDataDir: string,
  provider: ProviderId,
  nextCursor: string | null,
): Promise<void> {
  const dir = syncDirFor(userDataDir, provider);
  await fsp.mkdir(dir, { recursive: true });
  const state = {
    connector: "00000000-0000-0000-0000-000000000000",
    mode: "incremental" as const,
    cursor: nextCursor,
    last_synced_at: new Date().toISOString(),
    status: "succeeded" as const,
    last_error: null,
  };
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
}): Promise<{
  result: ConnectorSyncResult;
  nextCursor: string | null;
  warnings: string[];
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

  const outcomeJson = bridge.bridgeConnectorsV2Sync(
    provider,
    JSON.stringify(authConfig),
    JSON.stringify(wire),
    args.stateJson,
    args.scopeId,
    args.fetchContent ?? true,
    args.maxFetch ?? null,
  );
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

    const wasPresent = priorById.has(doc.document_id);
    const entry = await ingestDocument(provider, dir, doc, hooks, sourceIndex);
    if (entry) {
      newEntries.push(entry);
      seenRemoteIds.add(doc.document_id);
      if (wasPresent) modified += 1;
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
  };
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
