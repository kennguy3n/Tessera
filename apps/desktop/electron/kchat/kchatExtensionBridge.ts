/**
 * uney-chat-desktop extension bridge — discovery + transport.
 *
 * Phase 13 Task 1. Tessera can run as an *extension* of a
 * locally-running `uney-chat-desktop` instance: when the desktop
 * app is up, Tessera delegates auth to its authenticated session
 * instead of requiring a personal access token. When the desktop
 * app is not running, Tessera falls back to the existing PAT path
 * (see `kchatAuth.ts`).
 *
 * This module owns the *transport* layer:
 *
 *   1. Per-platform well-known socket discovery
 *      (`extensionSocketPath()`):
 *        - Linux:   `$XDG_RUNTIME_DIR/tessera-kchat-extension.sock`
 *                   (fallback `/tmp/tessera-kchat-extension-<uid>.sock`
 *                    when `XDG_RUNTIME_DIR` is unset).
 *        - macOS:   `~/Library/Application Support/Tessera/
 *                    tessera-kchat-extension.sock`
 *        - Windows: `\\.\pipe\tessera-kchat-extension`
 *      (Phase 13 Task 30 wires the Linux path to `XDG_RUNTIME_DIR`;
 *      the macOS / Windows paths follow the same per-platform shape
 *      `dbKey.ts` already uses for the SQLCipher key blob.)
 *
 *   2. Lightweight availability probe (`probeExtension`). Opens
 *      the socket, sends a `discover` frame, waits for an `ok`
 *      response with a short timeout, then closes. Returns
 *      `{ available: true, ... }` or `{ available: false }` —
 *      a connection error means the desktop app is not running
 *      OR did not expose the extension surface in this build.
 *
 *   3. Long-lived `ExtensionConnection` for the active session
 *      (handshake, token, events). NDJSON wire format (one JSON
 *      object per line, max 1 MiB / frame).
 *
 * **Trust model**: Tessera trusts the desktop app's authenticated
 * session (the user authenticated to KChat through the desktop app
 * and explicitly granted the extension access; Tessera receives a
 * scoped, time-limited delegation token that the desktop app
 * minted). But every frame coming back across the boundary is
 * validated for shape / size / SSRF, exactly as the renderer ↔
 * main IPC surface is. The bridge is otherwise inert — it does not
 * touch the filesystem, does not touch the token vault, does not
 * run a server. It speaks the protocol and surfaces typed events
 * to its caller (`kchatExtensionSession.ts`,
 * `kchatExtensionEvents.ts`).
 */

import * as os from "os";
import * as net from "net";
import * as path from "path";

/** Maximum size of a single NDJSON frame (1 MiB). */
export const MAX_EXTENSION_FRAME_BYTES = 1024 * 1024;

/** Default discovery probe timeout (ms). */
export const DEFAULT_PROBE_TIMEOUT_MS = 500;

/** Default request/response timeout for in-session calls (ms). */
export const DEFAULT_REQUEST_TIMEOUT_MS = 5_000;

/**
 * NDJSON frame shapes that cross the extension boundary. Every
 * frame is `{type: string, ...}`; the discriminator drives the
 * decoder. The frames are *symmetric* — the bridge sends some and
 * the desktop app sends others, but the shape namespace is shared.
 */
export type ExtensionFrame =
  | DiscoverRequestFrame
  | DiscoverResponseFrame
  | HandshakeRequestFrame
  | HandshakeResponseFrame
  | TokenRefreshRequestFrame
  | TokenRefreshResponseFrame
  | SubscribeEventsRequestFrame
  | SubscribeEventsResponseFrame
  | EventFrame
  | PingFrame
  | PongFrame
  | DisconnectFrame;

export interface DiscoverRequestFrame {
  type: "discover";
  /** Identifies which Tessera build is probing. */
  tesseraVersion: string;
  requestId: string;
}

export interface DiscoverResponseFrame {
  type: "discover_response";
  requestId: string;
  ok: boolean;
  /** Highest extension-protocol version the desktop app speaks. */
  protocolVersion: number;
  /** Human-readable desktop app version. */
  desktopVersion: string;
  /**
   * Capabilities the desktop app advertises. Tessera only uses
   * the subset it understands; new capabilities can be added
   * without breaking older Tessera builds.
   */
  capabilities: string[];
}

export interface HandshakeRequestFrame {
  type: "handshake";
  requestId: string;
  /** Identifies which Tessera build is asking for delegation. */
  tesseraVersion: string;
  /**
   * Scope the desktop app should mint into the delegation token.
   * The desktop app may downgrade if it doesn't recognise a
   * requested scope, but never upgrade — Tessera receives exactly
   * the intersection of what it asked for and what the desktop
   * app supports.
   */
  scopesRequested: string[];
}

export interface HandshakeResponseFrame {
  type: "handshake_response";
  requestId: string;
  ok: boolean;
  /** Present only on `ok: false`. */
  error?: string;
  /** Authenticated KChat user the delegation grants access as. */
  user?: {
    id: string;
    username: string;
    email: string;
    firstName: string;
    lastName: string;
  };
  /** Scoped, time-limited token Tessera stores under `kchat:extension`. */
  token?: string;
  /** Wall-clock expiry of the delegation token (ms since epoch). */
  expiresAtMs?: number;
  /** KChat server URL the delegated session is bound to. */
  serverUrl?: string;
  /** Final scope set granted (intersection of requested and supported). */
  scopesGranted?: string[];
}

export interface TokenRefreshRequestFrame {
  type: "token_refresh";
  requestId: string;
}

export interface TokenRefreshResponseFrame {
  type: "token_refresh_response";
  requestId: string;
  ok: boolean;
  /** Present only on `ok: false`. */
  error?: string;
  token?: string;
  expiresAtMs?: number;
}

export interface SubscribeEventsRequestFrame {
  type: "subscribe_events";
  requestId: string;
}

export interface SubscribeEventsResponseFrame {
  type: "subscribe_events_response";
  requestId: string;
  ok: boolean;
  error?: string;
}

/**
 * Event push frame. Sent by the desktop app *after* the
 * subscriber acknowledges. The shape is pre-translated to
 * Tessera's existing `KchatWebSocketEventView` semantics so the
 * downstream `KchatEventForwarder` consumes it unchanged.
 *
 * `event` is one of Tessera's Mattermost-style event names
 * (`posted`, `post_edited`, `post_deleted`, `file_added`,
 * `user_added`, `user_removed`, `channel_member_updated`,
 * `channel_deleted`, …). The desktop app's native event names
 * (`message:received`, `conversation:participant_added`, …) are
 * mapped to these by `kchatExtensionEvents.ts`.
 */
export interface EventFrame {
  type: "event";
  event: string;
  channelId: string | null;
  teamId: string | null;
  userId: string | null;
  seq: number;
  data: Record<string, unknown>;
}

export interface PingFrame {
  type: "ping";
  requestId: string;
}

export interface PongFrame {
  type: "pong";
  requestId: string;
}

export interface DisconnectFrame {
  type: "disconnect";
  /** Why the desktop app is ending the session (logged, never surfaced as PAT-style auth error). */
  reason: string;
}

/**
 * Return the well-known extension socket path for this platform.
 * Phase 13 Task 30: per-platform shape following the same pattern
 * `dbKey.ts` uses for the SQLCipher key blob location.
 */
export function extensionSocketPath(): string {
  const platform = process.platform;
  if (platform === "win32") {
    return "\\\\.\\pipe\\tessera-kchat-extension";
  }
  if (platform === "darwin") {
    const home = os.homedir();
    return path.join(
      home,
      "Library",
      "Application Support",
      "Tessera",
      "tessera-kchat-extension.sock",
    );
  }
  // Linux (and any other Unix-y platform). Prefer
  // `$XDG_RUNTIME_DIR` per freedesktop.org base-dir spec; it is
  // guaranteed to be a per-user tmpfs cleaned on logout, which is
  // the correct location for an ephemeral IPC socket. Fall back to
  // `/tmp/tessera-kchat-extension-<uid>.sock` (uid-suffixed to
  // avoid collisions on multi-user systems) when the variable is
  // unset — minimal containers and some CI runners don't set it.
  const xdgRuntime = process.env.XDG_RUNTIME_DIR;
  if (xdgRuntime && xdgRuntime.length > 0) {
    return path.join(xdgRuntime, "tessera-kchat-extension.sock");
  }
  const uid = typeof process.getuid === "function" ? process.getuid() : 0;
  return path.join(os.tmpdir(), `tessera-kchat-extension-${uid}.sock`);
}

/**
 * Result of `probeExtension`. `available: true` does NOT mean
 * Tessera has been authorised — only that an extension surface
 * exists and Tessera may attempt a handshake. The caller is
 * responsible for surfacing a "connect" affordance in the UI.
 */
export interface ExtensionProbeResult {
  available: boolean;
  /** Present on `available: true`. */
  protocolVersion?: number;
  desktopVersion?: string;
  capabilities?: string[];
  /** Reason the probe failed; `null` on `available: true`. */
  reason?:
    | "no-socket"
    | "connection-refused"
    | "timeout"
    | "protocol-error"
    | "permission-denied";
}

/**
 * Probe the per-platform socket and return whether
 * `uney-chat-desktop` is available. Cheap, side-effect free —
 * opens a socket, sends one `discover` frame, reads the response,
 * and closes.
 *
 * `connect` is injected so tests can supply a fake transport
 * without monkey-patching `net.createConnection`. Production
 * callers should use the default.
 */
export async function probeExtension(
  options: {
    socketPath?: string;
    tesseraVersion?: string;
    timeoutMs?: number;
    connect?: (socketPath: string) => net.Socket;
  } = {},
): Promise<ExtensionProbeResult> {
  const socketPath = options.socketPath ?? extensionSocketPath();
  const tesseraVersion = options.tesseraVersion ?? "tessera/unknown";
  const timeoutMs = options.timeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
  const connectFn = options.connect ?? ((p: string) => net.createConnection(p));

  return new Promise<ExtensionProbeResult>((resolve) => {
    let socket: net.Socket | null = null;
    let buffer = "";
    let settled = false;
    const requestId = randomRequestId();

    const settle = (result: ExtensionProbeResult): void => {
      if (settled) return;
      settled = true;
      try {
        socket?.destroy();
      } catch {
        // intentional — probe is best-effort
      }
      resolve(result);
    };

    try {
      socket = connectFn(socketPath);
    } catch {
      resolve({ available: false, reason: "no-socket" });
      return;
    }

    const timer = setTimeout(() => {
      settle({ available: false, reason: "timeout" });
    }, timeoutMs);

    socket.setEncoding("utf8");
    socket.on("error", (err) => {
      clearTimeout(timer);
      const code =
        err && typeof err === "object" && "code" in err
          ? (err as { code?: string }).code
          : undefined;
      settle({
        available: false,
        reason:
          code === "ENOENT"
            ? "no-socket"
            : code === "ECONNREFUSED"
              ? "connection-refused"
              : code === "EACCES"
                ? "permission-denied"
                : "no-socket",
      });
    });

    socket.on("close", () => {
      clearTimeout(timer);
      settle({ available: false, reason: "no-socket" });
    });

    socket.on("data", (chunk: string) => {
      buffer += chunk;
      if (buffer.length > MAX_EXTENSION_FRAME_BYTES) {
        clearTimeout(timer);
        settle({ available: false, reason: "protocol-error" });
        return;
      }
      const nl = buffer.indexOf("\n");
      if (nl === -1) return;
      const line = buffer.slice(0, nl);
      try {
        const frame = JSON.parse(line) as ExtensionFrame;
        if (
          frame &&
          (frame as DiscoverResponseFrame).type === "discover_response" &&
          (frame as DiscoverResponseFrame).requestId === requestId
        ) {
          const dr = frame as DiscoverResponseFrame;
          clearTimeout(timer);
          if (!dr.ok) {
            settle({ available: false, reason: "protocol-error" });
            return;
          }
          settle({
            available: true,
            protocolVersion: dr.protocolVersion,
            desktopVersion: dr.desktopVersion,
            capabilities: Array.isArray(dr.capabilities)
              ? dr.capabilities.filter((c) => typeof c === "string")
              : [],
          });
        }
      } catch {
        clearTimeout(timer);
        settle({ available: false, reason: "protocol-error" });
      }
    });

    // Once connected, send a single `discover` frame.
    socket.on("connect", () => {
      const req: DiscoverRequestFrame = {
        type: "discover",
        tesseraVersion,
        requestId,
      };
      try {
        socket?.write(JSON.stringify(req) + "\n");
      } catch {
        clearTimeout(timer);
        settle({ available: false, reason: "protocol-error" });
      }
    });
  });
}

/**
 * Long-lived connection to the extension surface. Wraps a Unix
 * domain socket / named pipe with NDJSON framing and an
 * EventEmitter-style listener API. The caller owns the lifecycle:
 *   - `await conn.open()` opens the socket and runs the
 *     discovery handshake.
 *   - `conn.request(frame)` sends a request frame and resolves
 *     with the typed matching response (matched by `requestId`).
 *   - `conn.on('event', ...)` subscribes to `event` frames.
 *   - `conn.close()` tears down the socket.
 */
export class ExtensionConnection {
  private socket: net.Socket | null = null;
  private buffer = "";
  private pendingRequests = new Map<
    string,
    {
      resolve: (frame: ExtensionFrame) => void;
      reject: (err: Error) => void;
      timer: NodeJS.Timeout;
    }
  >();
  private eventListeners = new Set<(frame: EventFrame) => void>();
  private disconnectListeners = new Set<(reason: string) => void>();
  private opened = false;
  private closed = false;

  constructor(
    private readonly opts: {
      socketPath?: string;
      tesseraVersion?: string;
      requestTimeoutMs?: number;
      connect?: (socketPath: string) => net.Socket;
    } = {},
  ) {}

  /** Return `true` when the underlying socket is connected. */
  isOpen(): boolean {
    return this.opened && !this.closed && this.socket !== null;
  }

  /**
   * Open the socket and complete the `discover` handshake. Throws
   * if the desktop app is unreachable or the protocol response is
   * invalid.
   */
  async open(): Promise<DiscoverResponseFrame> {
    if (this.closed) {
      throw new Error("ExtensionConnection: already closed");
    }
    const socketPath = this.opts.socketPath ?? extensionSocketPath();
    const connectFn =
      this.opts.connect ?? ((p: string) => net.createConnection(p));
    const sock = connectFn(socketPath);
    sock.setEncoding("utf8");
    this.socket = sock;
    sock.on("data", (chunk: string) => this.onData(chunk));
    sock.on("error", (err) => this.onError(err));
    sock.on("close", () => this.onClose());
    await new Promise<void>((resolve, reject) => {
      const onErr = (err: Error): void => {
        sock.off("connect", onConn);
        reject(err);
      };
      const onConn = (): void => {
        sock.off("error", onErr);
        resolve();
      };
      sock.once("connect", onConn);
      sock.once("error", onErr);
    });
    this.opened = true;
    const discover = (await this.request<DiscoverResponseFrame>({
      type: "discover",
      tesseraVersion: this.opts.tesseraVersion ?? "tessera/unknown",
      requestId: randomRequestId(),
    })) as DiscoverResponseFrame;
    if (!discover.ok) {
      throw new Error("ExtensionConnection: discover handshake rejected");
    }
    return discover;
  }

  /**
   * Send a request frame and wait for the matching response. The
   * caller supplies a unique `requestId` (or omits it and we
   * generate one). Times out after `requestTimeoutMs`.
   */
  async request<R extends ExtensionFrame>(frame: ExtensionFrame): Promise<R> {
    if (!this.socket || this.closed) {
      throw new Error("ExtensionConnection: not open");
    }
    // Treat both `undefined` and empty-string `requestId` as
    // "generate one for me". Callers that synthesise the frame
    // (`kchatExtensionSession.handshake`) leave the field empty
    // so the dispatch site's truthiness check on `rid` doesn't
    // misroute the response.
    const existingId = (frame as { requestId?: string }).requestId;
    const fid =
      typeof existingId === "string" && existingId.length > 0
        ? existingId
        : randomRequestId();
    (frame as { requestId?: string }).requestId = fid;
    const timeoutMs = this.opts.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS;
    return new Promise<R>((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pendingRequests.delete(fid);
        reject(new Error(`ExtensionConnection: request ${frame.type} timed out`));
      }, timeoutMs);
      this.pendingRequests.set(fid, {
        resolve: (f) => resolve(f as R),
        reject,
        timer,
      });
      try {
        this.socket?.write(JSON.stringify(frame) + "\n");
      } catch (err) {
        clearTimeout(timer);
        this.pendingRequests.delete(fid);
        reject(err instanceof Error ? err : new Error(String(err)));
      }
    });
  }

  /** Subscribe to event-push frames. Returns an unsubscribe fn. */
  onEvent(listener: (frame: EventFrame) => void): () => void {
    this.eventListeners.add(listener);
    return () => {
      this.eventListeners.delete(listener);
    };
  }

  /**
   * Subscribe to disconnect notices from the desktop app
   * (`{type: "disconnect", reason: "..."}` frames). The socket
   * may also close due to OS-level errors; in that case the
   * listener is invoked with `reason: "socket-closed"`.
   */
  onDisconnect(listener: (reason: string) => void): () => void {
    this.disconnectListeners.add(listener);
    return () => {
      this.disconnectListeners.delete(listener);
    };
  }

  /** Tear down the socket. Idempotent. */
  close(): void {
    if (this.closed) return;
    this.closed = true;
    for (const [, pending] of this.pendingRequests) {
      clearTimeout(pending.timer);
      pending.reject(new Error("ExtensionConnection: closed"));
    }
    this.pendingRequests.clear();
    try {
      this.socket?.destroy();
    } catch {
      // intentional — close is best-effort
    }
    this.socket = null;
  }

  private onData(chunk: string): void {
    this.buffer += chunk;
    if (this.buffer.length > MAX_EXTENSION_FRAME_BYTES) {
      // A single frame is over the limit before a `\n` arrived —
      // protocol-violation by the desktop app, drop the connection.
      this.notifyDisconnect("frame-too-large");
      this.close();
      return;
    }
    for (;;) {
      const nl = this.buffer.indexOf("\n");
      if (nl === -1) return;
      const line = this.buffer.slice(0, nl);
      this.buffer = this.buffer.slice(nl + 1);
      if (line.length === 0) continue;
      let frame: ExtensionFrame;
      try {
        frame = JSON.parse(line) as ExtensionFrame;
      } catch {
        this.notifyDisconnect("invalid-json");
        this.close();
        return;
      }
      this.dispatch(frame);
    }
  }

  private dispatch(frame: ExtensionFrame): void {
    switch (frame.type) {
      case "event": {
        for (const l of this.eventListeners) {
          try {
            l(frame);
          } catch {
            // Listeners must not poison the dispatch loop —
            // surface error through the listener's own error
            // boundary (the forwarder's audit-on-throw path).
          }
        }
        return;
      }
      case "disconnect": {
        this.notifyDisconnect(frame.reason || "remote-disconnect");
        this.close();
        return;
      }
      case "ping": {
        // Respond with a `pong` carrying the same requestId.
        try {
          this.socket?.write(
            JSON.stringify({ type: "pong", requestId: frame.requestId } as PongFrame) +
              "\n",
          );
        } catch {
          // Ignored — socket failure surfaces via onError.
        }
        return;
      }
      default: {
        const rid = (frame as { requestId?: string }).requestId;
        if (rid && this.pendingRequests.has(rid)) {
          const pending = this.pendingRequests.get(rid)!;
          this.pendingRequests.delete(rid);
          clearTimeout(pending.timer);
          pending.resolve(frame);
        }
        // Unmatched response frames are ignored — the desktop
        // app may have raced a refresh; the matching pending
        // request has already timed out.
      }
    }
  }

  private onError(_err: Error): void {
    this.notifyDisconnect("socket-error");
    this.close();
  }

  private onClose(): void {
    if (!this.closed) {
      this.notifyDisconnect("socket-closed");
      this.close();
    }
  }

  private notifyDisconnect(reason: string): void {
    for (const l of this.disconnectListeners) {
      try {
        l(reason);
      } catch {
        // intentional — disconnect listeners must not throw
      }
    }
  }
}

function randomRequestId(): string {
  // Crypto-strong is overkill — the requestId is only used for
  // pairing requests with responses inside a single socket. A 64-
  // bit-ish hex string drawn from `Math.random` is plenty.
  const hi = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  const lo = Math.floor(Math.random() * 0xffffffff).toString(16).padStart(8, "0");
  return `req-${hi}${lo}`;
}
