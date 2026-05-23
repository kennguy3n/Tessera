import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";

// Regression coverage for the streamOpened gate in
// `apps/desktop/electron/ipc/model.ts` — the `if (streamOpened)`
// branch in the external-provider `finally` block.
//
// The bug Devin Review flagged on PR #27: the original
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

const streamExternalProviderMock = vi.fn<
  (
    opts: unknown,
    emit: EmitCb,
  ) => Promise<void>
>();

vi.mock("../externalProviderStream", () => ({
  streamExternalProvider: (opts: unknown, emit: EmitCb) =>
    streamExternalProviderMock(opts, emit),
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
        // emit callback, not off the renderer send.
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

  it("mid-stream failure (emit fires, THEN throws) DOES persist what was received", async () => {
    // The stream emits one chunk, then fails. Tokens already
    // delivered must count — the user was billed for them upstream
    // regardless of the eventual error.
    streamExternalProviderMock.mockImplementation(async (_opts, emit) => {
      emit({ content: "partial answer received" });
      throw new Error("ECONNRESET mid-stream");
    });

    await expect(invokeGenerate("a prompt")).rejects.toThrow(
      "ECONNRESET mid-stream",
    );

    expect(updateConfigMock).toHaveBeenCalledTimes(1);
    // Persisted counter MUST include both promptTokens AND the
    // delivered completion tokens, since the body actually opened.
    expect(persistedUsage.totalPromptTokens).toBeGreaterThan(0);
    expect(persistedUsage.totalCompletionTokens).toBeGreaterThan(0);
  });

  it("framing-only first chunk (empty content) still opens the stream and counts the prompt", async () => {
    // Some providers emit a framing-only first delta (e.g.
    // OpenAI's role-assignment chunk: `{ delta: { role: "assistant" } }`).
    // Empty `content` must still mark the stream as opened —
    // otherwise the user pays for a successful generation that
    // wraps a framing-only first chunk + an immediate
    // finish_reason and the counter records zero.
    streamExternalProviderMock.mockImplementation(async (_opts, emit) => {
      emit({ content: "" }); // framing-only
      emit({ content: "real content arrives" });
    });

    await invokeGenerate("a prompt");

    expect(updateConfigMock).toHaveBeenCalledTimes(1);
    expect(persistedUsage.totalPromptTokens).toBeGreaterThan(0);
    expect(persistedUsage.totalCompletionTokens).toBeGreaterThan(0);
  });

  it("clean completion persists both prompt and completion tokens", async () => {
    streamExternalProviderMock.mockImplementation(async (_opts, emit) => {
      emit({ content: "hello world" });
      emit({ content: " and more tokens" });
    });

    await invokeGenerate("a prompt");

    expect(updateConfigMock).toHaveBeenCalledTimes(1);
    expect(persistedUsage.totalPromptTokens).toBeGreaterThan(0);
    expect(persistedUsage.totalCompletionTokens).toBeGreaterThan(0);
  });
});
