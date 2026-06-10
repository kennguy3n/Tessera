/**
 * Tests for the `substrate:*` IPC handlers (Session 1 knowledge
 * substrate). Each handler validates its scalar inputs with the
 * `./validate.ts` helpers and delegates to a `bridge*` N-API function
 * (real implementation in `crates/tessera_bridge/src/substrate.rs`), so
 * we stub the bridge and assert the validation + delegation contract:
 *
 *   1. Valid args are forwarded to the matching bridge method.
 *   2. Optional `scope` / `maxNodes` default to `null` when omitted.
 *   3. Malformed ids / out-of-range node caps throw before the bridge
 *      is touched.
 *   4. Without a bridge (cold start) every channel throws the standard
 *      "Native bridge not available" error rather than calling through.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

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

const sampleMemory = {
  id: "11111111-1111-4111-8111-111111111111",
  scopeId: "22222222-2222-4222-8222-222222222222",
  observationType: "fact",
  content: "an extracted fact",
  state: "candidate",
  retentionScore: 0.25,
  pinCount: 0,
  retrievalCount: 0,
  corroborationCount: 0,
  createdAt: 1_700_000_000,
  lastAccessedAt: 1_700_000_000,
  sourceId: "33333333-3333-4333-8333-333333333333",
};

const bridgeMock = {
  bridgeExtractObservations: vi.fn().mockReturnValue(7),
  bridgeGetMemories: vi.fn().mockReturnValue([sampleMemory]),
  bridgePinMemory: vi.fn().mockReturnValue({ ...sampleMemory, pinCount: 1 }),
  bridgeUnpinMemory: vi.fn().mockReturnValue(sampleMemory),
  bridgeForgetMemory: vi.fn().mockReturnValue(undefined),
  bridgeGetConceptGraph: vi.fn().mockReturnValue('{"nodes":[],"edges":[]}'),
  bridgeSuggestRelatedSources: vi.fn().mockReturnValue([
    {
      entity: "acme corp",
      sourceIds: ["55555555-5555-4555-8555-555555555555"],
      score: 1,
    },
  ]),
  bridgeRunDecaySweep: vi
    .fn()
    .mockReturnValue({ scored: 3, candidatesArchived: 1, supersededArchived: 0 }),
  bridgeTriggerSynthesis: vi.fn().mockReturnValue({
    windowId: "44444444-4444-4444-8444-444444444444",
    scopeId: sampleMemory.scopeId,
    version: 1,
    recap: "Working set: 1 decisions.",
    decisions: ["We decided to ship."],
    openQuestions: [],
    activeTasks: [],
  }),
};

let bridgeAvailable = true;

vi.mock("../appState", () => ({
  getBridge: () => (bridgeAvailable ? bridgeMock : null),
}));

import { registerSubstrateHandlers } from "../ipc/substrate";

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const listener = captured.get(channel);
  if (!listener) throw new Error(`No handler captured for "${channel}"`);
  return listener({} as unknown, ...args);
}

const SOURCE_ID = "33333333-3333-4333-8333-333333333333";
const MEM_ID = "11111111-1111-4111-8111-111111111111";

beforeEach(() => {
  captured.clear();
  bridgeAvailable = true;
  Object.values(bridgeMock).forEach((fn) => fn.mockClear());
  registerSubstrateHandlers();
});

describe("substrate IPC handlers", () => {
  it("registers all nine channels", () => {
    expect([...captured.keys()].sort()).toEqual(
      [
        "substrate:extractObservations",
        "substrate:forgetMemory",
        "substrate:getConceptGraph",
        "substrate:getMemories",
        "substrate:pinMemory",
        "substrate:runDecaySweep",
        "substrate:suggestRelatedSources",
        "substrate:triggerSynthesis",
        "substrate:unpinMemory",
      ].sort(),
    );
  });

  it("forwards a valid sourceId to bridgeExtractObservations", async () => {
    const count = await invoke("substrate:extractObservations", SOURCE_ID);
    expect(count).toBe(7);
    expect(bridgeMock.bridgeExtractObservations).toHaveBeenCalledWith(SOURCE_ID);
  });

  it("defaults an omitted scope to null on getMemories", async () => {
    const memories = await invoke("substrate:getMemories", null);
    expect(memories).toEqual([sampleMemory]);
    expect(bridgeMock.bridgeGetMemories).toHaveBeenCalledWith(null);
  });

  it("passes an explicit scope label through to getMemories", async () => {
    await invoke("substrate:getMemories", "default");
    expect(bridgeMock.bridgeGetMemories).toHaveBeenCalledWith("default");
  });

  it("pins, unpins and forgets by id", async () => {
    await invoke("substrate:pinMemory", MEM_ID);
    expect(bridgeMock.bridgePinMemory).toHaveBeenCalledWith(MEM_ID);
    await invoke("substrate:unpinMemory", MEM_ID);
    expect(bridgeMock.bridgeUnpinMemory).toHaveBeenCalledWith(MEM_ID);
    await invoke("substrate:forgetMemory", MEM_ID);
    expect(bridgeMock.bridgeForgetMemory).toHaveBeenCalledWith(MEM_ID);
  });

  it("clamps-validates and forwards the concept-graph node cap", async () => {
    await invoke("substrate:getConceptGraph", null, 50);
    expect(bridgeMock.bridgeGetConceptGraph).toHaveBeenCalledWith(null, 50);
    await invoke("substrate:getConceptGraph", "default", null);
    expect(bridgeMock.bridgeGetConceptGraph).toHaveBeenCalledWith("default", null);
  });

  it("runs a decay sweep and returns the report", async () => {
    const report = await invoke("substrate:runDecaySweep");
    expect(report).toEqual({
      scored: 3,
      candidatesArchived: 1,
      supersededArchived: 0,
    });
    expect(bridgeMock.bridgeRunDecaySweep).toHaveBeenCalledOnce();
  });

  it("triggers synthesis with a default scope", async () => {
    const synth = (await invoke("substrate:triggerSynthesis", null)) as {
      decisions: string[];
    };
    expect(synth.decisions).toEqual(["We decided to ship."]);
    expect(bridgeMock.bridgeTriggerSynthesis).toHaveBeenCalledWith(null);
  });

  it("rejects a malformed memory id before touching the bridge", async () => {
    await expect(invoke("substrate:pinMemory", "bad id!")).rejects.toThrow();
    expect(bridgeMock.bridgePinMemory).not.toHaveBeenCalled();
  });

  it("rejects a non-integer / out-of-range node cap", async () => {
    await expect(
      invoke("substrate:getConceptGraph", null, 0),
    ).rejects.toThrow();
    await expect(
      invoke("substrate:getConceptGraph", null, 1.5),
    ).rejects.toThrow();
    expect(bridgeMock.bridgeGetConceptGraph).not.toHaveBeenCalled();
  });

  it("forwards a selected-source set and default cap to suggestRelatedSources", async () => {
    const selected = ["33333333-3333-4333-8333-333333333333"];
    const suggestions = (await invoke(
      "substrate:suggestRelatedSources",
      selected,
      null,
    )) as Array<{ entity: string }>;
    expect(suggestions[0].entity).toBe("acme corp");
    expect(bridgeMock.bridgeSuggestRelatedSources).toHaveBeenCalledWith(
      selected,
      null,
    );
  });

  it("passes an explicit max-suggestions cap through to suggestRelatedSources", async () => {
    await invoke(
      "substrate:suggestRelatedSources",
      ["33333333-3333-4333-8333-333333333333"],
      5,
    );
    expect(bridgeMock.bridgeSuggestRelatedSources).toHaveBeenCalledWith(
      ["33333333-3333-4333-8333-333333333333"],
      5,
    );
  });

  it("rejects a malformed source id in the selected set before touching the bridge", async () => {
    await expect(
      invoke("substrate:suggestRelatedSources", ["not a uuid!"], null),
    ).rejects.toThrow();
    expect(bridgeMock.bridgeSuggestRelatedSources).not.toHaveBeenCalled();
  });

  it("rejects an out-of-range max-suggestions cap", async () => {
    await expect(
      invoke(
        "substrate:suggestRelatedSources",
        ["33333333-3333-4333-8333-333333333333"],
        0,
      ),
    ).rejects.toThrow();
    expect(bridgeMock.bridgeSuggestRelatedSources).not.toHaveBeenCalled();
  });

  it("throws when the native bridge is unavailable", async () => {
    bridgeAvailable = false;
    await expect(
      invoke("substrate:extractObservations", SOURCE_ID),
    ).rejects.toThrow("Native bridge not available");
    await expect(invoke("substrate:runDecaySweep")).rejects.toThrow(
      "Native bridge not available",
    );
  });
});
