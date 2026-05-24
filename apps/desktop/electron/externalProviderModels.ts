/**
 * `GET /v1/models` listing for the optional external LLM provider.
 *
 * The OpenAI Models API response shape (also implemented by Ollama,
 * vLLM, LM Studio, llama-server's OpenAI shim, and most "OpenAI
 * compatible" custom proxies) is:
 *
 *   {
 *     "object": "list",
 *     "data": [
 *       { "id": "gpt-4o-mini", "object": "model", "created": …, "owned_by": "…" },
 *       …
 *     ]
 *   }
 *
 * We only extract `data[*].id`. The other fields vary across
 * providers (Ollama emits `name` AND `id`, some custom shims emit
 * neither `created` nor `owned_by`) and are not surfaced in the
 * renderer dropdown.
 *
 * Anthropic does NOT have a `/v1/models` endpoint — the helper
 * returns `kind: "unsupported"` for that provider type so the UI
 * can gracefully fall back to a manual text input. This decision is
 * made by `resolveProviderModelsEndpoint` in
 * `externalProviderStream.ts` returning `null`.
 */
import type { ExternalProviderConfig } from "./config";
import type { ExternalProviderListModelsResult } from "../shared/types";
import { resolveProviderModelsEndpoint } from "./externalProviderStream";

/**
 * Shape of a `data[]` entry in the OpenAI `/v1/models` response.
 * We accept ANY object that has an `id: string`, because some
 * self-hosted shims add or drop sibling fields. The narrow
 * interface here documents what we actually USE.
 */
interface OpenAiModelsListResponse {
  data?: Array<{ id?: unknown }>;
}

/**
 * Fetch the available model ids from the configured provider.
 *
 * Returns:
 * - `{ ok: true, models }` with at least one entry on success
 *   (deduped + sorted alphabetically for stable display).
 * - `{ ok: false, kind: "unsupported" }` for Anthropic providers
 *   (no `/v1/models` endpoint).
 * - `{ ok: false, kind: "error", error }` for transport / HTTP /
 *   parse failures.
 *
 * The `apiKey` is the cleartext value retrieved from
 * `secretsVault` by the IPC handler. Anthropic providers never
 * reach the HTTP call because the unsupported branch returns
 * first — but we still require the parameter for type-uniformity
 * with the streaming call.
 *
 * Timeout: 10 seconds (`AbortController.abort()` from `setTimeout`).
 * This is shorter than the streaming timeout because a model list
 * should resolve in well under a second; ten seconds is a generous
 * upper bound that still gives the UI an interactive feel.
 */
export async function listExternalProviderModels(
  provider: ExternalProviderConfig,
  apiKey: string,
): Promise<ExternalProviderListModelsResult> {
  const url = resolveProviderModelsEndpoint(provider);
  if (url === null) {
    return { ok: false, kind: "unsupported" };
  }
  const controller = new AbortController();
  // The streaming endpoint uses the provider's configured timeout;
  // we deliberately use a shorter fixed timeout here because a
  // model-list call should resolve in well under a second.
  const timeoutMs = 10_000;
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const res = await fetch(url, {
      method: "GET",
      headers: {
        Authorization: `Bearer ${apiKey}`,
        Accept: "application/json",
      },
      signal: controller.signal,
    });
    if (!res.ok) {
      const bodyPreview = await res.text().catch(() => "");
      return {
        ok: false,
        kind: "error",
        error: `HTTP ${res.status}${bodyPreview ? `: ${bodyPreview.slice(0, 200)}` : ""}`,
      };
    }
    const parsed = (await res.json()) as OpenAiModelsListResponse;
    if (!parsed || !Array.isArray(parsed.data)) {
      return {
        ok: false,
        kind: "error",
        error: "Models endpoint returned an unexpected response shape",
      };
    }
    const ids = parsed.data
      .map((m) => (typeof m?.id === "string" ? m.id : null))
      .filter((id): id is string => id !== null && id.length > 0);
    if (ids.length === 0) {
      return {
        ok: false,
        kind: "error",
        error: "Models endpoint returned an empty list",
      };
    }
    // De-dupe and sort for stable display. `Set` preserves insertion
    // order, so the subsequent `.sort()` is the only ordering signal
    // that matters.
    const deduped = Array.from(new Set(ids)).sort((a, b) =>
      a.localeCompare(b),
    );
    return { ok: true, models: deduped };
  } catch (e) {
    // `e` is `unknown` from a fetch reject: could be AbortError
    // (timeout fired), TypeError (DNS / TLS failure), or any
    // platform-specific error. Surface the message so the UI can
    // show a useful diagnostic.
    const msg =
      e instanceof Error ? e.message : String(e ?? "Unknown error");
    if (e instanceof DOMException && e.name === "AbortError") {
      return {
        ok: false,
        kind: "error",
        error: `Models endpoint timed out after ${Math.round(timeoutMs / 1000)}s`,
      };
    }
    return { ok: false, kind: "error", error: msg };
  } finally {
    clearTimeout(timer);
  }
}
