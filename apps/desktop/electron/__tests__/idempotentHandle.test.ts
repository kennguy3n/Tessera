import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// `idempotentHandle` exists so re-importing a per-domain handler
// module (test harness, future hot-reload) can re-register the same
// channel without crashing Electron's "Attempted to register a second
// handler for '<channel>'" guard. These tests assert that contract
// against a stubbed `ipcMain` so the registration path stays safe
// without spinning up a real Electron main process.

const removeHandlerMock = vi.fn();
const handleMock = vi.fn();

vi.mock("electron", () => ({
  ipcMain: {
    removeHandler: (...args: unknown[]) => removeHandlerMock(...args),
    handle: (...args: unknown[]) => handleMock(...args),
  },
}));

import { idempotentHandle } from "../ipc/register";

describe("idempotentHandle", () => {
  beforeEach(() => {
    removeHandlerMock.mockReset();
    handleMock.mockReset();
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("removes any prior handler before registering", () => {
    const listener = async () => "ok";
    idempotentHandle("test:channel", listener);
    expect(removeHandlerMock).toHaveBeenCalledTimes(1);
    expect(removeHandlerMock).toHaveBeenCalledWith("test:channel");
    expect(handleMock).toHaveBeenCalledTimes(1);
    expect(handleMock).toHaveBeenCalledWith("test:channel", listener);
  });

  it("calls remove THEN handle (order matters — swapping them would race)", () => {
    const calls: string[] = [];
    removeHandlerMock.mockImplementation(() => calls.push("remove"));
    handleMock.mockImplementation(() => calls.push("handle"));
    idempotentHandle("test:channel", async () => undefined);
    expect(calls).toEqual(["remove", "handle"]);
  });

  it("supersedes a previous registration when called twice for the same channel", () => {
    const first = async () => "first";
    const second = async () => "second";
    idempotentHandle("test:channel", first);
    idempotentHandle("test:channel", second);
    expect(removeHandlerMock).toHaveBeenCalledTimes(2);
    expect(handleMock).toHaveBeenNthCalledWith(1, "test:channel", first);
    expect(handleMock).toHaveBeenNthCalledWith(2, "test:channel", second);
  });
});
