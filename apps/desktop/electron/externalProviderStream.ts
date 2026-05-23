/**
 * Real Server-Sent-Events streaming for the optional external LLM
 * provider configured in Settings.
 *
 * This file is the TypeScript counterpart to
 * `crates/tessera_runtime/src/external_provider.rs`'s
 * `http_impl::stream` function. The Rust implementation is the
 * canonical reference (with wiremock coverage for OpenAI deltas,
 * Anthropic deltas, [DONE] sentinels, CRLF line endings, finish
 * reasons, comments, ping events, and pre-stream HTTP errors).
 *
 * Why a TypeScript copy exists alongside the Rust one:
 *
 *   * The renderer's only streaming consumer today is the
 *     `model:token` IPC channel emitted from `ipc.ts`'s
 *     `model:generate` handler, which talks to the **local**
 *     llama-server sidecar directly via Electron-side `fetch`. The
 *     local path never crosses the N-API bridge.
 *   * Threading the external-provider streaming path through the
 *     bridge would require adding a tokio runtime + a
 *     `ThreadsafeFunction` callback bridge to a currently fully-
 *     synchronous napi-rs crate, plus moving the local sidecar
 *     streaming through the same surface for consistency. That is a
 *     deliberate future-PR scope.
 *   * Until then this TS module reproduces the **SSE parser
 *     algorithm** in `crates/tessera_runtime/src/external_provider.rs::http_impl::stream`
 *     byte-for-byte (line buffering, CRLF tolerance, comment skipping,
 *     OpenAI `[DONE]` / `finish_reason` / Anthropic `message_stop`
 *     sentinels, ping-event tolerance). The
 *     {@link parseExternalProviderSSE} function is exported and
 *     covered by a unit-test suite that asserts the same fixture
 *     shapes the Rust `http_tests` module asserts.
 *
 *     **Deliberate asymmetry, NOT a parser difference**: the Rust
 *     `stream` function always emits a terminal
 *     `GenerateChunk { content: "", stop: true }` (see
 *     `external_provider.rs:553-556`) while this module's
 *     {@link streamExternalProvider} deliberately does NOT — its
 *     callers (`ipc/model.ts`'s `model:generate` `finally` block) own
 *     the `sentDone` bookkeeping and need to stay authoritative
 *     across both the local-sidecar and external paths. The
 *     {@link parseExternalProviderSSE} test helper manually appends
 *     the stop chunk so the fixture-shape comparisons against the
 *     Rust tests still line up. If you add a NEW external-path
 *     caller, you are responsible for emitting your own stop signal —
 *     consider this a contract documented at the function level too.
 *
 * SSE framing per
 * https://html.spec.whatwg.org/multipage/server-sent-events.html:
 *
 *   * Each event ends with a blank line (`\n\n` or `\r\n\r\n`).
 *   * Within an event, `event: <name>` and `data: <payload>` lines
 *     accumulate; multiple `data:` lines are joined with `\n`.
 *   * Lines beginning with `:` are comments and ignored (often used
 *     as keep-alive frames).
 *   * Other field names (`id:`, `retry:`) are not relevant to token
 *     streaming and are ignored.
 *
 * Wire format dispatch:
 *
 *   * OpenAI-compatible (OpenAI, Ollama, vLLM, LM Studio,
 *     llama-server OpenAI shim, "Custom"):
 *     `data: {"choices":[{"delta":{"content":"..."}}]}` framing
 *     with terminal `data: [DONE]`. Per-chunk `finish_reason` is
 *     also honoured for providers that omit `[DONE]`.
 *   * Anthropic Messages API:
 *     `event: content_block_delta\ndata: {"delta":{"text":"..."}}`
 *     framing with terminal `event: message_stop`. `event: ping`
 *     keep-alive frames are silently ignored.
 */

import type { ExternalProviderConfig } from "./config";

export interface ExternalProviderStreamChunk {
  /** The token text emitted by the provider for this chunk. Empty
   *  for the final stop chunk and for events that carry no token
   *  payload (role-only deltas, content_block_start, ping, …). */
  content: string;
  /** True for the single terminating chunk per stream. Consumers
   *  should treat the first chunk with `stop: true` as authoritative
   *  end-of-stream. */
  stop: boolean;
}

/** Inputs to a streaming call. The API key is read from the OS
 *  keychain by the IPC layer and passed in per-request; it never
 *  lives in the config. */
export interface ExternalProviderStreamInputs {
  provider: ExternalProviderConfig;
  apiKey: string;
  prompt: string;
  /** Override for `provider.maxTokens` when the caller wants a
   *  per-request value. */
  maxTokens?: number;
  /** Override for `provider.temperature` when the caller wants a
   *  per-request value. */
  temperature?: number;
  /** Optional stop sequences. OpenAI-compatible providers (OpenAI,
   *  Ollama, vLLM, LM Studio, llama-server OpenAI shim, "Custom")
   *  reject more than 4 entries, so the array is truncated to 4 by
   *  `buildStreamRequest` for those providers. Anthropic has no
   *  documented hard cap on `stop_sequences`, so the full array is
   *  forwarded for `providerType === "anthropic"`. Caller-side
   *  validation should still keep this list short — Anthropic
   *  rejects oversized requests at the API gateway with a 400. */
  stop?: string[];
  /** AbortSignal so the caller can cancel an in-flight stream when
   *  the renderer issues another generation or the window closes. */
  signal?: AbortSignal;
}

/** Pure SSE parser: takes a chunk of UTF-8 text and a mutable parser
 *  state, emits zero or more decoded chunks via the supplied
 *  callback, and returns whether end-of-stream was signalled.
 *
 *  This is the algorithmic core extracted from `streamExternalProvider`
 *  so the parser can be unit-tested without a network round-trip.
 *
 *  Callers should feed bytes / decoded text into this function as
 *  they arrive from the response body. The parser tolerates events
 *  being split across multiple feeds — the unconsumed tail is
 *  retained in `state.lineBuffer` for the next call. */
export interface SseParserState {
  /** Bytes that have been received but not yet terminated by a
   *  newline. Carried across `feedSse` calls. */
  lineBuffer: string;
  /** Accumulated `event: <name>` field for the current event. */
  eventName: string;
  /** Accumulated `data:` lines for the current event (joined by
   *  `\n`). */
  eventData: string;
  /** Whether a terminator (OpenAI `[DONE]`, OpenAI `finish_reason`,
   *  or Anthropic `message_stop`) has been observed. */
  sawStopSentinel: boolean;
}

export function newSseParserState(): SseParserState {
  return {
    lineBuffer: "",
    eventName: "",
    eventData: "",
    sawStopSentinel: false,
  };
}

/**
 * Feed a chunk of decoded text into the SSE parser. Invokes
 * `emit` once per assembled GenerateChunk. Returns the updated
 * stop-sentinel state for the caller's convenience (also reflected
 * in `state.sawStopSentinel`).
 */
export function feedSse(
  text: string,
  state: SseParserState,
  providerType: ExternalProviderConfig["providerType"],
  emit: (chunk: ExternalProviderStreamChunk) => void,
): boolean {
  // Once the stop sentinel has been observed, the caller is
  // contractually done — but TextDecoder.decode() may still flush a
  // post-sentinel tail when a multi-byte UTF-8 codepoint is split
  // exactly across the TCP chunk that contained `[DONE]` /
  // `message_stop`. Without this guard the tail would be processed
  // and could emit a phantom content chunk to the renderer after
  // the stream was supposed to have ended. The Rust impl avoids
  // this naturally because it breaks the outer read loop the moment
  // the inner loop sets `saw_stop_sentinel`.
  if (state.sawStopSentinel) return true;

  state.lineBuffer += text;

  for (;;) {
    const nlIdx = state.lineBuffer.indexOf("\n");
    if (nlIdx < 0) break;

    let line = state.lineBuffer.slice(0, nlIdx);
    state.lineBuffer = state.lineBuffer.slice(nlIdx + 1);
    if (line.endsWith("\r")) line = line.slice(0, -1);

    if (line.length === 0) {
      // Event terminator. Dispatch what we've accumulated.
      if (state.eventData.length > 0) {
        if (dispatchEvent(state.eventName, state.eventData, providerType, emit)) {
          state.sawStopSentinel = true;
        }
      }
      state.eventName = "";
      state.eventData = "";
      if (state.sawStopSentinel) return true;
      continue;
    }

    // SSE comments
    if (line.startsWith(":")) continue;

    if (line.startsWith("event:")) {
      state.eventName = line.slice("event:".length).trimStart();
    } else if (line.startsWith("data:")) {
      let data = line.slice("data:".length);
      if (data.startsWith(" ")) data = data.slice(1);
      if (state.eventData.length > 0) state.eventData += "\n";
      state.eventData += data;
    }
    // Other field names (id:, retry:) are intentionally ignored.
  }

  return state.sawStopSentinel;
}

/** Finalise the parser at end-of-stream. Some providers (notably
 *  certain Anthropic reverse-proxies and older Ollama builds) close
 *  the connection without flushing the spec-required `\n\n`
 *  terminator after the last event; this drains the remaining
 *  buffered event so the consumer doesn't lose its last token.
 *
 *  Two recoverable shapes are handled:
 *
 *    1. A complete event whose `eventData` was assembled but never
 *       saw its blank-line terminator (most common).
 *    2. A trailing line in `lineBuffer` that was never terminated
 *       by `\n` at all (rare — only seen from misbehaving proxies
 *       that flush the buffer right before close without the
 *       spec-required line break). The line is processed as if a
 *       newline had arrived, then the resulting event is
 *       dispatched. */
export function flushSse(
  state: SseParserState,
  providerType: ExternalProviderConfig["providerType"],
  emit: (chunk: ExternalProviderStreamChunk) => void,
): void {
  if (state.sawStopSentinel) return;

  // (2) Pull any unterminated trailing line into the event
  // accumulators so it has a chance to dispatch.
  if (state.lineBuffer.length > 0) {
    let line = state.lineBuffer;
    state.lineBuffer = "";
    if (line.endsWith("\r")) line = line.slice(0, -1);
    if (line.length > 0 && !line.startsWith(":")) {
      if (line.startsWith("event:")) {
        state.eventName = line.slice("event:".length).trimStart();
      } else if (line.startsWith("data:")) {
        let data = line.slice("data:".length);
        if (data.startsWith(" ")) data = data.slice(1);
        if (state.eventData.length > 0) state.eventData += "\n";
        state.eventData += data;
      }
    }
  }

  // (1) Now dispatch whatever event we accumulated.
  if (state.eventData.length > 0) {
    if (dispatchEvent(state.eventName, state.eventData, providerType, emit)) {
      state.sawStopSentinel = true;
    }
    state.eventName = "";
    state.eventData = "";
  }
}

function dispatchEvent(
  eventName: string,
  eventData: string,
  providerType: ExternalProviderConfig["providerType"],
  emit: (chunk: ExternalProviderStreamChunk) => void,
): boolean {
  // OpenAI-style terminator
  if (eventData.trim() === "[DONE]") {
    return true;
  }

  let parsed: unknown;
  try {
    parsed = JSON.parse(eventData);
  } catch {
    // Provider-side noise (telemetry, ping payloads, malformed
    // partial JSON when a proxy buffer flushed early). Skip and
    // keep streaming.
    return false;
  }

  if (providerType === "anthropic") {
    return dispatchAnthropicEvent(eventName, parsed, emit);
  }
  // openai_compatible OR custom: both use the OpenAI chat-completions
  // SSE shape per WS11 design.
  return dispatchOpenAIEvent(parsed, emit);
}

interface OpenAIDeltaChunk {
  choices?: Array<{
    delta?: { content?: unknown };
    finish_reason?: unknown;
  }>;
}

function dispatchOpenAIEvent(
  parsed: unknown,
  emit: (chunk: ExternalProviderStreamChunk) => void,
): boolean {
  const choice = (parsed as OpenAIDeltaChunk).choices?.[0];
  if (!choice) return false;

  const content = choice.delta?.content;
  if (typeof content === "string" && content.length > 0) {
    emit({ content, stop: false });
  }

  // Some OpenAI-compatible providers (older Ollama, certain
  // LM Studio versions) close the connection after emitting
  // `finish_reason` without sending `data: [DONE]`. Treat any
  // non-empty finish_reason as an in-band stop signal.
  const finishReason = choice.finish_reason;
  return typeof finishReason === "string" && finishReason.length > 0;
}

interface AnthropicDelta {
  delta?: { text?: unknown };
}

function dispatchAnthropicEvent(
  eventName: string,
  parsed: unknown,
  emit: (chunk: ExternalProviderStreamChunk) => void,
): boolean {
  // The `event:` field is authoritative; the `type` field inside
  // `data` echoes it but the header line is what the spec uses.
  switch (eventName) {
    case "content_block_delta": {
      const text = (parsed as AnthropicDelta).delta?.text;
      if (typeof text === "string" && text.length > 0) {
        emit({ content: text, stop: false });
      }
      return false;
    }
    case "message_stop":
      return true;
    // message_start, content_block_start, content_block_stop,
    // message_delta, ping, and any future event: ignored.
    default:
      return false;
  }
}

/**
 * Pure parser-only entry point used by the unit tests: feed an
 * entire SSE byte stream as a single string and collect every
 * emitted chunk. The IPC handler should NOT use this — it should
 * call `feedSse` incrementally as bytes arrive so token rendering
 * doesn't wait for the whole response.
 *
 * The terminating stop chunk is included in the returned array.
 */
export function parseExternalProviderSSE(
  body: string,
  providerType: ExternalProviderConfig["providerType"],
): ExternalProviderStreamChunk[] {
  const state = newSseParserState();
  const chunks: ExternalProviderStreamChunk[] = [];
  feedSse(body, state, providerType, (c) => chunks.push(c));
  flushSse(state, providerType, (c) => chunks.push(c));
  chunks.push({ content: "", stop: true });
  return chunks;
}

interface BuildRequestResult {
  url: string;
  headers: Record<string, string>;
  body: string;
}

/**
 * Compose the canonical chat-completions / messages endpoint URL for
 * the given provider, honouring whichever sub-path the user may have
 * already typed into Settings.
 *
 * Two failure modes this prevents:
 *
 *   1. **Trailing-slash double-suffixing.** Strips one-or-more trailing
 *      slashes from `apiUrl` before composing the path, so an
 *      `apiUrl` of `https://api.openai.com/v1/` doesn't yield
 *      `https://api.openai.com/v1//v1/chat/completions`.
 *
 *   2. **Already-complete-URL double-suffixing.** If the user pastes
 *      the full endpoint (`https://api.openai.com/v1/chat/completions`
 *      for OpenAI, or `https://api.anthropic.com/v1/messages` for
 *      Anthropic), don't append the canonical sub-path a second time.
 *      The OpenAI branch also accepts the shorter `…/chat/completions`
 *      form some self-hosted shims advertise.
 *
 * Exported and re-used by:
 *
 *   - `buildStreamRequest` (this module, streaming path)
 *   - `testExternalProviderConnection` (`ipc/settings.ts`,
 *     `externalProvider:test` IPC handler)
 *
 * Keeping the URL composition single-sourced means the test endpoint
 * cannot drift away from the streaming endpoint — a previous version
 * of `testExternalProviderConnection` lacked the `endsWith` guards and
 * produced 404s ("…/v1/chat/completions/v1/chat/completions") when the
 * user pasted a complete URL, while the streaming path quietly worked.
 */
export function resolveProviderEndpoint(
  provider: ExternalProviderConfig,
): string {
  const apiUrl = provider.apiUrl.replace(/\/+$/, "");
  if (provider.providerType === "anthropic") {
    // The `/v1/messages` form is the only documented Anthropic
    // Messages endpoint; older `/v1/complete` is for the legacy
    // Completions API and shouldn't be routed through this provider
    // class.
    return apiUrl.endsWith("/v1/messages") ? apiUrl : `${apiUrl}/v1/messages`;
  }
  // OpenAI-compatible OR custom. Some self-hosted shims (older
  // llama-server builds, certain LM Studio versions) only expose
  // `…/chat/completions` without the `/v1` prefix — accept that too.
  const endsWithCompletions =
    apiUrl.endsWith("/v1/chat/completions") ||
    apiUrl.endsWith("/chat/completions");
  return endsWithCompletions ? apiUrl : `${apiUrl}/v1/chat/completions`;
}

/** Build the HTTP request for a streaming call. Exported for tests
 *  so they can assert that the wire format matches the Rust impl. */
export function buildStreamRequest(
  inputs: ExternalProviderStreamInputs,
): BuildRequestResult {
  const { provider, apiKey, prompt } = inputs;
  const maxTokens = inputs.maxTokens ?? provider.maxTokens;
  const temperature = inputs.temperature ?? provider.temperature;
  // OpenAI-compatible providers reject more than 4 stop sequences
  // with HTTP 400 ("too many stop sequences"). Anthropic has no
  // documented hard cap and accepts arbitrary-length
  // `stop_sequences` arrays, so we only truncate for the OpenAI
  // shape. This mirrors `openai_body` / `anthropic_body` in the
  // Rust impl byte-for-byte.
  const stop =
    inputs.stop && inputs.stop.length > 0
      ? provider.providerType === "anthropic"
        ? inputs.stop.slice()
        : inputs.stop.slice(0, 4)
      : undefined;

  const url = resolveProviderEndpoint(provider);

  if (provider.providerType === "anthropic") {
    const anthropicBody: Record<string, unknown> = {
      model: provider.modelName,
      messages: [{ role: "user", content: prompt }],
      max_tokens: maxTokens,
      temperature,
      stream: true,
    };
    if (stop) anthropicBody.stop_sequences = stop;
    return {
      url,
      headers: {
        "Content-Type": "application/json",
        "x-api-key": apiKey,
        "anthropic-version": "2023-06-01",
        Accept: "text/event-stream",
      },
      body: JSON.stringify(anthropicBody),
    };
  }

  // OpenAI-compatible OR custom (URL already resolved above via
  // `resolveProviderEndpoint(provider)`).
  const openAiBody: Record<string, unknown> = {
    model: provider.modelName,
    messages: [{ role: "user", content: prompt }],
    max_tokens: maxTokens,
    temperature,
    stream: true,
  };
  if (stop) openAiBody.stop = stop;
  return {
    url,
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
      Accept: "text/event-stream",
    },
    body: JSON.stringify(openAiBody),
  };
}

/**
 * Stream tokens from the configured external provider, invoking
 * `emit` once per assembled chunk. Resolves with `void` when the
 * stream terminates (either by `[DONE]` / `message_stop` /
 * `finish_reason`, or by clean connection close).
 *
 * Throws on pre-stream errors (non-2xx status, network failure
 * before the body opens). Mid-stream errors propagate via the
 * `reader.read()` promise rejection.
 *
 * The caller is responsible for emitting a final `{content: "",
 * stop: true}` chunk to its renderer-facing channel; this function
 * deliberately does NOT inject that sentinel because the IPC layer
 * already has its own `sentDone` bookkeeping that needs to stay
 * authoritative for both local and external paths.
 */
export async function streamExternalProvider(
  inputs: ExternalProviderStreamInputs,
  emit: (chunk: ExternalProviderStreamChunk) => void,
): Promise<void> {
  const req = buildStreamRequest(inputs);
  const res = await fetch(req.url, {
    method: "POST",
    headers: req.headers,
    body: req.body,
    signal: inputs.signal,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    throw new Error(
      `External provider HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
    );
  }

  const reader = res.body?.getReader();
  if (!reader) {
    throw new Error("External provider response had no body to stream");
  }

  const decoder = new TextDecoder("utf-8");
  const state = newSseParserState();

  // The reader holds a lock on `res.body` for the lifetime of this
  // function, and the underlying TCP connection stays open until the
  // stream is either drained (loop exits with `done: true`),
  // cancelled, or garbage-collected. We must explicitly cancel on
  // every exit path that is NOT a natural `done: true` — early-break
  // on stop sentinel, thrown exceptions, AbortSignal cancellation —
  // otherwise the connection can linger for the entire idle lifetime
  // of the Electron renderer, holding a slot in the provider's
  // concurrent-request quota. `cancel()` aborts the producer side,
  // signals the upstream that we don't need any more bytes, and
  // releases the reader lock so the body can be GC'd.
  let drainedNaturally = false;
  try {
    for (;;) {
      const { done, value } = await reader.read();
      if (done) {
        drainedNaturally = true;
        break;
      }
      const text = decoder.decode(value, { stream: true });
      if (text.length > 0) {
        if (feedSse(text, state, inputs.provider.providerType, emit)) {
          // Stop sentinel observed — drain any final buffered text
          // through the decoder and break the read loop. The
          // `finally` block below cancels the reader so the
          // underlying connection closes promptly.
          break;
        }
      }
    }

    // Flush any tail-end UTF-8 bytes the streaming decoder buffered.
    const tail = decoder.decode();
    if (tail.length > 0) {
      feedSse(tail, state, inputs.provider.providerType, emit);
    }
    flushSse(state, inputs.provider.providerType, emit);
  } finally {
    if (!drainedNaturally) {
      // `reader.cancel()` returns a promise that may reject if the
      // stream is already errored (e.g. the AbortSignal fired and
      // pushed the reader into an errored state before we got here).
      // Swallow — we're in cleanup and the caller has already moved
      // on. We do NOT swallow at the level of `await` itself because
      // an unhandled rejection from a finally-block awaited promise
      // would surface as a process warning in Electron's main.
      await reader.cancel().catch(() => {
        // Stream was already closed / errored; nothing to clean up.
      });
    }
  }
}
