/**
 * `sources:searchEnriched` IPC handler (Session 6 enriched search).
 *
 * The handler delegates to `bridgeSearchSourcesEnriched` and then
 * transforms the raw chunk `hits` (`SearchHitInfo`) into the renderer's
 * `SearchHit` shape — the same mapping as `sources:search` — while the
 * additive knowledge planes (entities, facts, concepts, memories) pass
 * through untouched. We mock the bridge (the `.node` addon is absent in
 * the vitest sandbox) and assert:
 *
 *   1. Valid args forward to the bridge and the result is re-shaped.
 *   2. `content`/`relevance` are mapped to `chunkContent`/`relevanceScore`.
 *   3. The knowledge planes survive verbatim.
 *   4. Out-of-range / malformed scalar inputs throw before the bridge.
 *   5. Without a bridge the handler resolves to a fully-empty result.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";

const handleMock = vi.fn();
const removeHandlerMock = vi.fn();

vi.mock("electron", () => ({
  ipcMain: {
    handle: (...args: unknown[]) => handleMock(...args),
    removeHandler: (...args: unknown[]) => removeHandlerMock(...args),
  },
  app: {
    getPath: (which: string) => {
      if (which === "userData") return "/tmp/does-not-matter";
      throw new Error(`unexpected getPath: ${which}`);
    },
  },
}));

let stubBridge: unknown = null;
vi.mock("../appState", () => ({
  getBridge: () => stubBridge,
  isBridgeAvailable: () => stubBridge !== null,
}));

import { registerSourcesHandlers } from "../ipc/sources";

function getHandler(
  channel: string,
): (event: unknown, ...args: unknown[]) => unknown {
  const call = handleMock.mock.calls.find((c) => c[0] === channel);
  if (!call) throw new Error(`No handler registered for ${channel}`);
  return call[1] as (event: unknown, ...args: unknown[]) => unknown;
}

const sampleMemory = {
  id: "11111111-1111-4111-8111-111111111111",
  scopeId: "22222222-2222-4222-8222-222222222222",
  observationType: "entity",
  content: "Acme Corp",
  state: "reinforced",
  retentionScore: 0.62,
  pinCount: 0,
  retrievalCount: 2,
  corroborationCount: 1,
  createdAt: 1_700_000_000,
  lastAccessedAt: 1_700_000_500,
  sourceId: "33333333-3333-4333-8333-333333333333",
};

const sampleConcept = {
  id: "44444444-4444-4444-8444-444444444444",
  label: "Acme Corp",
  definition: "concept node",
  state: "canonical",
  relatedSourceIds: ["33333333-3333-4333-8333-333333333333"],
};

const enriched = {
  hits: [
    {
      content: "the full chunk text about acme",
      excerpt: "…acme…",
      sourcePath: "/docs/acme.md",
      sourceId: "33333333-3333-4333-8333-333333333333",
      chunkHash: "deadbeef",
      chunkIndex: 4,
      relevance: 0.91,
    },
  ],
  entities: [sampleMemory],
  facts: [{ ...sampleMemory, observationType: "fact", content: "Acme ships Q4" }],
  concepts: [sampleConcept],
  memories: [sampleMemory],
};

beforeEach(() => {
  handleMock.mockReset();
  removeHandlerMock.mockReset();
  stubBridge = null;
});

describe("sources:searchEnriched IPC handler", () => {
  it("transforms chunk hits and passes the knowledge plane through", async () => {
    const bridgeSearchSourcesEnriched = vi.fn().mockReturnValue(enriched);
    stubBridge = { bridgeSearchSourcesEnriched };
    registerSourcesHandlers();

    const result = (await getHandler("sources:searchEnriched")(
      {},
      "acme",
      10,
    )) as {
      hits: Array<{
        chunkContent: string;
        relevanceScore: number;
        sourcePath: string;
        chunkHash: string;
      }>;
      entities: unknown[];
      facts: unknown[];
      concepts: unknown[];
      memories: unknown[];
    };

    expect(bridgeSearchSourcesEnriched).toHaveBeenCalledWith("acme", 10);
    // hits re-shaped: content -> chunkContent, relevance -> relevanceScore.
    expect(result.hits).toEqual([
      {
        sourcePath: "/docs/acme.md",
        sourceId: "33333333-3333-4333-8333-333333333333",
        chunkHash: "deadbeef",
        chunkContent: "the full chunk text about acme",
        relevanceScore: 0.91,
        excerpt: "…acme…",
      },
    ]);
    // Knowledge planes pass through verbatim.
    expect(result.entities).toEqual(enriched.entities);
    expect(result.facts).toEqual(enriched.facts);
    expect(result.concepts).toEqual(enriched.concepts);
    expect(result.memories).toEqual(enriched.memories);
  });

  it("rejects an out-of-range limit before touching the bridge", async () => {
    const bridgeSearchSourcesEnriched = vi.fn();
    stubBridge = { bridgeSearchSourcesEnriched };
    registerSourcesHandlers();

    await expect(
      getHandler("sources:searchEnriched")({}, "acme", 0),
    ).rejects.toThrow();
    await expect(
      getHandler("sources:searchEnriched")({}, "acme", 99_999),
    ).rejects.toThrow();
    await expect(
      getHandler("sources:searchEnriched")({}, 123, 10),
    ).rejects.toThrow();
    expect(bridgeSearchSourcesEnriched).not.toHaveBeenCalled();
  });

  it("returns a fully-empty result when the bridge is unavailable", async () => {
    stubBridge = null;
    registerSourcesHandlers();

    const result = (await getHandler("sources:searchEnriched")(
      {},
      "acme",
      10,
    )) as Record<string, unknown[]>;
    expect(result).toEqual({
      hits: [],
      entities: [],
      facts: [],
      concepts: [],
      memories: [],
    });
  });
});
