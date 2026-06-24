/**
 * Shared type declarations for the Tessera KChat extension.
 *
 * These types describe the wire format Tessera's localhost API server
 * (`apps/desktop/electron/kchat/kchatLocalApi.ts`) exchanges with the
 * extension. Tessera owns the canonical schema; this file is a
 * hand-rolled mirror because the extension has no build-time
 * dependency on Tessera's main-process bundle.
 */

/** Source kinds Tessera tracks for a KChat channel. */
export type TesseraSourceKind = "kchat-channel" | "kchat-thread";

/** Indexing state reported by Tessera for a single KChat source. */
export type TesseraSourceState = "idle" | "ingesting" | "ready" | "error";

/**
 * One row in `GET /api/sources`. The extension's rightbar view renders
 * this as a list item; the `tesseraDeeplink` (a `tessera://source/<id>`
 * URL) is what `shell.openExternal()` invokes when the user clicks the
 * row.
 */
export interface TesseraKchatSourceRow {
  sourceId: string;
  kind: TesseraSourceKind;
  channelId: string;
  channelName: string;
  teamId: string | null;
  state: TesseraSourceState;
  lastSyncedAt: string | null;
  errorMessage: string | null;
  tesseraDeeplink: string;
}

/** Response body of `GET /api/status`. */
export interface TesseraLocalApiStatus {
  tesseraVersion: string;
  connected: boolean;
  serverUrl: string | null;
  indexedChannelCount: number;
  lastEventAt: string | null;
  capabilities: readonly string[];
}

/** Request body of `POST /api/ingest-channel`. */
export interface IngestChannelRequest {
  channelId: string;
  teamId?: string;
  /**
   * The extension always sends the human-readable channel name so
   * Tessera's audit row carries useful context even when the
   * subsequent REST fetch happens to fail.
   */
  channelName: string;
}

/** Response body of `POST /api/ingest-channel`. */
export interface IngestChannelResponse {
  sourceId: string;
  state: TesseraSourceState;
}

/** Request body of `POST /api/share-artifact`. */
export interface ShareArtifactRequest {
  artifactId: string;
  channelId: string;
  /** Optional message body to prepend to the share card. */
  message?: string;
  /** When true Tessera attaches the evidence-pack ZIP alongside the share. */
  includeEvidence?: boolean;
}

/** Response body of `POST /api/share-artifact`. */
export interface ShareArtifactResponse {
  shareId: string;
  postId: string | null;
  permalink: string | null;
}

/**
 * Standard error envelope for non-2xx responses.
 *
 * Wire codes (mirror of the canonical `LocalApiErrorCode` in
 * `apps/desktop/electron/kchat/kchatLocalApi.ts` — both must stay in
 * sync):
 *
 *   - `unauthorized`        → 401. Bearer token missing or wrong.
 *   - `forbidden`           → 403. Token is fine, but the request is
 *                              rejected on a separate policy grounds
 *                              (currently: non-loopback `Host`
 *                              header). The extension MUST NOT retry
 *                              after a 403/`forbidden` — the request
 *                              is structurally blocked, not stale.
 *                              A 401/`unauthorized`, in contrast, is
 *                              a "refresh the port file and retry"
 *                              signal.
 *   - `invalid_request`     → 400. Malformed payload, headers, URL
 *                              (e.g. wrong Content-Type, empty body,
 *                              schema failure). The body fit in the
 *                              size budget; what's inside is the
 *                              problem.
 *   - `payload_too_large`   → 413. The request body exceeded the
 *                              server's `MAX_BODY_BYTES` (64 KiB).
 *                              Treat as terminal — chunking the
 *                              request will not help, because the
 *                              server has already torn down the read
 *                              stream by the time the 413 lands.
 *   - `not_found`           → 404. Unknown route or resource.
 *   - `rate_limited`        → 429. (Reserved; not currently emitted.)
 *   - `internal_error`      → 500. Uncaught handler exception.
 *   - `tessera_unavailable` → 503. Handler slot not wired yet.
 */
export interface TesseraLocalApiError {
  error: string;
  /** Machine-readable code so the extension can branch UX on it. */
  code:
    | "unauthorized"
    | "forbidden"
    | "invalid_request"
    | "payload_too_large"
    | "not_found"
    | "rate_limited"
    | "internal_error"
    | "tessera_unavailable";
}

/**
 * Shape of `{userData}/tessera-kchat-port.json`, the discovery file
 * Tessera writes when its localhost API server starts. The extension
 * reads it on activation to learn which port + token to use.
 */
export interface TesseraPortFileV1 {
  version: 1;
  host: "127.0.0.1";
  port: number;
  token: string;
  startedAt: string;
  pid: number;
}

/**
 * Minimum acceptable length of the bearer token (in characters) the
 * extension will tolerate before refusing to connect. Tessera's
 * server always mints a 43-character base64url-encoded 256-bit
 * value (`crypto.randomBytes(32).toString("base64url")`), so any
 * length below this constant indicates either a corrupted port file
 * or a hostile actor planting a guessable token. The portFile reader
 * AND the client constructor both reject below this threshold so a
 * test seam that bypasses `readPortFile` (e.g. `props.client` in
 * the sources-panel view) can't accidentally widen the contract.
 */
export const MIN_TOKEN_LENGTH = 32;
