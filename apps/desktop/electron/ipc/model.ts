/**
 * IPC handlers for the `model:*` channels (running llama-server
 * lifecycle + streaming completions).
 *
 * Distinct from `runtime:*` (in `./runtime.ts`), which deals with the
 * model registry / planning / on-disk download flow. This module owns
 * the live sidecar: start, stop, status check, and the SSE-streamed
 * `model:generate` channel that fans completion tokens out to the
 * renderer over `model:token`.
 */
import { BrowserWindow } from "electron";
import { access } from "fs/promises";
import { idempotentHandle } from "./register";
import {
  enforceSidecarExclusivity,
  getBridge,
} from "../appState";
import { isBatteryLow } from "../batteryMonitor";
import type { ModelStatus } from "../../shared/types";
import { assertString } from "./validate";
import { GenerateRequestSchema } from "./schemas";
import {
  loadConfig,
  updateConfig,
  type ExternalProviderConfig,
} from "../config";
import * as secretsVault from "../secretsVault";
import {
  streamExternalProvider,
  type ExternalProviderStreamChunk,
} from "../externalProviderStream";
import {
  estimateTokens,
  accumulateTokenUsage,
  type ExternalProviderTokenUsage,
} from "../tokenCounter";

/**
 * Bind a destroyed-window-safe sender for an IPC channel.
 *
 * Captures the `BrowserWindow` for `event.sender` at IPC entry and
 * returns a closure that pushes payloads on `channel` to that window.
 * The returned function:
 *
 *   - Skips the send if the window has been destroyed (user closed it,
 *     renderer crashed, etc.). `BrowserWindow.fromWebContents` returned
 *     a truthy JS handle whose native backing Electron has since freed,
 *     so optional-chaining `win?.webContents` does NOT short-circuit
 *     — we need an explicit `isDestroyed()` check.
 *   - try/catches the `.send()` call so a transient IPC failure
 *     (queue overflow, renderer crash mid-stream) cannot propagate up
 *     and short-circuit the caller's outer `try { ... } finally { ... }`
 *     cleanup.
 *
 * Channels that use this helper today:
 *
 *   - `runtime:downloadProgress` (the download-progress emitter)
 *   - `model:token` (the `model:generate` SSE stream)
 */
export function safeRendererSender<T>(
  event: Electron.IpcMainInvokeEvent,
  channel: string,
): (payload: T) => void {
  const win = BrowserWindow.fromWebContents(event.sender);
  return (payload: T) => {
    if (!win || win.isDestroyed()) return;
    try {
      win.webContents.send(channel, payload);
    } catch (err) {
      console.warn(
        `[tessera] ${channel} emit failed (continuing): ${(err as Error).message}`,
      );
    }
  };
}

/**
 * Active `model:generate` controller, lifted to module scope so the
 * matching `model:cancelJob` handler always targets the live
 * generation regardless of how many times `registerModelHandlers()`
 * has been called.
 *
 * Why this lives outside `registerModelHandlers()`:
 *
 *   The previous declaration was a `let` inside `registerModelHandlers`.
 *   That works fine for the production path (the function is invoked
 *   exactly once at startup), but a test harness — or a future
 *   electron-forge hot-reload — that re-invokes the registrar produces
 *   a NEW closure binding `model:cancelJob` to a NEW
 *   `activeGenerationController`, while an in-flight generation from
 *   the previous invocation still references the OLD one. The
 *   re-registered `model:cancelJob` would then be unable to abort that
 *   in-flight stream, because the variable it captures is `null`.
 *
 *   Hoisting to module scope means there is exactly one
 *   `activeGenerationController` per module load. Every call to
 *   `registerModelHandlers()` writes the SAME slot. `idempotentHandle`
 *   already drops the old IPC channel registration, so the previous
 *   handler's JS closure is now unreachable from outside — but if it
 *   is still mid-await on `reader.read()`, its `controller.abort()`
 *   call in the `finally` block still works because `controller` is
 *   captured by value in the local scope. The shared module-scope
 *   slot is only used for the cancel path, which always finds the
 *   current writer.
 *
 *   Concretely: the only way a re-registration can leave a generation
 *   uncancellable is if the new `model:cancelJob` handler looks at a
 *   different slot than the in-flight `model:generate` wrote to. By
 *   collapsing both handlers' references to one module-scope slot,
 *   that class of issue is structurally impossible.
 */
let activeGenerationController: AbortController | null = null;

/**
 * Exported for tests: reset the shared controller slot between cases
 * so a leaked one from a prior test cannot fail a re-registration
 * assertion. Production code never calls this — the controller resets
 * itself in `model:generate`'s `finally` block.
 */
export function _resetActiveGenerationControllerForTests(): void {
  activeGenerationController = null;
}

export function registerModelHandlers(): void {
  idempotentHandle("model:status", async () => {
    const bridge = getBridge();
    if (bridge && bridge.bridgeIsModelLoaded()) {
      return {
        available: true,
        modelName: "Ternary-Bonsai",
        status: "running",
      } as ModelStatus;
    }
    return {
      available: false,
      modelName: null,
      status: "stopped",
    } as ModelStatus;
  });

  idempotentHandle("model:start", async (_event, modelPath: unknown) => {
    const validated = assertString(modelPath, "modelPath", { maxLen: 4096 });
    const bridge = getBridge();
    if (!bridge) throw new Error("Native bridge not available");
    if (bridge.bridgeIsModelLoaded()) return;
    try {
      await access(validated);
    } catch {
      throw new Error(`Model file not found on disk: ${validated}`);
    }
    await enforceSidecarExclusivity("text");
    bridge.bridgeLoadModel(validated);
    try {
      bridge.bridgeLogModelStarted(validated);
    } catch {
      // best-effort
    }
  });

  idempotentHandle("model:stop", async () => {
    const bridge = getBridge();
    if (bridge && bridge.bridgeIsModelLoaded()) {
      bridge.bridgeUnloadModel();
      try {
        bridge.bridgeLogModelStopped("user-requested");
      } catch {
        // best-effort
      }
    }
  });

  idempotentHandle("model:generate", async (event, request: unknown) => {
    const parsed = GenerateRequestSchema.parse(request);

    // Resolve the dispatch target up front (this is a pure, synchronous
    // read of the external-provider config + keychain state) so the
    // battery gate below can branch on it.
    const adapter = resolveGenerationAdapter();

    // LW-3: pause synthesis when the device is on a low battery (≤20%
    // and discharging). Resolve a typed sentinel INSTEAD of starting a
    // stream so the renderer can show "Generation paused — battery
    // below 20%" rather than hanging on a token that never arrives. We
    // check before touching the AbortController slot / sidecar so a
    // gated call leaves no half-set-up generation state behind.
    // `isBatteryLow()` fails open — desktops, AC power, and unknown
    // battery state all return false — so this never blocks generation
    // on a plugged-in or non-laptop host.
    //
    // The gate applies ONLY to the local llama-server sidecar, which is
    // the actual battery cost: a local generation pegs CPU/GPU for the
    // duration. External-provider generation runs entirely on the
    // remote API — local power use is just network + token rendering,
    // negligible next to the screen already being on — so gating it
    // would needlessly block a user who deliberately configured a cloud
    // provider precisely to offload compute (arguably the *right* thing
    // to do on a dying battery). See PR #105 review thread.
    if (adapter.kind !== "external" && isBatteryLow()) {
      return { status: "battery_low" as const };
    }

    // Dispatch decision:
    //
    //   1. If the External Provider is enabled, configured and has a
    //      keychain-resident API key, route generation there and stream
    //      tokens via `model:token` using the shared SSE parser in
    //      `externalProviderStream.ts`.
    //   2. Otherwise fall back to the local llama-server sidecar (the
    //      original behaviour). The renderer doesn't need to know which
    //      adapter served the call — the `model:token` channel shape is
    //      identical.
    //
    // The two paths share the same destroyed-window-safe sender, the
    // same `activeGenerationController` AbortController slot (so a
    // single in-flight generation cancels cleanly on switch), and the
    // same `sentDone` finality bookkeeping.

    // Abort any in-flight generation before starting a new one
    if (activeGenerationController) {
      activeGenerationController.abort();
    }
    const controller = new AbortController();
    activeGenerationController = controller;

    // Route every `model:token` send through `safeRendererSender` so
    // the channel is best-effort and `finally` cleanup is
    // deterministic regardless of renderer state — see the doc
    // comment on `safeRendererSender` for the destroyed-window
    // rationale.
    const sendToken = safeRendererSender<{ token: string; done: boolean }>(
      event,
      "model:token",
    );
    let sentDone = false;

    if (adapter.kind === "external") {
      // Token-usage accounting for the optional external provider.
      //
      // We use a CLIENT-SIDE heuristic (see `tokenCounter.ts`)
      // rather than the provider's authoritative `usage` field
      // because OpenAI's `chat.completion.chunk.usage` requires
      // `stream_options.include_usage = true` (not supported by
      // every OpenAI-compatible proxy — Ollama, vLLM, LM Studio,
      // llama-server OpenAI shim — so turning it on would
      // silently degrade routing) and Anthropic's `usage` lives
      // in `message_start` / `message_delta` events we currently
      // treat as opaque framing.
      //
      // The prompt-token estimate is computed ONCE at the start.
      // Response-token estimates accumulate per delivered chunk
      // (NOT per byte; chunks already align with token boundaries
      // for OpenAI-compatible deltas, and Anthropic deltas
      // similarly align). We persist the cumulative usage
      // exactly ONCE per stream — in the `finally` block —
      // because writing on every chunk would amplify disk I/O
      // 100x for a 100-token completion and would race the IPC
      // settings handlers if the renderer happens to read the
      // counter mid-stream. The end-of-stream write captures the
      // final cumulative value.
      const promptTokens = estimateTokens(parsed.prompt);
      // Accumulate the streamed completion text as a single string
      // and call `estimateTokens` ONCE on the concatenation in the
      // `finally` block. The earlier implementation summed
      // `estimateTokens(chunk.content)` per chunk, but `estimateTokens`
      // uses `Math.ceil(length / CHARS_PER_TOKEN)` with a floor of
      // `MIN_TOKENS_FOR_NON_EMPTY = 1`, so applying it independently
      // to each short SSE delta (typically 1–6 chars) systematically
      // over-counted. Concrete example: `"Hello"` + `", "` +
      // `"world"` per-chunk yields
      // `ceil(5/4) + ceil(1/4) + ceil(5/4) = 2+1+2 = 5` tokens, but
      // the concatenated `"Hello, world"` yields `ceil(12/4) = 3`. For
      // typical OpenAI streaming (many short chunks) the cumulative
      // over-count is 40–60% of the bulk estimate, which inflated the
      // `"~N tokens used"` display in `SettingsPage` and would mislead
      // a user trying to track their actual provider spend.
      //
      // Buffering the full completion text in memory is acceptable
      // here: a single generation is bounded by `parsed.maxTokens`
      // (and the schema clamps that to a sensible ceiling), so the
      // buffer never exceeds a few tens of KB of UTF-16. The
      // alternative — tracking raw char count and applying the
      // `Math.ceil(chars / CHARS_PER_TOKEN)` formula directly here —
      // would lose the whitespace normalisation that `estimateTokens`
      // performs (collapsing runs of whitespace to a single space
      // before counting), which matters because providers compress
      // whitespace before tokenising. Keeping the single
      // `estimateTokens` call preserves bulk-vs-streaming
      // consistency: the counter increments by the same value
      // whether the response arrived as one chunk or fifty.
      let completionText = "";
      // Tracks whether the upstream stream body actually opened
      // (i.e. the provider returned a 2xx response and we have a
      // readable body). Pre-stream failures — HTTP 401/403/400,
      // retry-exhausted 5xx, DNS errors, TLS errors — surface as a
      // throw from `streamExternalProvider` BEFORE the body-opened
      // callback runs. In those cases the upstream provider never
      // processed the prompt and the user was never billed, so we
      // MUST NOT inflate the cumulative-usage counter by
      // `promptTokens`. A user who misconfigures their API key and
      // repeatedly retries would otherwise see the counter climb
      // without any actual provider spend, making the "used since
      // <date>" display misleading.
      //
      // The flag is set via the third `streamExternalProvider`
      // argument (the `onBodyOpened` callback), NOT via the emit
      // callback — the SSE dispatchers in `externalProviderStream.ts`
      // intentionally filter framing-only events (role-only deltas,
      // content_block_start, message_start, ping) BEFORE calling
      // emit, so a provider that accepts the request and then errors
      // mid-stream without ever emitting non-empty content would NOT
      // trigger emit even though the prompt was processed and
      // billed. Hooking the gate to the body-opened signal in
      // `streamExternalProvider` instead of the emit-content path
      // captures the architectural ground truth: "the upstream
      // accepted the request" → "count the prompt tokens", regardless
      // of subsequent SSE shape.
      let streamOpened = false;
      try {
        await streamExternalProvider(
          {
            provider: adapter.provider,
            apiKey: adapter.apiKey,
            prompt: parsed.prompt,
            maxTokens: parsed.maxTokens,
            temperature: parsed.temperature,
            signal: controller.signal,
          },
          (chunk: ExternalProviderStreamChunk) => {
            if (chunk.content.length > 0) {
              completionText += chunk.content;
              sendToken({ token: chunk.content, done: false });
            }
          },
          () => {
            // Fires exactly once when the HTTP body is confirmed
            // open in `streamExternalProvider`. See the comment block
            // above for why this is the correct gate (instead of the
            // emit callback).
            streamOpened = true;
          },
        );
      } finally {
        if (activeGenerationController === controller) {
          activeGenerationController = null;
        }
        if (!sentDone) {
          sendToken({ token: "", done: true });
          sentDone = true;
        }
        // Persist the cumulative usage delta ONLY if the upstream
        // body actually opened. This runs even on mid-stream
        // failure (network drop, abort) so a partial completion
        // still counts the tokens the user actually received —
        // they were billed for those tokens by the upstream
        // provider regardless of whether the stream completed
        // cleanly. Errors during the config write are swallowed
        // because (1) the disk write is best-effort for an
        // informational counter and (2) propagating them would
        // mask the original generation error.
        if (streamOpened) {
          try {
            // Single bulk `estimateTokens` call on the concatenated
            // completion text — NOT a per-chunk sum (see the long
            // comment near `completionText`'s declaration for the
            // over-counting rationale). The empty-text branch is
            // handled inside `estimateTokens` (returns 0 for
            // length-0 input), so a stream that opened but never
            // delivered non-empty content cleanly records 0
            // completion tokens — NOT the `MIN_TOKENS_FOR_NON_EMPTY`
            // floor that a per-chunk `estimateTokens("")` would have
            // hit had we still been summing.
            const completionTokens = estimateTokens(completionText);
            const current = loadConfig();
            const previous: ExternalProviderTokenUsage =
              current.externalProviderTokenUsage;
            const next = accumulateTokenUsage(previous, {
              promptTokens,
              completionTokens,
            });
            updateConfig({ externalProviderTokenUsage: next });
          } catch {
            // Best-effort; see comment above.
          }
        }
      }
      return;
    }

    const bridge = getBridge();
    if (!bridge || !bridge.bridgeIsModelLoaded()) {
      if (activeGenerationController === controller) {
        activeGenerationController = null;
      }
      sendToken({ token: "", done: true });
      throw new Error("Model runtime not running — start a model first");
    }

    try {
      await bridge.bridgeGenerateText(
        parsed.prompt,
        parsed.maxTokens ?? 2048,
        parsed.temperature ?? 0.7,
        (tok) => {
          sendToken({ token: tok.token, done: tok.done });
          if (tok.done) sentDone = true;
        },
      );
    } finally {
      if (activeGenerationController === controller) {
        activeGenerationController = null;
      }
      if (!sentDone) {
        sendToken({ token: "", done: true });
      }
    }
  });

  idempotentHandle("model:cancelJob", async () => {
    if (activeGenerationController) {
      activeGenerationController.abort();
    }
  });
}

/**
 * Pick the adapter to use for the next `model:generate` call.
 *
 * External provider wins iff: enabled, all required fields are
 * populated, AND a non-empty API key exists in the OS keychain under
 * `apiKeyRef`. The presence-of-key check happens here so the handler
 * can fall back to local before opening a network socket — a missing
 * keychain entry would otherwise produce a cryptic 401 from the
 * provider after the renderer already thought streaming had started.
 *
 * All three failure modes (disabled, missing config field, missing
 * key) collapse to `kind: "local"`. This mirrors how
 * `crates/tessera_runtime::adapters::plan_chain` treats the External
 * step — both layers agree on the same fallback policy.
 *
 * Hoisted out of `registerModelHandlers()` so its closure binding is
 * stable across re-registrations (test harness, future hot-reload),
 * matching the rationale on `activeGenerationController` above.
 */
function resolveGenerationAdapter():
  | { kind: "local" }
  | { kind: "external"; provider: ExternalProviderConfig; apiKey: string } {
  const cfg = loadConfig();
  const provider = cfg.externalProvider;
  if (!provider) {
    return { kind: "local" };
  }
  // Surface each fallback reason at `info` level so post-mortem
  // debugging from a packaged build doesn't require reproducing the
  // misconfiguration. The default Electron log destination
  // (`<userData>/logs/main.log`) preserves these without exposing them
  // to the renderer or telemetry. We deliberately do NOT include the
  // API URL or model name verbatim — those can leak private endpoints.
  if (!provider.enabled) {
    return { kind: "local" };
  }
  const missing: string[] = [];
  if (!provider.apiUrl.trim()) missing.push("apiUrl");
  if (!provider.modelName.trim()) missing.push("modelName");
  if (!provider.apiKeyRef.trim()) missing.push("apiKeyRef");
  if (missing.length > 0) {
    console.info(
      `[tessera] external provider enabled but config incomplete (missing: ${missing.join(", ")}); falling back to local sidecar`,
    );
    return { kind: "local" };
  }
  let apiKey: string | null = null;
  try {
    apiKey = secretsVault.getSecret(provider.apiKeyRef);
  } catch (err) {
    // A keychain read failure (e.g. user revoked Tessera's access to
    // the OS keychain) should fall back to local rather than surfacing
    // a confusing "secretsVault read failed" to the renderer
    // mid-generation. The Settings page already has its own diagnostic
    // surface for this.
    console.warn(
      `[tessera] external provider secret read failed; falling back to local: ${(err as Error).message}`,
    );
    return { kind: "local" };
  }
  if (!apiKey || apiKey.length === 0) {
    console.info(
      `[tessera] external provider enabled but no API key stored under '${provider.apiKeyRef}'; falling back to local sidecar`,
    );
    return { kind: "local" };
  }
  return { kind: "external", provider, apiKey };
}
