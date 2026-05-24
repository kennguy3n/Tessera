import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Regression coverage for the streamOpened gate in
// `apps/desktop/electron/ipc/model.ts` — the `if (streamOpened)`
// branch in the external-provider `finally` block.
//
// The bug : the original
// implementation persisted the `promptTokens` estimate
// unconditionally in `finally`, so a pre-stream failure (401, 403,
// retry-exhausted 503, DNS / TLS error — anything that surfaces as a
// throw from `streamExternalProvider` BEFORE the body opens)
// inflated the cumulative-usage counter by the prompt-token estimate
// even though the provider was never invoked and the user was never
// billed. A misconfigured API key that triggers 3 retries plus a
// final 401 would make the counter climb without any actual spend.
//
// Fix: track a `streamOpened` boolean that flips true the FIRST time
// the emit callback runs (even with empty content for framing-only
// deltas). Only persist the cumulative delta when `streamOpened`
// is true. Pre-stream failures keep the counter untouched;
// mid-stream failures still count what was actually received
// because chunks have already arrived by then.

type IpcListener = (event: unknown, ...args: unknown[]) => unknown;

const registeredHandlers = new Map<string, IpcListener>();

const handleMock = vi.fn((channel: string, listener: IpcListener) => {
  registeredHandlers.set(channel, listener);
});
const removeHandlerMock = vi.fn((channel: string) => {
  registeredHandlers.delete(channel);
});

vi.mock("electron", () => ({
  ipcMain: {
    removeHandler: (...args: unknown[]) =>
      removeHandlerMock(args[0] as string),
    handle: (...args: unknown[]) =>
      handleMock(args[0] as string, args[1] as IpcListener),
  },
  BrowserWindow: class {
    static fromWebContents() {
      return null;
    }
  },
}));

vi.mock("../appState", () => ({
  getModelSidecar: () => ({ isRunning: false }),
}));

const externalProvider = {
  enabled: true,
  providerType: "openai_compatible" as const,
  apiUrl: "https://api.example.com/v1",
  apiKeyRef: "tessera_default",
  modelName: "fake-model",
  maxTokens: 256,
  temperature: 0.2,
  timeoutSecs: 30,
  maxRetries: 3,
};

let persistedUsage = {
  totalPromptTokens: 0,
  totalCompletionTokens: 0,
  lastResetDate: new Date("2025-01-01T00:00:00.000Z").toISOString(),
};

const loadConfigMock = vi.fn(() => ({
  externalProvider,
  externalProviderTokenUsage: persistedUsage,
}));
const updateConfigMock = vi.fn((patch: Record<string, unknown>) => {
  if (patch.externalProviderTokenUsage) {
    persistedUsage = patch.externalProviderTokenUsage as typeof persistedUsage;
  }
});

vi.mock("../config", () => ({
  loadConfig: (...args: unknown[]) => loadConfigMock(...args),
  updateConfig: (...args: unknown[]) => updateConfigMock(...args),
}));

vi.mock("../secretsVault", () => ({
  getSecret: vi.fn(() => "sk-test"),
  hasSecret: vi.fn(() => true),
}));

type EmitCb = (chunk: { content: string }) => void;
type OnBodyOpenedCb = () => void;

const streamExternalProviderMock = vi.fn<
  (
    opts: unknown,
    emit: EmitCb,
    onBodyOpened?: OnBodyOpenedCb,
  ) => Promise<void>
>();

vi.mock("../externalProviderStream", () => ({
  streamExternalProvider: (
    opts: unknown,
    emit: EmitCb,
    onBodyOpened?: OnBodyOpenedCb,
  ) => streamExternalProviderMock(opts, emit, onBodyOpened),
}));

// Token counter — use the real module so the heuristic stays under
// test rather than being mocked away. We only need the
// estimateTokens shape; accumulateTokenUsage is pure arithmetic and
// covered by tokenCounter.test.ts.
vi.mock("../tokenCounter", async () => {
  const actual =
    await vi.importActual<typeof import("../tokenCounter")>("../tokenCounter");
  return actual;
});

import {
  registerModelHandlers,
  _resetActiveGenerationControllerForTests,
} from "../ipc/model";

function invokeGenerate(prompt: string): Promise<void> {
  const handler = registeredHandlers.get("model:generate");
  if (!handler) throw new Error("model:generate not registered");
  return handler(
    {
      sender: {
        // Trigger the destroyed-window short-circuit in
        // safeRendererSender so we don't have to fabricate a
        // BrowserWindow. The token-usage path runs identically
        // either way because the streamOpened gate keys off the
        // `onBodyOpened` callback passed to `streamExternalProvider`,
        // not off the renderer send.
        isDestroyed: () => true,
      },
    },
    { prompt, maxTokens: 64, temperature: 0.2 },
  ) as Promise<void>;
}

describe("model:generate — streamOpened gate", () => {
  beforeEach(() => {
    registeredHandlers.clear();
    handleMock.mockClear();
    removeHandlerMock.mockClear();
    streamExternalProviderMock.mockReset();
    loadConfigMock.mockClear();
    updateConfigMock.mockClear();
    persistedUsage = {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      lastResetDate: new Date("2025-01-01T00:00:00.000Z").toISOString(),
    };
    _resetActiveGenerationControllerForTests();
    registerModelHandlers();
  });

  afterEach(() => {
    registeredHandlers.clear();
  });

  it("pre-stream failure (throws BEFORE emit) does NOT inflate the token counter", async () => {
    // The upstream rejects with a 401-like error before the emit
    // callback ever runs — this is exactly the scenario the
    // bug report described: a misconfigured API key, retry
    // exhaustion, DNS failure, TLS failure, etc.
    streamExternalProviderMock.mockImplementation(async () => {
      throw new Error("HTTP 401 Unauthorized");
    });

    await expect(
      invokeGenerate("a fairly long prompt that estimates many tokens"),
    ).rejects.toThrow("HTTP 401 Unauthorized");

    // No usage write at all — pre-fix this would have called
    // updateConfig with a non-zero promptTokens.
    expect(updateConfigMock).not.toHaveBeenCalled();
    expect(persistedUsage.totalPromptTokens).toBe(0);
    expect(persistedUsage.totalCompletionTokens).toBe(0);
  });

  it("mid-stream failure (body-opened fires, emit fires, THEN throws) DOES persist what was received", async () => {
    // The stream opens the body, emits one chunk, then fails.
    // Tokens already delivered must count — the user was billed
    // for them upstream regardless of the eventual error.
    streamExternalProviderMock.mockImplementation(
      async (_opts, emit, onBodyOpened) => {
        onBodyOpened?.();
        emit({ content: "partial answer received" });
        throw new Error("ECONNRESET mid-stream");
      },
    );

    await expect(invokeGenerate("a prompt")).rejects.toThrow(
      "ECONNRESET mid-stream",
    );

    expect(updateConfigMock).toHaveBeenCalledTimes(1);
    // Persisted counter MUST include both promptTokens AND the
    // delivered completion tokens, since the body actually opened.
    expect(persistedUsage.totalPromptTokens).toBeGreaterThan(0);
    expect(persistedUsage.totalCompletionTokens).toBeGreaterThan(0);
  });

  it("body opens but only framing-only deltas arrive before error — prompt tokens STILL count", async () => {
    // Regression test: the gate was originally
    // keyed on the `emit` callback firing, but `dispatchOpenAIEvent`
    // and `dispatchAnthropicEvent` filter framing-only events
    // (role-only deltas, content_block_start, message_start, ping)
    // BEFORE calling emit — see `externalProviderStream.ts` lines
    // 304/330. A provider that sends a role-assignment chunk
    // (counted upstream, billed) and then errors before any
    // non-empty content would NOT trigger emit — so the gate would
    // wrongly leave `streamOpened = false` and the prompt-token
    // count would never be persisted.
    //
    // The fix re-architected the gate to fire on the `onBodyOpened`
    // callback that `streamExternalProvider` invokes once the body
    // is confirmed open, INDEPENDENT of SSE content filtering. This
    // test simulates the framing-only-then-error scenario exactly:
    // body opens, no emit fires, then the stream throws.
    streamExternalProviderMock.mockImplementation(
      async (_opts, _emit, onBodyOpened) => {
        onBodyOpened?.();
        // No emit() call — simulates a real provider that sent only
        // role-only / framing events before erroring.
        throw new Error("ECONNRESET after framing-only delta");
      },
    );

    await expect(invokeGenerate("a prompt")).rejects.toThrow(
      "ECONNRESET after framing-only delta",
    );

    expect(updateConfigMock).toHaveBeenCalledTimes(1);
    // Prompt tokens MUST count because the body opened (upstream
    // accepted the request and billed for the prompt).
    expect(persistedUsage.totalPromptTokens).toBeGreaterThan(0);
    // Completion tokens are zero because no content was delivered
    // — the user didn't receive any tokens from this generation.
    expect(persistedUsage.totalCompletionTokens).toBe(0);
  });

  it("body NEVER opens (onBodyOpened never fires) — no usage write", async () => {
    // Companion to the framing-only test above: if the upstream
    // throws BEFORE the body opens (HTTP 401, retry exhaustion, DNS
    // failure), `onBodyOpened` must never fire and the counter
    // must not move. This is the standard pre-stream-failure
    // scenario but pinned to the new architectural contract.
    streamExternalProviderMock.mockImplementation(
      async (_opts, _emit, _onBodyOpened) => {
        // Do NOT call onBodyOpened. Throw a pre-stream error.
        throw new Error("HTTP 403 Forbidden");
      },
    );

    await expect(invokeGenerate("a prompt")).rejects.toThrow(
      "HTTP 403 Forbidden",
    );

    expect(updateConfigMock).not.toHaveBeenCalled();
    expect(persistedUsage.totalPromptTokens).toBe(0);
    expect(persistedUsage.totalCompletionTokens).toBe(0);
  });

  it("clean completion: body-opened fires, then content arrives, prompt+completion both count", async () => {
    streamExternalProviderMock.mockImplementation(
      async (_opts, emit, onBodyOpened) => {
        onBodyOpened?.();
        emit({ content: "real content arrives" });
      },
    );

    await invokeGenerate("a prompt");

    expect(updateConfigMock).toHaveBeenCalledTimes(1);
    expect(persistedUsage.totalPromptTokens).toBeGreaterThan(0);
    expect(persistedUsage.totalCompletionTokens).toBeGreaterThan(0);
  });

  it("two-chunk clean completion persists both prompt and completion tokens", async () => {
    streamExternalProviderMock.mockImplementation(
      async (_opts, emit, onBodyOpened) => {
        onBodyOpened?.();
        emit({ content: "hello world" });
        emit({ content: " and more tokens" });
      },
    );

    await invokeGenerate("a prompt");

    expect(updateConfigMock).toHaveBeenCalledTimes(1);
    expect(persistedUsage.totalPromptTokens).toBeGreaterThan(0);
    expect(persistedUsage.totalCompletionTokens).toBeGreaterThan(0);
  });

  it("completion-token count equals the BULK estimate of the concatenated stream, not the per-chunk sum", async () => {
    // Regression test: the
    // earlier implementation summed `estimateTokens(chunk.content)`
    // per SSE chunk, applying `Math.ceil(length / 4)` independently
    // to each short delta. This systematically over-counted because
    // every chunk \u22641 char paid a forced 1-token floor. The fix
    // accumulates the raw completion text and calls `estimateTokens`
    // ONCE on the concatenation in the `finally` block.
    //
    // Concrete witness from the bot's example: streaming "Hello",
    // ", ", "world" with the broken implementation yields
    // ceil(5/4) + ceil(1/4) + ceil(5/4) = 2+1+2 = 5 tokens. The
    // correct bulk estimate is ceil(12/4) = 3 tokens (the
    // concatenated text "Hello, world" has 12 chars after the
    // whitespace-collapse normalisation in `estimateTokens`). A
    // regression that reintroduces per-chunk summing would push
    // this assertion from 3 back to 5.
    streamExternalProviderMock.mockImplementation(
      async (_opts, emit, onBodyOpened) => {
        onBodyOpened?.();
        emit({ content: "Hello" });
        emit({ content: ", " });
        emit({ content: "world" });
      },
    );

    await invokeGenerate("a prompt");

    expect(updateConfigMock).toHaveBeenCalledTimes(1);
    // 3 = ceil(12 / 4) where 12 is `len("Hello, world")` after the
    // collapse-whitespace normalisation that `estimateTokens`
    // applies internally. If a future refactor changes
    // `estimateTokens` to round differently this literal will need
    // updating, but the BULK-equals-streaming invariant is the
    // contract this test pins.
    expect(persistedUsage.totalCompletionTokens).toBe(3);
  });

  it("a single long chunk and many short chunks produce IDENTICAL completion-token counts when their concatenations match", async () => {
    // Companion to the witness above: pin the bulk-equals-streaming
    // invariant directly by running the SAME 24-char text through
    // (a) a single chunk and (b) twelve 2-char chunks, then
    // asserting both runs land on the same persisted counter
    // value. Without this invariant the per-chunk path would emit
    // 12 tokens (each 2-char chunk getting `MIN_TOKENS_FOR_NON_EMPTY
    // = 1`) while the single-chunk path would emit 6 (= ceil(24/4)).
    const text = "the quick brown fox jumps"; // 25 chars, 1 space
    // Reset counter between the two runs so we measure the delta
    // from each generation independently.
    persistedUsage = {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      lastResetDate: new Date("2025-01-01T00:00:00.000Z").toISOString(),
    };

    streamExternalProviderMock.mockImplementation(
      async (_opts, emit, onBodyOpened) => {
        onBodyOpened?.();
        emit({ content: text });
      },
    );
    await invokeGenerate("a prompt");
    const singleChunkCompletion = persistedUsage.totalCompletionTokens;

    // Reset for the many-chunk run.
    persistedUsage = {
      totalPromptTokens: 0,
      totalCompletionTokens: 0,
      lastResetDate: new Date("2025-01-01T00:00:00.000Z").toISOString(),
    };

    streamExternalProviderMock.mockImplementation(
      async (_opts, emit, onBodyOpened) => {
        onBodyOpened?.();
        // Split into 2-char chunks. The Anthropic delta protocol does
        // exactly this in practice for short token chunks.
        for (let i = 0; i < text.length; i += 2) {
          emit({ content: text.slice(i, i + 2) });
        }
      },
    );
    await invokeGenerate("a prompt");
    const manyChunkCompletion = persistedUsage.totalCompletionTokens;

    expect(manyChunkCompletion).toBe(singleChunkCompletion);
  });
});
