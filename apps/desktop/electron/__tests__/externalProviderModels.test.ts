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
      new Response(JSON.stringify({ data: [{ id: "local" }] }), {
        status: 200,
      }),
    );
    await listExternalProviderModels(
      mkProvider({ apiUrl: "http://localhost:1234/chat/completions" }),
      "sk",
    );
    // The trim removes `/chat/completions`, then `/v1/models` is appended.
    expect(fetchSpy.mock.calls[0]![0]).toBe("http://localhost:1234/v1/models");
  });

  it("accepts an already-resolved `/v1/models` URL without double-appending", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ data: [{ id: "x" }] }), { status: 200 }),
      );
    await listExternalProviderModels(
      mkProvider({ apiUrl: "https://api.example.com/v1/models" }),
      "sk",
    );
    expect(fetchSpy.mock.calls[0]![0]).toBe(
      "https://api.example.com/v1/models",
    );
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

  it("narrows HTTP 404 to kind: endpoint_not_found with the attempted url (custom self-hosted shim case)", async () => {
    // A custom provider's deployment that implements chat completions
    // without the /v1/models discovery endpoint returns 404. The
    // generic `kind: error, error: HTTP 404` would read as a transient
    // failure to the user — the renderer needs the typed
    // `endpoint_not_found` so it can show a "use manual entry" hint.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("<html>not found</html>", {
        status: 404,
        headers: { "content-type": "text/html" },
      }),
    );
    const result = await listExternalProviderModels(
      mkProvider({
        providerType: "custom",
        apiUrl: "http://localhost:9000/v1/chat/completions",
      }),
      "sk",
    );
    expect(result).toEqual({
      ok: false,
      kind: "endpoint_not_found",
      url: "http://localhost:9000/v1/models",
    });
  });

  it("includes the attempted url unmodified when the user pasted a bare /v1 base", async () => {
    // The `stripBareV1Suffix` normaliser in `externalProviderStream.ts`
    // turns `https://host/llm/v1` into `https://host/llm/v1/models`
    // (not `…/v1/v1/models`). The `endpoint_not_found` URL we surface
    // to the user must be the same URL we actually attempted, so the
    // user can paste it into a `curl` to verify their deployment.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("", { status: 404 }),
    );
    const result = await listExternalProviderModels(
      mkProvider({
        providerType: "openai_compatible",
        apiUrl: "https://api.example.com/llm/v1",
      }),
      "sk",
    );
    expect(result).toEqual({
      ok: false,
      kind: "endpoint_not_found",
      url: "https://api.example.com/llm/v1/models",
    });
  });

  it("does NOT narrow HTTP 405 (method not allowed) to endpoint_not_found", async () => {
    // Only HTTP 404 indicates "endpoint missing". A 405 means the URL
    // exists but the method is rejected — that's a deployment config
    // bug the user CAN fix by adjusting the upstream, so we keep the
    // generic `kind: error` and surface the status so they see it.
    vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(
      new Response("Method Not Allowed", { status: 405 }),
    );
    const result = await listExternalProviderModels(mkProvider(), "sk");
    expect(result.ok).toBe(false);
    if (!result.ok && result.kind === "error") {
      expect(result.error).toMatch(/HTTP 405/);
    } else {
      throw new Error(
        `expected kind: error for 405, got: ${JSON.stringify(result)}`,
      );
    }
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
      mkProvider({
        providerType: "anthropic",
        apiUrl: "https://api.anthropic.com",
      }),
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
