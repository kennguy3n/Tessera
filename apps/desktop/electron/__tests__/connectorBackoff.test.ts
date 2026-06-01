/**
 * unit tests for `connectorBackoff.ts`.
 *
 * These tests pin the policy decisions that the connector sync
 * orchestrator relies on:
 *
 *   - Permanent errors flip `failedPermanently` immediately and
 *     do NOT increment `retryCount` (so retries don't start
 *     burning the backoff schedule on a known-permanent
 *     failure).
 *   - Transient errors bump `retryCount` and only flip
 *     `failedPermanently` after the configured threshold.
 *   - The deterministic backoff schedule matches the documented
 *     `[2s, 4s, 8s, …, 256s, 300s, …]` curve, capped at
 *     `MAX_INTERVAL_MS`.
 *   - Jitter is bounded to ±25% of the underlying interval and
 *     handles pathological inputs (negative, NaN) gracefully.
 *   - Round-trip via the bridge mock preserves all three fields
 *     and the JSON-encoded last_error.
 *   - The classifier in handlers.ts is exercised end-to-end via
 *     a stub bridge.
 *
 * These pin the contract `tessera_connectors::failure_state`
 * already pins in Rust, so a future divergence between the two
 * implementations would surface as a test failure in BOTH
 * suites — which is what we want, since the renderer is the
 * production caller.
 */

import { describe, expect, it, vi } from "vitest";

import {
  applyFailureToState,
  applyJitter,
  BACKOFF_POLICY,
  clearSyncFailureState,
  deterministicBackoffMs,
  emptySyncFailureState,
  loadSyncFailureState,
  nextBackoffMs,
  saveSyncFailureState,
  type SyncFailureState,
} from "../connectorBackoff";

import type { TesseraBridge } from "../appState";
import { classifyConnectorError } from "../ipc/connectors/handlers";
import { MissingScopeError } from "../oauthScope";

function bridgeMock(initial?: {
  lastErrorJson?: string | null;
  retryCount?: number;
  failedPermanently?: boolean;
}): {
  bridge: TesseraBridge;
  recorded: {
    failure: Array<{
      sourceId: string;
      json: string;
      retryCount: number;
      failedPermanently: boolean;
    }>;
    success: string[];
  };
} {
  const recorded = {
    failure: [] as Array<{
      sourceId: string;
      json: string;
      retryCount: number;
      failedPermanently: boolean;
    }>,
    success: [] as string[],
  };
  // Casting a partial mock to TesseraBridge: the test ONLY
  // exercises three methods, so unused members can stay
  // undefined without runtime impact.
  const bridge = {
    bridgeGetSourceSyncFailureState: vi.fn(() => ({
      lastErrorJson: initial?.lastErrorJson ?? null,
      retryCount: initial?.retryCount ?? 0,
      failedPermanently: initial?.failedPermanently ?? false,
    })),
    bridgeRecordSourceSyncFailure: vi.fn(
      (
        sourceId: string,
        json: string,
        retryCount: number,
        failedPermanently: boolean,
      ) => {
        recorded.failure.push({
          sourceId,
          json,
          retryCount,
          failedPermanently,
        });
      },
    ),
    bridgeRecordSourceSyncSuccess: vi.fn((sourceId: string) => {
      recorded.success.push(sourceId);
    }),
  } as unknown as TesseraBridge;
  return { bridge, recorded };
}

describe("connectorBackoff policy constants", () => {
  it("are pinned at the documented values so a typo in the source flags as a test failure", () => {
    expect(BACKOFF_POLICY.baseIntervalMs).toBe(2_000);
    expect(BACKOFF_POLICY.maxIntervalMs).toBe(300_000);
    expect(BACKOFF_POLICY.multiplier).toBe(2.0);
    expect(BACKOFF_POLICY.jitterFraction).toBe(0.25);
    expect(BACKOFF_POLICY.maxRetriesBeforePermanent).toBe(8);
  });
});

describe("applyFailureToState — transient", () => {
  it("bumps retry_count and preserves sticky=false on first failure from pristine", () => {
    const next = applyFailureToState(emptySyncFailureState(), {
      kind: "transient",
      message: "EAI_AGAIN",
    });
    expect(next).toEqual({
      lastError: { kind: "transient", message: "EAI_AGAIN" },
      retryCount: 1,
      failedPermanently: false,
    });
  });

  it("only flips failedPermanently to true once retry_count reaches the policy threshold", () => {
    // Threshold is 8. The 7th transient failure should NOT flip
    // the sticky bit, but the 8th should (retryCount becomes 8,
    // which is >= maxRetriesBeforePermanent).
    let state: SyncFailureState = emptySyncFailureState();
    for (let i = 1; i <= 7; i += 1) {
      state = applyFailureToState(state, {
        kind: "transient",
        message: `attempt ${i}`,
      });
      expect(state.retryCount).toBe(i);
      expect(state.failedPermanently).toBe(false);
    }
    state = applyFailureToState(state, {
      kind: "transient",
      message: "attempt 8",
    });
    expect(state.retryCount).toBe(8);
    expect(state.failedPermanently).toBe(true);
  });

  it("preserves a previously-set sticky bit even on a transient subsequent failure", () => {
    // Once the sticky bit is set (e.g. by a previous permanent
    // error) a subsequent transient failure must not magically
    // un-stick it.
    const next = applyFailureToState(
      {
        lastError: { kind: "permanent", message: "401" },
        retryCount: 3,
        failedPermanently: true,
      },
      { kind: "transient", message: "503" },
    );
    expect(next.failedPermanently).toBe(true);
  });
});

describe("applyFailureToState — permanent", () => {
  it("flips failedPermanently immediately without bumping retry_count", () => {
    const next = applyFailureToState(emptySyncFailureState(), {
      kind: "permanent",
      message: "401 Unauthorized",
    });
    expect(next).toEqual({
      lastError: { kind: "permanent", message: "401 Unauthorized" },
      retryCount: 0,
      failedPermanently: true,
    });
  });

  it("does not reset retry_count from a previous transient streak", () => {
    const next = applyFailureToState(
      {
        lastError: { kind: "transient", message: "old" },
        retryCount: 5,
        failedPermanently: false,
      },
      { kind: "permanent", message: "401" },
    );
    expect(next.retryCount).toBe(5);
    expect(next.failedPermanently).toBe(true);
  });
});

describe("deterministicBackoffMs", () => {
  it("returns 0 for attempt <= 0 (nothing to retry yet)", () => {
    expect(deterministicBackoffMs(0)).toBe(0);
    expect(deterministicBackoffMs(-1)).toBe(0);
  });

  it("doubles the interval per attempt up to the cap", () => {
    expect(deterministicBackoffMs(1)).toBe(2_000);
    expect(deterministicBackoffMs(2)).toBe(4_000);
    expect(deterministicBackoffMs(3)).toBe(8_000);
    expect(deterministicBackoffMs(4)).toBe(16_000);
    expect(deterministicBackoffMs(5)).toBe(32_000);
    expect(deterministicBackoffMs(6)).toBe(64_000);
    expect(deterministicBackoffMs(7)).toBe(128_000);
    expect(deterministicBackoffMs(8)).toBe(256_000);
  });

  it("clamps to MAX_INTERVAL_MS once the exponential exceeds the cap", () => {
    expect(deterministicBackoffMs(9)).toBe(300_000);
    expect(deterministicBackoffMs(20)).toBe(300_000);
    expect(deterministicBackoffMs(100)).toBe(300_000);
  });
});

describe("applyJitter", () => {
  it("scales the interval to within ±25% bound", () => {
    // randUnit = 0 → multiplier 0.75 (lower bound)
    // randUnit = 1 → multiplier 1.25 (upper bound)
    // (randUnit clamped from [0, 1) — `1` rounds to the same
    // edge as 0.999...)
    expect(applyJitter(1000, 0)).toBe(750);
    expect(applyJitter(1000, 0.5)).toBe(1000);
    expect(applyJitter(1000, 1)).toBe(1250);
  });

  it("clamps to >= 0 on pathological randUnit (NaN, negative)", () => {
    expect(applyJitter(1000, Number.NaN)).toBe(750);
    expect(applyJitter(1000, -5)).toBe(750);
    // No negative output ever — even if the policy somehow
    // produced a negative interval, jitter cannot push it
    // below zero.
    expect(applyJitter(0, 0)).toBe(0);
  });
});

describe("nextBackoffMs", () => {
  it("returns a value within the jitter envelope around the deterministic schedule", () => {
    // Pin Math.random so the test is deterministic.
    const r = vi.spyOn(Math, "random");
    try {
      r.mockReturnValue(0.5);
      expect(nextBackoffMs(3)).toBe(8_000);
      r.mockReturnValue(0);
      expect(nextBackoffMs(3)).toBe(6_000);
      r.mockReturnValue(0.999);
      // Slightly less than the 1.25 cap (~1.2495x).
      expect(nextBackoffMs(3)).toBeCloseTo(9_992, -1);
    } finally {
      r.mockRestore();
    }
  });
});

describe("loadSyncFailureState", () => {
  it("returns null lastError when the column is null", () => {
    const { bridge } = bridgeMock({ lastErrorJson: null });
    expect(loadSyncFailureState(bridge, "src-1")).toEqual({
      lastError: null,
      retryCount: 0,
      failedPermanently: false,
    });
  });

  it("parses a well-formed JSON column back into the structured shape", () => {
    const { bridge } = bridgeMock({
      lastErrorJson: '{"kind":"transient","message":"EAI_AGAIN"}',
      retryCount: 3,
      failedPermanently: false,
    });
    expect(loadSyncFailureState(bridge, "src-1")).toEqual({
      lastError: { kind: "transient", message: "EAI_AGAIN" },
      retryCount: 3,
      failedPermanently: false,
    });
  });

  it("degrades to null lastError when the column is malformed (rather than throwing)", () => {
    const { bridge } = bridgeMock({
      lastErrorJson: "{ not actually json",
      retryCount: 2,
      failedPermanently: true,
    });
    const state = loadSyncFailureState(bridge, "src-1");
    expect(state.lastError).toBeNull();
    // The retry/sticky fields still survive — they're stored in
    // separate columns and don't depend on JSON parsing.
    expect(state.retryCount).toBe(2);
    expect(state.failedPermanently).toBe(true);
  });

  it("degrades to null lastError on unknown discriminator", () => {
    const { bridge } = bridgeMock({
      lastErrorJson: '{"kind":"weird","message":"unknown"}',
    });
    expect(loadSyncFailureState(bridge, "src-1").lastError).toBeNull();
  });
});

describe("saveSyncFailureState", () => {
  it("serialises the lastError to JSON and forwards retry_count + sticky bit", () => {
    const { bridge, recorded } = bridgeMock();
    saveSyncFailureState(bridge, "src-1", {
      lastError: { kind: "transient", message: "EAI_AGAIN" },
      retryCount: 4,
      failedPermanently: false,
    });
    expect(recorded.failure).toEqual([
      {
        sourceId: "src-1",
        json: '{"kind":"transient","message":"EAI_AGAIN"}',
        retryCount: 4,
        failedPermanently: false,
      },
    ]);
  });

  it("writes an empty object when lastError is null (so the DB column never becomes a NULL/empty-string ambiguity)", () => {
    const { bridge, recorded } = bridgeMock();
    saveSyncFailureState(bridge, "src-1", emptySyncFailureState());
    expect(recorded.failure[0]?.json).toBe("{}");
  });
});

/**
 * pin the classifier
 * matrix against the Rust `failure_kind` matrix on
 * `tessera_connectors::ConnectorError`. Each row here corresponds
 * to a row in the doc-comment on `classifyConnectorError`.
 */
describe("classifyConnectorError (mirrors tessera_connectors failure_kind)", () => {
  it("classifies NotConnectedError as permanent (AuthenticationFailed / TokenRevoked)", () => {
    const err = Object.assign(new Error("not connected"), {
      isNotConnectedError: true as const,
    });
    expect(classifyConnectorError(err)).toBe("permanent");
  });
  it("classifies isNetworkError flag as transient (NetworkError / Io)", () => {
    const err = Object.assign(new Error("EAI_AGAIN"), {
      isNetworkError: true as const,
    });
    expect(classifyConnectorError(err)).toBe("transient");
  });
  it("classifies RateLimitError (by name) as transient (RateLimited)", () => {
    const err = Object.assign(new Error("429"), { name: "RateLimitError" });
    expect(classifyConnectorError(err)).toBe("transient");
  });
  it("classifies MissingScopeError as permanent (re-auth required, do not retry)", () => {
    // Regression: on PR #89. Without this
    // branch in `classifyConnectorError`, MissingScopeError fell
    // through to the default `transient` return, which forced the
    // source-health badge to wait for 8 transient retries (~4
    // minutes of 30-second-rate-limited attempts) before
    // `applyFailureToState` flipped `failedPermanently`. A
    // narrowed OAuth grant is definitively permanent — only a
    // re-authentication widens the grant — so it MUST surface
    // the "re-auth needed" CTA on the first failed sync.
    const err = new MissingScopeError("github", ["repo"], []);
    expect(classifyConnectorError(err)).toBe("permanent");
  });
  it.each([
    ["401", "permanent"],
    ["403", "permanent"],
    ["404", "permanent"],
    ["410", "permanent"],
    ["422", "permanent"],
    ["408", "transient"],
    ["429", "transient"],
    ["500", "transient"],
    ["502", "transient"],
    ["503", "transient"],
  ])(
    "classifies plain Error('returned HTTP %s ...') as %s",
    (status, expected) => {
      const err = new Error(
        `Notion blocks API returned HTTP ${status} — body...`,
      );
      expect(classifyConnectorError(err)).toBe(expected);
    },
  );
  it("falls back to transient when no signal matches", () => {
    expect(classifyConnectorError(new Error("some unknown failure"))).toBe(
      "transient",
    );
    expect(classifyConnectorError(null)).toBe("transient");
    expect(classifyConnectorError("string error")).toBe("transient");
  });
});

describe("clearSyncFailureState", () => {
  it("routes through the dedicated success bridge call (not a record-failure with empty fields)", () => {
    const { bridge, recorded } = bridgeMock({
      lastErrorJson: '{"kind":"permanent","message":"401"}',
      retryCount: 5,
      failedPermanently: true,
    });
    clearSyncFailureState(bridge, "src-1");
    expect(recorded.success).toEqual(["src-1"]);
    // No record-failure call — clearing must be a single,
    // dedicated SQL statement so the audit trail shows
    // "success" not "failure with empty fields".
    expect(recorded.failure).toEqual([]);
  });
});
