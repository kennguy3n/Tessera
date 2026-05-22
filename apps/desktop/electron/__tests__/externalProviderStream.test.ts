import { describe, it, expect } from "vitest";
import {
  parseExternalProviderSSE,
  feedSse,
  flushSse,
  newSseParserState,
  buildStreamRequest,
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
});
