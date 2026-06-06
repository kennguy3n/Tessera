/**
 * IPC handlers for the `settings:*` and `externalProvider:*` channels.
 *
 * Settings (theme, default export format, ignore/watch patterns) live
 * in the on-disk JSON config that survives restarts. External LLM
 * provider settings (URL, model, etc.) live in the same JSON; the
 * actual API key is *referenced* by `apiKeyRef` but stored encrypted
 * in the OS keychain via `secretsVault`.
 */
import { app } from "electron";
import { idempotentHandle } from "./register";
import { getBridge } from "../appState";
import {
  loadConfig,
  updateConfig,
  DEFAULT_EXTERNAL_PROVIDER,
  DEFAULT_EXTERNAL_PROVIDER_TOKEN_USAGE,
  DEFAULT_HYBRID_SEARCH_CONFIG,
  type ExternalProviderConfig,
  type HybridSearchConfigPersisted,
} from "../config";
import { createEmptyTokenUsage } from "../tokenCounter";
import { resolveProviderEndpoint } from "../externalProviderStream";
import { listExternalProviderModels } from "../externalProviderModels";
import * as secretsVault from "../secretsVault";
import {
  enableTelemetry,
  disableTelemetry,
} from "../telemetrySink";
import { hasPinSet, hasFido2Set, clearPin } from "../appLock";
import { getLogger } from "../logger";
import type {
  EmbeddingDownloadProgressInfo,
  EmbeddingModelInfo,
  EmbeddingModelStatusInfo,
  ExternalProviderListModelsDraftOverrides,
  HybridSearchConfigInfo,
  HybridSearchConfigUpdate,
  SettingsData,
} from "../../shared/types";
import { EXTERNAL_PROVIDER_TYPES } from "../../shared/types";
import {
  DownloadableEmbeddingModelSlugInputSchema,
  EmbeddingModelSlugInputSchema,
  ExternalProviderApiKeySchema,
  ExternalProviderConfigSchema,
  HybridSearchConfigUpdateSchema,
  SettingsUpdateSchema,
} from "./schemas";
import { defaultRateLimiter, RATE_LIMIT_PROFILES } from "./rateLimiter";

/**
 * resolve the per-user `userData` directory the
 * bridge stores ONNX models under (`{userData}/models/onnx/<slug>/`).
 *
 * Centralised here so the three embedding-model IPC handlers stay in
 * agreement and so the `app.getPath` call lives on the Electron
 * main process side (the bridge is a pure Rust library with no
 * Electron dependency). A test override is provided to keep the
 * Vitest IPC suite hermetic — tests can stub this without
 * monkey-patching the electron `app` module.
 */
let userDataDirOverride: (() => string) | null = null;
export function setUserDataDirForTest(fn: (() => string) | null): void {
  userDataDirOverride = fn;
}
function userDataDir(): string {
  if (userDataDirOverride) return userDataDirOverride();
  return app.getPath("userData");
}

/**
 * audit shim for embedding-model lifecycle events.
 * We surface model downloads and switches as their own audit field
 * (`embeddingModel.{download|switch}`) so an operator can answer
 * "when did the user enable the multilingual model?" with a single
 * `WHERE field LIKE 'embeddingModel.%'` query, just like the hybrid
 * search config audit rows above.
 */
function auditEmbeddingModelEvent(action: string, slug: string): void {
  try {
    getBridge()?.bridgeLogSettingsChanged(`embeddingModel.${action}`, slug);
  } catch {
    // best-effort, see auditSettingsField doc comment
  }
}

const IDLE_DOWNLOAD: EmbeddingDownloadProgressInfo = {
  status: "idle",
  slug: null,
  bytesTotal: null,
  bytesDownloaded: 0,
  lastError: null,
};

/**
 * Best-effort audit shim for `settings:*` and `externalProvider:*`
 * handlers (the audit code).
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

/**
 * Best-effort parser for the optional `draft overrides` payload sent
 * by the renderer's "List models" button. Unknown fields, wrong
 * types, and missing fields are all silently dropped — the caller
 * merges the resulting partial against the persisted config.
 *
 * Validation rules:
 *   - `apiUrl`: must be a string (we accept any string here because
 *     the same trim/empty/format-check runs downstream in the
 *     handler and in `resolveProviderModelsEndpoint`).
 *   - `providerType`: must be one of `EXTERNAL_PROVIDER_TYPES`.
 *     Unrecognised types are dropped, NOT rejected — this lets a
 *     newer renderer (with a future provider type the main process
 *     doesn't know about) degrade gracefully rather than failing
 *     the whole list-models call.
 *   - `enabled`: must be a boolean. Lets a user who has just
 *     toggled the provider on in the form (without saving) still
 *     successfully list models — the handler gates on the EFFECTIVE
 *     `enabled` after merging overrides atop the persisted config.
 *     The handler previously gated on the PERSISTED `enabled` flag
 *     only, so fresh-enable + List would fail with "External
 *     provider is disabled" even though the form clearly intended
 *     otherwise.
 */
export function parseListModelsOverrides(
  raw: unknown,
): ExternalProviderListModelsDraftOverrides {
  if (raw === null || typeof raw !== "object") return {};
  const obj = raw as Record<string, unknown>;
  const out: ExternalProviderListModelsDraftOverrides = {};
  if (typeof obj.apiUrl === "string") {
    out.apiUrl = obj.apiUrl;
  }
  if (
    typeof obj.providerType === "string" &&
    (EXTERNAL_PROVIDER_TYPES as readonly string[]).includes(obj.providerType)
  ) {
    out.providerType =
      obj.providerType as ExternalProviderListModelsDraftOverrides["providerType"];
  }
  if (typeof obj.enabled === "boolean") {
    out.enabled = obj.enabled;
  }
  return out;
}

export function registerSettingsHandlers(): void {
  idempotentHandle("settings:get", async () => {
    const config = loadConfig();
    return {
      theme: config.theme,
      defaultExportFormat: config.defaultExportFormat,
      ignorePatterns: config.ignorePatterns,
      watchPatterns: config.watchPatterns,
      // surface the first-run onboarding flag to
      // the renderer so `OnboardingWizard` can decide whether to
      // mount itself.
      onboardingCompleted: config.onboardingCompleted,
      // Persisted favorites + view-recency.
      // The renderer fans these out to the command palette, the
      // sidebar Pinned section, and the editor PinButton via
      // `usePinnedArtifacts` / `useRecentlyViewedArtifacts`. Empty
      // arrays are surfaced explicitly (vs. `undefined`) so the
      // renderer's `?? []` paths can be removed and the shape is
      // unambiguous in tests.
      pinnedArtifactIds: config.pinnedArtifactIds,
      recentArtifactIds: config.recentArtifactIds,
      // surface the persisted model idle-unload
      // window so `SettingsPage` can hydrate the select. The value is
      // already validated by the on-disk schema (`.catch(...)`-healed
      // to `DEFAULT_MODEL_IDLE_TIMEOUT_SECS` if corrupted) so a fresh
      // install or healed config sees a usable bucket on first render.
      modelIdleTimeoutSecs: config.modelIdleTimeoutSecs,
      // Task 7/9/10: surface the security flags so
      // the renderer Settings UI can render the corresponding
      // toggles. The on-disk schema heals all three to safe
      // defaults if corrupted (`telemetryEnabled: false`,
      // `appLockMode: "off"`, `enforceUpdateSignature: true`).
      telemetryEnabled: config.telemetryEnabled,
      appLockMode: config.appLockMode,
      enforceUpdateSignature: config.enforceUpdateSignature,
      enforceKeychainAcl: config.enforceKeychainAcl,
    } as SettingsData;
  });

  idempotentHandle("settings:update", async (_event, settings: unknown) => {
    const parsed = SettingsUpdateSchema.parse(settings);
    // enforce the lock-mode/PIN invariant
    // documented in `shared/types.ts` and `config.ts`: flipping
    // `appLockMode` to `"pin"` or `"biometric"` without first
    // setting a PIN would leave the user staring at a lock overlay
    // they cannot dismiss. Reject at the IPC boundary BEFORE
    // `updateConfig` so the persisted state stays consistent. The
    // renderer's Settings UI MUST set up a PIN via `appLock:setPin`
    // before flipping the mode.
    if (
      (parsed.appLockMode === "pin" ||
        parsed.appLockMode === "biometric" ||
        parsed.appLockMode === "fido2") &&
      !hasPinSet()
    ) {
      throw new Error(
        `Cannot set appLockMode to "${parsed.appLockMode}" without a PIN. Call appLock:setPin first.`,
      );
    }
    // `"fido2"` additionally requires a registered authenticator —
    // flipping to it without one would render the lock overlay's
    // FIDO2 prompt unusable (the renderer would have to immediately
    // fall back to PIN every launch). Force the user to register a
    // credential via `appLock:registerFido2` first.
    if (parsed.appLockMode === "fido2" && !hasFido2Set()) {
      throw new Error(
        'Cannot set appLockMode to "fido2" without a registered security key. Call appLock:registerFido2 first.',
      );
    }
    // Return value is read from `loadConfig()` *after* the write so the
    // payload the renderer receives reflects what is actually on disk
    // (including any `.catch()` healing or `.loose()` passthrough that
    // happened on the read leg). Returning the pre-write `{...config,
    // ...parsed}` snapshot would diverge from the persisted state if a
    // field had been healed, and would be racy against any concurrent
    // writer.
    updateConfig(parsed);
    // when the user explicitly opts OUT
    // of app lock (mode -> "off"), the stored PIN material is also
    // removed. This keeps the PIN-lifecycle and mode-lifecycle in
    // lock-step: "off" means zero retained credentials, not "PIN
    // still on disk waiting to be re-enabled". The threat model is
    // explicit in `appLock.ts:46-49` ("switching to `off` does
    // delete the PIN") and this is the only path that guarantees
    // it for users who toggle from the Settings UI. The symmetric
    // `appLock:removePin` handler does the reverse: clears PIN +
    // forces mode to "off".
    if (parsed.appLockMode === "off" && hasPinSet()) {
      try {
        clearPin();
      } catch (err) {
        // best-effort — the mode is already persisted as "off" so
        // the user will not see the lock; the stored PIN is dead
        // weight. Log so a support trail exists.
        getLogger().warn("app_lock.clear_pin_on_off_failed", {
          err: err instanceof Error ? err.message : String(err),
        });
      }
    }
    const persisted = loadConfig();
    // emit one audit row per field the renderer
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
    if (parsed.onboardingCompleted !== undefined)
      auditSettingsField(
        "onboardingCompleted",
        String(parsed.onboardingCompleted),
      );
    // Log delta-by-length for the same reason
    // ignorePatterns / watchPatterns are logged by length — the
    // IDs themselves aren't useful in an audit, but the
    // "user added/removed a pin" or "user viewed 5 new artifacts
    // since last write" event is. The cap is bounded (256 / 32)
    // so this is always one short string per write.
    if (parsed.pinnedArtifactIds !== undefined)
      auditSettingsField(
        "pinnedArtifactIds",
        `${parsed.pinnedArtifactIds.length} pin(s)`,
      );
    if (parsed.recentArtifactIds !== undefined)
      auditSettingsField(
        "recentArtifactIds",
        `${parsed.recentArtifactIds.length} entry(ies)`,
      );
    if (parsed.modelIdleTimeoutSecs !== undefined) {
      auditSettingsField(
        "modelIdleTimeoutSecs",
        String(parsed.modelIdleTimeoutSecs),
      );
      // push the new window to every live
      // sidecar so the change takes effect immediately, even if the
      // user has a model loaded mid-session. Imported here rather
      // than statically at the top so test files that mock
      // `../appState` keep working without forcing every other
      // settings handler test to also stub `getDiffusionSidecar` /
      // `getVisionSidecar`. Errors are swallowed: a sidecar that
      // hasn't been initialised (fresh install with no models) or
      // that fails to update its timer is not worth blocking the
      // settings write — the next sidecar `start()` will read the
      // updated config value.
      try {
        const { applyModelIdleTimeoutToSidecars } = await import(
          "../appState"
        );
        applyModelIdleTimeoutToSidecars(parsed.modelIdleTimeoutSecs);
      } catch (err) {
        console.warn(
          "[Tessera] Failed to apply modelIdleTimeoutSecs to live sidecars:",
          err,
        );
      }
    }
    // telemetry toggle. Apply the new
    // state to the live sink BEFORE auditing so a failed audit
    // doesn't leave the sink half-enabled. The persisted-config
    // read above already reflects the new on-disk value, so the
    // next `loadConfig()` (at startup) would re-init from the
    // same source of truth.
    if (parsed.telemetryEnabled !== undefined) {
      if (parsed.telemetryEnabled) {
        enableTelemetry();
      } else {
        disableTelemetry();
      }
      auditSettingsField(
        "telemetryEnabled",
        String(parsed.telemetryEnabled),
      );
    }
    // app-lock mode change. The actual
    // PIN / biometric setup happens via dedicated `appLock:*`
    // handlers; here we only record the user's mode preference.
    if (parsed.appLockMode !== undefined)
      auditSettingsField("appLockMode", parsed.appLockMode);
    // updater signature enforcement
    // toggle. The auto-updater reads this on every download to
    // decide whether to gate `quitAndInstall` on a successful
    // Ed25519 verify.
    if (parsed.enforceUpdateSignature !== undefined)
      auditSettingsField(
        "enforceUpdateSignature",
        String(parsed.enforceUpdateSignature),
      );
    // Per-app keychain ACL enforcement toggle. The next call to
    // `vaultCrypto.encryptForVault` reads this via `loadConfig()` to
    // decide whether to refuse writes under `basic_text`. Flipping to
    // `false` on Linux materially weakens at-rest protection, hence
    // the audit-log entry.
    if (parsed.enforceKeychainAcl !== undefined)
      auditSettingsField(
        "enforceKeychainAcl",
        String(parsed.enforceKeychainAcl),
      );
    return {
      theme: persisted.theme,
      defaultExportFormat: persisted.defaultExportFormat,
      ignorePatterns: persisted.ignorePatterns,
      watchPatterns: persisted.watchPatterns,
      onboardingCompleted: persisted.onboardingCompleted,
      pinnedArtifactIds: persisted.pinnedArtifactIds,
      recentArtifactIds: persisted.recentArtifactIds,
      modelIdleTimeoutSecs: persisted.modelIdleTimeoutSecs,
      telemetryEnabled: persisted.telemetryEnabled,
      appLockMode: persisted.appLockMode,
      enforceUpdateSignature: persisted.enforceUpdateSignature,
      enforceKeychainAcl: persisted.enforceKeychainAcl,
    } as SettingsData;
  });

  // Note: the `telemetry:*` event-pumping IPCs (getEvents /
  // getPersistedEvents / recordCounter) live in
  // `ipc/telemetry.ts` under `registerTelemetryHandlers` so the
  // domain has a dedicated module like every other IPC area in
  // the codebase. The `telemetryEnabled` *toggle* still flows
  // through `settings:update` above because it's a persisted
  // config field, not an event channel — that's why
  // `enableTelemetry` / `disableTelemetry` are still imported
  // from `telemetrySink` here.

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

      // emit one audit row per externalProvider
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

  idempotentHandle(
    "externalProvider:listModels",
    // Accept an optional draft-overrides payload so the renderer's
    // "List models" button works against the user's IN-FLIGHT
    // form state — not the last-saved on-disk config. Without
    // this, a user who pasted a new `apiUrl` (or switched
    // `providerType` between openai_compatible and anthropic)
    // would see the model list for the OLD provider, even though
    // the form they're looking at points elsewhere. The override
    // payload closes that mismatch.
    //
    // The API key is intentionally NOT part of the overrides
    // payload — we keep secrets out of IPC payloads as a hard
    // rule. To list models against a NEW API key, the user must
    // save the key first (the form distinguishes "set a new key"
    // from "clear the key"); the listing then proceeds against
    // the persisted vault entry.
    async (_evt, rawOverrides?: unknown) => {
      // Top-level try/catch so the handler ALWAYS returns a
      // well-formed `ExternalProviderListModelsResult` rather than
      // rejecting the IPC invoke. Without this guard, a thrown
      // exception from `secretsVault.getSecret` (vault file
      // corruption, keyring reset on Linux, OS-level decryption
      // failure) would surface in the renderer as an unhandled
      // promise rejection — the same defense-in-depth pattern the
      // sibling `externalProvider:test` handler uses.
      try {
        // Rate-limit BEFORE any vault / config read so a flood of
        // List-Models calls can't (a) hammer the OS keychain, (b)
        // burn open-fd budget on the config file, or (c) trip
        // upstream per-IP throttling at the provider with the
        // user's authenticated key. Matches the sibling outbound-
        // network handlers (`connectors:authenticate`,
        // `connectors:sync`, `runtime:downloadModel`) which all
        // consume() at the head of their bodies. The rate-limit
        // error is caught by the surrounding try/catch and surfaced
        // to the renderer as `kind: error, error: <message>`,
        // matching the shape every other failure path on this
        // handler returns.
        defaultRateLimiter.consume(
          "externalProvider:listModels",
          RATE_LIMIT_PROFILES["externalProvider:listModels"],
        );
        const config = loadConfig();
        const baseProvider = config.externalProvider;
        // Defer the enabled-state check until AFTER overrides are
        // merged. A user who just toggled the provider on in the
        // form (without saving) should still be able to list models
        // — the form's draft `enabled` is what reflects their
        // intent, not the last-saved value. We only reject
        // outright here if the provider record itself is missing
        // (i.e. the user has never configured an external provider
        // at all), in which case the override could not possibly
        // provide enough state to proceed: no `apiKeyRef`, no
        // `apiUrl` field shape, nothing for the vault lookup
        // below to key off. The post-merge check at line ~370
        // handles the enabled-toggle gate.
        if (!baseProvider) {
          return {
            ok: false,
            kind: "error",
            error: "External provider is not configured",
          };
        }

        // Validate overrides defensively — the renderer is trusted
        // but we never want a malformed payload to crash the
        // handler. Untrusted-shape fields are dropped silently and
        // the persisted value is used as-is for that field.
        const overrides = parseListModelsOverrides(rawOverrides);
        const provider: ExternalProviderConfig = {
          ...baseProvider,
          ...(overrides.apiUrl !== undefined
            ? { apiUrl: overrides.apiUrl }
            : {}),
          ...(overrides.providerType !== undefined
            ? { providerType: overrides.providerType }
            : {}),
          ...(overrides.enabled !== undefined
            ? { enabled: overrides.enabled }
            : {}),
        };

        // Gate on the EFFECTIVE enabled flag (overrides merged
        // atop persisted) — the form's draft `enabled` now
        // reflects the user's intent for the listing call,
        // matching what the renderer's button-enabled gate checks.
        if (!provider.enabled) {
          return {
            ok: false,
            kind: "error",
            error: "External provider is disabled",
          };
        }

        if (!provider.apiUrl.trim()) {
          return {
            ok: false,
            kind: "error",
            error: "API URL is required",
          };
        }
        // The API key is always looked up against the PERSISTED
        // `apiKeyRef` — this is what enforces the "no plaintext keys
        // over IPC" invariant noted above.
        if (!secretsVault.hasSecret(baseProvider.apiKeyRef)) {
          return {
            ok: false,
            kind: "error",
            error: "API key has not been stored",
          };
        }
        const apiKey = secretsVault.getSecret(baseProvider.apiKeyRef);
        if (!apiKey) {
          return {
            ok: false,
            kind: "error",
            error: "API key has not been stored",
          };
        }
        return await listExternalProviderModels(provider, apiKey);
      } catch (err) {
        return {
          ok: false,
          kind: "error",
          error: err instanceof Error ? err.message : String(err),
        };
      }
    },
  );

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

  // ----- Hybrid retrieval config -----
  //
  // Three-way coherence: (1) the persisted JSON on disk
  // (`config.hybridSearchConfig`), (2) the live `HybridSearchConfig`
  // in the Rust `SourceManager` (mutable via
  // `bridge_update_hybrid_search_config`), and (3) the renderer's
  // form state (echoes whatever the bridge returns).
  //
  // The bridge is the source of truth at runtime — it owns the
  // validation, the live state used by every search call, and the
  // mutex around updates. We persist its effective state back to
  // disk after every update so a restart replays the user's choices
  // through `replayPersistedHybridSearchConfigToBridge` below.
  idempotentHandle("settings:getHybridSearchConfig", async () => {
    const bridge = getBridge();
    if (bridge) {
      // Bridge wins — its in-memory state is the source of truth at
      // runtime. The renderer should see exactly what the search
      // engine will use.
      return bridge.bridgeGetHybridSearchConfig();
    }
    // Pre-bridge fallback so the Settings page renders without
    // throwing during the brief startup window where the bridge is
    // still initialising. The values come from disk so they're
    // user-meaningful (vs. all-zeros placeholders).
    return persistedToInfo(loadConfig().hybridSearchConfig);
  });

  idempotentHandle(
    "settings:updateHybridSearchConfig",
    async (_event, update: unknown) => {
      defaultRateLimiter.consume(
        "settings:updateHybridSearchConfig",
        RATE_LIMIT_PROFILES["settings:updateHybridSearchConfig"],
      );
      const parsed = HybridSearchConfigUpdateSchema.parse(update);
      const bridge = getBridge();
      if (!bridge) {
        throw new Error("Native bridge not available");
      }
      // The bridge returns the new effective config (post-validation),
      // including any clamping the Rust side applied. Persist *that*
      // to disk — not `parsed` — so the disk shape always equals what
      // the live engine is using. Persistence happens before we
      // return so a crash between the bridge update and the disk
      // write is recoverable (next launch will re-read whatever we
      // managed to commit to disk).
      const effective: HybridSearchConfigInfo =
        bridge.bridgeUpdateHybridSearchConfig(parsed as HybridSearchConfigUpdate);
      updateConfig({ hybridSearchConfig: infoToPersisted(effective) });
      // hybrid retrieval is part of the user's
      // surface for tuning *what their data is searched for*, so a
      // change here is security-relevant in the same way a change
      // to `ignorePatterns` or `theme` is. We audit the EFFECTIVE
      // (post-clamp) values returned by the bridge — not the raw
      // user input — so the audit row reflects what the live
      // engine is actually using. Auditing here keeps every
      // settings-mutating IPC channel observable.
      //
      // Each field is logged as its own row so an operator's audit
      // query (`WHERE field LIKE 'hybridSearch.%'`) can attribute
      // a specific change to a specific timestamp without parsing
      // a composite value blob. Numbers are stringified to match
      // the `bridgeLogSettingsChanged(field, value)` contract;
      // booleans are normalised to `"true"` / `"false"` and the
      // `null` half-life (decay disabled) becomes the literal
      // `"disabled"` so the audit row is unambiguous.
      auditSettingsField(
        "hybridSearch.bm25Weight",
        String(effective.bm25Weight),
      );
      auditSettingsField(
        "hybridSearch.vectorWeight",
        String(effective.vectorWeight),
      );
      auditSettingsField("hybridSearch.rrfK", String(effective.rrfK));
      auditSettingsField(
        "hybridSearch.recencyDecayEnabled",
        effective.recencyDecayEnabled ? "true" : "false",
      );
      auditSettingsField(
        "hybridSearch.recencyHalflifeSecs",
        effective.recencyHalflifeSecs === null
          ? "disabled"
          : String(effective.recencyHalflifeSecs),
      );
      // `candidatePoolSize` is the size of the BM25+vector candidate
      // pool the engine retrieves before RRF fusion. It is a mutable
      // search-tuning parameter that ships in `HybridSearchConfigInfo`
      // alongside the other five tracked fields, so omitting it here
      // would break the contract documented above ("Each field is
      // logged as its own row").
      auditSettingsField(
        "hybridSearch.candidatePoolSize",
        String(effective.candidatePoolSize),
      );
      return effective;
    },
  );

  // =====================================================================
  // ONNX embedding-model lifecycle.
  //
  // Three channels mirror the bridge exports defined in
  // `crates/tessera_bridge/src/napi_exports.rs`:
  //
  //   * `settings:getEmbeddingModelStatus` — read-only snapshot of
  //     the catalogue + per-model install state + active model_id +
  //     in-flight download state. Polled by the Settings UI to
  //     render the picker and (during a download) the progress bar.
  //
  //   * `settings:downloadEmbeddingModel` — async; resolves when
  //     the requested model's `.onnx` + `tokenizer.json` are on
  //     disk with the pinned SHA-256. Idempotent on a fully-
  //     installed model.
  //
  //   * `settings:switchEmbeddingModel` — synchronously activates
  //     a downloaded model AND chains a `bridgeBackfillEmbeddings`
  //     call so existing chunks get the new model's vectors. The
  //     backfill runs through the same progress tracker the
  //     SourceDetailPage already polls, so the Settings UI's
  //     "switching…" spinner can defer to the existing embedding
  //     progress banner once the swap returns.
  //
  // The renderer never receives push events for downloads — it
  // polls `settings:getEmbeddingDownloadProgress`. That's the same
  // architecture as `sources:getEmbeddingProgress` and avoids any
  // `ThreadsafeFunction` complexity at the napi boundary.
  // =====================================================================

  idempotentHandle(
    "settings:getEmbeddingModelStatus",
    async (): Promise<EmbeddingModelStatusInfo> => {
      const bridge = getBridge();
      if (bridge) {
        return bridge.bridgeGetEmbeddingModelStatus(userDataDir());
      }
      // Pre-bridge fallback so the Settings page renders without
      // throwing during the brief startup window. The UI shows
      // every model as "not installed" until the bridge wakes up
      // and replaces this snapshot, which is the conservative
      // truth — we genuinely don't know what's on disk until the
      // registry's SHA-256 verifier runs.
      return {
        currentModelId: null,
        models: [],
        download: IDLE_DOWNLOAD,
        nonAsciiChunks: 0,
        totalChunks: 0,
      };
    },
  );

  idempotentHandle(
    "settings:getEmbeddingDownloadProgress",
    async (): Promise<EmbeddingDownloadProgressInfo> => {
      const bridge = getBridge();
      if (bridge) {
        return bridge.bridgeGetEmbeddingDownloadProgress();
      }
      return IDLE_DOWNLOAD;
    },
  );

  idempotentHandle(
    "settings:downloadEmbeddingModel",
    async (_event, input: unknown): Promise<EmbeddingModelInfo> => {
      defaultRateLimiter.consume(
        "settings:downloadEmbeddingModel",
        RATE_LIMIT_PROFILES["settings:downloadEmbeddingModel"],
      );
      const { slug } = DownloadableEmbeddingModelSlugInputSchema.parse(input);
      const bridge = getBridge();
      if (!bridge) {
        throw new Error("Native bridge not available");
      }
      const info = await bridge.bridgeDownloadEmbeddingModel(
        slug,
        userDataDir(),
      );
      // Audit AFTER success so a failed download (network blip,
      // SHA-256 mismatch) doesn't leave a phantom "downloaded" row
      // in the audit log. Matches the contract for hybrid search
      // config above and every other settings-mutating channel.
      auditEmbeddingModelEvent("download", slug);
      return info;
    },
  );

  idempotentHandle(
    "settings:switchEmbeddingModel",
    async (_event, input: unknown): Promise<EmbeddingModelInfo> => {
      defaultRateLimiter.consume(
        "settings:switchEmbeddingModel",
        RATE_LIMIT_PROFILES["settings:switchEmbeddingModel"],
      );
      const { slug } = EmbeddingModelSlugInputSchema.parse(input);
      const bridge = getBridge();
      if (!bridge) {
        throw new Error("Native bridge not available");
      }
      const info = bridge.bridgeSwitchEmbeddingModel(slug, userDataDir());
      auditEmbeddingModelEvent("switch", slug);
      // Fire-and-forget backfill so the existing chunks get the
      // new model's vectors. We deliberately do NOT await — the
      // backfill can take minutes on a large corpus, and the
      // renderer already has an `useEmbeddingProgress` hook
      // polling `sources:getEmbeddingProgress` that renders the
      // progress banner identically whether the backfill was
      // triggered from the SourceDetailPage's Re-embed button or
      // from here. Awaiting would block the Settings UI's
      // "switching…" spinner for the same wall time and offer no
      // additional information to the user. Errors from the
      // backfill surface through that same progress channel.
      void bridge
        .bridgeBackfillEmbeddings(null)
        .catch(() => {
          // Swallowed; the progress tracker captures the error
          // and the renderer's banner renders it. Logging here
          // would just duplicate the audit row the bridge already
          // produces.
        });
      return info;
    },
  );

  idempotentHandle("externalProvider:test", async () => {
    // Wrap the entire handler body in try/catch so the rate-limit
    // gate (which throws `RateLimitError`) and any unexpected
    // failure are surfaced as the typed `{ ok: false, error }`
    // shape the renderer expects. This matches the
    // `externalProvider:listModels` handler's posture and closes
    // a parallel gap: the test handler makes the same kind
    // of outbound HTTPS call as listModels (and arguably a more
    // expensive one — chat completion vs. discovery) yet had no
    // rate-limit gate, so leaving it ungated while limiting
    // listModels would invert the protection priority.
    try {
      // Rate-limit BEFORE any vault / config read so a flood of
      // Test calls can't (a) hammer the OS keychain, (b) burn
      // open-fd budget on the config file, or (c) trip upstream
      // per-IP throttling at the provider with the user's
      // authenticated key. Same posture as listModels (added in
      // this PR commit `4f6dacf`).
      defaultRateLimiter.consume(
        "externalProvider:test",
        RATE_LIMIT_PROFILES["externalProvider:test"],
      );
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

// ---- Hybrid retrieval config — disk ↔ bridge translation helpers ----
//
// The disk uses `recencyDecayEnabled: boolean + recencyHalflifeSecs:
// number` (a number is always present, even when decay is disabled,
// because JSON cannot represent the `Infinity` sentinel the Rust side
// uses). The bridge surfaces the same disabled state as
// `recencyDecayEnabled: false + recencyHalflifeSecs: null`. The two
// helpers below keep that translation in one place so the IPC handlers
// can ignore the distinction.

function persistedToInfo(
  p: HybridSearchConfigPersisted,
): HybridSearchConfigInfo {
  return {
    bm25Weight: p.bm25Weight,
    vectorWeight: p.vectorWeight,
    rrfK: p.rrfK,
    recencyDecayEnabled: p.recencyDecayEnabled,
    recencyHalflifeSecs: p.recencyDecayEnabled ? p.recencyHalflifeSecs : null,
    candidatePoolSize: p.candidatePoolSize,
  };
}

function infoToPersisted(
  info: HybridSearchConfigInfo,
): HybridSearchConfigPersisted {
  // When decay is disabled the bridge sets `recencyHalflifeSecs` to
  // null. We need a number on disk (because zod's `.finite().min(1)`
  // would reject null), so we keep the user's previously-persisted
  // halflife if available, otherwise fall back to the documented
  // 30-day default. This means a user who toggles decay off and then
  // back on without changing the halflife sees their original value
  // restored.
  let halflife = info.recencyHalflifeSecs;
  if (halflife === null) {
    const prior = loadConfig().hybridSearchConfig.recencyHalflifeSecs;
    halflife = Number.isFinite(prior) && prior >= 1
      ? prior
      : DEFAULT_HYBRID_SEARCH_CONFIG.recencyHalflifeSecs;
  }
  return {
    bm25Weight: info.bm25Weight,
    vectorWeight: info.vectorWeight,
    rrfK: info.rrfK,
    recencyDecayEnabled: info.recencyDecayEnabled,
    recencyHalflifeSecs: halflife,
    candidatePoolSize: info.candidatePoolSize,
  };
}

/**
 * Replay the persisted hybrid retrieval config into the Rust
 * `SourceManager` on app startup so the user's choices survive a
 * restart. Called once from `appState.ts` after the bridge becomes
 * available, before any UI is shown.
 *
 * Defensive: if the persisted config has identical values to the
 * Rust default we skip the replay (a) to avoid unnecessary work
 * on the very common fresh-install path and (b) to limit log noise.
 * A future-version disk shape that adds a field we don't recognise
 * will be passed through unchanged by the loose schema, but the
 * `updateConfig` after the next `settings:updateHybridSearchConfig`
 * call will discard the unknown field, which is acceptable: we
 * never want stale unknowns to win over user intent.
 *
 * **Dual contract — callers MUST be aware of both outcomes.**
 *
 *  1. **Side effect on bridge rejection.** When the persisted
 *     config violates the bridge's validation rules (negative
 *     weights, non-finite halflife, etc.), this function calls
 *     `updateConfig` to **reset disk to the documented default**
 *     before rethrowing. The reset is intentional: the next launch
 *     must not loop on the same invalid config. A successful return
 *     leaves disk unchanged; a thrown return rewrites disk to the
 *     default. Callers that want to inspect disk after this function
 *     returns/throws should re-read via `loadConfig()`.
 *
 *  2. **Throws on bridge rejection.** The bridge error is
 *     re-thrown so the caller can log it and surface a warning to
 *     the user. The `hybridSearchConfigIpc.test.ts` integration
 *     test (`hybridSearchConfigIpc.test.ts:replay…rejects…`) pins
 *     this contract: a malformed persisted config produces both the
 *     disk reset AND a thrown error. Callers MUST wrap this call in
 *     `try / catch` or the entire main-process bootstrap aborts.
 *
 * Today there is exactly one production callsite at
 * `apps/desktop/electron/main.ts` which already wraps this in a
 * try/catch and logs `bridge.replayHybridSearchConfig.failed`. Any
 * future callsite (e.g. a hypothetical "reset search config" menu
 * command) must do the same.
 */
export function replayPersistedHybridSearchConfigToBridge(): void {
  const bridge = getBridge();
  if (!bridge) {
    return;
  }
  const persisted = loadConfig().hybridSearchConfig;
  // Skip if the persisted shape is the documented default — the
  // bridge already starts with that config so the replay is a
  // no-op. This avoids the work AND the audit-log entry.
  const isDefault =
    persisted.bm25Weight === DEFAULT_HYBRID_SEARCH_CONFIG.bm25Weight &&
    persisted.vectorWeight === DEFAULT_HYBRID_SEARCH_CONFIG.vectorWeight &&
    persisted.rrfK === DEFAULT_HYBRID_SEARCH_CONFIG.rrfK &&
    persisted.recencyDecayEnabled ===
      DEFAULT_HYBRID_SEARCH_CONFIG.recencyDecayEnabled &&
    persisted.recencyHalflifeSecs ===
      DEFAULT_HYBRID_SEARCH_CONFIG.recencyHalflifeSecs &&
    persisted.candidatePoolSize ===
      DEFAULT_HYBRID_SEARCH_CONFIG.candidatePoolSize;
  if (isDefault) {
    return;
  }
  const update: HybridSearchConfigUpdate = {
    bm25Weight: persisted.bm25Weight,
    vectorWeight: persisted.vectorWeight,
    rrfK: persisted.rrfK,
    recencyDecayEnabled: persisted.recencyDecayEnabled,
    recencyHalflifeSecs: persisted.recencyHalflifeSecs,
    candidatePoolSize: persisted.candidatePoolSize,
  };
  try {
    bridge.bridgeUpdateHybridSearchConfig(update);
  } catch (e) {
    // The persisted config came from us, so a validation failure
    // here means the on-disk file was hand-edited (or written by a
    // newer Tessera version with looser bounds). Reset to the
    // documented default rather than crash the app — the user can
    // re-tune in Settings.
    updateConfig({
      hybridSearchConfig: { ...DEFAULT_HYBRID_SEARCH_CONFIG },
    });
    throw e;
  }
}
