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
export type TesseraSourceState =
  | "idle"
  | "ingesting"
  | "ready"
  | "error";

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

/** Standard error envelope for non-2xx responses. */
export interface TesseraLocalApiError {
  error: string;
  /** Machine-readable code so the extension can branch UX on it. */
  code:
    | "unauthorized"
    | "invalid_request"
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
