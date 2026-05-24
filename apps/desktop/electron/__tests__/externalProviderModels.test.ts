import { describe, it, expect, vi, afterEach } from "vitest";
import { listExternalProviderModels } from "../externalProviderModels";
import type { ExternalProviderConfig } from "../config";

function mkProvider(
  overrides: Partial<ExternalProviderConfig> = {},
): ExternalProviderConfig {
  return {
    enabled: true,
    providerType: "openai_compatible",
    apiUrl: "https://api.example.com",
    apiKeyRef: "tessera.external_provider.test",
    modelName: "test-model",
    maxTokens: 256,
    temperature: 0.4,
    timeoutSecs: 30,
    maxRetries: 2,
    ...overrides,
  };
}

afterEach(() => {
  vi.restoreAllMocks();
});

describe("listExternalProviderModels — OpenAI-compatible", () => {
  it("parses the standard `{object,data:[{id}]}` response into a sorted, deduped list", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          object: "list",
          data: [
            { id: "gpt-4o-mini", object: "model" },
            { id: "gpt-4o", object: "model" },
            { id: "gpt-4o-mini", object: "model" }, // duplicate
            { id: "gpt-3.5-turbo", object: "model" },
          ],
        }),
        { status: 200, headers: { "content-type": "application/json" } },
      ),
    );
    const result = await listExternalProviderModels(mkProvider(), "sk");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.models).toEqual(["gpt-3.5-turbo", "gpt-4o", "gpt-4o-mini"]);
    }
    // Verify the URL composed correctly.
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    const [calledUrl, opts] = fetchSpy.mock.calls[0]!;
    expect(calledUrl).toBe("https://api.example.com/v1/models");
    expect(opts?.method).toBe("GET");
    expect((opts?.headers as Record<string, string>).Authorization).toBe(
      "Bearer sk",
    );
  });

  it("strips a `/v1/chat/completions` suffix from the configured apiUrl before appending /v1/models", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: "gpt-4o" }] }), {
        status: 200,
      }),
    );
    await listExternalProviderModels(
      mkProvider({ apiUrl: "https://api.openai.com/v1/chat/completions" }),
      "sk",
    );
    expect(fetchSpy.mock.calls[0]![0]).toBe("https://api.openai.com/v1/models");
  });

  it("strips a non-versioned `/chat/completions` suffix (LM Studio / older shims)", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: "local" }] }), { status: 200 }),
    );
    await listExternalProviderModels(
      mkProvider({ apiUrl: "http://localhost:1234/chat/completions" }),
      "sk",
    );
    // The trim removes `/chat/completions`, then `/v1/models` is appended.
    expect(fetchSpy.mock.calls[0]![0]).toBe(
      "http://localhost:1234/v1/models",
    );
  });

  it("accepts an already-resolved `/v1/models` URL without double-appending", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [{ id: "x" }] }), { status: 200 }),
    );
    await listExternalProviderModels(
      mkProvider({ apiUrl: "https://api.example.com/v1/models" }),
      "sk",
    );
    expect(fetchSpy.mock.calls[0]![0]).toBe("https://api.example.com/v1/models");
  });

  it("returns kind: error on non-2xx with body preview included", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("missing scope: models.read", { status: 403 }),
    );
    const result = await listExternalProviderModels(mkProvider(), "sk");
    expect(result).toEqual({
      ok: false,
      kind: "error",
      error: "HTTP 403: missing scope: models.read",
    });
  });

  it("returns kind: error when the response shape lacks a data[] array", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ object: "list" }), { status: 200 }),
    );
    const result = await listExternalProviderModels(mkProvider(), "sk");
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "error") {
      expect(result.error).toMatch(/unexpected response shape/);
    }
  });

  it("returns kind: error when data[] is empty (no usable model ids)", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(JSON.stringify({ data: [] }), { status: 200 }),
    );
    const result = await listExternalProviderModels(mkProvider(), "sk");
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "error") {
      expect(result.error).toMatch(/empty list/);
    }
  });

  it("skips data[] entries whose id field is missing or non-string", async () => {
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response(
        JSON.stringify({
          data: [
            { id: "valid-model" },
            { id: 12345 }, // non-string id — filtered out
            { id: "" }, // empty string id — filtered out
            { name: "no-id-field" }, // missing id — filtered out
            { id: "another-valid" },
          ],
        }),
        { status: 200 },
      ),
    );
    const result = await listExternalProviderModels(mkProvider(), "sk");
    expect(result.ok).toBe(true);
    if (result.ok) {
      expect(result.models).toEqual(["another-valid", "valid-model"]);
    }
  });
});

describe("listExternalProviderModels — Anthropic short-circuit", () => {
  it("returns kind: unsupported without making an HTTP call", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    const result = await listExternalProviderModels(
      mkProvider({ providerType: "anthropic", apiUrl: "https://api.anthropic.com" }),
      "sk",
    );
    expect(result).toEqual({ ok: false, kind: "unsupported" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});

describe("listExternalProviderModels — transport failures", () => {
  it("surfaces a network-level TypeError as kind: error", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new TypeError("Failed to fetch"),
    );
    const result = await listExternalProviderModels(mkProvider(), "sk");
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "error") {
      expect(result.error).toBe("Failed to fetch");
    }
  });

  it("formats an AbortError as a timeout message", async () => {
    vi.spyOn(globalThis, "fetch").mockRejectedValueOnce(
      new DOMException("Aborted", "AbortError"),
    );
    const result = await listExternalProviderModels(mkProvider(), "sk");
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "error") {
      expect(result.error).toMatch(/timed out after \d+s/);
    }
  });
});
