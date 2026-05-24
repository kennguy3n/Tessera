import { ChildProcess, spawn, SpawnOptions } from "child_process";
import * as fs from "fs";
import * as path from "path";
import { buildSpawnEnv } from "./sidecar";

/**
 * Diffusion sidecar configuration. Mirrors the shape of
 * [`SidecarOptions`](./sidecar.ts) but targets `sd-server` from
 * `leejet/stable-diffusion.cpp` rather than `llama-server`. The two
 * sidecars have superficially similar lifecycles (spawn detached on
 * POSIX, deliver SIGTERM/SIGKILL through the process group, idle-unload
 * after N seconds, restart with exponential back-off) but the argv
 * conventions, default port, and idle behaviour differ enough that we
 * keep them in separate files rather than wedging a polymorphic
 * "ServerKind" enum into `ModelSidecar`.
 *
 * Key argv differences from llama-server:
 *
 *   `sd-server --model <path>           --port <N>          --host <ip>`
 *
 * is the same triple llama-server uses, but sd-server adds:
 *
 *   `--steps <N>`        – diffusion steps; default 20 for FLUX.2-klein.
 *   `--cfg-scale <F>`    – classifier-free guidance scale.
 *   `--output-format <fmt>` – png / jpg; we always use png so the
 *                            renderer can `<img src="file://...">` it
 *                            directly without a re-encode step.
 *
 * Idle-unload defaults to 30 s here (vs. 60 s for the text sidecar)
 * because diffusion models are ~10× larger than text-gen models and
 * user interaction is bursty — the user clicks "Generate image",
 * waits for the result, edits the prompt, generates again. The 30 s
 * window covers the natural prompt-edit pause without keeping ~6 GB
 * of GPU VRAM locked while the user is doing something else.
 */
export interface DiffusionSidecarOptions {
  binaryPath: string;
  modelPath: string;
  port: number;
  healthCheckIntervalMs: number;
  idleUnloadMs: number;
  /**
   * Diffusion steps. FLUX.2-klein is calibrated for 20 steps in its
   * default configuration — more steps yield diminishing returns and
   * just burn GPU time. Anything below 12 produces visible noise.
   */
  steps: number;
  /**
   * Classifier-free guidance scale. 7.5 is the stable-diffusion.cpp
   * default; FLUX models are typically tuned lower (3.5–4.5) for less
   * over-saturation, but the per-request `cfg_scale` override in the
   * generation API beats this default when callers care.
   */
  cfgScale: number;
  /**
   * Extra CLI flags to append AFTER the core triple, mirroring
   * `SidecarOptions.extraArgs`. Used for things like
   * `--diffusion-fa` (FlashAttention) or `--rng cuda` overrides.
   */
  extraArgs: string[];
  /**
   * Diagnostic log label — distinct from the text/vision sidecar so
   * multi-sidecar deployments emit separable log lines.
   */
  label: string;
}

const DEFAULT_OPTIONS: DiffusionSidecarOptions = {
  binaryPath: "sd-server",
  modelPath: "",
  port: 8386,
  healthCheckIntervalMs: 5000,
  // Diffusion idle-unload is aggressive: 30 s vs. 60 s for text/vision.
  // Diffusion model weights are 2–10× larger than text models and
  // sit on the GPU while loaded; users typically interact in
  // generate / edit / re-generate bursts that finish within 30 s of
  // the previous generation completing.
  idleUnloadMs: 30_000,
  steps: 20,
  cfgScale: 3.5,
  extraArgs: [],
  label: "diffusion",
};

const MAX_RESTART_RETRIES = 5;
const STARTUP_GRACE_MS = 60_000;

/**
 * Manages the lifecycle of an out-of-process `sd-server` instance.
 *
 * Parallel implementation of [`ModelSidecar`](./sidecar.ts) for image
 * generation. Kept separate rather than refactored into a shared base
 * class because:
 *
 *   1. The argv contract is genuinely different (`--steps`,
 *      `--cfg-scale`, `--output-format` have no analogue in
 *      llama-server), and a parameterised base class would devolve
 *      into per-backend conditionals at every spawn.
 *   2. The idle-unload window is a different order of magnitude (30 s
 *      vs. 60 s) — sharing the constant would force callers to
 *      remember to override it every time, which is a footgun.
 *   3. The startup-time semantics diverge — llama-server loads a
 *      few hundred MB and is warm in ~3 s; FLUX.2-klein loads ~6 GB
 *      and takes 15–30 s on GPU. The startup-grace period is a
 *      legitimate runtime-policy difference.
 *
 * The detached-spawn + `unref()` + synchronous `process.on("exit")`
 * SIGKILL fallback are duplicated VERBATIM from `ModelSidecar` so the
 * lifecycle-orphan guarantees the text sidecar gets (PR #18's
 * lifecycle regression tests) also apply here.
 */
export class DiffusionSidecar {
  private process: ChildProcess | null = null;
  private options: DiffusionSidecarOptions;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRequestTime: number = 0;
  private _isRunning: boolean = false;
  private _isTerminating: boolean = false;
  private restartCount: number = 0;
  private startTime: number = 0;
  private restartTimer: ReturnType<typeof setTimeout> | null = null;
  private _generationActiveCount: number = 0;
  private crashCleanupHandler: (() => void) | null = null;

  constructor(options: Partial<DiffusionSidecarOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  get endpoint(): string {
    return `http://127.0.0.1:${this.options.port}`;
  }

  get steps(): number {
    return this.options.steps;
  }

  get cfgScale(): number {
    return this.options.cfgScale;
  }

  get label(): string {
    return this.options.label;
  }

  setModelPath(modelPath: string): void {
    if (this._isRunning) {
      throw new Error("Cannot change model path while diffusion sidecar is running");
    }
    this.options.modelPath = modelPath;
  }

  /**
   * Build the full argv passed to `spawn`. Exported on the instance
   * (via `buildSpawnArgs`) so the per-instance defaults remain
   * encapsulated, but exposed for tests to assert that --steps /
   * --cfg-scale / --output-format are wired correctly without
   * actually executing the binary.
   */
  buildSpawnArgs(): string[] {
    return [
      "--model",
      this.options.modelPath,
      "--port",
      this.options.port.toString(),
      "--host",
      "127.0.0.1",
      "--steps",
      this.options.steps.toString(),
      "--cfg-scale",
      this.options.cfgScale.toString(),
      "--output-format",
      "png",
      ...this.options.extraArgs,
    ];
  }

  async start(resetRetries = false): Promise<void> {
    if (this._isRunning) return;
    if (resetRetries) this.restartCount = 0;

    if (!this.options.modelPath) {
      throw new Error("Model path is required to start the diffusion sidecar");
    }

    const spawnOpts: SpawnOptions = {
      env: buildSpawnEnv(this.options.binaryPath),
      // Detach on POSIX for process-group signalling (mirrors
      // ModelSidecar — same rationale).
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    };
    this.process = spawn(this.options.binaryPath, this.buildSpawnArgs(), spawnOpts);

    // Mirror ModelSidecar's lifecycle-orphan mitigations exactly:
    //   1. unref() so the detached child doesn't pin Node's event
    //      loop after an abnormal main-process exit.
    //   2. Synchronous process.on("exit") fallback that SIGKILLs the
    //      child's process group so the diffusion process doesn't
    //      survive the parent as an orphan holding port 8386.
    if (process.platform !== "win32" && typeof this.process.pid === "number") {
      this.process.unref();
      const pid = this.process.pid;
      const handler = () => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // ESRCH on Linux/macOS = already exited; harmless.
        }
      };
      process.on("exit", handler);
      this.crashCleanupHandler = handler;
    }

    this.process.on("exit", (code) => {
      this._isRunning = false;
      this.stopHealthCheck();
      this.stopIdleMonitor();
      this.clearCrashCleanup();
      if (this._isTerminating) return;
      if (code !== 0 && code !== null) {
        this.restartCount++;
        if (this.restartCount <= MAX_RESTART_RETRIES) {
          const delay = Math.min(3000 * Math.pow(2, this.restartCount - 1), 60_000);
          this.restartTimer = setTimeout(() => {
            this.restartTimer = null;
            this.start().catch(() => {});
          }, delay);
        }
      }
    });

    this.process.on("error", () => {
      this._isRunning = false;
      this.stopHealthCheck();
      this.stopIdleMonitor();
      // Mirror the `exit` handler: drop the synchronous SIGKILL
      // fallback so a future abnormal Node-process exit doesn't
      // try to SIGKILL a PID that already failed to spawn. In
      // practice the `try/catch` inside the handler swallows the
      // resulting ESRCH, but registering one process.on("exit")
      // listener per failed spawn slowly leaks listener slots if
      // the binary path is wrong and the sidecar keeps restarting
      // — Node prints a MaxListenersExceededWarning at 10.
      this.clearCrashCleanup();
    });

    this._isRunning = true;
    this.lastRequestTime = Date.now();
    this.startTime = Date.now();
    this.startHealthCheck();
    this.startIdleMonitor();
  }

  async stop(): Promise<void> {
    this._isTerminating = true;
    if (this.restartTimer) {
      clearTimeout(this.restartTimer);
      this.restartTimer = null;
    }
    this.stopHealthCheck();
    this.stopIdleMonitor();

    if (this.process) {
      sendSignal(this.process, process.platform === "win32" ? "SIGKILL" : "SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) sendSignal(this.process, "SIGKILL");
          resolve();
        }, 5000);
        if (this.process) {
          this.process.on("exit", () => {
            clearTimeout(timeout);
            resolve();
          });
        } else {
          clearTimeout(timeout);
          resolve();
        }
      });
      this.process = null;
    }
    this.clearCrashCleanup();
    this._isRunning = false;
    this._isTerminating = false;
  }

  private clearCrashCleanup(): void {
    if (this.crashCleanupHandler) {
      process.removeListener("exit", this.crashCleanupHandler);
      this.crashCleanupHandler = null;
    }
  }

  async healthCheck(): Promise<boolean> {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 3000);
      const response = await fetch(`${this.endpoint}/health`, {
        signal: controller.signal,
      });
      clearTimeout(timeout);
      return response.ok;
    } catch {
      return false;
    }
  }

  /**
   * Poll `/health` until the sd-server HTTP listener is accepting
   * connections, then return. Mirrors
   * [`ModelSidecar.waitForReady`](./sidecar.ts) — see that JSDoc
   * for the full rationale. sd-server's cold-start is much longer
   * than llama-server's (15-30 s to load ~6 GB of FLUX weights vs.
   * 1-3 s for ~3 GB of llama text weights), so this guard is
   * proportionally more important here: without it the very first
   * `imagegen:generate` after a cold start would race the listener
   * bind and reject with `ECONNREFUSED`, surfacing as a confusing
   * "image generation failed" error to a user who is correctly
   * waiting for a slow operation.
   */
  async waitForReady(timeoutMs: number = STARTUP_GRACE_MS): Promise<boolean> {
    if (!this._isRunning) return false;
    const deadline = Date.now() + timeoutMs;
    const pollInterval = Math.min(500, this.options.healthCheckIntervalMs);
    while (Date.now() < deadline) {
      if (!this._isRunning) return false;
      if (await this.healthCheck()) return true;
      await new Promise((r) => setTimeout(r, pollInterval));
    }
    return false;
  }

  recordActivity(): void {
    this.lastRequestTime = Date.now();
  }

  markGenerationActive(): void {
    this._generationActiveCount++;
    this.lastRequestTime = Date.now();
  }

  markGenerationIdle(): void {
    this._generationActiveCount = Math.max(0, this._generationActiveCount - 1);
    this.lastRequestTime = Date.now();
  }

  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(async () => {
      if (this._isRunning) {
        const healthy = await this.healthCheck();
        if (healthy) {
          this.restartCount = 0;
        } else if (this._isRunning) {
          if (Date.now() - this.startTime < STARTUP_GRACE_MS) return;
          this.restartCount++;
          if (this.restartCount > MAX_RESTART_RETRIES) {
            await this.stop();
            return;
          }
          await this.stop();
          await this.start();
        }
      }
    }, this.options.healthCheckIntervalMs);
  }

  private stopHealthCheck(): void {
    if (this.healthCheckTimer) {
      clearInterval(this.healthCheckTimer);
      this.healthCheckTimer = null;
    }
  }

  private startIdleMonitor(): void {
    this.idleTimer = setInterval(async () => {
      const idleTime = Date.now() - this.lastRequestTime;
      if (
        idleTime > this.options.idleUnloadMs &&
        this._isRunning &&
        this._generationActiveCount === 0
      ) {
        await this.stop();
      }
    }, 10_000);
  }

  private stopIdleMonitor(): void {
    if (this.idleTimer) {
      clearInterval(this.idleTimer);
      this.idleTimer = null;
    }
  }
}

/**
 * POSIX process-group signal helper. Identical contract to the one in
 * `sidecar.ts` — duplicated rather than shared so each sidecar file
 * is self-contained and a developer reading `diffusionSidecar.ts`
 * doesn't have to chase symbols across modules. Total cost: ~20
 * lines duplicated.
 */
function sendSignal(child: ChildProcess, signal: NodeJS.Signals): void {
  if (process.platform === "win32") {
    try {
      child.kill();
    } catch {
      // Already gone.
    }
    return;
  }
  try {
    if (typeof child.pid === "number") {
      process.kill(-child.pid, signal);
    } else {
      child.kill(signal);
    }
  } catch {
    // ESRCH (already exited) is harmless.
  }
}

/**
 * Resolve the path to the bundled `sd-server` binary. Mirrors the
 * resolution scheme used by `resolveSidecarBinary()` in `appState.ts`
 * for llama-server: check the packaged `resourcesPath`, then dev
 * fallbacks relative to `app.getAppPath()` and `__dirname`. Kept
 * here (not in `appState.ts`) because the binary-search candidates
 * are sd-server–specific and should not leak into the
 * llama-server resolver.
 *
 * The `appPath` argument is injected so this function is testable
 * without booting Electron; in production callers pass
 * `app.getAppPath()`.
 */
export function resolveDiffusionBinary(
  appPath: string,
  scriptDirname: string,
  resourcesPath?: string,
): string {
  const ext = process.platform === "win32" ? ".exe" : "";
  const binaryName = `sd-server${ext}`;
  // electron-builder copies sidecars/sd-server/ into
  // resourcesPath/sidecars/sd-server for packaged builds; dev builds
  // walk up from __dirname (which is dist-electron/electron/ at
  // runtime — see appState.ts:resolveSidecarBinary for the full
  // explanation of why this needs three levels of ".." to reach the
  // repo root in the dev layout).
  const candidates = [
    resourcesPath ? path.join(resourcesPath, "sidecars", "sd-server", binaryName) : null,
    path.join(appPath, "sidecars", "sd-server", binaryName),
    path.join(appPath, "..", "sidecars", "sd-server", binaryName),
    path.join(scriptDirname, "..", "..", "sidecars", "sd-server", binaryName),
    path.join(
      scriptDirname,
      "..",
      "..",
      "..",
      "sidecars",
      "sd-server",
      binaryName,
    ),
  ].filter((p): p is string => typeof p === "string");
  // Iterate the candidate list and pick the first path that actually
  // exists, mirroring `resolveSidecarBinary()` in `appState.ts`.
  // Returning the first candidate unconditionally would fail with
  // ENOENT on any deployment (notably dev) where the binary lives at a
  // later candidate — the resourcesPath candidate is built
  // unconditionally when resourcesPath is provided, but in dev that
  // directory doesn't exist.
  for (const candidate of candidates) {
    if (fs.existsSync(candidate)) return candidate;
  }
  // No candidate exists. Return the bare binary name and let PATH
  // resolution (or the eventual `spawn()` ENOENT) surface the failure
  // — matches the fallthrough in `resolveSidecarBinary()`.
  return binaryName;
}
