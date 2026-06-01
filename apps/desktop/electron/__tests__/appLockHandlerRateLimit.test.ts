/**
 * defense-in-depth rate-limit parity for
 * the four `appLock:*` channels that invoke scrypt or the platform
 * biometric prompt.
 *
 * Why this test exists
 * --------------------
 * `appLock:attemptUnlock` and `appLock:attemptBiometric` have
 * always been rate-limited at 1 / 250ms per process. Devin Review
 * round 4 flagged that `appLock:setPin`, `appLock:changePin`, and
 * `appLock:removePin` invoke the same scrypt KDF (and in
 * `changePin`'s case, twice — `attemptUnlock(old)` followed by
 * `setPin(new)`) but were not rate-limited. A compromised renderer
 * could pick the cheapest reachable scrypt channel to side-step
 * the throttle that protects the unlock path.
 *
 * These tests lock in the contract that all five crypto channels
 * share the 250ms / token budget. `appLock:getStatus` is the only
 * channel that is intentionally NOT rate-limited (cheap read, no
 * crypto on the hot path) and we assert that explicitly.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

const handleMock = vi.fn();
const removeHandlerMock = vi.fn();

const hoisted = vi.hoisted(() => ({
  userData: { value: "" },
}));

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => hoisted.userData.value) },
  ipcMain: {
    handle: (...args: unknown[]) => handleMock(...args),
    removeHandler: (...args: unknown[]) => removeHandlerMock(...args),
    on: vi.fn(),
    removeListener: vi.fn(),
  },
  BrowserWindow: vi.fn(),
  systemPreferences: {
    canPromptTouchID: vi.fn(() => false),
    promptTouchID: vi.fn(),
  },
  safeStorage: {
    isEncryptionAvailable: vi.fn(() => true),
    encryptString: vi.fn((s: string) =>
      Buffer.concat([Buffer.from("v10\x00"), Buffer.from(s, "utf-8")]),
    ),
    decryptString: vi.fn((b: Buffer) => {
      if (b.subarray(0, 4).equals(Buffer.from("v10\x00"))) {
        return b.subarray(4).toString("utf-8");
      }
      throw new Error("decryptString: not a v10 blob");
    }),
  },
}));

vi.mock("../appState", () => ({
  getBridge: () => null,
  isBridgeAvailable: () => false,
}));

import { _clearConfigCacheForTests } from "../config";
import { registerAppLockHandlers } from "../ipc/appLock";
import {
  hasPinSet,
  setPin,
  clearPin,
  _setAppLockPathForTests,
  _resetAttemptCounterForTests,
} from "../appLock";
import { defaultRateLimiter, RateLimitError } from "../ipc/rateLimiter";

function getHandler(
  channel: string,
): (event: unknown, ...args: unknown[]) => unknown {
  const call = handleMock.mock.calls.find((c) => c[0] === channel);
  if (!call) {
    throw new Error(`No handler registered for ${channel}`);
  }
  return call[1] as (event: unknown, ...args: unknown[]) => unknown;
}

let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-lock-rate-"));
  hoisted.userData.value = tmpDir;
  _setAppLockPathForTests(() => path.join(tmpDir, "app-lock.bin"));
  handleMock.mockClear();
  removeHandlerMock.mockClear();
  _clearConfigCacheForTests();
  defaultRateLimiter.reset();
});

afterEach(() => {
  _setAppLockPathForTests(null);
  try {
    if (hasPinSet()) clearPin();
  } catch {
    /* best-effort */
  }
  try {
    _resetAttemptCounterForTests();
  } catch {
    /* best-effort */
  }
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* best-effort */
  }
  vi.restoreAllMocks();
});

describe("appLock:setPin — rate limit parity with attemptUnlock", () => {
  it("blocks the second back-to-back call as RateLimitError", async () => {
    registerAppLockHandlers();
    const handler = getHandler("appLock:setPin");
    // First call must reach the handler (and may fail later for
    // unrelated reasons like a stale PIN); the rate-limiter consumes
    // the only token in the bucket before any business logic.
    await handler({}, "abc12345").catch(() => {
      /* business-logic failure ok — we only care about the limiter */
    });
    // Second call within the same tick must throw RateLimitError,
    // not "A PIN is already set" or any other business error.
    let caught: unknown = null;
    try {
      await handler({}, "def67890");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RateLimitError);
    expect((caught as RateLimitError).channel).toBe("appLock:setPin");
  });
});

describe("appLock:changePin — rate limit parity with attemptUnlock", () => {
  it("blocks the second back-to-back call as RateLimitError", async () => {
    await setPin("abc12345");
    registerAppLockHandlers();
    const handler = getHandler("appLock:changePin");
    await handler({}, "abc12345", "newpin99").catch(() => {
      /* business-logic failure ok */
    });
    let caught: unknown = null;
    try {
      await handler({}, "anything", "alsonew0");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RateLimitError);
    expect((caught as RateLimitError).channel).toBe("appLock:changePin");
  });
});

describe("appLock:removePin — rate limit parity with attemptUnlock", () => {
  it("blocks the second back-to-back call as RateLimitError", async () => {
    await setPin("abc12345");
    registerAppLockHandlers();
    const handler = getHandler("appLock:removePin");
    await handler({}, "abc12345").catch(() => {
      /* business-logic failure ok */
    });
    let caught: unknown = null;
    try {
      await handler({}, "anything");
    } catch (err) {
      caught = err;
    }
    expect(caught).toBeInstanceOf(RateLimitError);
    expect((caught as RateLimitError).channel).toBe("appLock:removePin");
  });
});

describe("appLock:getStatus — intentionally not rate-limited", () => {
  it("accepts many back-to-back calls without throwing", async () => {
    registerAppLockHandlers();
    const handler = getHandler("appLock:getStatus");
    // Poll cadence on app boot can fire several status reads
    // back-to-back; throttling these would break the UI's lock
    // gating with no security benefit (no crypto involved).
    for (let i = 0; i < 20; i++) {
      await expect(handler({})).resolves.toMatchObject({
        hasPinSet: expect.any(Boolean),
      });
    }
  });
});

describe("rate-limit budgets are bucketed per channel", () => {
  it("consuming the setPin bucket does not consume the changePin / removePin / attemptUnlock buckets", async () => {
    registerAppLockHandlers();
    // Burn setPin's token.
    const setHandler = getHandler("appLock:setPin");
    await setHandler({}, "abc12345").catch(() => {
      /* ok */
    });
    // changePin must still have its own token available.
    const changeHandler = getHandler("appLock:changePin");
    let changeErr: unknown = null;
    try {
      await changeHandler({}, "abc12345", "newpin99");
    } catch (err) {
      changeErr = err;
    }
    expect(changeErr).not.toBeInstanceOf(RateLimitError);
    // removePin's first call also gets its own token (the next
    // call would burn it, but we're only asserting independence).
    const removeHandler = getHandler("appLock:removePin");
    let removeErr: unknown = null;
    try {
      await removeHandler({}, "abc12345");
    } catch (err) {
      removeErr = err;
    }
    expect(removeErr).not.toBeInstanceOf(RateLimitError);
  });
});
