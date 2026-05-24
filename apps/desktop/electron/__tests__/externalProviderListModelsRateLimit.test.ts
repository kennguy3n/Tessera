/**
 * Regression test for the rate-limit gate on the
 * `externalProvider:listModels` IPC handler.
 *
 * Why the gate matters:
 *
 * - The handler makes an outbound HTTPS call to the user's
 *   configured LLM provider, attaching their cleartext API key
 *   (retrieved from the secrets vault) in the Authorization
 *   header. On metered providers (OpenAI, Anthropic, …) every
 *   call costs the user real money on their monthly bill, and a
 *   user mashing the "List models" button while iterating on
 *   their URL configuration can burn through unnecessary spend in
 *   seconds.
 *
 * - Upstream providers also rate-limit per-IP — a flood of
 *   listModels calls can trip the upstream gate, which then
 *   cascades into failed `externalProvider:test` calls,
 *   degrading the whole settings UX with no observable cause.
 *
 * - All sibling outbound-network handlers
 *   (`connectors:authenticate`, `connectors:sync`,
 *   `runtime:downloadModel`) consume() at the top of their
 *   bodies. Missing the same posture on listModels was the gap
 *   the Devin Review on PR #27 flagged.
 *
 * The fix wires `defaultRateLimiter.consume(…)` at the head of
 * the handler body, before any vault read or config touch. The
 * configured profile is 1 token / second with a 5-token burst —
 * enough for a power user clicking List, tweaking URL, clicking
 * List again a few times without hitting the gate, while
 * blocking sustained scripted abuse.
 *
 * This test pins the gate by:
 *   1. Burst-calling the handler 5 times in quick succession.
 *      The first call MUST NOT return a rate-limit error (the
 *      bucket starts full at burst=5); the remaining calls also
 *      must not error on rate limit even though they may return
 *      other typed errors (e.g. "External provider is not
 *      configured" because the test stubs no provider record).
 *   2. The 6th call within the same window must return
 *      `{ ok: false, kind: "error" }` with a message identifying
 *      the rate-limit channel by name.
 *
 * The handler's top-level try/catch is what turns the thrown
 * `RateLimitError` into the typed result the renderer can
 * display, so this test also indirectly verifies that the catch
 * wrapping (added in PR #27 round 4) still covers the rate-limit
 * path.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";
import type { ExternalProviderListModelsResult } from "../../shared/types";

const handleMock = vi.fn();
const removeHandlerMock = vi.fn();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (...args: unknown[]) => handleMock(...args),
    removeHandler: (...args: unknown[]) => removeHandlerMock(...args),
  },
  app: {
    getPath: (which: string) => {
      if (which === "userData") return userDataDir;
      throw new Error(`unexpected getPath: ${which}`);
    },
  },
}));

vi.mock("../appState", () => ({
  getBridge: () => null,
  isBridgeAvailable: () => false,
}));

let userDataDir = "";

import { registerSettingsHandlers } from "../ipc/settings";
import { defaultRateLimiter } from "../ipc/rateLimiter";
import { _clearConfigCacheForTests } from "../config";

function getHandler(
  channel: string,
): (event: unknown, ...args: unknown[]) => Promise<unknown> {
  const call = handleMock.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`No handler registered for ${channel}`);
  return call[1] as (
    event: unknown,
    ...args: unknown[]
  ) => Promise<unknown>;
}

describe("externalProvider:listModels — rate limiter", () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tessera-listmodels-rl-"),
    );
    handleMock.mockClear();
    removeHandlerMock.mockClear();
    _clearConfigCacheForTests();
    // The token-bucket limiter is process-global; reset between
    // tests so a sibling test's overspend can't bleed in. This
    // matches the posture in `hybridSearchConfigIpc.test.ts`.
    defaultRateLimiter.reset();
  });

  it("returns a rate-limited result on the 6th call within the burst window", async () => {
    registerSettingsHandlers();
    const handler = getHandler("externalProvider:listModels");

    // Burst the bucket dry. Without a persisted external provider
    // these calls will return `kind: "error", error: "External
    // provider is not configured"` — but they STILL consume a
    // token each, because the gate runs before the config check.
    // We don't assert on the body of these results; only that
    // they don't already trip the rate-limit gate.
    for (let i = 0; i < 5; i++) {
      const result = (await handler({})) as ExternalProviderListModelsResult;
      expect(result.ok).toBe(false);
      if (!result.ok && result.kind === "error") {
        // The first 5 calls should NOT mention the rate-limit
        // channel — they fail on the missing-provider gate
        // downstream of the rate-limit consume().
        expect(result.error).not.toMatch(/Rate limit/);
      }
    }

    // 6th call within the window — bucket empty, gate fires.
    const sixth = (await handler({})) as ExternalProviderListModelsResult;
    expect(sixth.ok).toBe(false);
    if (!sixth.ok && sixth.kind === "error") {
      // The RateLimitError message format is:
      //   "Rate limit exceeded for <channel> — retry in <N>s"
      // We pin both the channel name (so a future rename of the
      // channel forces this test to update in lockstep) and the
      // "retry in" suffix (so a future drift to a different error
      // class with similar-looking text doesn't silently pass).
      expect(sixth.error).toMatch(/Rate limit exceeded/);
      expect(sixth.error).toMatch(/externalProvider:listModels/);
      expect(sixth.error).toMatch(/retry in \d+s/);
    } else {
      throw new Error(
        `expected kind: error on 6th call, got: ${JSON.stringify(sixth)}`,
      );
    }
  });

  it("permits a 6th call after the bucket has refilled", async () => {
    registerSettingsHandlers();
    const handler = getHandler("externalProvider:listModels");

    // Burn the bucket as before.
    for (let i = 0; i < 5; i++) {
      await handler({});
    }
    const blocked = (await handler({})) as ExternalProviderListModelsResult;
    if (!blocked.ok && blocked.kind === "error") {
      expect(blocked.error).toMatch(/Rate limit exceeded/);
    } else {
      throw new Error("setup: expected the 6th call to be rate-limited");
    }

    // Manually refill by resetting the limiter (equivalent to
    // 5+ seconds elapsing — testing real wall-clock would slow
    // the suite needlessly, and `reset()` is the public escape
    // hatch the limiter exposes for exactly this case).
    defaultRateLimiter.reset();

    const unblocked = (await handler(
      {},
    )) as ExternalProviderListModelsResult;
    expect(unblocked.ok).toBe(false);
    if (!unblocked.ok && unblocked.kind === "error") {
      // Must NOT be the rate-limit error anymore — should be the
      // downstream missing-provider error, proving the limiter
      // refilled and the consume() succeeded.
      expect(unblocked.error).not.toMatch(/Rate limit/);
    }
  });
});
