import type { ExternalProviderTokenUsage } from "../shared/types";

/**
 * Token-usage estimator and cumulative accumulator for the optional
 * external LLM provider.
 *
 * # Why a heuristic (not provider-reported usage)
 *
 * The external-provider streaming surface in Tessera uses SSE
 * deltas (`data: {"choices":[{"delta":{"content":"..."}}]}` for
 * OpenAI-compatible providers; `event: content_block_delta` for
 * Anthropic). Neither delta carries a token count per chunk —
 * authoritative usage info arrives in a different shape:
 *
 *   - **OpenAI**: in a final `chat.completion.chunk` whose
 *     `choices[].finish_reason` is set AND a top-level `usage`
 *     object is included only when the client requests it via
 *     `stream_options: { include_usage: true }`. We deliberately do
 *     NOT set that flag because it isn't supported by every
 *     OpenAI-compatible proxy (Ollama, vLLM, LM Studio, llama-server
 *     OpenAI shim) — turning it on would silently degrade routing
 *     to those providers.
 *   - **Anthropic**: in `message_start` (input tokens) and
 *     `message_delta` (output tokens) events. We currently parse
 *     these as opaque framing tokens and don't extract `usage`.
 *
 * A future PR can wire authoritative usage in — but until then a
 * client-side heuristic gives the user a useful directional signal
 * (e.g. "≈12,450 tokens used since May 23") without forcing every
 * provider through the most-restrictive opt-in feature set.
 *
 * # The heuristic
 *
 * We use the 4-chars-per-token rule of thumb that OpenAI itself
 * publishes for English-prose token estimation
 * (https://platform.openai.com/docs/concepts/tokens). For the
 * non-English / code / structured-JSON cases the heuristic is less
 * accurate (sub-word tokenisers like BPE often emit 1-2 tokens per
 * non-ASCII character, and code/JSON has different token density),
 * but the headline number is still useful as a directional
 * "you've used 10k vs 100k tokens this month" indicator. Users who
 * need authoritative accounting will read it from the provider's
 * billing dashboard.
 *
 * For inputs that contain runs of whitespace, we apply a small
 * correction: pure whitespace is usually a single token (or fewer)
 * regardless of length, so collapsing runs of whitespace before
 * applying the char-per-token divisor avoids overestimating padded
 * prompts.
 */

/**
 * The standard "1 token ≈ 4 chars of English prose" divisor.
 * Exposed as a named constant so future tuning is centralised.
 */
export const CHARS_PER_TOKEN = 4;

/** Minimum token count for any non-empty input. Even a single
 *  character (e.g. `"a"`) costs at least one token — a literal
 *  `Math.ceil(1 / 4) = 1`, but pulling this out as a named constant
 *  documents the floor explicitly. */
const MIN_TOKENS_FOR_NON_EMPTY = 1;

/**
 * Estimate the number of tokens in a piece of text.
 *
 * Returns `0` for the empty string. Returns at least `1` for any
 * non-empty input.
 *
 * The estimator is intentionally simple and deterministic:
 *
 *   1. Normalise the text by collapsing runs of whitespace into
 *      single spaces. Most BPE-style tokenisers (used by OpenAI,
 *      Anthropic, Ollama, llama.cpp) compress whitespace
 *      aggressively, so a 100-char prompt with 50 chars of
 *      whitespace padding shouldn't be billed at 25 tokens.
 *   2. Divide the normalised length by {@link CHARS_PER_TOKEN}
 *      and round up.
 *   3. Floor at 1 token for any non-empty input.
 *
 * This is the same heuristic the OpenAI quick-start docs publish
 * for "ballpark" token estimation, with the whitespace correction
 * being a minor refinement to avoid over-counting padded prompts.
 */
export function estimateTokens(text: string): number {
  if (text.length === 0) return 0;
  // Collapse runs of whitespace to a single space. The empty-string
  // guard above ensures we never reach here with a length-0 input,
  // so the post-normalisation length is also guaranteed > 0.
  const normalised = text.replace(/\s+/g, " ").trim();
  if (normalised.length === 0) {
    // Pure whitespace — still costs a token at most providers
    // (newlines, tabs, indent are tokenised individually in some
    // BPE schemes). Floor at the minimum.
    return MIN_TOKENS_FOR_NON_EMPTY;
  }
  const estimated = Math.ceil(normalised.length / CHARS_PER_TOKEN);
  return Math.max(estimated, MIN_TOKENS_FOR_NON_EMPTY);
}

/**
 * Cumulative token-usage record. Stored verbatim in `AppConfig` as
 * the `externalProviderTokenUsage` field, persisted across
 * launches so the user sees a real "tokens used this month"
 * number rather than a per-session counter that resets on restart.
 *
 * The canonical declaration lives in `apps/desktop/shared/types.ts`
 * so the renderer (typed off `window.tessera.externalProvider`)
 * and the main process see the EXACT same shape — TypeScript's
 * structural typing would gloss over a drift in field names,
 * which would silently break the IPC handshake. Re-exporting from
 * the canonical module here keeps `tokenCounter.ts`'s public API
 * stable while eliminating that drift risk.
 *
 * `lastResetDate` is an ISO-8601 timestamp string (not a `Date`
 * object) so it survives JSON round-trips. The renderer formats it
 * for display via `new Date(lastResetDate).toLocaleDateString()`.
 *
 * The structure deliberately does NOT include per-provider or
 * per-model breakdowns — those would be useful but require a
 * provider-aware accumulator (we'd need to know which provider was
 * active for each call), which is out of scope for this PR. A
 * future enhancement can extend the record without breaking the
 * stored shape via zod's `.catch()` heal-on-load policy in
 * `config.ts`.
 */
export type { ExternalProviderTokenUsage };

/**
 * Construct a fresh, empty usage record with the current
 * timestamp. Used both for first-run initialisation in `config.ts`
 * (`DEFAULT_EXTERNAL_PROVIDER_TOKEN_USAGE`) and for the explicit
 * "Reset counter" button in `SettingsPage`.
 */
export function createEmptyTokenUsage(): ExternalProviderTokenUsage {
  return {
    totalPromptTokens: 0,
    totalCompletionTokens: 0,
    lastResetDate: new Date().toISOString(),
  };
}

/**
 * Combine a previous usage record with a new (prompt, completion)
 * delta, producing the updated record. Pure function — does NOT
 * persist; the caller is responsible for writing the result back to
 * config.
 *
 * `lastResetDate` is preserved from the input record (deltas
 * accumulate against an existing reset timestamp; only the explicit
 * reset action calls {@link createEmptyTokenUsage}).
 */
export function accumulateTokenUsage(
  previous: ExternalProviderTokenUsage,
  delta: { promptTokens: number; completionTokens: number },
): ExternalProviderTokenUsage {
  return {
    totalPromptTokens: previous.totalPromptTokens + delta.promptTokens,
    totalCompletionTokens:
      previous.totalCompletionTokens + delta.completionTokens,
    lastResetDate: previous.lastResetDate,
  };
}
