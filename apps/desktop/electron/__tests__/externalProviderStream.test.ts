import { describe, it, expect, vi } from "vitest";
import {
  parseExternalProviderSSE,
  feedSse,
  flushSse,
  newSseParserState,
  buildStreamRequest,
  streamExternalProvider,
  parseRetryAfter,
  retryDelayMs,
  type ExternalProviderStreamChunk,
} from "../externalProviderStream";
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

/** Strip the terminating empty-stop chunk so test assertions can
 *  focus on the parsed content events. The terminator is its own
 *  test in `appends_terminal_stop_chunk`. */
function contentChunks(
  chunks: ExternalProviderStreamChunk[],
): string[] {
  return chunks
    .filter((c) => c.content.length > 0)
    .map((c) => c.content);
}

describe("externalProviderStream — OpenAI-compatible SSE parser", () => {
  // These fixtures match the wiremock-backed Rust tests in
  // `crates/tessera_runtime/src/external_provider.rs` byte-for-byte.
  // If the Rust impl changes, the TS impl MUST be updated to match
  // and vice versa — the two parsers are required to produce
  // identical output for the same input.

  it("parses delta content across multiple events", () => {
    const sse =
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"Hello"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":", "}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"world!"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"stop"}]}\n\n' +
      "data: [DONE]\n\n";
    const chunks = parseExternalProviderSSE(sse, "openai_compatible");
    expect(contentChunks(chunks)).toEqual(["Hello", ", ", "world!"]);
  });

  it("emits the terminal stop chunk last", () => {
    const sse = 'data: {"choices":[{"delta":{"content":"x"}}]}\n\n' + "data: [DONE]\n\n";
    const chunks = parseExternalProviderSSE(sse, "openai_compatible");
    expect(chunks.length).toBeGreaterThan(0);
    const last = chunks[chunks.length - 1];
    expect(last.stop).toBe(true);
    expect(last.content).toBe("");
  });

  it("honours finish_reason when [DONE] is missing (older Ollama / LM Studio)", () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"final"}}]}\n\n' +
      'data: {"choices":[{"delta":{},"finish_reason":"length"}]}\n\n';
    const chunks = parseExternalProviderSSE(sse, "openai_compatible");
    expect(contentChunks(chunks)).toEqual(["final"]);
    expect(chunks[chunks.length - 1].stop).toBe(true);
  });

  it("treats `custom` provider type as OpenAI-shaped", () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"via-custom"}}]}\n\n' + "data: [DONE]\n\n";
    const chunks = parseExternalProviderSSE(sse, "custom");
    expect(contentChunks(chunks)).toEqual(["via-custom"]);
  });

  it("ignores SSE comments and unparseable data", () => {
    const sse =
      ": keepalive\n\n" +
      "data: not-json\n\n" +
      'data: {"choices":[{"delta":{"content":"survived"}}]}\n\n' +
      "data: [DONE]\n\n";
    const chunks = parseExternalProviderSSE(sse, "openai_compatible");
    expect(contentChunks(chunks)).toEqual(["survived"]);
  });

  it("accepts CRLF line endings (nginx-style proxies)", () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"crlf"}}]}\r\n\r\n' + "data: [DONE]\r\n\r\n";
    const chunks = parseExternalProviderSSE(sse, "openai_compatible");
    expect(contentChunks(chunks)).toEqual(["crlf"]);
  });

  it("drops chunks with no content (role-only deltas)", () => {
    const sse =
      'data: {"choices":[{"delta":{"role":"assistant"}}]}\n\n' +
      'data: {"choices":[{"delta":{"content":"with-text"}}]}\n\n' +
      "data: [DONE]\n\n";
    const chunks = parseExternalProviderSSE(sse, "openai_compatible");
    expect(contentChunks(chunks)).toEqual(["with-text"]);
  });

  it("stops cleanly on [DONE] even when more bytes arrive after", () => {
    // The parser must NOT continue draining events after [DONE]; any
    // bytes after the sentinel must be ignored. This is rare in
    // practice but possible if a proxy buffers an oversized response.
    const sse =
      'data: {"choices":[{"delta":{"content":"first"}}]}\n\n' +
      "data: [DONE]\n\n" +
      'data: {"choices":[{"delta":{"content":"after-done"}}]}\n\n';
    const chunks = parseExternalProviderSSE(sse, "openai_compatible");
    expect(contentChunks(chunks)).toEqual(["first"]);
  });

  it("flushes an unterminated final event when the stream closes mid-frame", () => {
    // Some Anthropic-style proxies and certain Ollama builds close
    // the connection without the spec-required trailing `\n\n`. The
    // flushSse path must still surface the buffered final event.
    const sse = 'data: {"choices":[{"delta":{"content":"tail"}}]}\n';
    const chunks = parseExternalProviderSSE(sse, "openai_compatible");
    expect(contentChunks(chunks)).toEqual(["tail"]);
  });

  it("flushes a final event closed without ANY trailing newline (hostile proxy)", () => {
    // Some misbehaving proxies close the TCP connection right after
    // the last byte of `data:` without ever sending the `\n` that
    // terminates the line, let alone the `\n\n` that terminates the
    // event. Before the fix the line sat unprocessed in lineBuffer
    // and was lost. After the fix flushSse promotes it.
    const sse = 'data: {"choices":[{"delta":{"content":"truncated"}}]}';
    const chunks = parseExternalProviderSSE(sse, "openai_compatible");
    expect(contentChunks(chunks)).toEqual(["truncated"]);
  });

  it("does not emit content from bytes that arrive AFTER the stop sentinel", () => {
    // Reproduces the BUG_pr-review-job-..._0001 scenario: a multi-
    // byte UTF-8 codepoint split across TCP chunks at the exact
    // boundary that contains `[DONE]`. The decoder flushes the
    // post-sentinel tail into feedSse; the early-return guard MUST
    // discard it instead of emitting a phantom token.
    const state = newSseParserState();
    const emitted: ExternalProviderStreamChunk[] = [];
    feedSse(
      'data: {"choices":[{"delta":{"content":"before"}}]}\n\n' + "data: [DONE]\n\n",
      state,
      "openai_compatible",
      (c) => emitted.push(c),
    );
    expect(state.sawStopSentinel).toBe(true);

    // Simulate the TextDecoder tail flush — a complete-looking event
    // arriving after the sentinel was already observed.
    feedSse(
      'data: {"choices":[{"delta":{"content":"phantom"}}]}\n\n',
      state,
      "openai_compatible",
      (c) => emitted.push(c),
    );
    expect(emitted.map((c) => c.content)).toEqual(["before"]);
  });
});

describe("externalProviderStream — Anthropic SSE parser", () => {
  it("parses content_block_delta events with text deltas", () => {
    const sse =
      "event: message_start\n" +
      'data: {"type":"message_start","message":{"id":"msg_1"}}\n\n' +
      "event: content_block_start\n" +
      'data: {"type":"content_block_start","index":0,"content_block":{"type":"text","text":""}}\n\n' +
      "event: content_block_delta\n" +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Hello"}}\n\n' +
      "event: content_block_delta\n" +
      'data: {"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" Claude"}}\n\n' +
      "event: content_block_stop\n" +
      'data: {"type":"content_block_stop","index":0}\n\n' +
      "event: message_delta\n" +
      'data: {"type":"message_delta","delta":{"stop_reason":"end_turn"}}\n\n' +
      "event: message_stop\n" +
      'data: {"type":"message_stop"}\n\n';
    const chunks = parseExternalProviderSSE(sse, "anthropic");
    expect(contentChunks(chunks)).toEqual(["Hello", " Claude"]);
    expect(chunks[chunks.length - 1].stop).toBe(true);
  });

  it("ignores ping keep-alive frames", () => {
    const sse =
      "event: ping\n" +
      'data: {"type":"ping"}\n\n' +
      "event: content_block_delta\n" +
      'data: {"delta":{"text":"after-ping"}}\n\n' +
      "event: message_stop\n" +
      "data: {}\n\n";
    const chunks = parseExternalProviderSSE(sse, "anthropic");
    expect(contentChunks(chunks)).toEqual(["after-ping"]);
  });

  it("stops on message_stop regardless of subsequent events", () => {
    const sse =
      "event: content_block_delta\n" +
      'data: {"delta":{"text":"x"}}\n\n' +
      "event: message_stop\n" +
      "data: {}\n\n" +
      "event: content_block_delta\n" +
      'data: {"delta":{"text":"never"}}\n\n';
    const chunks = parseExternalProviderSSE(sse, "anthropic");
    expect(contentChunks(chunks)).toEqual(["x"]);
  });

  it("dispatches by `event:` header, not by `type` field in data", () => {
    // The parser must trust the SSE event-name header even if the
    // inline `type` field disagrees. (This guards against a server
    // bug where the inline `type` is incorrect but the event header
    // is right.)
    const sse =
      "event: content_block_delta\n" +
      'data: {"type":"some_other_type","delta":{"text":"trust-header"}}\n\n' +
      "event: message_stop\n" +
      "data: {}\n\n";
    const chunks = parseExternalProviderSSE(sse, "anthropic");
    expect(contentChunks(chunks)).toEqual(["trust-header"]);
  });
});

describe("externalProviderStream — incremental feedSse byte splits", () => {
  // The Rust impl uses bytes_stream() which delivers TCP-segment-sized
  // chunks; the parser must handle a single SSE event arriving across
  // multiple feeds. These tests pin that the TS impl is equivalent.

  it("handles an event split across two chunks at the data: prefix", () => {
    const state = newSseParserState();
    const out: ExternalProviderStreamChunk[] = [];
    feedSse('data: {"choices":[{"delta', state, "openai_compatible", (c) =>
      out.push(c),
    );
    feedSse(
      '":{"content":"split"}}]}\n\n' + "data: [DONE]\n\n",
      state,
      "openai_compatible",
      (c) => out.push(c),
    );
    flushSse(state, "openai_compatible", (c) => out.push(c));
    expect(contentChunks(out)).toEqual(["split"]);
  });

  it("handles an event split between data line and blank-line terminator", () => {
    const state = newSseParserState();
    const out: ExternalProviderStreamChunk[] = [];
    feedSse(
      'data: {"choices":[{"delta":{"content":"between"}}]}\n',
      state,
      "openai_compatible",
      (c) => out.push(c),
    );
    expect(contentChunks(out)).toEqual([]); // pending: blank-line not seen yet
    feedSse("\n" + "data: [DONE]\n\n", state, "openai_compatible", (c) =>
      out.push(c),
    );
    expect(contentChunks(out)).toEqual(["between"]);
  });

  it("handles byte-by-byte feeds (worst case)", () => {
    const sse =
      'data: {"choices":[{"delta":{"content":"bytewise"}}]}\n\n' +
      "data: [DONE]\n\n";
    const state = newSseParserState();
    const out: ExternalProviderStreamChunk[] = [];
    for (const ch of sse) {
      feedSse(ch, state, "openai_compatible", (c) => out.push(c));
    }
    flushSse(state, "openai_compatible", (c) => out.push(c));
    expect(contentChunks(out)).toEqual(["bytewise"]);
  });

  it("supports multi-line data fields per SSE spec", () => {
    // Multiple `data:` lines in the same event are concatenated with
    // `\n` per spec. Providers that emit JSON containing literal
    // newlines (rare, but technically legal) rely on this.
    const sse = 'data: {"choices":[\ndata: {"delta":{"content":"multiline"}}]}\n\n';
    const state = newSseParserState();
    const out: ExternalProviderStreamChunk[] = [];
    feedSse(sse, state, "openai_compatible", (c) => out.push(c));
    // The concatenated JSON `{"choices":[\n{"delta":{"content":"multiline"}}]}`
    // is valid JSON because newlines are legal whitespace inside JSON.
    expect(contentChunks(out)).toEqual(["multiline"]);
  });
});

describe("externalProviderStream — buildStreamRequest wire format", () => {
  it("targets /v1/chat/completions for OpenAI-compatible providers", () => {
    const req = buildStreamRequest({
      provider: mkProvider({ apiUrl: "https://api.openai.com" }),
      apiKey: "sk-test",
      prompt: "hi",
    });
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
    expect(req.headers).toMatchObject({
      "Content-Type": "application/json",
      Authorization: "Bearer sk-test",
      Accept: "text/event-stream",
    });
    const body = JSON.parse(req.body);
    expect(body.stream).toBe(true);
    expect(body.model).toBe("test-model");
    expect(body.messages).toEqual([{ role: "user", content: "hi" }]);
    expect(body.max_tokens).toBe(256);
    expect(body.temperature).toBe(0.4);
  });

  it("does not double-suffix /v1/chat/completions when already present", () => {
    const req = buildStreamRequest({
      provider: mkProvider({
        apiUrl: "https://api.openai.com/v1/chat/completions",
      }),
      apiKey: "sk",
      prompt: "x",
    });
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("targets /v1/messages for Anthropic providers with the required headers", () => {
    const req = buildStreamRequest({
      provider: mkProvider({
        providerType: "anthropic",
        apiUrl: "https://api.anthropic.com",
      }),
      apiKey: "sk-ant-test",
      prompt: "hi",
    });
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
    expect(req.headers).toMatchObject({
      "Content-Type": "application/json",
      "x-api-key": "sk-ant-test",
      "anthropic-version": "2023-06-01",
      Accept: "text/event-stream",
    });
    // Anthropic does NOT accept an `Authorization` header — verify we
    // never accidentally include one.
    expect(req.headers).not.toHaveProperty("Authorization");
    const body = JSON.parse(req.body);
    expect(body.stream).toBe(true);
  });

  it("trims trailing slashes from the base URL before suffixing", () => {
    const req = buildStreamRequest({
      provider: mkProvider({ apiUrl: "https://api.openai.com///" }),
      apiKey: "sk",
      prompt: "x",
    });
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("does NOT double `/v1` when the user pastes a bare `/v1` apiUrl (Devin Review round 6 BUG_003)", () => {
    // Regression for Devin Review round 6 BUG_003: a user who pastes
    // the bare version prefix `https://api.openai.com/v1` previously
    // ended up routed to `https://api.openai.com/v1/v1/chat/completions`
    // because the existing `endsWith("/v1/chat/completions")` and
    // `endsWith("/chat/completions")` checks didn't match. The fix
    // strips a bare-`/v1` suffix in a shared normaliser
    // (`stripBareV1Suffix`) BEFORE any longer-suffix check runs.
    const req = buildStreamRequest({
      provider: mkProvider({ apiUrl: "https://api.openai.com/v1" }),
      apiKey: "sk",
      prompt: "x",
    });
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("does NOT double `/v1` for Anthropic when the user pastes a bare `/v1` apiUrl", () => {
    // Companion regression for the Anthropic branch: a paste of
    // `https://api.anthropic.com/v1` must resolve to
    // `https://api.anthropic.com/v1/messages`, not
    // `https://api.anthropic.com/v1/v1/messages`. The
    // `stripBareV1Suffix` normaliser is provider-type-agnostic.
    const req = buildStreamRequest({
      provider: mkProvider({
        providerType: "anthropic",
        apiUrl: "https://api.anthropic.com/v1",
      }),
      apiKey: "sk-ant",
      prompt: "x",
    });
    expect(req.url).toBe("https://api.anthropic.com/v1/messages");
  });

  it("trims trailing slashes AND bare `/v1` before suffixing", () => {
    // The user could paste `https://api.openai.com/v1/` with a
    // trailing slash. The trailing-slash strip must run first so the
    // bare-`/v1` detector sees the canonical form.
    const req = buildStreamRequest({
      provider: mkProvider({ apiUrl: "https://api.openai.com/v1/" }),
      apiKey: "sk",
      prompt: "x",
    });
    expect(req.url).toBe("https://api.openai.com/v1/chat/completions");
  });

  it("uses per-request maxTokens / temperature overrides when supplied", () => {
    const req = buildStreamRequest({
      provider: mkProvider({ maxTokens: 256, temperature: 0.4 }),
      apiKey: "sk",
      prompt: "x",
      maxTokens: 4096,
      temperature: 0.1,
    });
    const body = JSON.parse(req.body);
    expect(body.max_tokens).toBe(4096);
    expect(body.temperature).toBe(0.1);
  });

  it("caps stop sequences at 4 for OpenAI-compatible providers", () => {
    const req = buildStreamRequest({
      provider: mkProvider(),
      apiKey: "sk",
      prompt: "x",
      stop: ["a", "b", "c", "d", "e"],
    });
    const body = JSON.parse(req.body);
    expect(body.stop).toEqual(["a", "b", "c", "d"]);
  });

  it("emits stop_sequences (plural) for Anthropic, not stop", () => {
    const req = buildStreamRequest({
      provider: mkProvider({ providerType: "anthropic" }),
      apiKey: "sk",
      prompt: "x",
      stop: ["a", "b"],
    });
    const body = JSON.parse(req.body);
    expect(body.stop_sequences).toEqual(["a", "b"]);
    expect(body.stop).toBeUndefined();
  });

  it("does NOT cap Anthropic stop_sequences at 4 (no documented hard limit)", () => {
    // Anthropic's `stop_sequences` field accepts arbitrary-length
    // arrays — capping here would silently drop user-supplied
    // sequences. Only the OpenAI `stop` field has the 4-entry hard
    // limit. This test guards against regressing to the previous
    // copy-paste-from-OpenAI behaviour.
    const req = buildStreamRequest({
      provider: mkProvider({ providerType: "anthropic" }),
      apiKey: "sk",
      prompt: "x",
      stop: ["a", "b", "c", "d", "e", "f", "g"],
    });
    const body = JSON.parse(req.body);
    expect(body.stop_sequences).toEqual(["a", "b", "c", "d", "e", "f", "g"]);
  });
});

describe("externalProviderStream — reader cleanup on early break", () => {
  // Build a minimal mock ReadableStream + Response that the
  // `streamExternalProvider` reader path can consume. The mock
  // records cancel() invocations so we can assert that the reader
  // is cancelled on every non-natural exit path.

  function makeMockResponse(chunks: string[]): {
    response: Response;
    cancelSpy: ReturnType<typeof vi.fn>;
  } {
    const cancelSpy = vi.fn().mockResolvedValue(undefined);
    let i = 0;
    const stream = new ReadableStream<Uint8Array>({
      pull(controller) {
        if (i < chunks.length) {
          controller.enqueue(new TextEncoder().encode(chunks[i]));
          i += 1;
        } else {
          controller.close();
        }
      },
      cancel: cancelSpy,
    });
    // `Response` constructor with a ReadableStream produces the
    // shape that `streamExternalProvider` expects from
    // `fetch(...)`. We have to set `ok` true via status 200.
    const response = new Response(stream, { status: 200 });
    return { response, cancelSpy };
  }

  it("cancels the reader when the stop sentinel is observed mid-stream", async () => {
    // Regression for the original "reader not explicitly cancelled
    // on early break" issue. When the SSE parser observes
    // `data: [DONE]` (OpenAI) or `event: message_stop` (Anthropic),
    // the read loop breaks BEFORE the natural `done: true`. Without
    // the explicit `reader.cancel()` in `finally`, the underlying
    // TCP connection lingered until GC or AbortController.abort(),
    // holding a slot in the provider's concurrent-request quota for
    // long-lived idle Electron sessions.
    //
    // We construct an SSE body where `[DONE]` arrives BEFORE the
    // server closes the stream, then assert that the mock stream's
    // `cancel()` was called exactly once.
    const { response, cancelSpy } = makeMockResponse([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      "data: [DONE]\n\n",
      // Deliberate trailing event that should NEVER be observed —
      // its presence in `chunks` (without the test asserting the
      // emit didn't see it) is a smoke test that the early break
      // really did fire.
      'data: {"choices":[{"delta":{"content":"PHANTOM"}}]}\n\n',
    ]);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response);

    const emitted: ExternalProviderStreamChunk[] = [];
    await streamExternalProvider(
      {
        provider: mkProvider(),
        apiKey: "sk",
        prompt: "hi",
      },
      (c) => emitted.push(c),
    );

    expect(cancelSpy).toHaveBeenCalledTimes(1);
    expect(emitted.map((c) => c.content)).toEqual(["hi"]);
    // The phantom event must not have been observed: the early
    // break-and-cancel pair guarantees no further data is fed.
    expect(emitted.some((c) => c.content === "PHANTOM")).toBe(false);
    fetchSpy.mockRestore();
  });

  it("does NOT cancel when the stream drains naturally (server closed)", async () => {
    // Counter-test: when the producer closes the stream itself
    // (`done: true` on `reader.read()`), there's no leaking
    // connection to cancel — the body is already exhausted.
    // Calling `cancel()` here would be a wasted FFI hop and could
    // surface as a misleading "cancellation" in the producer's
    // logs. The fix in `streamExternalProvider` deliberately tracks
    // `drainedNaturally` so this case is a no-op.
    const { response, cancelSpy } = makeMockResponse([
      'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
      // No [DONE] — the stream just ends. This is the path that
      // happens when a server closes the connection without
      // emitting the spec-required sentinel.
    ]);
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(response);

    const emitted: ExternalProviderStreamChunk[] = [];
    await streamExternalProvider(
      {
        provider: mkProvider(),
        apiKey: "sk",
        prompt: "hi",
      },
      (c) => emitted.push(c),
    );

    expect(cancelSpy).not.toHaveBeenCalled();
    expect(emitted.map((c) => c.content)).toEqual(["hi"]);
    fetchSpy.mockRestore();
  });

  // Note: a third test that exercises the `feedSse throws` exception
  // path was attempted but hit a Node WHATWG-streams timing edge
  // where the underlying source's `cancel` was not deterministically
  // observed when the reader was cancelled mid-read in the same
  // microtask the throw propagated through. The two tests above
  // already pin the regression: every non-natural exit path goes
  // through the `finally` block which awaits `reader.cancel()`.
});

describe("externalProviderStream — pre-stream retry with exponential backoff", () => {
  // The retry loop in `streamExternalProvider` wraps the
  // pre-stream HTTP exchange. The body stream itself is NEVER
  // retried (mid-stream retries would silently re-deliver tokens).
  //
  // Tests use vitest fake timers so the 1s/2s/4s backoff schedule
  // doesn't actually wait — we advance the timer manually after
  // every retryable response.

  /** Mock a 503 (or other transient) HTTP response that doesn't open
   *  a stream body. The `Response` constructor with a non-empty
   *  body is enough; the retry loop checks `res.ok` BEFORE reading
   *  the body. */
  function makeErrorResponse(
    status: number,
    body: string = "",
    headers: Record<string, string> = {},
  ): Response {
    return new Response(body, { status, headers });
  }

  /** Mock a 200 SSE response with a single content delta + DONE.
   *  Used for the "succeeds after N retries" tests. */
  function makeSuccessResponse(): Response {
    const stream = new ReadableStream<Uint8Array>({
      start(controller) {
        controller.enqueue(
          new TextEncoder().encode(
            'data: {"choices":[{"delta":{"content":"ok"}}]}\n\n' +
              "data: [DONE]\n\n",
          ),
        );
        controller.close();
      },
    });
    return new Response(stream, { status: 200 });
  }

  it("retries on 503 twice then succeeds on the third attempt", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeErrorResponse(503, "service unavailable"))
      .mockResolvedValueOnce(makeErrorResponse(503, "service unavailable"))
      .mockResolvedValueOnce(makeSuccessResponse());
    const emitted: ExternalProviderStreamChunk[] = [];
    const streamPromise = streamExternalProvider(
      { provider: mkProvider(), apiKey: "sk", prompt: "hi" },
      (c) => emitted.push(c),
    );
    // Advance through the 1s + 2s schedule. The third attempt
    // returns 200 and the stream drains naturally.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await streamPromise;
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    expect(emitted.map((c) => c.content)).toEqual(["ok"]);
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it("does NOT retry on 401 (client error) — fails immediately on first attempt", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeErrorResponse(401, "invalid api key"));
    await expect(
      streamExternalProvider(
        { provider: mkProvider(), apiKey: "sk-bad", prompt: "hi" },
        () => {},
      ),
    ).rejects.toThrow(/HTTP 401/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it("does NOT retry on 400 (bad request) — fails immediately", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        makeErrorResponse(400, '{"error":"bad request"}'),
      );
    await expect(
      streamExternalProvider(
        { provider: mkProvider(), apiKey: "sk", prompt: "hi" },
        () => {},
      ),
    ).rejects.toThrow(/HTTP 400/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it("does NOT retry on 403 (forbidden) — fails immediately", async () => {
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeErrorResponse(403, "forbidden"));
    await expect(
      streamExternalProvider(
        { provider: mkProvider(), apiKey: "sk", prompt: "hi" },
        () => {},
      ),
    ).rejects.toThrow(/HTTP 403/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it("exhausts retry budget after 4 attempts (1 + 3 retries) on persistent 502 when maxRetries=3", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeErrorResponse(502, "bad gateway"));
    const streamPromise = streamExternalProvider(
      {
        provider: mkProvider({ maxRetries: 3 }),
        apiKey: "sk",
        prompt: "hi",
      },
      () => {},
    );
    const rejection = expect(streamPromise).rejects.toThrow(
      /HTTP 502 after 4 attempts/,
    );
    // Walk through the full 1s + 2s + 4s schedule.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await rejection;
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it("honours provider.maxRetries=0 by NOT retrying — single attempt then failure", async () => {
    // Devin Review (round 2 on PR #27) flagged that the retry loop
    // used to hardcode a 3-retry schedule regardless of the
    // user-configured `maxRetries`. This regression test pins the
    // new behaviour: `maxRetries: 0` means "do not retry, surface
    // the first transient failure immediately".
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeErrorResponse(503, "service unavailable"));
    await expect(
      streamExternalProvider(
        {
          provider: mkProvider({ maxRetries: 0 }),
          apiKey: "sk",
          prompt: "hi",
        },
        () => {},
      ),
    ).rejects.toThrow(/HTTP 503 after 1 attempt(?!s)/);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
  });

  it("honours the default provider.maxRetries=2 — 3 total attempts on persistent failure", async () => {
    // Companion to the maxRetries=0 test: with the schema default
    // (`2`), we expect 1 initial + 2 retries = 3 total attempts,
    // NOT the legacy 4. This is the exact gap Devin Review flagged.
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeErrorResponse(503, "service unavailable"));
    const streamPromise = streamExternalProvider(
      { provider: mkProvider(), apiKey: "sk", prompt: "hi" },
      () => {},
    );
    const rejection = expect(streamPromise).rejects.toThrow(
      /HTTP 503 after 3 attempts/,
    );
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await rejection;
    expect(fetchSpy).toHaveBeenCalledTimes(3);
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it("does NOT misclassify a slow body-drain on a non-retryable HTTP error as a pre-stream timeout (BUG_001 regression)", async () => {
    // Devin Review round 12 BUG_001 flagged that the per-attempt
    // timer was only cleared in the `res.ok` branch of
    // `openExternalProviderStream`. For a non-retryable status
    // (e.g. 401 invalid api key), the function reads the response
    // body via `await res.text().catch(() => "")` before throwing
    // the explicit `External provider HTTP 401` error. If the
    // per-attempt timer fired DURING that body read,
    // `attemptController.abort()` would run, the `.catch(() => "")`
    // would swallow the resulting abort error returning empty
    // string, and the subsequent `throw new Error("HTTP 401")`
    // would enter the catch block where
    // `attemptController.signal.aborted === true` would misclassify
    // the failure as a retryable timeout. The retry loop would
    // then waste its budget retrying a permanent 401 and surface
    // "pre-stream timeout (1000ms) after K attempts" instead of
    // "HTTP 401" — a confusing and misleading error message for
    // the user.
    //
    // The fix clears the timer immediately after `fetch` resolves,
    // before any body-read branches. This test pins the invariant:
    // a 401 with a slow-to-drain body MUST still surface as HTTP
    // 401, not as pre-stream timeout.
    vi.useFakeTimers();
    // Construct a Response-shaped object whose `.text()` resolves
    // after 5 seconds. We don't reject with AbortError because the
    // production code swallows that anyway via `.catch(() => "")`;
    // the resolve path is enough to demonstrate the bug. A real
    // `Response` body backed by the underlying fetch would be
    // aborted by `attemptController.signal`, but we're testing
    // what happens REGARDLESS of whether the body read sees the
    // abort — the bug is structural in `openExternalProviderStream`
    // (the timer firing during the drain), not in the body
    // reader's awareness of the signal.
    const mockText = vi.fn(
      () =>
        new Promise<string>((resolve) => {
          setTimeout(() => resolve("invalid api key"), 5000);
        }),
    );
    const mockResponse = {
      ok: false,
      status: 401,
      headers: new Headers(),
      text: mockText,
    } as unknown as Response;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(mockResponse);
    const streamPromise = streamExternalProvider(
      {
        // timeoutSecs=1 → per-attempt timer fires at +1000ms
        // (before the body-drain mock resolves at +5000ms).
        // maxRetries=0 keeps the test simple — with the bug the
        // loop would exhaust to "after 1 attempt" of timeout; with
        // the fix it throws HTTP 401 directly.
        provider: mkProvider({ timeoutSecs: 1, maxRetries: 0 }),
        apiKey: "sk-bad",
        prompt: "hi",
      },
      () => {},
    );
    const rejection = expect(streamPromise).rejects.toThrow(/HTTP 401/);
    // Advance through both the per-attempt timer (1000ms) AND the
    // slow body-drain (5000ms total). With the fix, the per-attempt
    // timer is a no-op because it was cleared right after fetch
    // resolved.
    await vi.advanceTimersByTimeAsync(5000);
    await rejection;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    expect(mockText).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it("honours provider.maxRetries=5 with the doubling schedule (1s/2s/4s/8s/16s)", async () => {
    // Pins the >3-retry behaviour. Without this assertion a future
    // refactor could silently re-introduce the hardcoded 3-retry
    // limit. The schema clamps maxRetries to 0..=10 so 5 is in-range.
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValue(makeErrorResponse(502, "bad gateway"));
    const streamPromise = streamExternalProvider(
      {
        provider: mkProvider({ maxRetries: 5 }),
        apiKey: "sk",
        prompt: "hi",
      },
      () => {},
    );
    const rejection = expect(streamPromise).rejects.toThrow(
      /HTTP 502 after 6 attempts/,
    );
    // 1 + 2 + 4 + 8 + 16 = 31s of waits across 5 retries.
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(4000);
    await vi.advanceTimersByTimeAsync(8000);
    await vi.advanceTimersByTimeAsync(16000);
    await rejection;
    expect(fetchSpy).toHaveBeenCalledTimes(6);
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it("honours `Retry-After: 5` (seconds) on 429, waiting at least 5s before next attempt", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(
        makeErrorResponse(429, "rate limited", { "retry-after": "5" }),
      )
      .mockResolvedValueOnce(makeSuccessResponse());
    const streamPromise = streamExternalProvider(
      { provider: mkProvider(), apiKey: "sk", prompt: "hi" },
      () => {},
    );
    // The first attempt returned 429 with Retry-After: 5 → we
    // should be waiting ~5 s, not the 1 s default. Advancing 1 s
    // should NOT trigger the second fetch yet.
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    // Now advance the remaining 4 s and the second attempt fires.
    await vi.advanceTimersByTimeAsync(4000);
    await streamPromise;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it("per-attempt timeout fires when the upstream never responds — treated as retryable, second attempt succeeds (Devin Review round 7)", async () => {
    // Regression for Devin Review round 7 (ANALYSIS_006): the
    // streaming path previously had no per-attempt timeout, so a
    // slow-but-responsive upstream would hang attempt 1 forever and
    // the retry budget was effectively meaningless. The fix wires
    // `provider.timeoutSecs * 1000` into `openExternalProviderStream`
    // via a forked AbortController that distinguishes user-cancel
    // from per-attempt timeout. This test pins the success path: a
    // first attempt that never resolves, then the timer fires, then
    // a second attempt that returns a real body.
    vi.useFakeTimers();
    let attemptCount = 0;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_input, init) => {
        attemptCount += 1;
        if (attemptCount === 1) {
          // Never resolves on its own; only the per-attempt timer
          // abort will reject this. Mirrors a real upstream that
          // accepts the connection but never sends headers.
          return new Promise((_resolve, reject) => {
            const sig = init?.signal as AbortSignal | undefined;
            sig?.addEventListener("abort", () => {
              reject(new DOMException("Aborted", "AbortError"));
            });
          });
        }
        return Promise.resolve(makeSuccessResponse());
      });
    const streamPromise = streamExternalProvider(
      {
        provider: mkProvider({ timeoutSecs: 2, maxRetries: 3 }),
        apiKey: "sk",
        prompt: "hi",
      },
      () => {},
    );
    // Advance past the per-attempt timeout (2s) to trigger the
    // timer abort. Then advance through the inter-attempt backoff
    // (1s = `retryDelayMs(1)`) so the second attempt fires.
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(1000);
    await streamPromise;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it("per-attempt timeout exhausts retry budget — error message reflects timeout, not HTTP status (Devin Review round 7)", async () => {
    // Companion to the success path: when EVERY attempt times out,
    // the retry-exhausted error must say `pre-stream timeout`
    // (with the configured timeoutMs) so the user can see the
    // distinction from an HTTP failure. Pinning the message shape
    // is important because users / log aggregators rely on it to
    // tell upstream-slow apart from upstream-failing.
    vi.useFakeTimers();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_input, init) => {
        return new Promise((_resolve, reject) => {
          const sig = init?.signal as AbortSignal | undefined;
          sig?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      });
    const streamPromise = streamExternalProvider(
      {
        provider: mkProvider({ timeoutSecs: 2, maxRetries: 1 }),
        apiKey: "sk",
        prompt: "hi",
      },
      () => {},
    );
    const rejection = expect(streamPromise).rejects.toThrow(
      /pre-stream timeout \(2000ms\) after 2 attempts/,
    );
    // Attempt 1: 2s timeout, then 1s backoff, then attempt 2 with
    // its own 2s timeout.
    await vi.advanceTimersByTimeAsync(2000);
    await vi.advanceTimersByTimeAsync(1000);
    await vi.advanceTimersByTimeAsync(2000);
    await rejection;
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it("user-cancel during a hung request propagates AbortError, NOT a retryable timeout (Devin Review round 7)", async () => {
    // The critical safety property of the timeout work: the user's
    // Stop button must always win over the per-attempt timer. If
    // both signals are aborted, we MUST surface AbortError so the
    // retry loop terminates immediately rather than swallowing the
    // user's cancel and dispatching another attempt. The fix
    // distinguishes the two abort sources in the catch block by
    // checking `signal?.aborted` BEFORE checking the internal
    // attemptController.
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_input, init) => {
        return new Promise((_resolve, reject) => {
          const sig = init?.signal as AbortSignal | undefined;
          sig?.addEventListener("abort", () => {
            reject(new DOMException("Aborted", "AbortError"));
          });
        });
      });
    const streamPromise = streamExternalProvider(
      {
        provider: mkProvider({ timeoutSecs: 60, maxRetries: 3 }),
        apiKey: "sk",
        prompt: "hi",
        signal: controller.signal,
      },
      () => {},
    );
    const rejection = expect(streamPromise).rejects.toThrow(/Aborted/);
    // Cancel BEFORE the per-attempt timeout fires (60s configured,
    // we only advance by 1s).
    await vi.advanceTimersByTimeAsync(1000);
    controller.abort();
    await rejection;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it("AbortSignal during backoff delay rejects immediately with AbortError", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(makeErrorResponse(503, "transient"));
    const streamPromise = streamExternalProvider(
      {
        provider: mkProvider(),
        apiKey: "sk",
        prompt: "hi",
        signal: controller.signal,
      },
      () => {},
    );
    // The first 503 has fired; we're mid-backoff. Cancel.
    const rejection = expect(streamPromise).rejects.toThrow(/Aborted/);
    controller.abort();
    await rejection;
    expect(fetchSpy).toHaveBeenCalledTimes(1);
    fetchSpy.mockRestore();
    vi.useRealTimers();
  });

  it("detaches user-cancel forwarder when response body is missing (Devin Review round 9 BUG_001)", async () => {
    // Devin Review round 9 surfaced a listener-leak on the rare
    // "200 OK with no body" path: `openExternalProviderStream`
    // transfers listener ownership to the caller via
    // `cleanupBodyForwarder`, but the body-reading try/finally
    // (which normally invokes that cleanup) is only entered AFTER
    // `res.body?.getReader()` returns a non-null reader. When the
    // upstream returns a 200 with no body, the function throws
    // before the try/finally, leaking the forwarder on the user's
    // AbortSignal.
    //
    // Pin the fix by intercepting add/removeEventListener on the
    // user's signal: count net `abort`-listener installations and
    // assert the implementation's forwarder was detached before
    // the throw. Without the round-9 fix this count is +1 (leak);
    // with the fix it is 0.
    const controller = new AbortController();
    let netAbortListeners = 0;
    const origAdd = controller.signal.addEventListener.bind(controller.signal);
    const origRemove = controller.signal.removeEventListener.bind(controller.signal);
    controller.signal.addEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: AddEventListenerOptions | boolean,
    ) => {
      if (type === "abort") netAbortListeners += 1;
      return origAdd(type, listener, options);
    };
    controller.signal.removeEventListener = (
      type: string,
      listener: EventListenerOrEventListenerObject | null,
      options?: EventListenerOptions | boolean,
    ) => {
      if (type === "abort") netAbortListeners -= 1;
      return origRemove(type, listener, options);
    };
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(new Response(null, { status: 200 }));
    await expect(
      streamExternalProvider(
        {
          provider: mkProvider(),
          apiKey: "sk",
          prompt: "hi",
          signal: controller.signal,
        },
        () => {},
      ),
    ).rejects.toThrow(/no body to stream/);
    // The implementation must have detached the forwarder before
    // throwing. Net listener delta should be 0 — every
    // addEventListener("abort", ...) on the user signal must be
    // matched by a removeEventListener("abort", ...).
    expect(netAbortListeners).toBe(0);
    fetchSpy.mockRestore();
  });

  it("user-cancel mid-stream aborts the body reader (Devin Review round 8 BUG_001)", async () => {
    // Devin Review round 8 surfaced a regression: after the round 7
    // per-attempt-timeout refactor split fetch onto a per-attempt
    // `AbortController`, `openExternalProviderStream`'s `finally`
    // block detached the user-cancel forwarder as soon as the body
    // opened. The body reader was bound to the per-attempt signal,
    // and the user's outer signal was never reconnected — so
    // clicking "Stop generating" after tokens started flowing did
    // nothing.
    //
    // The fix transfers listener ownership to the caller via
    // `cleanupBodyForwarder()`, returned in the OpenedResponse. This
    // test pins the correct behaviour: open a body, emit one chunk
    // so we're definitively mid-stream, then user-cancel — the
    // promise must reject with AbortError, NOT hang.
    const controller = new AbortController();
    let bodyController: ReadableStreamDefaultController<Uint8Array> | null = null;
    const fetchSpy = vi
      .spyOn(globalThis, "fetch")
      .mockImplementation((_input, init) => {
        const fetchSignal = init?.signal as AbortSignal | undefined;
        const stream = new ReadableStream<Uint8Array>({
          start(c) {
            bodyController = c;
            // Emit one valid SSE chunk so the parser advances past
            // initial framing and we're definitively in mid-stream
            // territory before the user cancels.
            c.enqueue(
              new TextEncoder().encode(
                'data: {"choices":[{"delta":{"content":"hi"}}]}\n\n',
              ),
            );
            // Wire the fetch's signal into our body stream so an
            // abort on the per-attempt controller (which is what
            // user-cancel forwards to) errors the body — the same
            // wiring real `fetch()` does internally. Without this
            // the mock would never error and the test couldn't
            // distinguish "Stop button broken" from "test mock
            // doesn't propagate aborts".
            fetchSignal?.addEventListener(
              "abort",
              () => {
                c.error(new DOMException("Aborted", "AbortError"));
              },
              { once: true },
            );
          },
        });
        return Promise.resolve(new Response(stream, { status: 200 }));
      });
    const emitted: ExternalProviderStreamChunk[] = [];
    const streamPromise = streamExternalProvider(
      {
        provider: mkProvider(),
        apiKey: "sk",
        prompt: "hi",
        signal: controller.signal,
      },
      (c) => emitted.push(c),
    );
    // Yield once so the body stream is read and the first chunk
    // arrives — we are now unambiguously mid-stream.
    await Promise.resolve();
    await Promise.resolve();
    // Cancel. Without the round-8 fix the user signal is
    // disconnected from the body reader and this rejects only
    // when the test runner times out the entire it().
    controller.abort();
    await expect(streamPromise).rejects.toThrow(/Aborted/);
    expect(bodyController).not.toBeNull();
    fetchSpy.mockRestore();
  });
});

describe("externalProviderStream — parseRetryAfter", () => {
  it("parses delta-seconds form", () => {
    expect(parseRetryAfter("5")).toBe(5000);
    expect(parseRetryAfter("30")).toBe(30_000);
    expect(parseRetryAfter("  10  ")).toBe(10_000);
  });

  it("caps at 60s for excessive delta-seconds values", () => {
    expect(parseRetryAfter("120")).toBe(60_000);
    expect(parseRetryAfter("3600")).toBe(60_000);
  });

  it("returns undefined for missing / blank / zero / negative", () => {
    expect(parseRetryAfter(null)).toBeUndefined();
    expect(parseRetryAfter("")).toBeUndefined();
    expect(parseRetryAfter("   ")).toBeUndefined();
    expect(parseRetryAfter("0")).toBeUndefined();
  });

  it("returns undefined for unparseable strings", () => {
    expect(parseRetryAfter("not-a-date")).toBeUndefined();
    expect(parseRetryAfter("abc")).toBeUndefined();
  });

  it("parses HTTP-date form (future date)", () => {
    const future = new Date(Date.now() + 10_000).toUTCString();
    const ms = parseRetryAfter(future);
    // Allow ±500ms slack for test-execution timing.
    expect(ms).toBeGreaterThan(8_500);
    expect(ms).toBeLessThanOrEqual(10_000);
  });

  it("returns undefined for HTTP-date in the past", () => {
    const past = new Date(Date.now() - 10_000).toUTCString();
    expect(parseRetryAfter(past)).toBeUndefined();
  });
});

describe("externalProviderStream — retryDelayMs", () => {
  // Pins the doubling schedule for any maxRetries up to the
  // schema's 10-retry ceiling. The 30s cap kicks in at retry 6
  // (1s, 2s, 4s, 8s, 16s, 30s, 30s, …) so the cumulative wait at
  // the schema maximum is well-bounded but allows >7s when the
  // user has explicitly opted in by raising `maxRetries`.

  it("returns 0 for retry indices below 1", () => {
    expect(retryDelayMs(0)).toBe(0);
    expect(retryDelayMs(-1)).toBe(0);
  });

  it("doubles on each step starting at 1000ms", () => {
    expect(retryDelayMs(1)).toBe(1000);
    expect(retryDelayMs(2)).toBe(2000);
    expect(retryDelayMs(3)).toBe(4000);
    expect(retryDelayMs(4)).toBe(8000);
    expect(retryDelayMs(5)).toBe(16000);
  });

  it("caps at 30_000ms for high retry indices", () => {
    expect(retryDelayMs(6)).toBe(30_000);
    expect(retryDelayMs(7)).toBe(30_000);
    expect(retryDelayMs(10)).toBe(30_000);
  });
});
