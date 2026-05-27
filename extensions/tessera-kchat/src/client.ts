/**
 * Typed HTTP client the extension uses to talk to Tessera's localhost
 * API. The implementation is intentionally framework-free so it runs
 * unchanged inside KChat Desktop's extension sandbox (browser-style
 * `fetch`).
 *
 * All requests:
 *   1. Target `http://127.0.0.1:<port>` discovered from the port file.
 *   2. Carry the bearer token also discovered from the port file.
 *   3. Time out aggressively (5 s) — Tessera runs on the same machine
 *      and a slow response means it's hung / crashed, in which case
 *      the extension should surface "Tessera unavailable" rather than
 *      stall its rightbar view.
 *   4. Reject any redirect — the API is loopback-bound, so a 30x
 *      response would indicate a bug or a hijack attempt.
 */
import type {
  IngestChannelRequest,
  IngestChannelResponse,
  ShareArtifactRequest,
  ShareArtifactResponse,
  TesseraKchatSourceRow,
  TesseraLocalApiError,
  TesseraLocalApiStatus,
  TesseraPortFileV1,
} from "./types";

export class TesseraLocalApiUnavailableError extends Error {
  override readonly name = "TesseraLocalApiUnavailableError";
  constructor(message: string) {
    super(message);
  }
}

export class TesseraLocalApiHttpError extends Error {
  override readonly name = "TesseraLocalApiHttpError";
  constructor(
    public readonly status: number,
    public readonly body: TesseraLocalApiError,
  ) {
    super(`Tessera local API ${status}: ${body.code} (${body.error})`);
  }
}

/** Default per-request timeout. */
export const DEFAULT_TIMEOUT_MS = 5_000;

export interface TesseraLocalApiClientOptions {
  /** Discovery record (port + token) — usually read from the port file. */
  portFile: TesseraPortFileV1;
  /** Override fetch (tests). Default uses globalThis.fetch. */
  fetchImpl?: typeof fetch;
  /** Override per-request timeout. */
  timeoutMs?: number;
}

export class TesseraLocalApiClient {
  private readonly baseUrl: string;
  private readonly token: string;
  private readonly fetchImpl: typeof fetch;
  private readonly timeoutMs: number;

  constructor(opts: TesseraLocalApiClientOptions) {
    if (opts.portFile.host !== "127.0.0.1") {
      throw new TesseraLocalApiUnavailableError(
        "Tessera local API host is not 127.0.0.1; refusing to connect.",
      );
    }
    if (!Number.isInteger(opts.portFile.port) || opts.portFile.port <= 0) {
      throw new TesseraLocalApiUnavailableError(
        "Tessera local API port is invalid.",
      );
    }
    if (!opts.portFile.token || opts.portFile.token.length < 16) {
      throw new TesseraLocalApiUnavailableError(
        "Tessera local API token is missing or too short.",
      );
    }
    this.baseUrl = `http://127.0.0.1:${opts.portFile.port}`;
    this.token = opts.portFile.token;
    this.fetchImpl = opts.fetchImpl ?? globalThis.fetch.bind(globalThis);
    this.timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  }

  status(): Promise<TesseraLocalApiStatus> {
    return this.request<TesseraLocalApiStatus>("GET", "/api/status");
  }

  listSources(): Promise<readonly TesseraKchatSourceRow[]> {
    return this.request<readonly TesseraKchatSourceRow[]>(
      "GET",
      "/api/sources",
    );
  }

  ingestChannel(req: IngestChannelRequest): Promise<IngestChannelResponse> {
    return this.request<IngestChannelResponse>(
      "POST",
      "/api/ingest-channel",
      req,
    );
  }

  shareArtifact(
    req: ShareArtifactRequest,
  ): Promise<ShareArtifactResponse> {
    return this.request<ShareArtifactResponse>(
      "POST",
      "/api/share-artifact",
      req,
    );
  }

  private async request<T>(
    method: "GET" | "POST",
    path: string,
    body?: unknown,
  ): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.timeoutMs);
    try {
      const response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          authorization: `Bearer ${this.token}`,
          accept: "application/json",
          ...(body !== undefined
            ? { "content-type": "application/json" }
            : {}),
        },
        body: body !== undefined ? JSON.stringify(body) : undefined,
        redirect: "error",
        signal: controller.signal,
      });
      if (!response.ok) {
        const errorBody = await safeJson<TesseraLocalApiError>(response, {
          error: response.statusText,
          code: "internal_error",
        });
        throw new TesseraLocalApiHttpError(response.status, errorBody);
      }
      return (await response.json()) as T;
    } catch (err) {
      if (
        err instanceof TesseraLocalApiHttpError ||
        err instanceof TesseraLocalApiUnavailableError
      ) {
        throw err;
      }
      const message =
        err instanceof Error ? err.message : String(err);
      throw new TesseraLocalApiUnavailableError(
        `Tessera local API request failed: ${message}`,
      );
    } finally {
      clearTimeout(timer);
    }
  }
}

async function safeJson<T>(response: Response, fallback: T): Promise<T> {
  try {
    return (await response.json()) as T;
  } catch {
    return fallback;
  }
}
