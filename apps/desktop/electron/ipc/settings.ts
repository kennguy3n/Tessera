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
  type ExternalProviderConfig,
} from "../config";
import * as secretsVault from "../secretsVault";
import type { SettingsData } from "../../shared/types";
import {
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

  let url: string;
  let headers: Record<string, string>;
  let body: string;

  const apiUrl = provider.apiUrl.replace(/\/+$/, "");
  if (provider.providerType === "anthropic") {
    url = `${apiUrl}/v1/messages`;
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
    url = `${apiUrl}/v1/chat/completions`;
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
    const config = loadConfig();
    const updated = {
      ...config,
      ...parsed,
    };
    updateConfig(parsed);
    return {
      theme: updated.theme,
      defaultExportFormat: updated.defaultExportFormat,
      ignorePatterns: updated.ignorePatterns,
      watchPatterns: updated.watchPatterns,
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
      if (apiKey !== null && typeof apiKey !== "string") {
        throw new Error(
          `apiKey must be a string or null (got ${typeof apiKey})`,
        );
      }
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

      if (apiKey === null) {
        // null = leave whatever's in the keychain alone.
      } else if (apiKey === "") {
        // empty string = explicitly forget the key.
        secretsVault.deleteSecret(merged.apiKeyRef);
      } else {
        secretsVault.storeSecret(merged.apiKeyRef, apiKey);
      }

      return {
        ...merged,
        hasApiKey: secretsVault.hasSecret(merged.apiKeyRef),
      };
    },
  );

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
