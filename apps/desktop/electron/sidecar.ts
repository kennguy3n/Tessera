import { ChildProcess, spawn, SpawnOptions } from "child_process";
import * as path from "path";

export interface SidecarOptions {
  binaryPath: string;
  modelPath: string;
  port: number;
  healthCheckIntervalMs: number;
  idleUnloadMs: number;
  /**
   * Extra CLI flags to append to the llama-server invocation, AFTER the
   * core `--model / --port / --host` triple. Used to carry:
   *
   *   - `--mmproj <path>` for the vision sidecar (the multimodal
   *     projector file ships alongside VLM weights and tells
   *     llama-server which vision tower to load).
   *   - `--parallel 1` for memory-constrained low-tier vision
   *     (SmolVLM 256M targets <=1 GB RAM machines; parallel=1
   *     halves the KV-cache budget over the default).
   *   - `--ctx-size <N>` overrides per-capability (vision contexts
   *     are typically smaller than text contexts).
   *
   * Empty by default so the text sidecar's existing behaviour is
   * unchanged.
   */
  extraArgs: string[];
  /**
   * Diagnostic label used in log lines so the multi-sidecar
   * deployments (text + vision + diffusion) emit distinguishable
   * output. Free-form; never parsed.
   */
  label: string;
  /**
   * Platform the sidecar should target for spawn-options shape
   * (`detached`, POSIX-vs-Windows process-group signalling, the
   * synchronous `exit` SIGKILL fallback). Defaults to
   * `process.platform` so production code is unchanged; exposed as
   * an option so tests can pin per-platform behaviour deterministically
   * WITHOUT mutating `process.platform` via `Object.defineProperty`
   * (the mutation pattern is safe under the default vitest worker
   * model but breaks under `--pool=threads` with shared worker pools).
   * Per Devin Review PR #55 Finding 6 follow-up.
   */
  platform: NodeJS.Platform;
}

/**
 * `platform` is excluded from this module-scope default because
 * `process.platform` is itself a process-level immutable value
 * (Node freezes it at startup); the per-instance default is
 * computed inside the constructor so the type system enforces
 * `SidecarOptions.platform` being present on every constructed
 * `ModelSidecar` even though callers omit it.
 */
const DEFAULT_OPTIONS: Omit<SidecarOptions, "platform"> = {
  binaryPath: "llama-server",
  modelPath: "",
  port: 8384,
  healthCheckIntervalMs: 5000,
  idleUnloadMs: 60_000,
  extraArgs: [],
  label: "text",
};

const MAX_RESTART_RETRIES = 5;
const STARTUP_GRACE_MS = 60_000;

/**
 * Build platform-specific spawn options. On Linux the llama-server binary may
 * sit next to required shared libraries (libllama.so) — we prepend the binary
 * directory to LD_LIBRARY_PATH so the dynamic linker finds them. macOS uses
 * @loader_path-relative install names and Windows uses the binary directory as
 * a DLL search path automatically, so no extra env is needed there.
 *
 * Accepts an optional `platform` parameter so tests can pin each branch
 * deterministically WITHOUT mutating `process.platform` via
 * `Object.defineProperty`. Production callers omit it and read from
 * `process.platform`. Per Devin Review PR #55 Finding 6 follow-up.
 */
export function buildSpawnEnv(
  binaryPath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
  platform: NodeJS.Platform = process.platform,
): NodeJS.ProcessEnv {
  if (platform !== "linux") return { ...baseEnv };
  const binaryDir = path.dirname(binaryPath);
  const existing = baseEnv.LD_LIBRARY_PATH ?? "";
  const ldLibraryPath = existing ? `${binaryDir}:${existing}` : binaryDir;
  return { ...baseEnv, LD_LIBRARY_PATH: ldLibraryPath };
}

export class ModelSidecar {
  private process: ChildProcess | null = null;
  private options: SidecarOptions;
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

  constructor(options: Partial<SidecarOptions> = {}) {
    // `platform` defaults to the live `process.platform` at construction
    // time. Production code constructs sidecars once at app startup so
    // capturing it here is observationally identical to reading it
    // lazily on every `start()` call. Tests inject a fixed `platform`
    // via `options` to pin per-platform behaviour without process-level
    // mutation. Per Devin Review PR #55 Finding 6 follow-up.
    this.options = {
      ...DEFAULT_OPTIONS,
      platform: process.platform,
      ...options,
    };
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  get endpoint(): string {
    return `http://127.0.0.1:${this.options.port}`;
  }

  setModelPath(modelPath: string): void {
    if (this._isRunning) {
      throw new Error("Cannot change model path while sidecar is running");
    }
    this.options.modelPath = modelPath;
  }

  /**
   * Replace the appended llama-server CLI flags. Same precondition as
   * `setModelPath`: cannot be changed while running because flags are
   * baked into the `spawn` argv at start time and the process would
   * have to be restarted to pick up a new value. Callers that need
   * to re-flag mid-session must `await stop()` first.
   *
   * Used by `appState` when switching the vision model: the
   * `--mmproj <path>` flag is per-model (Qwen3.5 and SmolVLM ship
   * their own projector files) so it must be updated alongside
   * `setModelPath`.
   */
  setExtraArgs(extraArgs: string[]): void {
    if (this._isRunning) {
      throw new Error("Cannot change extra args while sidecar is running");
    }
    this.options.extraArgs = [...extraArgs];
  }

  get extraArgs(): string[] {
    return [...this.options.extraArgs];
  }

  get label(): string {
    return this.options.label;
  }

  async start(resetRetries = false): Promise<void> {
    if (this._isRunning) return;
    if (resetRetries) this.restartCount = 0;

    if (!this.options.modelPath) {
      throw new Error("Model path is required to start the sidecar");
    }

    const spawnOpts: SpawnOptions = {
      env: buildSpawnEnv(
        this.options.binaryPath,
        process.env,
        this.options.platform,
      ),
      // Detach on POSIX so we can deliver SIGTERM/SIGKILL to the whole process
      // group; on Windows leave the default tied to the parent.
      detached: this.options.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    };
    // Core arg triple comes first so any --model / --port / --host the
    // caller fat-fingers into `extraArgs` is ignored by llama-server
    // (it uses the first occurrence). `extraArgs` carries vision-only
    // flags (--mmproj, --parallel, --ctx-size); empty for the text
    // sidecar so behaviour is unchanged there.
    this.process = spawn(
      this.options.binaryPath,
      [
        "--model",
        this.options.modelPath,
        "--port",
        this.options.port.toString(),
        "--host",
        "127.0.0.1",
        ...this.options.extraArgs,
      ],
      spawnOpts,
    );

    // On POSIX the child was spawned with `detached: true` so we can deliver
    // signals to the whole process group via `process.kill(-pid, ...)`. That
    // also means the child becomes a process-group leader of its own session
    // and survives the parent's death by default. Two follow-on fixes are
    // required to make this safe:
    //
    //   1. `unref()` so Node's event loop doesn't keep a reference to the
    //      child handle — without this, an abnormal main-process shutdown
    //      (uncaughtException default-exit, explicit `process.exit()` from
    //      a fatal error path, the renderer crashing the main process)
    //      would block Node from terminating while waiting on the child
    //      that we intentionally detached.
    //   2. A synchronous `exit` handler that delivers SIGKILL to the child's
    //      process group when the parent dies without going through our
    //      normal `stop()` path. Node 'exit' listeners must be synchronous
    //      so we go straight to SIGKILL rather than the SIGTERM/grace
    //      sequence used in `stop()` — at this point the parent is already
    //      tearing down and we just need the child reaped, not gracefully
    //      shut down. The normal `stop()` path runs *before* 'exit' fires
    //      and clears the handler so we never double-signal.
    if (this.options.platform !== "win32" && typeof this.process.pid === "number") {
      this.process.unref();
      const pid = this.process.pid;
      const handler = () => {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          // ESRCH = already exited (the normal post-stop case);
          // EPERM would mean we lost the right to signal it, which
          // shouldn't happen for a child we spawned.
        }
      };
      process.on("exit", handler);
      this.crashCleanupHandler = handler;
    }

    this.process.on("exit", (code) => {
      this._isRunning = false;
      this.stopHealthCheck();
      this.stopIdleMonitor();
      // The child has reaped itself; the parent-exit fallback is no longer
      // needed and would attempt to signal a dead PID (harmlessly but
      // noisily).
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
      // — Node prints a MaxListenersExceededWarning at 10. Kept
      // in lock-step with `DiffusionSidecar.error` for cleanup
      // symmetry across the two sidecar classes.
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
      sendSignal(
        this.process,
        this.options.platform === "win32" ? "SIGKILL" : "SIGTERM",
        this.options.platform,
      );
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) {
            sendSignal(this.process, "SIGKILL", this.options.platform);
          }
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
   * Poll `/health` until the sidecar's HTTP listener is accepting
   * connections, then return. Resolves `true` on success, `false`
   * on timeout / process exit. Used by callers (`ipc/model.ts`,
   * `ipc/vision.ts`) that need to make a sidecar request
   * immediately after `start()` resolves — `start()` only confirms
   * that `spawn()` was called, not that llama-server has finished
   * loading the model and bound the port.
   *
   * Without this guard the first request after a cold-start can
   * land before the listener is up and reject with `ECONNREFUSED`
   * / `ECONNRESET`, which surfaces as a confusing "sidecar errored"
   * dialog to the user even though the sidecar is starting up
   * normally. Llama-server warms up in 1-3 s on typical hosts; the
   * 60 s default covers vision (`--mmproj`) cold-starts on slow
   * disks.
   *
   * The poll interval scales with the configured
   * `healthCheckIntervalMs` but is capped at 500 ms so the
   * post-`start()` latency stays bounded — once the listener is
   * up the very next probe succeeds.
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
          // Skip restart during startup grace period — model loading can take 10-30s+
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
      if (idleTime > this.options.idleUnloadMs && this._isRunning && this._generationActiveCount === 0) {
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
 * Send a signal to a child process. On POSIX we deliver to the negative pid
 * to reach the whole process group (since we spawned with detached:true);
 * on Windows the signal name is ignored and the process is terminated.
 *
 * Accepts an optional `platform` parameter so callers (notably
 * `ModelSidecar`) can route the signal based on the platform the
 * sidecar was constructed for rather than the live `process.platform`,
 * which lets tests inject a per-instance platform without mutating
 * globals. Per Devin Review PR #55 Finding 6 follow-up.
 */
function sendSignal(
  child: ChildProcess,
  signal: NodeJS.Signals,
  platform: NodeJS.Platform = process.platform,
): void {
  if (platform === "win32") {
    try {
      child.kill();
    } catch {
      // Process already gone; nothing to do.
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
    // ESRCH on Linux/macOS means the process already exited; safe to ignore.
  }
}
