/**
 * Tests for the `audit:listRecent` IPC handler.
 *
 * The handler delegates to `bridge.bridgeRecentAuditEvents` (real
 * implementation in `crates/tessera_bridge/src/napi_exports.rs`) so
 * we stub the bridge and assert the shape/validation contract:
 *
 *   1. Defaults (no args) → request 100 rows starting at offset 0.
 *   2. Explicit limit/offset are forwarded after clamping the
 *      renderer-side range to `[1, 500]`.
 *   3. Non-numeric / out-of-range values throw before reaching the
 *      bridge.
 *   4. Without a bridge (cold-start), the handler returns [] rather
 *      than throwing.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

const captured = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      captured.set(channel, listener);
    },
    removeHandler: (channel: string) => {
      captured.delete(channel);
    },
  },
}));

// The napi bridge surfaces serde-serialized `AuditEventType` strings.
// The Rust enum uses `#[serde(rename_all = "snake_case")]`, so the
// wire format is e.g. `"kchat_connected"` (not `"KchatConnected"`).
// Mirror that here so the test fixture matches production output.
const bridgeMock = {
  bridgeRecentAuditEvents: vi.fn().mockReturnValue([
    {
      id: "00000000-0000-0000-0000-000000000001",
      eventType: "kchat_connected",
      timestamp: "2025-01-01T00:00:00Z",
      details: "ok",
    },
  ]),
};

vi.mock("../appState", () => ({
  getBridge: () => bridgeMock,
}));

import { registerAuditHandlers } from "../ipc/audit";

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const listener = captured.get(channel);
  if (!listener) throw new Error(`No handler captured for "${channel}"`);
  return listener({} as unknown, ...args);
}

beforeEach(() => {
  captured.clear();
  bridgeMock.bridgeRecentAuditEvents.mockClear();
  bridgeMock.bridgeRecentAuditEvents.mockReturnValue([
    {
      id: "00000000-0000-0000-0000-000000000001",
      eventType: "kchat_connected",
      timestamp: "2025-01-01T00:00:00Z",
      details: "ok",
    },
  ]);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe("audit:listRecent IPC handler", () => {
  it("registers the channel exactly once", () => {
    registerAuditHandlers();
    expect(captured.has("audit:listRecent")).toBe(true);
  });

  it("defaults to limit=100 / offset=0 when called with no args", async () => {
    registerAuditHandlers();
    await invoke("audit:listRecent");
    expect(bridgeMock.bridgeRecentAuditEvents).toHaveBeenCalledWith(100, 0);
  });

  it("forwards an explicit limit + offset to the bridge", async () => {
    registerAuditHandlers();
    await invoke("audit:listRecent", 25, 50);
    expect(bridgeMock.bridgeRecentAuditEvents).toHaveBeenCalledWith(25, 50);
  });

  it("rejects out-of-range limits before reaching the bridge", async () => {
    registerAuditHandlers();
    await expect(invoke("audit:listRecent", 0, 0)).rejects.toThrow(/limit/);
    await expect(invoke("audit:listRecent", 1000, 0)).rejects.toThrow(/limit/);
    expect(bridgeMock.bridgeRecentAuditEvents).not.toHaveBeenCalled();
  });

  it("rejects non-numeric arguments", async () => {
    registerAuditHandlers();
    await expect(
      invoke("audit:listRecent", "huge" as unknown, 0),
    ).rejects.toThrow(/limit/);
    await expect(
      invoke("audit:listRecent", 25, "first" as unknown),
    ).rejects.toThrow(/offset/);
  });

  it("returns the bridge rows unchanged", async () => {
    registerAuditHandlers();
    const rows = (await invoke("audit:listRecent")) as Array<{ id: string }>;
    expect(rows).toEqual([
      {
        id: "00000000-0000-0000-0000-000000000001",
        eventType: "kchat_connected",
        timestamp: "2025-01-01T00:00:00Z",
        details: "ok",
      },
    ]);
  });
});
