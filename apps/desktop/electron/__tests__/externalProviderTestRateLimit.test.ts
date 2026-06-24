/**
 * Regression test for the rate-limit gate on the
 * `externalProvider:test` IPC handler.
 *
 * This is the sibling of `externalProviderListModelsRateLimit.test.ts`.
 * Both handlers wrap outbound HTTPS calls with the user's
 * authenticated API key:
 *
 *   - `externalProvider:listModels` — discovery (`GET /v1/models`)
 *   - `externalProvider:test` — chat completion (the Test button on
 *     the External Provider settings card; verifies the API key
 *     actually works against the configured model)
 *
 * The Test handler is arguably MORE expensive than listModels: a
 * chat-completion request triggers a real (small) generation on
 * the upstream side, which costs prompt + completion tokens on
 * metered APIs. A user repeatedly clicking Test while iterating
 * on their URL/model configuration would burn through tokens
 * orders of magnitude faster than mashing List.
 *
 * The earlier rate-limit landing added a token-bucket gate to
 * `listModels` but the sibling Test handler was left ungated,
 * inverting the protection priority. This test pins the fix.
 *
 * The fix wires `defaultRateLimiter.consume(…)` at the head of
 * the Test handler body, before any vault read or config touch,
 * with the same `1 token/sec, burst 5` profile as listModels.
 * Because the Test handler did not previously have a top-level
 * try/catch, the fix also wraps the entire body in try/catch so
 * the thrown `RateLimitError` is surfaced as the typed
 * `{ ok: false, error: <message> }` result the renderer
 * `onTest` callback already expects (rather than escaping as an
 * unhandled IPC rejection that would un-busy the button without
 * a status message).
 *
 * Test layout mirrors `externalProviderListModelsRateLimit.test.ts`
 * intentionally so a future contributor reading both files
 * recognizes the symmetry — same scaffolding, same assertions on
 * the rate-limit error shape, same `reset()` escape hatch for
 * the refill case.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

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

/**
 * Shape of the `externalProvider:test` result the renderer
 * consumes. We don't export this from `shared/types` (unlike
 * `ExternalProviderListModelsResult`) because the existing test
 * result is a looser type used by both the bridge and IPC paths;
 * the inline shape here is sufficient for asserting on what the
 * IPC handler returns.
 */
type TestResult = { ok: true } | { ok: false; error: string };

function getHandler(
  channel: string,
): (event: unknown, ...args: unknown[]) => Promise<unknown> {
  const call = handleMock.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`No handler registered for ${channel}`);
  return call[1] as (event: unknown, ...args: unknown[]) => Promise<unknown>;
}

describe("externalProvider:test — rate limiter", () => {
  beforeEach(() => {
    userDataDir = fs.mkdtempSync(
      path.join(os.tmpdir(), "tessera-providertest-rl-"),
    );
    handleMock.mockClear();
    removeHandlerMock.mockClear();
    _clearConfigCacheForTests();
    // The token-bucket limiter is process-global; reset between
    // tests so a sibling test's overspend can't bleed in. This
    // matches the posture in `hybridSearchConfigIpc.test.ts` and
    // `externalProviderListModelsRateLimit.test.ts`.
    defaultRateLimiter.reset();
  });

  it("returns a rate-limited error on the 6th call within the burst window", async () => {
    registerSettingsHandlers();
    const handler = getHandler("externalProvider:test");

    // Burst the bucket dry. The default config provides an
    // `externalProvider` record with `enabled: false`, so these
    // calls return `{ ok: false, error: "External provider is
    // disabled" }` — but they STILL consume a token each, because
    // the rate-limit gate runs BEFORE the disabled check in the
    // handler body. We don't assert on the exact text of the
    // non-rate-limit error; only that it doesn't already match
    // /Rate limit/, which is what the 6th-call assertion below
    // pins.
    for (let i = 0; i < 5; i++) {
      const result = (await handler({})) as TestResult;
      expect(result.ok).toBe(false);
      if (!result.ok) {
        expect(result.error).not.toMatch(/Rate limit/);
      }
    }

    // 6th call within the window — bucket empty, gate fires.
    const sixth = (await handler({})) as TestResult;
    expect(sixth.ok).toBe(false);
    if (!sixth.ok) {
      // The RateLimitError message format is:
      //   "Rate limit exceeded for <channel> — retry in <N>s"
      // We pin both the channel name (so a future rename forces
      // this test to update in lockstep) and the "retry in"
      // suffix (so a future drift to a different error class
      // with similar-looking text doesn't silently pass).
      expect(sixth.error).toMatch(/Rate limit exceeded/);
      expect(sixth.error).toMatch(/externalProvider:test/);
      expect(sixth.error).toMatch(/retry in \d+s/);
    } else {
      throw new Error(
        `expected ok:false on 6th call, got: ${JSON.stringify(sixth)}`,
      );
    }
  });

  it("permits a 6th call after the bucket has refilled", async () => {
    registerSettingsHandlers();
    const handler = getHandler("externalProvider:test");

    for (let i = 0; i < 5; i++) {
      await handler({});
    }
    const blocked = (await handler({})) as TestResult;
    if (!blocked.ok) {
      expect(blocked.error).toMatch(/Rate limit exceeded/);
    } else {
      throw new Error("setup: expected the 6th call to be rate-limited");
    }

    // Manually refill by resetting the limiter (equivalent to
    // 5+ seconds elapsing). Testing real wall-clock would slow
    // the suite needlessly; `reset()` is the public escape hatch
    // the limiter exposes for exactly this case and matches the
    // posture in the listModels rate-limit test.
    defaultRateLimiter.reset();

    const unblocked = (await handler({})) as TestResult;
    expect(unblocked.ok).toBe(false);
    if (!unblocked.ok) {
      // Must NOT be the rate-limit error anymore — should be the
      // downstream disabled-provider error, proving the limiter
      // refilled and the consume() succeeded.
      expect(unblocked.error).not.toMatch(/Rate limit/);
    }
  });

  it("separate token buckets per channel — Test does NOT share with listModels", async () => {
    // Architectural invariant: each rate-limit channel keeps its
    // own bucket so a user mashing Test does not also block their
    // List call (and vice versa). Pinning this prevents a future
    // refactor from accidentally collapsing the two channels
    // onto a shared key, which would re-introduce the same
    // protection-priority inversion this PR set out to fix.
    registerSettingsHandlers();
    const testHandler = getHandler("externalProvider:test");
    const listHandler = getHandler("externalProvider:listModels");

    // Burst the Test bucket dry — 5 calls each consume one token.
    for (let i = 0; i < 5; i++) {
      await testHandler({});
    }
    // Confirm Test is now rate-limited.
    const blockedTest = (await testHandler({})) as TestResult;
    expect(blockedTest.ok).toBe(false);
    if (!blockedTest.ok) {
      expect(blockedTest.error).toMatch(/Rate limit exceeded/);
      expect(blockedTest.error).toMatch(/externalProvider:test/);
    }

    // The listModels bucket must be unaffected — its first call
    // (within the same wall-clock window) must NOT mention the
    // rate-limit channel. If this assertion ever flips, the
    // limiter has been reconfigured to share a bucket across
    // channels and the gate posture has regressed.
    const firstList = (await listHandler({})) as {
      ok: boolean;
      error?: string;
    };
    expect(firstList.ok).toBe(false);
    if (!firstList.ok && firstList.error !== undefined) {
      expect(firstList.error).not.toMatch(/Rate limit/);
    }
  });
});
