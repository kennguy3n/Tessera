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
  // Normalise trailing slashes AND a bare `/v1` version prefix
  // before any suffix-matching. Without the bare-`/v1` strip a user
  // who pastes `https://api.openai.com/v1` (just the version, no
  // further path) ends up with `https://api.openai.com/v1/v1/chat/
  // completions` because none of the longer `endsWith` checks below
  // match. The strip is safe because `stripBareV1Suffix` only
  // matches URLs ending in EXACTLY `/v1` — any longer composition
  // that CONTAINS `/v1` as a sub-path (`/v1/chat/completions`,
  // `/v1/messages`, `/v1/models`) does not end with bare `/v1` and
  // is therefore left untouched by the strip. The subsequent
  // `endsWith` checks then handle those longer forms correctly. See
  // the strict-semantics block on `stripBareV1Suffix` for the full
  // invariant.
  const apiUrl = stripBareV1Suffix(provider.apiUrl.replace(/\/+$/, ""));
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

/**
 * Strip a bare `/v1` version-prefix suffix from a normalised
 * (trailing-slash-trimmed) apiUrl. Used by both
 * {@link resolveProviderEndpoint} and
 * {@link resolveProviderModelsEndpoint} to handle the
 * `https://api.openai.com/v1` paste form without producing a
 * doubled `…/v1/v1/…` composition.
 *
 * Strict semantics: only strips the suffix when the apiUrl ends
 * with EXACTLY `/v1` (i.e. the next-to-last segment is the host
 * or some intermediate path — there's no trailing `/messages`,
 * `/chat/completions`, `/models`, etc.). This is the only form
 * that produces the duplication bug; any longer composition that
 * happens to contain `/v1` as a non-terminal segment is left
 * untouched.
 *
 * Callers must apply this AFTER the trailing-slash strip (so
 * `…/v1/` is treated the same as `…/v1`) and BEFORE any
 * longer-suffix `endsWith` check (so the result of this strip
 * cleanly composes with the standard append-suffix branch).
 */
function stripBareV1Suffix(apiUrl: string): string {
  return apiUrl.endsWith("/v1") ? apiUrl.slice(0, -"/v1".length) : apiUrl;
}

/**
 * Compose the OpenAI-compatible `GET /v1/models` endpoint for the
 * configured provider, applying the same "did the user paste a full
 * URL?" trimming logic as {@link resolveProviderEndpoint}.
 *
 * Returns `null` for Anthropic — the Messages API has no
 * `/v1/models` analogue, and asking the caller to handle a
 * provider-type-aware decision higher up in the stack would
 * duplicate the "is the listing supported?" predicate at every
 * caller. Returning `null` lets the IPC handler short-circuit to a
 * graceful "not supported" reply without an extra type-narrowing
 * pass.
 *
 * For OpenAI-compatible / custom: the user's `apiUrl` may be a
 * base (`https://api.openai.com`), a chat-completions endpoint
 * (`https://api.openai.com/v1/chat/completions`), or even an
 * already-resolved models endpoint
 * (`https://api.openai.com/v1/models`). We strip the
 * chat-completions suffix when present and append `/v1/models` if
 * not already there. The handful of self-hosted shims that omit
 * the `/v1` prefix on chat completions (LM Studio's
 * `.../chat/completions`) generally ALSO omit it on `/models`, so
 * we accept both endings.
 */
export function resolveProviderModelsEndpoint(
  provider: ExternalProviderConfig,
): string | null {
  if (provider.providerType === "anthropic") return null;
  let apiUrl = provider.apiUrl.replace(/\/+$/, "");
  // If the user pasted a `…/v1/chat/completions` or
  // `…/chat/completions` URL, strip the suffix so we can append the
  // `/models` path below without composing
  // `…/chat/completions/v1/models`. Check the longer suffix first
  // — the shorter `/chat/completions` is a structural superset of
  // `/v1/chat/completions`, and matching it first would only strip
  // the inner `/chat/completions`, leaving a dangling `/v1`.
  if (apiUrl.endsWith("/v1/chat/completions")) {
    apiUrl = apiUrl.slice(0, -"/v1/chat/completions".length);
  } else if (apiUrl.endsWith("/chat/completions")) {
    apiUrl = apiUrl.slice(0, -"/chat/completions".length);
  }
  // After stripping any chat-completions suffix, ALSO strip a bare
  // `/v1` version-prefix suffix. Without this, a user who pastes
  // `https://api.openai.com/v1` would end up with
  // `https://api.openai.com/v1/v1/models` because the existing
  // longer-suffix `endsWith` checks for `/v1/models` / `/models`
  // don't match. See `stripBareV1Suffix` for the ordering invariant.
  apiUrl = stripBareV1Suffix(apiUrl);
  if (
    apiUrl.endsWith("/v1/models") ||
    apiUrl.endsWith("/models")
  ) {
    return apiUrl;
  }
  return `${apiUrl}/v1/models`;
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
 * HTTP status codes that we treat as transient pre-stream failures
 * and retry with exponential backoff. The set is deliberately
 * narrow:
 *
 *   - **408 Request Timeout**: the server didn't respond in time;
 *     a quick retry against the same edge often succeeds.
 *   - **429 Too Many Requests**: rate limit hit; we honour the
 *     `Retry-After` response header if present (see
 *     {@link parseRetryAfter}) and otherwise fall back to the
 *     standard exponential schedule.
 *   - **500 Internal Server Error, 502 Bad Gateway, 503 Service
 *     Unavailable, 504 Gateway Timeout**: edge / origin failures
 *     that are routinely transient.
 *
 * Everything else — in particular **400/401/403/404/422** — is a
 * client-side error (bad request shape, bad credentials, missing
 * model, content-policy violation) that retrying cannot fix; we
 * fail fast on those so the user sees the real error message
 * immediately instead of waiting 7 seconds for the retry chain to
 * exhaust against a permanent failure.
 *
 * This list mirrors the canonical "retryable upstream" set used by
 * the OpenAI / Anthropic official client SDKs and by industry
 * best-practice proxies (envoy, nginx-plus, traefik). Keeping it in
 * sync means the desktop client doesn't develop its own opinion of
 * which errors are transient versus permanent.
 */
const RETRYABLE_HTTP_STATUS_CODES: ReadonlySet<number> = new Set([
  408, 429, 500, 502, 503, 504,
]);

/**
 * Base delay for the first retry, in milliseconds. Subsequent
 * retries double this on each step: attempt 1 waits `1000ms`,
 * attempt 2 waits `2000ms`, attempt 3 waits `4000ms`, and so on
 * (see {@link retryDelayMs}). We deliberately do NOT add jitter —
 * the desktop app issues at most one streaming request at a time
 * per user gesture, so the thundering-herd concern that motivates
 * jitter in server-side retry policies doesn't apply here.
 *
 * The user-visible "Stop generating" button (`ipc/model.ts`'s
 * `AbortController`) interrupts this delay via the standard
 * `AbortSignal` polling inside `delayWithAbort`, so a long
 * `Retry-After` header does NOT trap the user; they can always
 * cancel.
 */
const RETRY_BASE_DELAY_MS = 1000;

/**
 * Safety cap on individual retry delays. The schema clamps
 * `maxRetries` to `0..=10`; without a cap, a doubling schedule
 * would request a ~17-minute wait before the 10th retry (1s, 2s,
 * 4s, …, 512s, 1024s). The cap keeps any single wait under 30s so
 * the user gets timely feedback even at the schema's upper bound.
 * Note this is the cap on a SINGLE backoff step — the cumulative
 * wait across 10 retries is still bounded but allows >7s overall
 * when the user has explicitly raised `maxRetries`.
 */
const RETRY_MAX_DELAY_MS = 30_000;

/**
 * Compute the wait before retry `n` (1-indexed: `n=1` is the wait
 * before the 1st retry, i.e. before attempt 2 overall). Exposed
 * for tests; production callers go through the main retry loop.
 *
 * The formula is `RETRY_BASE_DELAY_MS * 2^(n-1)`, capped at
 * {@link RETRY_MAX_DELAY_MS}. For the default `maxRetries=2` this
 * yields the legacy schedule (1s, 2s); for higher values it
 * continues doubling (4s, 8s, 16s, 30s, 30s, …).
 */
export function retryDelayMs(retryIndex1Based: number): number {
  if (retryIndex1Based < 1) {
    return 0;
  }
  return Math.min(
    RETRY_MAX_DELAY_MS,
    RETRY_BASE_DELAY_MS * 2 ** (retryIndex1Based - 1),
  );
}

/**
 * Parse an HTTP `Retry-After` header (RFC 7231 §7.1.3). Returns the
 * delay in milliseconds, or `undefined` if the header is missing or
 * unparseable. Accepts both numeric forms (delta-seconds) and
 * HTTP-date forms.
 *
 * Returns `undefined` for negative or zero values so the caller
 * falls through to the standard exponential schedule rather than
 * retrying immediately (which would just thrash the upstream).
 *
 * Capped at 60 seconds: a server that asks for a multi-minute
 * back-off effectively means the request will never succeed in
 * this interactive session; the cap lets the retry chain exhaust
 * and surface the 429 to the user, who can then back off manually.
 */
export function parseRetryAfter(value: string | null): number | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (trimmed.length === 0) return undefined;

  // delta-seconds form.
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number.parseInt(trimmed, 10);
    if (!Number.isFinite(seconds) || seconds <= 0) return undefined;
    return Math.min(seconds * 1000, 60_000);
  }

  // HTTP-date form.
  const ts = Date.parse(trimmed);
  if (Number.isNaN(ts)) return undefined;
  const deltaMs = ts - Date.now();
  if (deltaMs <= 0) return undefined;
  return Math.min(deltaMs, 60_000);
}

/**
 * Sleep for `ms` milliseconds, but resolve early (and throw a
 * `DOMException` named `"AbortError"`) if the supplied
 * `AbortSignal` fires. The error shape matches what `fetch()`
 * itself throws on `AbortController.abort()`, so the upstream
 * caller's already-existing abort handling kicks in unchanged.
 */
function delayWithAbort(
  ms: number,
  signal: AbortSignal | undefined,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException("Aborted", "AbortError"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = (): void => {
      clearTimeout(timer);
      signal?.removeEventListener("abort", onAbort);
      reject(new DOMException("Aborted", "AbortError"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

/**
 * One attempt at the pre-stream HTTP exchange. Returns the open
 * `Response` on a 2xx body, OR a sentinel describing a retryable
 * status so the caller's loop can decide whether to back off and
 * retry. Throws on non-retryable HTTP failures (the error message
 * includes the upstream body so the user can see what went wrong)
 * and on network-level failures (DNS, TLS, connection-refused).
 *
 * The function name reflects its scope: this is the PRE-STREAM
 * boundary. Once the body opens (return value here), every
 * subsequent failure is treated as mid-stream and is NOT retried
 * — we don't want to silently re-deliver tokens the renderer has
 * already shown to the user.
 *
 * # Per-attempt timeout
 *
 * `timeoutMs` is the upper bound on how long this single attempt
 * waits for the upstream HTTP exchange to start producing a body.
 * It is wired through `provider.timeoutSecs` (schema-validated to
 * `1..=600` seconds in `electron/ipc/schemas.ts`). The timeout
 * fires via a per-attempt `AbortController` whose signal is forked
 * with the user's outer cancel signal so we can distinguish the
 * two abort sources:
 *
 *   - **User cancel**: the user-provided `signal` aborts. We
 *     propagate the `AbortError` upward so the caller's retry loop
 *     terminates immediately (cancelling mid-retry is the whole
 *     point of the Stop Generation button).
 *   - **Per-attempt timeout**: only our internal controller
 *     aborts. We return a `{ kind: "timeout" }` retryable
 *     sentinel so the caller's loop can back off and re-attempt
 *     (a slow-but-responsive upstream is exactly the case the
 *     retry budget exists to handle).
 *
 * Without this distinction the retry budget is effectively
 * useless against a slow-but-responsive upstream — attempt 1
 * would hang forever waiting for the response, and the retry
 * loop would never reach attempts 2…N. This was the gap Devin
 * Review round 7 surfaced: `timeoutSecs` was wired into
 * `testExternalProviderConnection` and (with a fixed 10 s)
 * `listExternalProviderModels`, but the streaming path relied
 * solely on the user's Stop button.
 */
interface OpenedResponse {
  readonly status: "opened";
  readonly response: Response;
  /**
   * Detach the per-attempt user-cancel forwarder from the user's
   * outer `AbortSignal`. The caller MUST call this exactly once,
   * after body reading completes (success, abort, or error), so the
   * listener does not leak past the lifetime of the stream.
   *
   * Until this is called, a user-cancel on the outer signal will
   * propagate to the per-attempt `AbortController` that backs the
   * open response body, which is exactly what makes the "Stop
   * generating" button cancel mid-stream. Detaching too early
   * (e.g. in `openExternalProviderStream`'s own `finally`) would
   * silently disconnect the user signal from the body stream and
   * make the Stop button non-functional once the body opened.
   */
  readonly cleanupBodyForwarder: () => void;
}
/** Pre-stream attempt completed but the upstream returned a
 *  retryable HTTP status (408/429/500/502/503/504). */
interface RetryableHttp {
  readonly status: "retryable";
  readonly kind: "http";
  readonly httpStatus: number;
  readonly retryAfterMs: number | undefined;
  readonly bodyPreview: string;
}
/** Pre-stream attempt timed out before the upstream produced a
 *  response body. The user did NOT cancel — this is a transient
 *  upstream slowness that the retry loop should back off and
 *  re-attempt. */
interface RetryableTimeout {
  readonly status: "retryable";
  readonly kind: "timeout";
  readonly timeoutMs: number;
}
type RetryableStatus = RetryableHttp | RetryableTimeout;
async function openExternalProviderStream(
  req: BuildRequestResult,
  signal: AbortSignal | undefined,
  timeoutMs: number,
): Promise<OpenedResponse | RetryableStatus> {
  // Per-attempt cancel source: aborts EITHER when the user clicks
  // Stop (via `signal`) OR when the per-attempt timer fires. We use
  // a single composite controller so the `fetch` call sees one
  // unified signal, then distinguish the two sources in the catch
  // block by checking which underlying signal is aborted.
  const attemptController = new AbortController();
  const timer = setTimeout(() => attemptController.abort(), timeoutMs);

  // Forward an already-aborted user signal immediately so we don't
  // even kick off a request. Without this guard a user who clicks
  // Stop during a backoff delay would still consume one wasted
  // attempt before the retry loop saw the abort.
  if (signal?.aborted) {
    clearTimeout(timer);
    throw new DOMException("Aborted", "AbortError");
  }

  // Forward a LATER user-cancel into our composite controller so
  // `fetch` aborts immediately even though we passed it the
  // composite signal (not the user's signal directly). The lifetime
  // of this listener depends on the outcome:
  //
  //   - Pre-stream failure (retryable HTTP, non-retryable HTTP,
  //     timeout, network error, propagated user-cancel) — the
  //     listener is detached by this function's `finally` block
  //     because the attempt is over.
  //   - Body opens successfully — ownership of the listener transfers
  //     to the caller via `cleanupBodyForwarder()`, so the user's
  //     Stop signal continues to abort the underlying connection
  //     while the caller reads the body. The caller MUST detach
  //     exactly once after body reading completes.
  //
  // Without the ownership transfer, the listener would be detached
  // here while the body stream is still bound to `attemptController.
  // signal`, leaving the user's outer signal disconnected from the
  // body stream and making the Stop button non-functional mid-
  // stream. Devin Review round 8 surfaced exactly this regression.
  const forwardUserAbort = (): void => attemptController.abort();
  signal?.addEventListener("abort", forwardUserAbort, { once: true });
  // Set to true when the body opens successfully so the `finally`
  // block below leaves the listener attached for the caller. All
  // other code paths exit with this still `false` and the listener
  // is detached normally.
  let ownershipTransferred = false;

  try {
    const res = await fetch(req.url, {
      method: "POST",
      headers: req.headers,
      body: req.body,
      signal: attemptController.signal,
    });
    // Headers arrived. The per-attempt timer's job is bounding the
    // PRE-RESPONSE wait (how long we wait for the upstream to start
    // producing a body); once `fetch` resolves we've passed that
    // boundary and the timer should be cleared regardless of which
    // status-code branch we take below. Devin Review round 12
    // BUG_001 surfaced the regression: when the timer was only
    // cleared in the `res.ok` branch, a slow body-drain on a non-
    // retryable HTTP error (e.g. a `await res.text()` for a 401
    // response that takes longer than `timeoutMs`) would trip the
    // timer mid-drain, the `.catch(() => "")` would swallow the
    // resulting abort error, and the explicit `throw new Error(...)`
    // for "HTTP 401" would then enter the catch block where
    // `attemptController.signal.aborted === true` would misclassify
    // the failure as a retryable timeout. The user would see "pre-
    // stream timeout (Nms) after K attempts" instead of "HTTP 401",
    // and the retry loop would waste its budget on a permanent
    // failure. Clearing the timer here, before any body-read, makes
    // the misclassification structurally impossible.
    clearTimeout(timer);
    if (res.ok) {
      // Body is open. Mid-stream slowness is bounded only by the
      // user's Stop signal (see the long-running-streaming-response
      // comment on `timeoutMs` in `streamExternalProvider`).
      // Transfer listener ownership to the caller via
      // `cleanupBodyForwarder`; the per-attempt timer was already
      // cleared above.
      ownershipTransferred = true;
      return {
        status: "opened",
        response: res,
        cleanupBodyForwarder: () => {
          signal?.removeEventListener("abort", forwardUserAbort);
        },
      };
    }
    if (RETRYABLE_HTTP_STATUS_CODES.has(res.status)) {
      // Drain the body so the connection can be reused and so we can
      // include a preview in the eventual user-visible error (if the
      // retry chain exhausts). Errors here are swallowed because the
      // status code is the authoritative signal, not the body shape.
      // Per the comment above, the timer was already cleared so this
      // drain can take as long as the upstream needs without
      // affecting classification.
      const bodyPreview = await res.text().catch(() => "");
      const retryAfterMs = parseRetryAfter(res.headers.get("retry-after"));
      return {
        status: "retryable",
        kind: "http",
        httpStatus: res.status,
        retryAfterMs,
        bodyPreview,
      };
    }
    // Non-retryable client error (400/401/403/404/422/…). Surface
    // immediately so the user sees the real problem without 7 s of
    // pointless retry delay. Per the comment above, the timer was
    // already cleared so a slow body-drain on the error response
    // can't mid-classify this as a retryable timeout.
    const text = await res.text().catch(() => "");
    throw new Error(
      `External provider HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
    );
  } catch (e) {
    // The fetch threw — distinguish user-cancel from per-attempt
    // timeout from genuine network-level failure (DNS, TLS,
    // connection-refused). The order of checks matters: user
    // intent takes priority over the timer, so a user-cancel that
    // arrives during a hung request must propagate the AbortError
    // upward rather than silently being mapped to a retryable
    // timeout.
    if (signal?.aborted) {
      throw e;
    }
    // Only our internal timer fired — transient slowness from the
    // upstream. Return a retryable sentinel so the caller's loop
    // can back off and try again.
    if (attemptController.signal.aborted) {
      return {
        status: "retryable",
        kind: "timeout",
        timeoutMs,
      };
    }
    // Genuine network-level failure (DNS, TLS, connection-refused).
    // Surface immediately — these are typically misconfiguration,
    // not transient slowness, and retrying just wastes the budget.
    // The existing line 549–554 comment block in this file
    // documents the same design choice for the streaming half.
    throw e;
  } finally {
    // Always clear the timer — idempotent if already cleared on the
    // success path. Only detach the listener if ownership was NOT
    // transferred to the caller (i.e. body never opened).
    clearTimeout(timer);
    if (!ownershipTransferred) {
      signal?.removeEventListener("abort", forwardUserAbort);
    }
  }
}

/**
 * Stream tokens from the configured external provider, invoking
 * `emit` once per assembled chunk. Resolves with `void` when the
 * stream terminates (either by `[DONE]` / `message_stop` /
 * `finish_reason`, or by clean connection close).
 *
 * # Retry policy
 *
 * The PRE-STREAM HTTP exchange is wrapped in an exponential-backoff
 * retry loop that retries transient upstream failures (408, 429,
 * 500, 502, 503, 504) up to `provider.maxRetries` times (schema-
 * validated `0..=10`, default `2`) with delays of 1s / 2s / 4s / …
 * (see {@link retryDelayMs}). On 429, the `Retry-After` response
 * header is honoured (see {@link parseRetryAfter}); otherwise the
 * standard schedule applies. Non-retryable HTTP failures
 * (400/401/403/404/422/…) and network-level failures (DNS, TLS
 * handshake, connection refused) throw immediately so the user
 * sees the real error.
 *
 * Once the response body opens, we are mid-stream and **do NOT**
 * retry on any subsequent failure — retrying mid-stream could
 * silently re-deliver tokens that the renderer has already shown
 * to the user, breaking the at-most-once delivery contract that
 * `ipc/model.ts`'s `model:token` channel assumes.
 *
 * Throws on pre-stream errors (non-retryable status, exhausted
 * retry chain, network failure before the body opens). Mid-stream
 * errors propagate via the `reader.read()` promise rejection.
 *
 * The caller is responsible for emitting a final `{content: "",
 * stop: true}` chunk to its renderer-facing channel; this function
 * deliberately does NOT inject that sentinel because the IPC layer
 * already has its own `sentDone` bookkeeping that needs to stay
 * authoritative for both local and external paths.
 *
 * # Body-opened signal (optional)
 *
 * The optional `onBodyOpened` callback fires EXACTLY ONCE, the
 * moment the HTTP response body is confirmed open
 * (`openedResponse` is set, before SSE parsing begins). Callers
 * use this as the architectural ground truth for "the upstream
 * provider accepted the request and the prompt was processed" —
 * independent of whether the SSE body ever produces a non-empty
 * content delta. The `emit` callback is NOT a valid substitute for
 * this signal because the SSE dispatchers in this module
 * (`dispatchOpenAIEvent` line 304, `dispatchAnthropicEvent` line
 * 330) intentionally filter out role-only deltas, content_block_
 * start, message_start, ping, and other framing-only events
 * BEFORE calling emit. A provider that sends a role-assignment
 * chunk and then errors mid-stream would therefore never trigger
 * emit, but the prompt has unambiguously been processed and the
 * user has unambiguously been billed.
 *
 * The token-usage accountant in `ipc/model.ts` uses this to gate
 * `promptTokens` persistence: pre-stream failures (HTTP 401/403,
 * retry-exhausted 5xx, DNS errors, TLS errors) all throw BEFORE
 * `onBodyOpened` fires, so the counter never inflates on a
 * misconfigured-API-key retry storm. See the long comment near
 * the gate in `ipc/model.ts` for the full motivation.
 */
export async function streamExternalProvider(
  inputs: ExternalProviderStreamInputs,
  emit: (chunk: ExternalProviderStreamChunk) => void,
  onBodyOpened?: () => void,
): Promise<void> {
  const req = buildStreamRequest(inputs);
  // Retry loop for the pre-stream HTTP exchange. `attempt` is
  // 0-indexed: attempt 0 is the initial try, attempts 1..maxRetries
  // are retries. We stop after exhausting the user-configured retry
  // budget or once the body opens.
  //
  // `provider.maxRetries` is schema-clamped to `0..=10` in
  // `electron/ipc/schemas.ts` and `electron/config.ts`'s loader, so
  // it is safe to use directly here without a re-clamp.
  const maxRetries = inputs.provider.maxRetries;
  // `provider.timeoutSecs` is schema-clamped to `1..=600` in
  // `electron/ipc/schemas.ts`, so we can convert directly without a
  // re-clamp. The per-attempt timer applies to the PRE-STREAM
  // exchange only — once the body opens (return value of
  // `openExternalProviderStream`) we are mid-stream and the timer
  // is cleared in `openExternalProviderStream`'s finally block.
  // SSE reads after that point are bounded by the user's Stop
  // signal, not by the configured timeout (a long-running
  // legitimate streaming response can exceed `timeoutSecs`).
  const timeoutMs = inputs.provider.timeoutSecs * 1000;
  let openedResponse: Response | undefined;
  let cleanupBodyForwarder: (() => void) | undefined;
  let lastRetryable: RetryableStatus | undefined;
  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const outcome = await openExternalProviderStream(
      req,
      inputs.signal,
      timeoutMs,
    );
    if (outcome.status === "opened") {
      openedResponse = outcome.response;
      cleanupBodyForwarder = outcome.cleanupBodyForwarder;
      break;
    }
    lastRetryable = outcome;
    if (attempt === maxRetries) {
      // Retry budget exhausted — surface the last transient error.
      break;
    }
    // `attempt + 1` is the 1-indexed retry number we are about to
    // perform: attempt=0 → about to do retry 1 → wait `retryDelayMs(1)`.
    const baseDelay = retryDelayMs(attempt + 1);
    // Honour `Retry-After` for the upcoming wait when the outcome
    // is an HTTP retryable (only HTTP outcomes carry a
    // `retryAfterMs` field). A timeout outcome has no server-sent
    // back-off hint, so it uses the exponential schedule directly.
    // We never wait LESS than the exponential schedule (so a
    // server-sent `Retry-After: 0` can't trick us into a tight
    // retry loop).
    const retryAfterMs =
      outcome.kind === "http" ? outcome.retryAfterMs ?? 0 : 0;
    const delay = Math.max(baseDelay, retryAfterMs);
    await delayWithAbort(delay, inputs.signal);
  }

  if (!openedResponse) {
    // The retry chain exhausted without opening a body. Surface the
    // last transient status to the user; for HTTP failures the
    // body preview helps diagnose provider-side rate-limit / outage
    // messages, for timeouts we show the configured timeout so the
    // user can see whether they need to raise it. Attempts count
    // appears mid-message (`… after N attempt(s)`) before any tail
    // body preview so error monitoring / log aggregation can
    // structure-match against the prefix without false-positives on
    // attacker-controlled body text. The singular/plural form
    // matters because `maxRetries=0` (no retries) produces a single
    // attempt total — "after 1 attempts" reads as a bug to the
    // user even though it isn't, so we pluralise correctly.
    const last = lastRetryable as RetryableStatus;
    const summary =
      last.kind === "http"
        ? `HTTP ${last.httpStatus}`
        : `pre-stream timeout (${last.timeoutMs}ms)`;
    const detail =
      last.kind === "http" && last.bodyPreview
        ? `: ${last.bodyPreview.slice(0, 200)}`
        : "";
    const totalAttempts = maxRetries + 1;
    const attemptsWord = totalAttempts === 1 ? "attempt" : "attempts";
    throw new Error(
      `External provider ${summary} after ${totalAttempts} ${attemptsWord}${detail}`,
    );
  }

  const res = openedResponse;
  const reader = res.body?.getReader();
  if (!reader) {
    // Detach the user-cancel forwarder before throwing — we never
    // reach the body-reading try/finally that normally invokes
    // `cleanupBodyForwarder()`, so without this the listener leaks
    // on the user's outer signal for the full lifetime of the
    // controller (often the entire renderer session, since the
    // controller is reused across generations in `ipc/model.ts`).
    // The trigger condition (HTTP 200 OK with no body) is rare in
    // practice but the `res.body?.getReader()` guard explicitly
    // exists for it, so the cleanup must mirror the guard.
    cleanupBodyForwarder?.();
    throw new Error("External provider response had no body to stream");
  }

  // Fire the body-opened signal exactly once now that we have a
  // confirmed-open response WITH a readable body. We fire AFTER the
  // reader-acquired guard above (line 822-825) because a response
  // with no body is not actually "open" in the streaming-contract
  // sense — it's a degenerate edge case (provider sent headers but
  // no body) and the user has effectively gotten a pre-stream
  // failure. Firing only after this point guarantees the
  // architectural invariant the caller relies on: if
  // `onBodyOpened` fired, the SSE parser is about to run AND the
  // upstream provider has accepted the request. Surrounded in a
  // try/catch because a caller-supplied callback that throws
  // should NOT abort the stream — the caller's gate-update is
  // their problem, not ours.
  if (onBodyOpened) {
    try {
      onBodyOpened();
    } catch {
      // Caller-supplied callback errors are swallowed; see comment.
    }
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
    // Detach the user-cancel forwarder from the user's outer signal.
    // Ownership was transferred to us from `openExternalProviderStream`
    // on the successful body-open; failure to detach here would leak
    // the listener for the lifetime of the user's AbortController
    // (which often outlives the stream because the controller is
    // reused for the next generation in `ipc/model.ts`).
    cleanupBodyForwarder?.();
  }
}
