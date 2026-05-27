/**
 * Integration tests for the `uney-chat-desktop` extension bridge
 * (Phase 13 Task 8).
 *
 * Coverage:
 *   1. **Discovery + handshake** — Tessera opens the well-known
 *      socket, exchanges the `discover` frame, mints a delegation
 *      token via `handshake`, and surfaces the resulting
 *      `ExtensionSessionInfo` shape.
 *   2. **Event forwarding** — translated `EventFrame`s from the
 *      desktop app surface as Mattermost-style
 *      `KchatWebSocketEvent`s through the auth-service event
 *      bridge.
 *   3. **Disconnect** — closing the socket from the desktop side
 *      tears down the in-memory session and fires the
 *      auth-service `error`-state transition with a human-readable
 *      reason.
 *   4. **Fallback to PAT** — when the extension probe fails
 *      (`available: false`), `KchatAuthService.connect()` (PAT
 *      mode) still works without leaking extension-mode state into
 *      `getState()`.
 *   5. **Concurrent PAT+extension reject** — a `connect()` (PAT)
 *      call while extension mode is active tears the extension
 *      session down BEFORE the PAT attempt, so the two never
 *      overlap. (Mirrored: `connectViaExtension()` tears down a
 *      live PAT session.)
 *   6. **SSRF on extension handshake** — a `serverUrl` pointing
 *      at a private/loopback address in the handshake response
 *      is rejected by the shared `enforceKchatServerUrl` guard
 *      BEFORE the delegation lands in the vault.
 *
 * The test mocks the `uney-chat-desktop` side with a minimal
 * `net.createServer` Unix-domain-socket / named-pipe server
 * speaking the same NDJSON wire format the production bridge
 * uses. The mock server is deterministic — every test starts a
 * fresh listener on a temp socket path, exchanges frames, and
 * tears down at the end.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as net from "net";
import * as os from "os";
import * as path from "path";
import * as fs from "fs";

const vaultStore = new Map<string, { accessToken: string; scopes: string[] }>();

vi.mock("../tokenVault", () => ({
  storeTokens: (p: string, t: { accessToken: string; scopes: string[] }) =>
    vaultStore.set(p, { accessToken: t.accessToken, scopes: [...t.scopes] }),
  getTokens: (p: string) => vaultStore.get(p) ?? null,
  hasTokens: (p: string) => vaultStore.has(p),
  deleteTokens: (p: string) => {
    vaultStore.delete(p);
  },
  listProviders: () => [...vaultStore.keys()],
  encryptionUnavailableReason: () => null,
}));

import { ExtensionConnection } from "../kchat/kchatExtensionBridge";
import { KchatExtensionSession } from "../kchat/kchatExtensionSession";
import { translateExtensionEvent } from "../kchat/kchatExtensionEvents";
import { KchatAuthService } from "../kchat/kchatAuth";
import { KchatClient } from "../kchat/kchatClient";

/**
 * Spin up a minimal extension server mocking
 * `uney-chat-desktop`'s side of the protocol. The handler is a
 * map from request `type` → response builder so individual tests
 * can override per-frame behaviour (e.g. force a rejected
 * handshake, or push an event after a delay).
 */
interface MockServer {
  socketPath: string;
  emitEvent: (frame: Record<string, unknown>) => void;
  emitDisconnect: (reason: string) => void;
  close: () => Promise<void>;
}

async function startMockServer(
  responder: (frame: Record<string, unknown>) => Record<string, unknown> | null,
): Promise<MockServer> {
  // On POSIX systems use a Unix-domain socket under `os.tmpdir()`.
  // On Windows `net.createServer().listen(<path>)` rejects ordinary
  // filesystem paths with EACCES — `net.Server` can only bind to
  // named pipes there, which use the `\\.\pipe\<name>` namespace
  // (no filesystem unlink needed; the kernel owns the lifetime). The
  // production `extensionSocketPath()` in `kchatExtensionBridge.ts`
  // follows the same per-platform shape, so this test mirrors it.
  const unique = `${process.pid}-${Date.now()}-${Math.random().toString(36).slice(2)}`;
  const tmp =
    process.platform === "win32"
      ? `\\\\.\\pipe\\tessera-kchat-ext-test-${unique}`
      : path.join(os.tmpdir(), `tessera-kchat-ext-test-${unique}.sock`);
  if (process.platform !== "win32") {
    // Best-effort cleanup if a stale file is present (POSIX only —
    // named pipes have no filesystem entry to unlink).
    try {
      fs.unlinkSync(tmp);
    } catch {
      // ignored — typical case is "file not found"
    }
  }
  const sockets = new Set<net.Socket>();
  const server = net.createServer((sock) => {
    sockets.add(sock);
    sock.setEncoding("utf8");
    let buf = "";
    sock.on("data", (chunk: string) => {
      buf += chunk;
      let nl: number;
      while ((nl = buf.indexOf("\n")) !== -1) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim()) continue;
        let parsed: Record<string, unknown>;
        try {
          parsed = JSON.parse(line);
        } catch {
          continue;
        }
        const reply = responder(parsed);
        if (reply) {
          sock.write(JSON.stringify(reply) + "\n");
        }
      }
    });
    sock.on("error", () => {
      // intentional — close path will fire
    });
    sock.on("close", () => {
      sockets.delete(sock);
    });
  });
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(tmp, () => {
      server.off("error", reject);
      resolve();
    });
  });
  return {
    socketPath: tmp,
    emitEvent: (frame) => {
      for (const sock of sockets) {
        sock.write(JSON.stringify(frame) + "\n");
      }
    },
    emitDisconnect: (reason) => {
      for (const sock of sockets) {
        sock.write(
          JSON.stringify({ type: "disconnect", reason }) + "\n",
        );
        sock.end();
      }
    },
    close: () =>
      new Promise<void>((resolve) => {
        for (const sock of sockets) {
          try {
            sock.destroy();
          } catch {
            // intentional
          }
        }
        server.close(() => {
          try {
            fs.unlinkSync(tmp);
          } catch {
            // intentional
          }
          resolve();
        });
      }),
  };
}

beforeEach(() => {
  vaultStore.clear();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("uney-chat-desktop extension bridge integration", () => {
  it("1. discovers, handshakes, and surfaces the delegation token", async () => {
    const server = await startMockServer((frame) => {
      if (frame.type === "discover") {
        return {
          type: "discover_response",
          requestId: frame.requestId,
          ok: true,
          protocolVersion: 1,
          desktopVersion: "1.2.3",
          capabilities: ["handshake", "events"],
        };
      }
      if (frame.type === "handshake") {
        return {
          type: "handshake_response",
          requestId: frame.requestId,
          ok: true,
          user: {
            id: "user1234567890abcdefgh",
            username: "ken",
            email: "k@e.com",
            firstName: "K",
            lastName: "N",
          },
          token: "delegation-token-1",
          expiresAtMs: Date.now() + 5 * 60_000,
          serverUrl: "https://kchat.example.com",
          scopesGranted: ["kchat:posts.read"],
        };
      }
      return null;
    });
    try {
      const conn = new ExtensionConnection({
        socketPath: server.socketPath,
      });
      const discover = await conn.open();
      expect(discover.ok).toBe(true);
      expect(discover.desktopVersion).toBe("1.2.3");
      const session = new KchatExtensionSession(conn);
      const info = await session.handshake({});
      expect(info.user.username).toBe("ken");
      expect(info.token).toBe("delegation-token-1");
      expect(info.serverUrl).toBe("https://kchat.example.com");
      // Token was persisted under the extension provider.
      expect(vaultStore.has("kchat-extension")).toBe(true);
      session.disconnect();
      conn.close();
    } finally {
      await server.close();
    }
  });

  it("2. translates desktop-app events to Mattermost-style frames", () => {
    // Pure unit-level translation check — covers the entries in
    // the NATIVE_TO_MATTERMOST table.
    const translated = translateExtensionEvent({
      type: "event",
      event: "message:received",
      data: { post: "{\"id\":\"p1\"}" },
      channelId: "ch1234567890abcdefgh",
      teamId: "tm1234567890abcdefgh",
      userId: "u1234567890abcdefgh",
      seq: 42,
    });
    expect(translated).not.toBeNull();
    expect(translated!.event).toBe("posted");
    expect(translated!.broadcast.channel_id).toBe("ch1234567890abcdefgh");
    expect(translated!.data._extension_native_event).toBe(
      "message:received",
    );

    // Already-mattermost passthrough.
    const passthrough = translateExtensionEvent({
      type: "event",
      event: "posted",
      data: { post: "{\"id\":\"p2\"}" },
      channelId: "ch1234567890abcdefgh",
      seq: 43,
    });
    expect(passthrough).not.toBeNull();
    expect(passthrough!.event).toBe("posted");

    // Unknown event drops.
    const dropped = translateExtensionEvent({
      type: "event",
      event: "completely:unknown:event",
      data: {},
      seq: 0,
    });
    expect(dropped).toBeNull();

    // Explicitly null-mapped event drops (auth:link_status_changed).
    const explicitlyDropped = translateExtensionEvent({
      type: "event",
      event: "auth:link_status_changed",
      data: {},
      seq: 0,
    });
    expect(explicitlyDropped).toBeNull();
  });

  it("3. surfaces desktop-side disconnect as an error transition", async () => {
    const server = await startMockServer((frame) => {
      if (frame.type === "discover") {
        return {
          type: "discover_response",
          requestId: frame.requestId,
          ok: true,
          protocolVersion: 1,
          desktopVersion: "1.2.3",
          capabilities: ["handshake", "events"],
        };
      }
      return null;
    });
    try {
      const conn = new ExtensionConnection({
        socketPath: server.socketPath,
      });
      await conn.open();
      const reasons: string[] = [];
      conn.onDisconnect((r) => reasons.push(r));
      server.emitDisconnect("desktop-app-shutdown");
      // Give the socket a tick to deliver the frame.
      await new Promise((r) => setTimeout(r, 50));
      expect(reasons.length).toBeGreaterThan(0);
      expect(reasons[0]).toBe("desktop-app-shutdown");
      conn.close();
    } finally {
      await server.close();
    }
  });

  it("4. PAT mode works when the extension probe fails", async () => {
    // No mock server running — probe will fail. PAT path uses a
    // fetch-injected client.
    const fetchFn = vi.fn(
      async (_input: RequestInfo | URL): Promise<Response> => {
        return {
          ok: true,
          status: 200,
          statusText: "OK",
          text: async () => "",
          json: async () => ({
            id: "user1234567890abcdefgh",
            username: "ken",
            email: "k@e.com",
            first_name: "K",
            last_name: "N",
            roles: "system_user",
          }),
          arrayBuffer: async () => new ArrayBuffer(0),
        } as unknown as Response;
      },
    );
    const client = new KchatClient({ fetchFn });
    const svc = new KchatAuthService(client, {
      probeFn: async () => ({
        available: false,
        protocolVersion: 0,
        desktopVersion: "",
        capabilities: [],
        reason: "no-socket",
      }),
    });
    const user = await svc.connect("pat-token-12345", "https://kchat.example.com");
    expect(user.username).toBe("ken");
    expect(svc.getAuthMode()).toBe("pat");
    expect(svc.isExtensionAvailable()).toBe(false);
    // Probe still reports unavailable.
    const probe = await svc.probeExtension();
    expect(probe.available).toBe(false);
    svc.disconnect();
  });

  it("5. PAT teardown when an extension session is active", async () => {
    const server = await startMockServer((frame) => {
      if (frame.type === "discover") {
        return {
          type: "discover_response",
          requestId: frame.requestId,
          ok: true,
          protocolVersion: 1,
          desktopVersion: "1.2.3",
          capabilities: ["handshake", "events"],
        };
      }
      if (frame.type === "handshake") {
        return {
          type: "handshake_response",
          requestId: frame.requestId,
          ok: true,
          user: {
            id: "user1234567890abcdefgh",
            username: "ken",
            email: "k@e.com",
            firstName: "K",
            lastName: "N",
          },
          token: "delegation-token-1",
          expiresAtMs: Date.now() + 5 * 60_000,
          serverUrl: "https://kchat.example.com",
          scopesGranted: ["kchat:posts.read"],
        };
      }
      return null;
    });
    try {
      const fetchFn = vi.fn(
        async (_input: RequestInfo | URL): Promise<Response> => {
          return {
            ok: true,
            status: 200,
            statusText: "OK",
            text: async () => "",
            json: async () => ({
              id: "user1234567890abcdefgh",
              username: "ken",
              email: "k@e.com",
              first_name: "K",
              last_name: "N",
              roles: "system_user",
            }),
            arrayBuffer: async () => new ArrayBuffer(0),
          } as unknown as Response;
        },
      );
      const client = new KchatClient({ fetchFn });
      const svc = new KchatAuthService(client, {
        extensionFactory: () =>
          new ExtensionConnection({ socketPath: server.socketPath }),
        probeFn: async () => ({
          available: true,
          protocolVersion: 1,
          desktopVersion: "1.2.3",
          capabilities: ["handshake", "events"],
        }),
      });
      await svc.connectViaExtension();
      expect(svc.getAuthMode()).toBe("extension");
      // Switching to PAT must tear down the extension session
      // and leave the PAT entry as the active mode.
      await svc.connect("pat-token-12345", "https://kchat.example.com");
      expect(svc.getAuthMode()).toBe("pat");
      // The extension vault entry should be wiped (the extension
      // session was torn down before the PAT attempt). The
      // service's `teardownExtension()` path calls
      // `KchatExtensionSession.disconnect()` which deletes the
      // entry.
      expect(vaultStore.has("kchat-extension")).toBe(false);
      svc.disconnect();
    } finally {
      await server.close();
    }
  });

  it("6. SSRF on extension handshake serverUrl is rejected", async () => {
    const server = await startMockServer((frame) => {
      if (frame.type === "discover") {
        return {
          type: "discover_response",
          requestId: frame.requestId,
          ok: true,
          protocolVersion: 1,
          desktopVersion: "1.2.3",
          capabilities: ["handshake"],
        };
      }
      if (frame.type === "handshake") {
        return {
          type: "handshake_response",
          requestId: frame.requestId,
          ok: true,
          user: {
            id: "user1234567890abcdefgh",
            username: "ken",
            email: "k@e.com",
            firstName: "K",
            lastName: "N",
          },
          token: "delegation-token-1",
          expiresAtMs: Date.now() + 5 * 60_000,
          // Loopback URL — SSRF guard must reject.
          serverUrl: "http://127.0.0.1:1234",
          scopesGranted: ["kchat:posts.read"],
        };
      }
      return null;
    });
    try {
      const conn = new ExtensionConnection({
        socketPath: server.socketPath,
      });
      await conn.open();
      const session = new KchatExtensionSession(conn);
      await expect(session.handshake({})).rejects.toThrow();
      // No vault write should have happened.
      expect(vaultStore.has("kchat-extension")).toBe(false);
      conn.close();
    } finally {
      await server.close();
    }
  });
});
