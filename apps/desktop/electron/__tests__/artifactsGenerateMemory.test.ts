/**
 * IPC round-trip test for the memory-augmented generation path
 * (`artifacts:generateFromTemplate`). Asserts that the handler pulls
 * substrate memories/concepts and forwards them to the native
 * `bridgeGenerateFromTemplate` as the additive third argument, while
 * remaining backward compatible (no context → third arg omitted).
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const captured = new Map<string, (...args: unknown[]) => unknown>();

vi.mock("electron", () => ({
  app: { getPath: vi.fn().mockReturnValue("/tmp") },
  BrowserWindow: { getFocusedWindow: vi.fn().mockReturnValue(null) },
  dialog: {},
  ipcMain: {
    handle: (channel: string, listener: (...args: unknown[]) => unknown) => {
      captured.set(channel, listener);
    },
    removeHandler: (channel: string) => {
      captured.delete(channel);
    },
  },
}));

// Keep the OnGenerate automation dispatch out of this test's scope; we
// only care about the generation call + its augmentation argument.
vi.mock("../scheduler", () => ({
  dispatchOnGenerate: vi.fn().mockResolvedValue(undefined),
}));

const sampleMemory = {
  id: "11111111-1111-4111-8111-111111111111",
  scopeId: "22222222-2222-4222-8222-222222222222",
  observationType: "entity",
  content: "Atlas is the project codename",
  state: "canonical",
  retentionScore: 0.9,
  pinCount: 1,
  retrievalCount: 2,
  corroborationCount: 3,
  createdAt: 1_700_000_000,
  lastAccessedAt: 1_700_000_000,
  sourceId: "33333333-3333-4333-8333-333333333333",
};

const generatedArtifact = { id: "art-1", title: "PRD" };

const bridgeMock = {
  bridgeGetMemories: vi.fn().mockReturnValue([sampleMemory]),
  bridgeGetConceptGraph: vi.fn().mockReturnValue(
    JSON.stringify({
      nodes: [
        { id: "a", label: "Atlas" },
        { id: "b", label: "Project" },
      ],
      edges: [{ from: "a", to: "b", relation_type: "is_a" }],
    }),
  ),
  bridgeGenerateFromTemplate: vi.fn().mockReturnValue(generatedArtifact),
};

let bridgeAvailable = true;

vi.mock("../appState", () => ({
  getBridge: () => (bridgeAvailable ? bridgeMock : null),
}));

import { registerArtifactsHandlers } from "../ipc/artifacts";

async function invoke(channel: string, ...args: unknown[]): Promise<unknown> {
  const listener = captured.get(channel);
  if (!listener) throw new Error(`No handler captured for "${channel}"`);
  return listener({} as unknown, ...args);
}

const TEMPLATE_ID = "44444444-4444-4444-8444-444444444444";
const SOURCE_ID = "33333333-3333-4333-8333-333333333333";

describe("artifacts:generateFromTemplate (memory-augmented)", () => {
  beforeEach(() => {
    captured.clear();
    bridgeAvailable = true;
    vi.clearAllMocks();
    bridgeMock.bridgeGetMemories.mockReturnValue([sampleMemory]);
    bridgeMock.bridgeGenerateFromTemplate.mockReturnValue(generatedArtifact);
    registerArtifactsHandlers();
  });

  it("forwards substrate context as the third generation argument", async () => {
    const result = await invoke(
      "artifacts:generateFromTemplate",
      TEMPLATE_ID,
      [SOURCE_ID],
    );
    expect(result).toEqual(generatedArtifact);
    expect(bridgeMock.bridgeGenerateFromTemplate).toHaveBeenCalledTimes(1);
    const [tpl, ids, context] =
      bridgeMock.bridgeGenerateFromTemplate.mock.calls[0];
    expect(tpl).toBe(TEMPLATE_ID);
    expect(ids).toEqual([SOURCE_ID]);
    expect(Array.isArray(context)).toBe(true);
    expect(context.join("\n")).toContain("Atlas is the project codename");
    expect(context.join("\n")).toContain("Atlas — is a → Project");
  });

  it("omits the third argument when the substrate is empty (backward compatible)", async () => {
    bridgeMock.bridgeGetMemories.mockReturnValue([]);
    bridgeMock.bridgeGetConceptGraph.mockReturnValue('{"nodes":[],"edges":[]}');
    await invoke("artifacts:generateFromTemplate", TEMPLATE_ID, [SOURCE_ID]);
    expect(bridgeMock.bridgeGenerateFromTemplate).toHaveBeenCalledWith(
      TEMPLATE_ID,
      [SOURCE_ID],
      undefined,
    );
  });

  it("still generates when substrate access throws", async () => {
    bridgeMock.bridgeGetMemories.mockImplementation(() => {
      throw new Error("substrate locked");
    });
    bridgeMock.bridgeGetConceptGraph.mockImplementation(() => {
      throw new Error("substrate locked");
    });
    const result = await invoke(
      "artifacts:generateFromTemplate",
      TEMPLATE_ID,
      [SOURCE_ID],
    );
    expect(result).toEqual(generatedArtifact);
    expect(bridgeMock.bridgeGenerateFromTemplate).toHaveBeenCalledWith(
      TEMPLATE_ID,
      [SOURCE_ID],
      undefined,
    );
  });

  it("throws before generating when the bridge is unavailable", async () => {
    bridgeAvailable = false;
    await expect(
      invoke("artifacts:generateFromTemplate", TEMPLATE_ID, [SOURCE_ID]),
    ).rejects.toThrow("Native bridge not available");
  });
});
