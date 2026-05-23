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
import { getBridge } from "../appState";
import {
  loadConfig,
  updateConfig,
  DEFAULT_EXTERNAL_PROVIDER,
  type ExternalProviderConfig,
} from "../config";
import { resolveProviderEndpoint } from "../externalProviderStream";
import * as secretsVault from "../secretsVault";
import type { SettingsData } from "../../shared/types";
import {
  ExternalProviderApiKeySchema,
  ExternalProviderConfigSchema,
  SettingsUpdateSchema,
} from "./schemas";

/**
 * Best-effort audit shim for `settings:*` and `externalProvider:*`
 * handlers (Phase 10 / Task 17).
 *
 * Three deliberate properties:
 *
 *   1. **Best-effort.** A failure to append to the audit store
 *      must never prevent the user-visible setting change from
 *      taking effect — the renderer already wrote to the on-disk
 *      JSON via `updateConfig` and forcing an unhandled rejection
 *      back through `idempotentHandle` would surface as a confusing
 *      "settings failed to save" toast in the UI.
 *   2. **No secret leakage.** Callers always pass the audit
 *      *value* as a stringified scalar or as a count of array
 *      elements (see `auditSettingsField` overloads below). We
 *      never log the API key, the API URL contents, or the raw
 *      ignore/watch pattern bodies — only the field name and a
 *      benign value envelope.
 *   3. **Bridge may not be ready.** During the brief window
 *      between IPC registration and bridge init, `getBridge()`
 *      returns `null`. `bridge?.bridgeLogSettingsChanged` then
 *      short-circuits to `undefined` without throwing.
 */
function auditSettingsField(field: string, value: string): void {
  try {
    getBridge()?.bridgeLogSettingsChanged(field, value);
  } catch {
    // best-effort — see doc comment above
  }
}

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
    // Phase 10 / Task 17: emit one audit row per field the renderer
    // actually sent. The schema marks every field optional, so
    // iterating the parsed object's own keys captures exactly the
    // delta the renderer requested. Array fields are logged by
    // length rather than verbatim because the patterns themselves
    // can encode user glob choices that aren't useful in an audit
    // (and the per-pattern length is bounded but the array length
    // bound — 10_000 — would produce a multi-MB log row).
    if (parsed.theme !== undefined) auditSettingsField("theme", parsed.theme);
    if (parsed.defaultExportFormat !== undefined)
      auditSettingsField("defaultExportFormat", parsed.defaultExportFormat);
    if (parsed.ignorePatterns !== undefined)
      auditSettingsField(
        "ignorePatterns",
        `${parsed.ignorePatterns.length} pattern(s)`,
      );
    if (parsed.watchPatterns !== undefined)
      auditSettingsField(
        "watchPatterns",
        `${parsed.watchPatterns.length} pattern(s)`,
      );
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

      // Phase 10 / Task 17: emit one audit row per externalProvider
      // field that's auditable without leaking secrets. The API
      // URL and the API key reference are deliberately NOT logged
      // verbatim — `apiKeyRef` is a stable identifier whose value
      // is implementation detail (it indexes into the OS keychain;
      // logging it would tie the audit row to a specific keychain
      // slot in a way an auditor doesn't need). The API URL
      // contents can include private endpoints, so we log only
      // whether the provider is enabled / what type it is / what
      // model the user picked.
      auditSettingsField(
        "externalProvider.enabled",
        merged.enabled ? "true" : "false",
      );
      auditSettingsField(
        "externalProvider.providerType",
        merged.providerType,
      );
      auditSettingsField("externalProvider.modelName", merged.modelName);
      // The API-key write itself is auditable — whether the user
      // stored, cleared, or left the key alone is a security-
      // relevant transition. Logging the action (store / clear /
      // unchanged) does NOT leak the secret.
      const apiKeyAction =
        parsedApiKey === null
          ? "unchanged"
          : parsedApiKey === ""
            ? "cleared"
            : "stored";
      auditSettingsField("externalProvider.apiKey", apiKeyAction);

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
