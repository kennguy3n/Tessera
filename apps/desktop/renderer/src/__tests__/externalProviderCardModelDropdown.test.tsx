/**
 * Regression test for .
 *
 * The bug: after a user clicked "List models" on an
 * `openai_compatible` provider (populating the model `<select>`
 * dropdown via `setAvailableModels`), switching the providerType to
 * `anthropic` left the stale OpenAI-compatible dropdown rendered.
 * The "List models" button is intentionally hidden for `anthropic`
 * (the Messages API has no `/v1/models` analogue), so the user had
 * no obvious way back to the manual-text-input default except
 * hunting for the `— enter manually —` sentinel at the bottom of a
 * wrong-provider list.
 *
 * The fix wires the dropdown clear into the central `setField`
 * helper: whenever `providerType` changes, `setAvailableModels(null)`
 * fires alongside the provider update, returning the card to the
 * manual-text-input state (which is the correct default for
 * Anthropic and a sensible default for a re-configured OpenAI-
 * compatible provider awaiting a fresh "List models" click).
 *
 * This test pins the contract by:
 *   1. Mounting the card with a stub providerGet that resolves
 *      `openai_compatible`.
 *   2. Driving the "List models" click → asserting the `<select>`
 *      dropdown renders (with the stubbed model list).
 *   3. Switching the providerType select to `anthropic` → asserting
 *      the dropdown is gone and the manual `<input type="text">`
 *      is back.
 *
 * If the central `setField` clear is removed, step 3's assertion
 * fails immediately with a visible stale `<select>` element.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";
import "@testing-library/jest-dom";

import ExternalProviderCard from "../components/ExternalProviderCard";

describe("ExternalProviderCard — model dropdown lifecycle across providerType switch", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("clears the listed-models dropdown when the user switches providerType to anthropic", async () => {
    const user = userEvent.setup();

    // Seed the card so it lands in openai_compatible mode with a
    // typed apiUrl (so the "List models" button isn't disabled).
    const tessera = window.tessera;
    tessera.externalProvider.get = vi.fn().mockResolvedValue({
      enabled: true,
      providerType: "openai_compatible",
      apiUrl: "https://api.openai.com",
      apiKeyRef: "tessera.external_provider.primary",
      modelName: "",
      maxTokens: 1024,
      temperature: 0.7,
      timeoutSecs: 60,
      maxRetries: 2,
      hasApiKey: true,
    });
    tessera.externalProvider.listModels = vi.fn().mockResolvedValue({
      ok: true,
      models: ["gpt-3.5-turbo", "gpt-4o", "gpt-4o-mini"],
    });

    render(<ExternalProviderCard />);

    // Wait for the card to finish its initial load (`provider:get`
    // resolves async, the form fields only render after).
    await waitFor(() => {
      expect(screen.getByText("Model name")).toBeInTheDocument();
    });

    // The "List models" button is visible for openai_compatible.
    // Until clicked, the model field is the manual text input.
    expect(
      screen.getByLabelText("Fetch available models from this provider"),
    ).toBeInTheDocument();
    expect(screen.getByPlaceholderText(/gpt-4o-mini/)).toBeInTheDocument();

    // Click "List models" → the dropdown populates and the manual
    // text input is replaced by a `<select>`.
    await user.click(
      screen.getByLabelText("Fetch available models from this provider"),
    );
    await waitFor(() => {
      // The dropdown's first listed option (the stub returns gpt-3.5,
      // gpt-4o, gpt-4o-mini) is now in the DOM. The simpler & more
      // robust assertion is that the manual text input is gone.
      expect(
        screen.queryByPlaceholderText(/gpt-4o-mini/),
      ).not.toBeInTheDocument();
    });

    // Switch providerType to `anthropic`. The "List models" button
    // is hidden for anthropic, AND the stale dropdown should clear
    // so the user lands back on manual text input.
    const providerTypeSelect = screen.getByLabelText("Provider type");
    await user.selectOptions(providerTypeSelect, "anthropic");

    // Assertion: the manual text input is back (the Anthropic
    // placeholder this time, but the same field is rendered as
    // <input type="text"> not <select>).
    await waitFor(() => {
      expect(
        screen.getByPlaceholderText(/claude-3-5-sonnet-latest/),
      ).toBeInTheDocument();
    });

    // And the "List models" button is hidden for anthropic — pinned
    // by the existing visibility predicate, but assert it here too so
    // a regression that removes the predicate doesn't leave a
    // misleading button onscreen.
    expect(
      screen.queryByLabelText("Fetch available models from this provider"),
    ).not.toBeInTheDocument();
  });

  it("preserves the listed-models dropdown across apiUrl keystrokes (the dropdown clear is asymmetric, only on providerType)", async () => {
    // Companion test: the fix deliberately does NOT clear the
    // dropdown on every `apiUrl` onChange because the user is
    // typically mid-edit. Clobbering the list per-keystroke would
    // feel buggy. This test pins the asymmetry so a future
    // maintainer doesn't generalise the clear and break the
    // mid-edit case.
    const user = userEvent.setup();

    const tessera = window.tessera;
    tessera.externalProvider.get = vi.fn().mockResolvedValue({
      enabled: true,
      providerType: "openai_compatible",
      apiUrl: "https://api.openai.com",
      apiKeyRef: "tessera.external_provider.primary",
      modelName: "",
      maxTokens: 1024,
      temperature: 0.7,
      timeoutSecs: 60,
      maxRetries: 2,
      hasApiKey: true,
    });
    tessera.externalProvider.listModels = vi.fn().mockResolvedValue({
      ok: true,
      models: ["gpt-3.5-turbo", "gpt-4o", "gpt-4o-mini"],
    });

    render(<ExternalProviderCard />);
    await waitFor(() => {
      expect(screen.getByText("Model name")).toBeInTheDocument();
    });

    await user.click(
      screen.getByLabelText("Fetch available models from this provider"),
    );
    await waitFor(() => {
      expect(
        screen.queryByPlaceholderText(/gpt-4o-mini/),
      ).not.toBeInTheDocument();
    });

    // Edit the apiUrl by appending a `/v1` path — the dropdown
    // should still be visible because per-keystroke clearing
    // would be hostile to the mid-edit user.
    const apiUrlInput = screen.getByLabelText("API URL");
    await user.type(apiUrlInput, "/v1");

    // The manual text input should still NOT be rendered (i.e.
    // the dropdown survived the keystrokes). This is the exact
    // negation of the providerType-switch assertion above.
    expect(
      screen.queryByPlaceholderText(/gpt-4o-mini/),
    ).not.toBeInTheDocument();
  });

  // UX gap pinned: the
  // "List models" button was clickable even when the persisted
  // provider was not saved/enabled or had no API key in the vault,
  // producing a confusing "External provider is disabled" toast on a
  // first-time-setup click. The fix gates the button on
  // `provider.enabled`, `provider.hasApiKey`, and a non-empty
  // `apiUrl`. The three tests below pin each gate independently so a
  // future maintainer who narrows the predicate to fewer dimensions
  // re-introduces a regression that the test suite flags.

  it("disables List models when the persisted provider has no API key", async () => {
    const tessera = window.tessera;
    tessera.externalProvider.get = vi.fn().mockResolvedValue({
      enabled: true,
      providerType: "openai_compatible",
      apiUrl: "https://api.openai.com",
      apiKeyRef: "tessera.external_provider.primary",
      modelName: "",
      maxTokens: 1024,
      temperature: 0.7,
      timeoutSecs: 60,
      maxRetries: 2,
      hasApiKey: false,
    });
    render(<ExternalProviderCard />);
    await waitFor(() => {
      expect(screen.getByText("Model name")).toBeInTheDocument();
    });
    const button = screen.getByLabelText(
      "Fetch available models from this provider",
    );
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute(
      "title",
      "Save an API key first to list models from the provider",
    );
  });

  it("disables List models when the form has the provider toggled off", async () => {
    const tessera = window.tessera;
    tessera.externalProvider.get = vi.fn().mockResolvedValue({
      enabled: false,
      providerType: "openai_compatible",
      apiUrl: "https://api.openai.com",
      apiKeyRef: "tessera.external_provider.primary",
      modelName: "",
      maxTokens: 1024,
      temperature: 0.7,
      timeoutSecs: 60,
      maxRetries: 2,
      hasApiKey: true,
    });
    render(<ExternalProviderCard />);
    // When the form's `enabled` is false the entire editor body —
    // including the Model name row and the List models button — is
    // collapsed by the parent conditional. The button being absent
    // is the correct UX: the user can't list models against a
    // disabled provider in any state. Pin the negative assertion so
    // a future maintainer who flattens the conditional doesn't
    // accidentally expose a clickable List models button under a
    // disabled provider.
    await waitFor(() => {
      expect(
        screen.getByLabelText("Enable external provider"),
      ).toBeInTheDocument();
    });
    expect(
      screen.queryByLabelText("Fetch available models from this provider"),
    ).not.toBeInTheDocument();
  });

  it("forwards the form's CURRENT enabled flag to listModels after the user toggles it", async () => {
    // Stale-closure bug pinned: the `enabled` override was captured
    // by the `onListModels` useCallback at first render and never
    // refreshed because `enabled` was missing from the deps array.
    // Pin the fix here:
    // after the user toggles the form's `enabled`, a subsequent
    // List models click must forward the CURRENT value, not the
    // stale closure capture from first render.
    //
    // Scenario (matches the bot's repro):
    //   1. Persisted config: enabled=false, apiUrl set, key stored.
    //   2. User toggles the form ON via the "Enable external
    //      provider" checkbox.
    //   3. User clicks List models.
    //   4. Without the fix: `listModels` receives `enabled: false`
    //      (stale closure). Handler returns "External provider is
    //      disabled".
    //   5. With the fix: `listModels` receives `enabled: true`
    //      (current form state). Handler proceeds.
    const user = userEvent.setup();
    const tessera = window.tessera;
    // Persisted state: enabled=false, but everything else valid so
    // the toggle-on path is a clean enable.
    tessera.externalProvider.get = vi.fn().mockResolvedValue({
      enabled: false,
      providerType: "openai_compatible",
      apiUrl: "https://api.openai.com",
      apiKeyRef: "tessera.external_provider.primary",
      modelName: "",
      maxTokens: 1024,
      temperature: 0.7,
      timeoutSecs: 60,
      maxRetries: 2,
      hasApiKey: true,
    });
    const listModelsSpy = vi.fn().mockResolvedValue({
      ok: true,
      models: ["gpt-4o-mini"],
    });
    tessera.externalProvider.listModels = listModelsSpy;

    render(<ExternalProviderCard />);
    // The card renders the enable checkbox even when the provider
    // is disabled — that's how the user flips it on.
    await waitFor(() => {
      expect(
        screen.getByLabelText("Enable external provider"),
      ).toBeInTheDocument();
    });

    // Toggle enabled ON in the form. The editor body (with the
    // List models button) only renders after this.
    await user.click(screen.getByLabelText("Enable external provider"));
    await waitFor(() => {
      expect(
        screen.getByLabelText("Fetch available models from this provider"),
      ).toBeInTheDocument();
    });

    // Click List models. With the stale-closure bug, this would
    // send enabled=false. With the fix, it sends enabled=true.
    await user.click(
      screen.getByLabelText("Fetch available models from this provider"),
    );

    await waitFor(() => {
      expect(listModelsSpy).toHaveBeenCalledTimes(1);
    });
    expect(listModelsSpy).toHaveBeenCalledWith(
      expect.objectContaining({
        apiUrl: "https://api.openai.com",
        providerType: "openai_compatible",
        enabled: true,
      }),
    );
  });

  it("disables List models when apiUrl is empty", async () => {
    const tessera = window.tessera;
    tessera.externalProvider.get = vi.fn().mockResolvedValue({
      enabled: true,
      providerType: "openai_compatible",
      apiUrl: "",
      apiKeyRef: "tessera.external_provider.primary",
      modelName: "",
      maxTokens: 1024,
      temperature: 0.7,
      timeoutSecs: 60,
      maxRetries: 2,
      hasApiKey: true,
    });
    render(<ExternalProviderCard />);
    await waitFor(() => {
      expect(screen.getByText("Model name")).toBeInTheDocument();
    });
    const button = screen.getByLabelText(
      "Fetch available models from this provider",
    );
    expect(button).toBeDisabled();
    expect(button).toHaveAttribute("title", "Provide an API URL first");
  });

  it("surfaces a 'use manual entry' hint with the attempted url when listModels returns kind: endpoint_not_found (typed-404 fix)", async () => {
    // The custom-provider 404 path: a self-hosted shim that implements
    // chat completions but not /v1/models. Before the typed
    // `endpoint_not_found` variant the renderer fell into the generic
    // `kind: error` branch and showed the raw "HTTP 404: <html>not
    // found</html>" string, which reads as a transient failure the
    // user should retry. The proper fix is a discriminated result
    // variant whose renderer mapping points the user at the manual
    // text input and includes the URL they can `curl` to verify their
    // deployment.
    const user = userEvent.setup();
    const tessera = window.tessera;
    tessera.externalProvider.get = vi.fn().mockResolvedValue({
      enabled: true,
      providerType: "custom",
      apiUrl: "http://localhost:9000",
      apiKeyRef: "tessera.external_provider.primary",
      modelName: "",
      maxTokens: 1024,
      temperature: 0.7,
      timeoutSecs: 60,
      maxRetries: 2,
      hasApiKey: true,
    });
    tessera.externalProvider.listModels = vi.fn().mockResolvedValue({
      ok: false,
      kind: "endpoint_not_found",
      url: "http://localhost:9000/v1/models",
    });

    render(<ExternalProviderCard />);
    await waitFor(() => {
      expect(
        screen.getByLabelText("Fetch available models from this provider"),
      ).toBeInTheDocument();
    });

    await user.click(
      screen.getByLabelText("Fetch available models from this provider"),
    );

    // The user-facing message must include the URL that was
    // attempted (so they can verify their deployment with curl) and
    // the explicit "enter manually" hint (so they don't think this
    // is a transient retry-this failure). The status pill renders
    // the full message in a single DOM node, so a substring match
    // against both halves of the text is sufficient.
    await waitFor(() => {
      const status = screen.getByText(
        /This provider does not expose a model listing endpoint/,
      );
      expect(status).toBeInTheDocument();
      expect(status.textContent).toContain(
        "http://localhost:9000/v1/models",
      );
      expect(status.textContent).toContain("Enter the model name manually");
    });

    // The dropdown must NOT have appeared — endpoint_not_found is a
    // failure path that keeps the user on the manual text input.
    // The Model name input keeps its text-input form (not a <select>).
    // We check `tagName` rather than `type=text` because the JSX
    // omits the attribute (HTML defaults `<input>` to text), so the
    // attribute is structurally absent on the rendered node.
    const modelInput = screen.getByLabelText("Model name");
    expect(modelInput.tagName).toBe("INPUT");
  });

  it("does NOT mention the URL for the kind: unsupported branch (Anthropic-only manual-entry hint)", async () => {
    // Symmetric to the endpoint_not_found test above: the Anthropic
    // path has no URL the user could possibly hit to make listing
    // work, so the renderer message must NOT include a URL — only
    // the "use manual entry" hint. This pins the discriminator
    // semantics: unsupported = provider type lacks the endpoint at
    // all; endpoint_not_found = this deployment lacks it.
    const user = userEvent.setup();
    const tessera = window.tessera;
    tessera.externalProvider.get = vi.fn().mockResolvedValue({
      enabled: true,
      providerType: "openai_compatible",
      apiUrl: "https://api.openai.com",
      apiKeyRef: "tessera.external_provider.primary",
      modelName: "",
      maxTokens: 1024,
      temperature: 0.7,
      timeoutSecs: 60,
      maxRetries: 2,
      hasApiKey: true,
    });
    tessera.externalProvider.listModels = vi
      .fn()
      .mockResolvedValue({ ok: false, kind: "unsupported" });

    render(<ExternalProviderCard />);
    await waitFor(() => {
      expect(
        screen.getByLabelText("Fetch available models from this provider"),
      ).toBeInTheDocument();
    });

    await user.click(
      screen.getByLabelText("Fetch available models from this provider"),
    );

    let alertText: string | null = null;
    await waitFor(() => {
      const alert = screen.getByRole("alert");
      alertText = alert.textContent;
      expect(alertText).toMatch(
        /Model listing is not available for this provider/,
      );
    });
    // The unsupported message must NOT include a URL — the alert
    // pill's full text is the entire user-facing surface for this
    // failure mode, so substring-asserting against the alert text
    // (rather than the broader DOM) gives us a precise pin without
    // matching the unrelated `apiUrl` input value rendered nearby.
    expect(alertText!).not.toMatch(/https?:\/\//);
  });

  it("surfaces a deep failure from Test connection via setStatus instead of silently un-busying", async () => {
    // `onTest` was the
    // only handler in this file using `try/finally` instead of the
    // sibling pattern `try/catch/finally`. If the IPC channel itself
    // failed (bridge serialization error, contextIsolation violation,
    // the IPC handler throwing before its own try/catch wraps the
    // result), the rejected promise would propagate unhandled while
    // the finally block ran `setBusy(false)` — leaving the button
    // re-enabled but with no error message displayed to the user.
    // The fix adds a `catch` block matching the sibling pattern.
    //
    // This test pins the new behavior by making the IPC mock reject
    // (the realistic "deep failure" scenario) and asserting the
    // surfaced error message reaches the DOM rather than the test
    // throwing the unhandled rejection. With the pre-fix code, the
    // rejection would escape the component and React Testing
    // Library's `act` wrapper would surface it as an uncaught error.
    const user = userEvent.setup();
    const tessera = window.tessera;
    tessera.externalProvider.get = vi.fn().mockResolvedValue({
      enabled: true,
      providerType: "openai_compatible",
      apiUrl: "https://api.openai.com",
      apiKeyRef: "tessera.external_provider.primary",
      modelName: "gpt-4o-mini",
      maxTokens: 1024,
      temperature: 0.7,
      timeoutSecs: 60,
      maxRetries: 2,
      hasApiKey: true,
    });
    tessera.externalProvider.test = vi
      .fn()
      .mockRejectedValue(new Error("bridge serialization broke"));
    render(<ExternalProviderCard />);
    await waitFor(() => {
      expect(screen.getByText("Test connection")).toBeInTheDocument();
    });
    await user.click(screen.getByText("Test connection"));
    // Wait for the rejection to be caught and the error to surface.
    await waitFor(() => {
      expect(
        screen.getByText("bridge serialization broke"),
      ).toBeInTheDocument();
    });
    // The button must also re-enable via the finally block.
    expect(screen.getByText("Test connection")).not.toBeDisabled();
  });
});
