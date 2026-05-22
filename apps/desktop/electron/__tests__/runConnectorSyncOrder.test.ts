/**
 * Regression tests for rate-limit ordering in `runConnectorSync`.
 *
 * The bug: the per-provider 1/30s rate-limit token was consumed
 * BEFORE `getValidAccessToken` ran. When a user clicked "Sync Now"
 * on a disconnected provider, the path was:
 *   1. `consume()` succeeds, decrementing the budget.
 *   2. `getValidAccessToken` throws `NotConnectedError`.
 *   3. UI shows "please authenticate".
 *   4. User re-authenticates and clicks Sync within 30 s.
 *   5. `consume()` now throws `RateLimitError` — the user is asked
 *      to wait, even though no actual sync has happened yet.
 *
 * The fix: resolve the access token first, then consume the budget
 * only once we know we'll actually do API work.
 */

import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn().mockReturnValue("/tmp") },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
  BrowserWindow: class {
    static fromWebContents() {
      return null;
    }
  },
}));

import {
  runConnectorSync,
  NotConnectedError,
} from "../ipc/connectors/handlers";
import { RateLimiter, RateLimitError } from "../ipc/rateLimiter";
import type { IpcContext } from "../ipc/context";

function makeCtx(): {
  ctx: IpcContext;
  rateLimiter: RateLimiter;
} {
  const rateLimiter = new RateLimiter();
  const ctx = {
    tokenVault: {
      getTokens: vi.fn().mockReturnValue(null), // no token stored
      storeTokens: vi.fn(),
      deleteTokens: vi.fn(),
    },
    rateLimiter,
    userDataDir: () => "/tmp",
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  } as unknown as IpcContext;
  return { ctx, rateLimiter };
}

describe("runConnectorSync — rate-limit ordering", () => {
  it(
    "does NOT consume the rate-limit budget when the user is not " +
      "connected — the same budget is available for the next attempt",
    async () => {
      const { ctx, rateLimiter } = makeCtx();

      // First click: not connected → must throw NotConnectedError
      // BEFORE the rate-limit consume call.
      await expect(runConnectorSync(ctx, "notion")).rejects.toBeInstanceOf(
        NotConnectedError,
      );

      // The budget for `connectors:sync:notion` must STILL be full.
      // If the bug were present, this call would itself throw
      // RateLimitError because the previous attempt spent the only
      // token.
      expect(() =>
        rateLimiter.consume("connectors:sync:notion", {
          tokensPerInterval: 1,
          intervalMs: 30_000,
        }),
      ).not.toThrow();
    },
  );

  it(
    "still throws RateLimitError when the token IS present but the " +
      "user has already synced within the cooldown window",
    async () => {
      const { ctx, rateLimiter } = makeCtx();
      // Pretend the user IS connected (token vault returns valid token).
      (ctx.tokenVault as unknown as {
        getTokens: ReturnType<typeof vi.fn>;
      }).getTokens.mockReturnValue({
        accessToken: "AT",
        refreshToken: null,
        expiresAt: Date.now() + 60 * 60 * 1000,
        scopes: [],
      });
      // Pre-burn the rate-limit budget so the next consume throws.
      rateLimiter.consume("connectors:sync:notion", {
        tokensPerInterval: 1,
        intervalMs: 30_000,
      });
      // The call must throw a *rate-limit* error (not NotConnectedError).
      await expect(runConnectorSync(ctx, "notion")).rejects.toThrow(
        /rate-limited/i,
      );
    },
  );
});

describe("RateLimitError exposed from rateLimiter module", () => {
  it("is the same class instance handlers.ts throws", () => {
    const limiter = new RateLimiter();
    limiter.consume("k", { tokensPerInterval: 1, intervalMs: 1000 });
    try {
      limiter.consume("k", { tokensPerInterval: 1, intervalMs: 1000 });
      throw new Error("should have thrown");
    } catch (err) {
      expect(err).toBeInstanceOf(RateLimitError);
    }
  });
});

describe("runConnectorSync — token refresh offline path", () => {
  it(
    "returns `{ status: 'offline' }` when the refresh-token exchange " +
      "fails with a transport-level error (DNS / connection refused), " +
      "rather than letting a raw fetch rejection bubble out and bypass " +
      "the Offline badge",
    async () => {
      const { ctx } = makeCtx();
      // Pretend the user IS connected but their access token is
      // expired AND they have a refresh token — i.e. we will take
      // the `refreshProviderToken` branch.
      (ctx.tokenVault as unknown as {
        getTokens: ReturnType<typeof vi.fn>;
      }).getTokens.mockReturnValue({
        accessToken: "AT_OLD",
        refreshToken: "RT",
        // Force the expiry check at line 245 to fail so we fall
        // through to the refresh path.
        expiresAt: Date.now() - 60_000,
        scopes: [],
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
      });

      // Stub global.fetch to simulate the user's wifi dropping
      // mid-refresh. This is the exact shape Node 18+ undici emits
      // when DNS resolution fails for a hostname.
      const originalFetch = globalThis.fetch;
      const fetchErr = Object.assign(new TypeError("fetch failed"), {
        cause: Object.assign(new Error("getaddrinfo ENOTFOUND auth.atlassian.com"), {
          code: "ENOTFOUND",
        }),
      });
      globalThis.fetch = vi.fn().mockRejectedValue(fetchErr) as typeof fetch;

      try {
        const result = await runConnectorSync(ctx, "jira");
        expect(result).toEqual({
          added: 0,
          modified: 0,
          removed: 0,
          status: "offline",
        });
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );

  it(
    "still propagates non-network refresh errors (4xx from the " +
      "provider, missing credentials, etc.) as hard errors so the UI " +
      "can prompt re-authentication",
    async () => {
      const { ctx } = makeCtx();
      (ctx.tokenVault as unknown as {
        getTokens: ReturnType<typeof vi.fn>;
      }).getTokens.mockReturnValue({
        accessToken: "AT_OLD",
        refreshToken: "RT",
        expiresAt: Date.now() - 60_000,
        scopes: [],
        clientId: "CLIENT_ID",
        clientSecret: "CLIENT_SECRET",
      });

      const originalFetch = globalThis.fetch;
      // HTTP 400 invalid_grant — a hard auth error, NOT a network
      // failure. The Offline badge must NOT light up; the user
      // needs to re-authenticate.
      globalThis.fetch = vi.fn().mockResolvedValue(
        new Response('{"error":"invalid_grant"}', {
          status: 400,
          statusText: "Bad Request",
          headers: { "Content-Type": "application/json" },
        }),
      ) as typeof fetch;

      try {
        await expect(runConnectorSync(ctx, "jira")).rejects.toThrow(
          /Token refresh failed for jira/,
        );
      } finally {
        globalThis.fetch = originalFetch;
      }
    },
  );
});
