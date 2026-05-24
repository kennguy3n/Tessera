import { useCallback, useEffect, useState } from "react";
import Card from "./Card";
import Button from "./Button";
import type {
  ExternalProviderConfigInput,
  ExternalProviderConfigView,
  ExternalProviderListModelsResult,
  ExternalProviderTestResult,
  ExternalProviderTokenUsage,
  ExternalProviderType,
} from "../types/ipc";

/** Format a token count for compact display, e.g. 1234 -> "1.2k",
 *  1_234_567 -> "1.2M". Used in the token-usage row to keep the UI
 *  width stable as the counter grows over time. The threshold for
 *  switching units is intentionally low (1_000) so small counts
 *  still show meaningful precision for users running tests.
 *
 *  The k→M boundary is at 999_500 (not 1_000_000) because (999_999 /
 *  1_000).toFixed(1) === "1000.0" — displaying "1000.0k" instead of
 *  "1.0M" is the obvious-but-wrong threshold that Devin Review round
 *  10 flagged. Moving the boundary down to 999_500 means any value
 *  that would round-up to 1000.0k at one decimal place is shown in M
 *  units instead, which is what every conventional financial /
 *  analytics display does (e.g. Stripe dashboard, GitHub Insights). */
function formatTokenCount(n: number): string {
  if (n < 1_000) return n.toLocaleString();
  if (n < 999_500) return `${(n / 1_000).toFixed(1)}k`;
  return `${(n / 1_000_000).toFixed(2)}M`;
}

/** Format an ISO-8601 reset date for the "since &lt;date&gt;" label.
 *  A first-launch sentinel (epoch zero, before 2010) is displayed
 *  as "since first launch" so the UI doesn't show a confusing
 *  1970 date for users who never explicitly reset. */
function formatResetDate(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime()) || d.getFullYear() < 2010) {
    return "since first launch";
  }
  return `since ${d.toLocaleDateString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
  })}`;
}

/**
 * Settings card that owns the user's optional external LLM provider
 * configuration. Defers all state mutation to the IPC layer
 * (`window.tessera.externalProvider`) so the renderer never
 * sees the raw API key after the user types it — it is forwarded
 * straight to the keychain via `secretsVault`.
 *
 * Surfaced behaviour:
 *   - collapsed by default; "Enable external provider" toggle expands
 *     the editor
 *   - provider-type-aware URL placeholder
 *   - "API key" field is a password input that:
 *       - is blank when no key is stored — typing will store on save
 *       - shows ``"●●●●● (stored)"`` placeholder when a key is in the
 *         keychain — leaving it blank keeps the existing key
 *       - typing a new value replaces the stored key; typing "clear"
 *         + Save explicitly removes it (we send "" over IPC)
 *   - "Test connection" button issues a 1-token round-trip and reports
 *     latency or failure.
 *
 * This card validates the form locally so users get immediate
 * feedback before reaching the Rust runtime, but the runtime layer
 * (`ExternalProviderConfig::validate`) is the source of truth.
 */
export default function ExternalProviderCard() {
  const [provider, setProvider] = useState<ExternalProviderConfigView | null>(
    null,
  );
  const [draftKey, setDraftKey] = useState<string>("");
  const [clearKey, setClearKey] = useState<boolean>(false);
  const [busy, setBusy] = useState<boolean>(false);
  const [status, setStatus] = useState<
    | { kind: "idle" }
    | { kind: "saved" }
    | { kind: "test_ok"; latencyMs: number }
    | { kind: "error"; message: string }
    | { kind: "usage_reset" }
  >({ kind: "idle" });
  const [tokenUsage, setTokenUsage] =
    useState<ExternalProviderTokenUsage | null>(null);
  /** When set, displays the dropdown populated from
   *  `externalProvider:listModels`. Null means the dropdown has
   *  never been opened — the manual text input is the only
   *  control. Empty array means "list returned no models"
   *  (different from "never listed"). */
  const [availableModels, setAvailableModels] = useState<string[] | null>(
    null,
  );

  const refresh = useCallback(async () => {
    // Fetch both the provider config AND the token usage in
    // parallel — they're independent IPC calls and the user
    // sees the card update in one frame instead of two.
    const [cur, usage] = await Promise.all([
      window.tessera.externalProvider.get(),
      window.tessera.externalProvider.getTokenUsage(),
    ]);
    setProvider(cur);
    setTokenUsage(usage);
    setDraftKey("");
    setClearKey(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  const onListModels = useCallback(async () => {
    setBusy(true);
    setStatus({ kind: "idle" });
    try {
      // Pass the in-flight form state (apiUrl + providerType) to
      // the main process so the listing operates against what the
      // user is CURRENTLY editing, not the last-saved on-disk
      // config. This avoids the "I changed the URL, clicked List,
      // got the old provider's models" confusion that Devin
      // Review flagged. The API key is intentionally NOT
      // overridable here — the persisted vault entry is the only
      // source of plaintext-key truth (see comment on the IPC
      // handler in `electron/ipc/settings.ts`).
      //
      // `provider` may be null between mount and first refresh()
      // settling; we send `undefined` overrides in that window
      // and the handler falls back to the persisted config.
      const result: ExternalProviderListModelsResult =
        await window.tessera.externalProvider.listModels(
          provider
            ? {
                apiUrl: provider.apiUrl,
                providerType: provider.providerType,
                // Forward the form's `enabled` so the handler gates
                // on what the user is currently seeing (form state)
                // rather than what was last persisted. This lets a
                // user who has just toggled the provider on click
                // "List models" without first hitting Save. See the
                // long doc comment on
                // `ExternalProviderListModelsDraftOverrides` for the
                // motivation (Devin Review round 12 ANALYSIS_002).
                enabled: provider.enabled,
              }
            : undefined,
        );
      if (result.ok) {
        setAvailableModels(result.models);
      } else if (result.kind === "unsupported") {
        setStatus({
          kind: "error",
          message:
            "Model listing is not available for this provider — keep using the manual model name input.",
        });
      } else {
        setStatus({ kind: "error", message: result.error });
      }
    } catch (e) {
      // The IPC handler in `electron/ipc/settings.ts` wraps its own
      // body in a try/catch and always returns a result object — so
      // reaching this `catch` indicates a deeper failure: bridge
      // serialization error, contextIsolation violation, etc. Surface
      // it the same way `onSave` and `onResetTokenUsage` surface
      // their errors so the user never sees a silently un-busied
      // button with no feedback.
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
    // Narrow deps to ONLY the three `provider` fields this callback
    // actually reads (`apiUrl`, `providerType`, and `enabled`)
    // instead of the whole `provider` object. The previous
    // `[provider]` dep caused the callback to recreate on every
    // keystroke in any form field (`modelName`, `maxTokens`,
    // `temperature`, etc.) because `setField` produces a new object
    // via spread — which in turn re-rendered the "List models"
    // Button with a new `onClick` reference on every character
    // typed elsewhere. With the narrowed deps the callback identity
    // is stable across edits to unrelated fields, and the Button
    // only re-renders when one of the three fields the callback
    // actually reads changes.
    //
    // The `enabled` dep is REQUIRED — without it the callback's
    // closure captures the value at first render and never sees
    // subsequent toggles (Devin Review round 13 BUG_001). Concrete
    // failure mode: user has persisted `enabled: false`, toggles
    // the form ON, clicks List models → stale `false` flows through
    // as the override and the handler returns "External provider
    // is disabled", defeating the round-12 ANALYSIS_002 fix.
  }, [provider?.apiUrl, provider?.providerType, provider?.enabled]);

  const onResetTokenUsage = useCallback(async () => {
    // Bracket the async IPC with the same `busy` flag the sibling
    // handlers (`onSave`, `onTest`, `onListModels`) use. Even though
    // the operation is idempotent (`createEmptyTokenUsage()` just
    // writes zeros + current timestamp), bracketing it (a) disables
    // every other button in the card for the duration so a user
    // can't kick off a Save while a reset is mid-flight, and (b)
    // visually matches the sibling controls so a reviewer reading
    // the four callbacks finds them all structured the same way.
    setBusy(true);
    try {
      const fresh = await window.tessera.externalProvider.resetTokenUsage();
      setTokenUsage(fresh);
      setStatus({ kind: "usage_reset" });
    } catch (e) {
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  }, []);

  if (!provider) {
    return (
      <Card>
        <h3 style={{ marginBottom: "var(--spacing-md)" }}>External Provider</h3>
        <p style={{ color: "var(--color-text-secondary)" }}>Loading…</p>
      </Card>
    );
  }

  const setField = <K extends keyof ExternalProviderConfigInput>(
    key: K,
    value: ExternalProviderConfigInput[K],
  ) => {
    setProvider({ ...provider, [key]: value });
    // Clear the listed-models dropdown when the user switches the
    // provider type. Without this clear, switching from
    // `openai_compatible` (after a successful "List models" populate)
    // to `anthropic` would leave a stale select dropdown showing
    // OpenAI-compatible model names, AND the "List models" button is
    // intentionally hidden for `anthropic` (no `/v1/models` endpoint)
    // so the user has no obvious way back to manual entry except
    // hunting for the `— enter manually —` option at the bottom of a
    // wrong-provider list. Clearing on the type-switch returns the
    // card to the manual-text-input state, which IS the right
    // default for Anthropic and a sensible default for an unconfigured
    // OpenAI-compatible provider too (the user can re-click "List
    // models" once they finish typing the apiUrl).
    //
    // We do NOT clear on every apiUrl keystroke because the user is
    // typically mid-edit when the URL field receives onChange events
    // — clobbering the list on each character would feel buggy. A
    // stale list against a different host is recoverable via a fresh
    // "List models" click; a stuck dropdown across a provider-type
    // switch is not, hence the asymmetric treatment.
    if (key === "providerType") {
      setAvailableModels(null);
    }
  };

  const placeholderUrl =
    provider.providerType === "anthropic"
      ? "https://api.anthropic.com"
      : provider.providerType === "openai_compatible"
        ? "https://api.openai.com (or http://localhost:11434 for Ollama)"
        : "Custom endpoint base URL";

  const validate = (): string | null => {
    if (!provider.enabled) return null;
    if (!provider.apiUrl.trim()) return "API URL is required.";
    if (!provider.modelName.trim()) return "Model name is required.";
    if (provider.temperature < 0 || provider.temperature > 2) {
      return "Temperature must be between 0 and 2.";
    }
    if (provider.maxTokens <= 0) {
      return "Max tokens must be greater than 0.";
    }
    if (provider.timeoutSecs <= 0) {
      return "Timeout must be greater than 0 seconds.";
    }
    if (provider.maxRetries < 0) {
      return "Max retries cannot be negative.";
    }
    return null;
  };

  const onSave = async () => {
    const err = validate();
    if (err) {
      setStatus({ kind: "error", message: err });
      return;
    }
    setBusy(true);
    setStatus({ kind: "idle" });
    try {
      const payload: ExternalProviderConfigInput = {
        enabled: provider.enabled,
        providerType: provider.providerType,
        apiUrl: provider.apiUrl.trim(),
        apiKeyRef: provider.apiKeyRef,
        modelName: provider.modelName.trim(),
        maxTokens: provider.maxTokens,
        temperature: provider.temperature,
        timeoutSecs: provider.timeoutSecs,
        maxRetries: provider.maxRetries,
      };
      // null = leave keychain alone; "" = clear; otherwise store.
      const apiKey: string | null = clearKey
        ? ""
        : draftKey.length > 0
          ? draftKey
          : null;
      const saved = await window.tessera.externalProvider.set(
        payload,
        apiKey,
      );
      setProvider(saved);
      setDraftKey("");
      setClearKey(false);
      setStatus({ kind: "saved" });
    } catch (e) {
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  const onTest = async () => {
    setBusy(true);
    setStatus({ kind: "idle" });
    try {
      const result: ExternalProviderTestResult =
        await window.tessera.externalProvider.test();
      if (result.ok) {
        setStatus({ kind: "test_ok", latencyMs: result.latencyMs });
      } else {
        setStatus({ kind: "error", message: result.error });
      }
    } catch (e) {
      // Match the defense-in-depth pattern of every sibling handler
      // (`onSave`, `onListModels`, `onResetTokenUsage`) so a deep
      // failure — bridge serialization error, contextIsolation
      // violation, the IPC handler itself throwing before its own
      // try/catch can wrap it — surfaces visibly instead of leaving
      // the button silently un-busied with no feedback. The IPC
      // handler at `electron/ipc/settings.ts` already wraps its body
      // in a try/catch and returns a typed result, so this `catch`
      // is the renderer-side belt to the handler-side suspenders.
      // Devin Review round 14 ANALYSIS_001 flagged the pre-existing
      // inconsistency: every other handler in this file uses
      // try/catch/finally, only `onTest` used try/finally.
      setStatus({
        kind: "error",
        message: e instanceof Error ? e.message : String(e),
      });
    } finally {
      setBusy(false);
    }
  };

  const fieldLabel: React.CSSProperties = {
    display: "block",
    fontSize: "var(--font-size-sm)",
    fontWeight: "var(--font-weight-medium)" as unknown as number,
    marginBottom: "var(--spacing-xs)",
    color: "var(--color-text-headline)",
  };
  const fieldRow: React.CSSProperties = { marginBottom: "var(--spacing-md)" };

  return (
    <Card>
      <div
        style={{
          display: "flex",
          alignItems: "center",
          justifyContent: "space-between",
          marginBottom: "var(--spacing-md)",
        }}
      >
        <h3 style={{ margin: 0 }}>External Provider</h3>
        <label
          style={{ display: "flex", alignItems: "center", gap: 8 }}
          aria-label="Enable external provider"
        >
          <input
            type="checkbox"
            checked={provider.enabled}
            onChange={(e) => setField("enabled", e.target.checked)}
          />
          <span style={{ fontSize: "var(--font-size-sm)" }}>
            {provider.enabled ? "Enabled" : "Disabled"}
          </span>
        </label>
      </div>

      <p
        style={{
          color: "var(--color-text-secondary)",
          fontSize: "var(--font-size-sm)",
          marginBottom: "var(--spacing-md)",
        }}
      >
        Off by default. When on, Tessera will fall back to the configured
        OpenAI-compatible or Anthropic endpoint after the local model. The
        API key is stored in the OS keychain, never on disk.
      </p>

      {provider.enabled && (
        <>
          <div style={fieldRow}>
            <label style={fieldLabel} htmlFor="external-provider-type">
              Provider type
            </label>
            <select
              id="external-provider-type"
              className="input"
              value={provider.providerType}
              onChange={(e) =>
                setField(
                  "providerType",
                  e.target.value as ExternalProviderType,
                )
              }
            >
              <option value="openai_compatible">OpenAI-compatible</option>
              <option value="anthropic">Anthropic</option>
              <option value="custom">Custom</option>
            </select>
          </div>

          <div style={fieldRow}>
            <label style={fieldLabel} htmlFor="external-provider-url">
              API URL
            </label>
            <input
              id="external-provider-url"
              className="input"
              value={provider.apiUrl}
              onChange={(e) => setField("apiUrl", e.target.value)}
              placeholder={placeholderUrl}
            />
          </div>

          <div style={fieldRow}>
            <div
              style={{
                display: "flex",
                alignItems: "center",
                justifyContent: "space-between",
                marginBottom: "var(--spacing-xs)",
              }}
            >
              <label
                style={{ ...fieldLabel, marginBottom: 0 }}
                htmlFor="external-provider-model"
              >
                Model name
              </label>
              {provider.providerType !== "anthropic" && (
                <Button
                  variant="secondary"
                  onClick={onListModels}
                  // Disable the button when any of the pre-conditions
                  // for a successful listModels invocation are not met:
                  //
                  //   - `busy`: another IPC operation is in flight
                  //     (Save / Test / Reset / List).
                  //   - `!provider.apiUrl.trim()`: nothing to list
                  //     against — the form's URL field is empty or
                  //     whitespace only.
                  //   - `!provider.hasApiKey`: no saved API key in
                  //     the vault. The handler cannot proceed
                  //     without one (we deliberately do NOT accept
                  //     plaintext keys over IPC, see the handler
                  //     comment) so the only way forward is to Save
                  //     the key first and click List models again.
                  //
                  // Note: there is intentionally NO `!provider.enabled`
                  // gate here. The entire editor body (this button
                  // included) is wrapped in `{provider.enabled && ...}`
                  // at line ~376, so a `provider.enabled=false` state
                  // collapses this whole subtree before the button
                  // can render. Adding the gate to `disabled` would
                  // be dead code — Devin Review round 12 ANALYSIS_002
                  // flagged the redundancy. The form's `enabled`
                  // value is forwarded as a draft override to the
                  // listModels handler (see `onListModels` above)
                  // so the handler gates on the EFFECTIVE enabled
                  // (form-override merged atop persisted), avoiding
                  // the previous "fresh-enable + List = External
                  // provider is disabled" UX gap.
                  //
                  // Devin Review round 10 surfaced the broader UX
                  // gap: the button was clickable in all these
                  // states and the user saw "External provider is
                  // disabled" on a first-time-setup click instead
                  // of the expected model list. The `title`
                  // attribute below surfaces the precise reason so
                  // the user knows what to do.
                  disabled={
                    busy || !provider.apiUrl.trim() || !provider.hasApiKey
                  }
                  title={
                    !provider.apiUrl.trim()
                      ? "Provide an API URL first"
                      : !provider.hasApiKey
                        ? "Save an API key first to list models from the provider"
                        : "Fetch available models from this provider"
                  }
                  aria-label="Fetch available models from this provider"
                >
                  List models
                </Button>
              )}
            </div>
            {availableModels && availableModels.length > 0 ? (
              <select
                id="external-provider-model"
                className="input"
                value={
                  availableModels.includes(provider.modelName)
                    ? provider.modelName
                    : ""
                }
                onChange={(e) => {
                  if (e.target.value === "__manual__") {
                    // Switch back to manual entry by clearing the
                    // populated list. The current modelName is
                    // preserved so the user can edit it.
                    setAvailableModels(null);
                  } else {
                    setField("modelName", e.target.value);
                  }
                }}
              >
                {!availableModels.includes(provider.modelName) && (
                  <option value="">
                    {provider.modelName
                      ? `Current: ${provider.modelName} (not in list)`
                      : "— select a model —"}
                  </option>
                )}
                {availableModels.map((m) => (
                  <option key={m} value={m}>
                    {m}
                  </option>
                ))}
                <option value="__manual__">— enter manually —</option>
              </select>
            ) : (
              <input
                id="external-provider-model"
                className="input"
                value={provider.modelName}
                onChange={(e) => setField("modelName", e.target.value)}
                placeholder={
                  provider.providerType === "anthropic"
                    ? "claude-3-5-sonnet-latest"
                    : "gpt-4o-mini / llama3.1:8b / etc."
                }
              />
            )}
          </div>

          <div style={fieldRow}>
            <label style={fieldLabel} htmlFor="external-provider-key">
              API key
              {provider.hasApiKey && !clearKey ? (
                <span
                  style={{
                    marginLeft: 8,
                    fontSize: "var(--font-size-xs)",
                    color: "var(--color-text-secondary)",
                  }}
                >
                  (a key is currently stored — leave blank to keep it)
                </span>
              ) : null}
            </label>
            <input
              id="external-provider-key"
              className="input"
              type="password"
              autoComplete="new-password"
              value={draftKey}
              disabled={clearKey}
              onChange={(e) => setDraftKey(e.target.value)}
              placeholder={
                clearKey
                  ? "(cleared on save)"
                  : provider.hasApiKey
                    ? "●●●●● stored"
                    : "Paste your API key"
              }
            />
            {provider.hasApiKey && (
              <label
                style={{
                  display: "inline-flex",
                  alignItems: "center",
                  gap: 6,
                  marginTop: 6,
                  fontSize: "var(--font-size-xs)",
                  color: "var(--color-text-secondary)",
                }}
              >
                <input
                  type="checkbox"
                  checked={clearKey}
                  onChange={(e) => setClearKey(e.target.checked)}
                />
                Forget the stored API key on save
              </label>
            )}
          </div>

          <div
            style={{
              display: "grid",
              gridTemplateColumns: "repeat(3, 1fr)",
              gap: "var(--spacing-md)",
            }}
          >
            <div>
              <label style={fieldLabel} htmlFor="external-provider-maxtokens">
                Max tokens
              </label>
              <input
                id="external-provider-maxtokens"
                className="input"
                type="number"
                min={1}
                value={provider.maxTokens}
                onChange={(e) =>
                  setField("maxTokens", parseInt(e.target.value, 10) || 0)
                }
              />
            </div>
            <div>
              <label style={fieldLabel} htmlFor="external-provider-temperature">
                Temperature
              </label>
              <input
                id="external-provider-temperature"
                className="input"
                type="number"
                step={0.1}
                min={0}
                max={2}
                value={provider.temperature}
                onChange={(e) =>
                  setField("temperature", parseFloat(e.target.value) || 0)
                }
              />
            </div>
            <div>
              <label style={fieldLabel} htmlFor="external-provider-timeout">
                Timeout (seconds)
              </label>
              <input
                id="external-provider-timeout"
                className="input"
                type="number"
                min={1}
                value={provider.timeoutSecs}
                onChange={(e) =>
                  setField("timeoutSecs", parseInt(e.target.value, 10) || 0)
                }
              />
            </div>
          </div>
        </>
      )}

      <div
        style={{
          display: "flex",
          gap: "var(--spacing-sm)",
          marginTop: "var(--spacing-md)",
        }}
      >
        <Button onClick={onSave} disabled={busy}>
          Save
        </Button>
        {provider.enabled && (
          <Button onClick={onTest} disabled={busy} variant="secondary">
            Test connection
          </Button>
        )}
      </div>

      {tokenUsage && (
        <div
          style={{
            marginTop: "var(--spacing-lg)",
            paddingTop: "var(--spacing-md)",
            borderTop: "1px solid var(--color-border)",
          }}
        >
          <div
            style={{
              display: "flex",
              alignItems: "center",
              justifyContent: "space-between",
              marginBottom: "var(--spacing-xs)",
            }}
          >
            <h4
              style={{
                margin: 0,
                fontSize: "var(--font-size-sm)",
                color: "var(--color-text-headline)",
              }}
            >
              Token usage
            </h4>
            <Button
              onClick={onResetTokenUsage}
              variant="secondary"
              aria-label="Reset external provider token usage counter"
              disabled={busy}
            >
              Reset counter
            </Button>
          </div>
          <p
            role="status"
            aria-live="polite"
            style={{
              margin: 0,
              fontSize: "var(--font-size-sm)",
              color: "var(--color-text-secondary)",
            }}
          >
            ~
            <span style={{ color: "var(--color-text)" }}>
              {formatTokenCount(
                tokenUsage.totalPromptTokens + tokenUsage.totalCompletionTokens,
              )}
            </span>{" "}
            tokens used {formatResetDate(tokenUsage.lastResetDate)}{" "}
            <span style={{ color: "var(--color-text-tertiary)" }}>
              (prompt {formatTokenCount(tokenUsage.totalPromptTokens)},
              completion {formatTokenCount(tokenUsage.totalCompletionTokens)})
            </span>
          </p>
          <p
            style={{
              marginTop: "var(--spacing-xs)",
              fontSize: "var(--font-size-xs)",
              color: "var(--color-text-tertiary)",
            }}
          >
            Counts are client-side estimates (~4 chars/token) since not every
            OpenAI-compatible proxy returns authoritative usage in stream
            mode. Use the provider's billing dashboard for exact figures.
          </p>
        </div>
      )}

      {status.kind === "saved" && (
        <p
          role="status"
          style={{
            marginTop: "var(--spacing-md)",
            color: "var(--color-success)",
            fontSize: "var(--font-size-sm)",
          }}
        >
          Saved.
        </p>
      )}
      {status.kind === "usage_reset" && (
        <p
          role="status"
          style={{
            marginTop: "var(--spacing-md)",
            color: "var(--color-success)",
            fontSize: "var(--font-size-sm)",
          }}
        >
          Token counter reset.
        </p>
      )}
      {status.kind === "test_ok" && (
        <p
          role="status"
          style={{
            marginTop: "var(--spacing-md)",
            color: "var(--color-success)",
            fontSize: "var(--font-size-sm)",
          }}
        >
          Connection OK — round trip {status.latencyMs} ms.
        </p>
      )}
      {status.kind === "error" && (
        <p
          role="alert"
          style={{
            marginTop: "var(--spacing-md)",
            color: "var(--color-error)",
            fontSize: "var(--font-size-sm)",
          }}
        >
          {status.message}
        </p>
      )}
    </Card>
  );
}
