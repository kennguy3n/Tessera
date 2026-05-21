import { useCallback, useEffect, useState } from "react";
import Card from "./Card";
import Button from "./Button";
import type {
  ExternalProviderConfigInput,
  ExternalProviderConfigView,
  ExternalProviderTestResult,
  ExternalProviderType,
} from "../types/ipc";

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
  >({ kind: "idle" });

  const refresh = useCallback(async () => {
    const cur = await window.tessera.externalProvider.get();
    setProvider(cur);
    setDraftKey("");
    setClearKey(false);
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

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
            <label style={fieldLabel} htmlFor="external-provider-model">
              Model name
            </label>
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
