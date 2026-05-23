/**
 * IPC handlers for the `settings:*` and `externalProvider:*` channels.
 *
 * Settings (theme, default export format, ignore/watch patterns) live
 * in the on-disk JSON config that survives restarts. External LLM
 * provider settings (URL, model, etc.) live in the same JSON; the
 * actual API key is *referenced* by `apiKeyRef` but stored encrypted
 * in the OS keychain via `secretsVault`.
 */
import { idempotentHandle } from "./register";
import {
  loadConfig,
  updateConfig,
  DEFAULT_EXTERNAL_PROVIDER,
  DEFAULT_EXTERNAL_PROVIDER_TOKEN_USAGE,
  type ExternalProviderConfig,
} from "../config";
import { createEmptyTokenUsage } from "../tokenCounter";
import { resolveProviderEndpoint } from "../externalProviderStream";
import { listExternalProviderModels } from "../externalProviderModels";
import * as secretsVault from "../secretsVault";
import type { SettingsData } from "../../shared/types";
import {
  ExternalProviderApiKeySchema,
  ExternalProviderConfigSchema,
  SettingsUpdateSchema,
} from "./schemas";

/**
 * Issue a minimal request against the configured external LLM provider
 * to verify that the URL is reachable, the API key is accepted, and
 * the model exists. Returns `{ ok: true, latencyMs }` on success and
 * `{ ok: false, error }` on any HTTP-level or network failure.
 *
 * Deliberately kept small (1-token completion) so the test does not
 * burn user budget on actual generation work.
 */
async function testExternalProviderConnection(
  provider: ExternalProviderConfig,
  apiKey: string,
): Promise<{ ok: true; latencyMs: number } | { ok: false; error: string }> {
  const start = Date.now();
  const controller = new AbortController();
  const timeoutMs = Math.max(1, provider.timeoutSecs) * 1000;
  const t = setTimeout(() => controller.abort(), timeoutMs);

  // Use the same endpoint-resolution helper that the streaming path
  // uses (`apps/desktop/electron/externalProviderStream.ts`). Critical
  // so a user who pastes a complete endpoint (e.g.
  // `https://api.openai.com/v1/chat/completions`) into Settings gets
  // a working test instead of a 404 from the double-suffixed URL
  // `…/v1/chat/completions/v1/chat/completions`. The prior version of
  // this function hand-rolled the URL composition and drifted out of
  // sync with `buildStreamRequest` when the streaming path grew the
  // `endsWith` guards.
  const url = resolveProviderEndpoint(provider);
  let headers: Record<string, string>;
  let body: string;

  if (provider.providerType === "anthropic") {
    headers = {
      "Content-Type": "application/json",
      "x-api-key": apiKey,
      "anthropic-version": "2023-06-01",
    };
    body = JSON.stringify({
      model: provider.modelName,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
  } else {
    // OpenAI-compatible (covers OpenAI, Ollama, vLLM, LM Studio, …)
    headers = {
      "Content-Type": "application/json",
      Authorization: `Bearer ${apiKey}`,
    };
    body = JSON.stringify({
      model: provider.modelName,
      max_tokens: 1,
      messages: [{ role: "user", content: "ping" }],
    });
  }

  try {
    const res = await fetch(url, {
      method: "POST",
      headers,
      body,
      signal: controller.signal,
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      return {
        ok: false,
        error: `HTTP ${res.status}${text ? `: ${text.slice(0, 200)}` : ""}`,
      };
    }
    return { ok: true, latencyMs: Date.now() - start };
  } catch (e) {
    if ((e as Error).name === "AbortError") {
      return { ok: false, error: `Timed out after ${provider.timeoutSecs}s` };
    }
    return {
      ok: false,
      error: e instanceof Error ? e.message : String(e),
    };
  } finally {
    clearTimeout(t);
  }
}

export function registerSettingsHandlers(): void {
  idempotentHandle("settings:get", async () => {
    const config = loadConfig();
    return {
      theme: config.theme,
      defaultExportFormat: config.defaultExportFormat,
      ignorePatterns: config.ignorePatterns,
      watchPatterns: config.watchPatterns,
    } as SettingsData;
  });

  idempotentHandle("settings:update", async (_event, settings: unknown) => {
    const parsed = SettingsUpdateSchema.parse(settings);
    // Return value is read from `loadConfig()` *after* the write so the
    // payload the renderer receives reflects what is actually on disk
    // (including any `.catch()` healing or `.loose()` passthrough that
    // happened on the read leg). Returning the pre-write `{...config,
    // ...parsed}` snapshot would diverge from the persisted state if a
    // field had been healed, and would be racy against any concurrent
    // writer.
    updateConfig(parsed);
    const persisted = loadConfig();
    return {
      theme: persisted.theme,
      defaultExportFormat: persisted.defaultExportFormat,
      ignorePatterns: persisted.ignorePatterns,
      watchPatterns: persisted.watchPatterns,
    } as SettingsData;
  });

  idempotentHandle("externalProvider:get", async () => {
    const config = loadConfig();
    const provider = config.externalProvider ?? {
      ...DEFAULT_EXTERNAL_PROVIDER,
    };
    return {
      ...provider,
      hasApiKey: provider.apiKeyRef
        ? secretsVault.hasSecret(provider.apiKeyRef)
        : false,
    };
  });

  idempotentHandle(
    "externalProvider:set",
    async (_event, provider: unknown, apiKey: unknown) => {
      const parsed = ExternalProviderConfigSchema.parse(provider);
      // `apiKey` is validated separately from the provider config
      // because the secret itself lives in the OS keychain, not in the
      // on-disk JSON. The schema bounds the string length so a
      // compromised renderer cannot push an arbitrarily large blob into
      // `secretsVault.storeSecret` below. Tri-state semantics (string /
      // empty-string / null) are documented on the schema definition.
      const parsedApiKey = ExternalProviderApiKeySchema.parse(apiKey);
      // `ExternalProviderConfigSchema` requires every field, so `parsed`
      // is already complete; the default-spread below is defence in
      // depth — if a future schema version makes a field optional, the
      // on-disk config will still carry a deterministic value rather
      // than `undefined` (which would then crash JSON.stringify on the
      // way back out of `loadConfig` or trip the Rust bridge's strict
      // serde deserialization).
      const merged: ExternalProviderConfig = {
        ...DEFAULT_EXTERNAL_PROVIDER,
        ...parsed,
      };
      updateConfig({ externalProvider: merged });

      if (parsedApiKey === null) {
        // null = leave whatever's in the keychain alone.
      } else if (parsedApiKey === "") {
        // empty string = explicitly forget the key.
        secretsVault.deleteSecret(merged.apiKeyRef);
      } else {
        secretsVault.storeSecret(merged.apiKeyRef, parsedApiKey);
      }

      return {
        ...merged,
        hasApiKey: secretsVault.hasSecret(merged.apiKeyRef),
      };
    },
  );

  idempotentHandle("externalProvider:listModels", async () => {
    const config = loadConfig();
    const provider = config.externalProvider;
    if (!provider || !provider.enabled) {
      return { ok: false, kind: "error", error: "External provider is disabled" };
    }
    if (!provider.apiUrl.trim()) {
      return { ok: false, kind: "error", error: "API URL is required" };
    }
    if (!secretsVault.hasSecret(provider.apiKeyRef)) {
      return {
        ok: false,
        kind: "error",
        error: "API key has not been stored",
      };
    }
    const apiKey = secretsVault.getSecret(provider.apiKeyRef);
    if (!apiKey) {
      return {
        ok: false,
        kind: "error",
        error: "API key has not been stored",
      };
    }
    return await listExternalProviderModels(provider, apiKey);
  });

  idempotentHandle("externalProvider:getTokenUsage", async () => {
    const config = loadConfig();
    return (
      config.externalProviderTokenUsage ?? {
        ...DEFAULT_EXTERNAL_PROVIDER_TOKEN_USAGE,
      }
    );
  });

  idempotentHandle("externalProvider:resetTokenUsage", async () => {
    // The reset writes a fresh record with `lastResetDate = now()`
    // so the renderer's "since &lt;date&gt;" label updates
    // immediately after the user clicks the button. The two
    // counters drop to zero; the field is persisted via the same
    // `updateConfig` write-through path settings updates use, so a
    // subsequent main-process crash / kill cannot lose the reset.
    const fresh = createEmptyTokenUsage();
    updateConfig({ externalProviderTokenUsage: fresh });
    return fresh;
  });

  idempotentHandle("externalProvider:test", async () => {
    const config = loadConfig();
    const provider = config.externalProvider;
    if (!provider || !provider.enabled) {
      return { ok: false, error: "External provider is disabled" };
    }
    if (!provider.apiUrl.trim() || !provider.modelName.trim()) {
      return { ok: false, error: "API URL and model name are required" };
    }
    if (!secretsVault.hasSecret(provider.apiKeyRef)) {
      return { ok: false, error: "API key has not been stored" };
    }
    const apiKey = secretsVault.getSecret(provider.apiKeyRef);
    if (!apiKey) {
      return { ok: false, error: "API key has not been stored" };
    }
    try {
      const result = await testExternalProviderConnection(provider, apiKey);
      return result;
    } catch (e) {
      return {
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      };
    }
  });
}
