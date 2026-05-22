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
import { idempotentHandle } from "./register";
import { getModelSidecar } from "../appState";
import type { ModelStatus } from "../../shared/types";
import { assertString } from "./validate";
import { GenerateRequestSchema } from "./schemas";

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

export function registerModelHandlers(): void {
  idempotentHandle("model:status", async () => {
    const sidecar = getModelSidecar();
    if (sidecar && sidecar.isRunning) {
      const healthy = await sidecar.healthCheck();
      return {
        available: true,
        modelName: "Ternary-Bonsai",
        status: healthy ? "running" : "loading",
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
    const sidecar = getModelSidecar();
    if (!sidecar) throw new Error("Model sidecar not initialized");
    if (sidecar.isRunning) return;
    sidecar.setModelPath(validated);
    await sidecar.start(true);
  });

  idempotentHandle("model:stop", async () => {
    const sidecar = getModelSidecar();
    if (sidecar && sidecar.isRunning) {
      await sidecar.stop();
    }
  });

  let activeGenerationController: AbortController | null = null;

  idempotentHandle("model:generate", async (event, request: unknown) => {
    const parsed = GenerateRequestSchema.parse(request);
    const sidecar = getModelSidecar();
    if (!sidecar || !sidecar.isRunning) {
      throw new Error("Model runtime not running — start a model first");
    }
    sidecar.markGenerationActive();
    const endpoint = sidecar.endpoint;
    const body = {
      prompt: parsed.prompt,
      n_predict: parsed.maxTokens ?? 2048,
      temperature: parsed.temperature ?? 0.7,
      stream: true,
    };

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

    try {
      const resp = await fetch(`${endpoint}/completion`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(body),
        signal: controller.signal,
      });

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Generation failed: HTTP ${resp.status} — ${text}`);
      }

      const reader = resp.body?.getReader();
      if (!reader) throw new Error("No response body");

      const decoder = new TextDecoder();
      let lineBuffer = "";
      let streamDone = false;

      for (;;) {
        const { done, value } = await reader.read();
        if (done || streamDone) break;
        sidecar.recordActivity();
        lineBuffer += decoder.decode(value, { stream: true });
        const lines = lineBuffer.split("\n");
        lineBuffer = lines.pop() ?? "";
        for (const line of lines) {
          if (!line.startsWith("data: ")) continue;
          const data = line.slice(6);
          if (data === "[DONE]") {
            sendToken({ token: "", done: true });
            sentDone = true;
            streamDone = true;
            break;
          }
          try {
            const parsedChunk = JSON.parse(data) as {
              content?: string;
              stop?: boolean;
            };
            sendToken({
              token: parsedChunk.content ?? "",
              done: parsedChunk.stop ?? false,
            });
            if (parsedChunk.stop) {
              sentDone = true;
              streamDone = true;
              break;
            }
          } catch {
            // skip unparseable SSE lines
          }
        }
      }
    } finally {
      sidecar.markGenerationIdle();
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
