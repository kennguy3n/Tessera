/**
 * Regression tests for the non-expiring access-token short-circuit in
 * `getValidAccessToken` (Devin Review wave 4, finding
 * BUG_pr-review-job-4afddb38ae6c4285a5134f8ca3aebb64_0001).
 *
 * The bug: Notion's OAuth token-exchange response does NOT include
 * `expires_in` (its integration tokens are documented as non-expiring).
 * The previous code defaulted `expiresIn` to 3600s, so every stored
 * Notion token *looked* expired after one hour. Because
 * `supportsRefresh = false` for Notion, the next call to
 * `getValidAccessToken` would delete the tokens and throw
 * `NotConnectedError`, silently signing the user out every hour.
 *
 * The fix has two layers:
 *   1. `exchangeAuthorizationCode` / `refreshProviderToken` now use a
 *      very-large default (~10y) instead of 3600s when the provider
 *      doesn't `supportsRefresh` and the response omitted `expires_in`,
 *      so the stored `expiresAt` is sensible for inspection.
 *   2. `getValidAccessToken` short-circuits the expiry check entirely
 *      for non-refreshable providers (no refresh token AND
 *      `supportsRefresh = false`): the only credential we have IS the
 *      access token, so guessing at its lifetime can only hurt — we
 *      always return it and let the upstream API surface a real 401
 *      if it's actually invalid.
 */

import { describe, it, expect, vi, beforeEach } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn().mockReturnValue("/tmp") },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
  BrowserWindow: class {
    static fromWebContents() {
      return null;
    }
  },
  dialog: {},
}));

import {
  getValidAccessTokenForProvider,
  NotConnectedError,
} from "../ipc/connectors/handlers";
import type { IpcContext } from "../ipc/context";

interface StoredTokens {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: number;
  scopes: string[];
  clientId?: string;
  clientSecret?: string;
}

function makeCtx(initial: Partial<Record<string, StoredTokens>>): {
  ctx: IpcContext;
  deletes: string[];
} {
  const store = new Map<string, StoredTokens>(
    Object.entries(initial).filter(([, v]) => v !== undefined) as [
      string,
      StoredTokens,
    ][],
  );
  const deletes: string[] = [];
  const tokenVault = {
    getTokens: (p: string) => store.get(p) ?? null,
    storeTokens: (p: string, t: StoredTokens) => {
      store.set(p, t);
    },
    deleteTokens: (p: string) => {
      deletes.push(p);
      store.delete(p);
    },
  } as unknown as IpcContext["tokenVault"];
  const ctx = {
    tokenVault,
    log: {
      debug: () => {},
      info: () => {},
      warn: () => {},
      error: () => {},
    },
  } as unknown as IpcContext;
  return { ctx, deletes };
}

describe("getValidAccessToken — non-expiring providers (Notion)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2025-01-01T00:00:00Z"));
  });

  it("returns the stored Notion token even when expiresAt has already passed (would-be-1h-expiry case)", async () => {
    // Simulate the exact bug condition: a Notion token stored an hour
    // ago with expiresAt = stored_time + 3600s. With the old code this
    // would be deleted and throw; with the fix it must be returned.
    const oneHourAgo = Date.now() - 60 * 60 * 1000;
    const { ctx, deletes } = makeCtx({
      notion: {
        accessToken: "secret_notion_token",
        refreshToken: null,
        expiresAt: oneHourAgo + 3600 * 1000, // exactly at "now"
        scopes: [],
      },
    });
    const token = await getValidAccessTokenForProvider(ctx, "notion");
    expect(token).toBe("secret_notion_token");
    expect(deletes).toEqual([]);
  });

  it("returns the stored Notion token even when expiresAt is far in the past", async () => {
    const { ctx, deletes } = makeCtx({
      notion: {
        accessToken: "secret_notion_token",
        refreshToken: null,
        expiresAt: Date.now() - 365 * 24 * 60 * 60 * 1000, // a year ago
        scopes: [],
      },
    });
    const token = await getValidAccessTokenForProvider(ctx, "notion");
    expect(token).toBe("secret_notion_token");
    expect(deletes).toEqual([]);
  });

  it("still throws `NotConnectedError` for Notion when no token has been stored", async () => {
    const { ctx } = makeCtx({});
    await expect(
      getValidAccessTokenForProvider(ctx, "notion"),
    ).rejects.toBeInstanceOf(NotConnectedError);
  });

  it("does not short-circuit refreshable providers: an expired Google Drive token without a refresh token still throws", async () => {
    // Drive has `supportsRefresh = true` so the non-expiring guard
    // must NOT fire here — the expiry check + auth-state cleanup path
    // is correct for refreshable providers.
    const { ctx, deletes } = makeCtx({
      google_drive: {
        accessToken: "ya29.gdrive_token",
        refreshToken: null,
        expiresAt: Date.now() - 60 * 60 * 1000,
        scopes: [],
      },
    });
    await expect(
      getValidAccessTokenForProvider(ctx, "google_drive"),
    ).rejects.toBeInstanceOf(NotConnectedError);
    expect(deletes).toEqual(["google_drive"]);
  });

  it("does not short-circuit when a non-refreshable provider somehow has a refresh token (defense in depth)", async () => {
    // Hypothetical: a provider whose config says `supportsRefresh =
    // false` but a refresh token leaked into the store. The guard
    // requires BOTH `!supportsRefresh` AND `!refreshToken`, so this
    // case must still go through the normal expiry-check path. The
    // expiry check would then fail (no client credentials), confirming
    // we haven't accidentally widened the short-circuit.
    const { ctx, deletes } = makeCtx({
      notion: {
        accessToken: "secret_notion_token",
        refreshToken: "rogue_refresh_token",
        expiresAt: Date.now() - 60 * 60 * 1000,
        scopes: [],
      },
    });
    await expect(
      getValidAccessTokenForProvider(ctx, "notion"),
    ).rejects.toBeInstanceOf(NotConnectedError);
    expect(deletes).toEqual(["notion"]);
  });
});
