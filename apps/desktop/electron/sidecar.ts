import { ChildProcess, spawn, SpawnOptions } from "child_process";
import * as path from "path";

export interface SidecarOptions {
  binaryPath: string;
  modelPath: string;
  port: number;
  healthCheckIntervalMs: number;
  idleUnloadMs: number;
}

const DEFAULT_OPTIONS: SidecarOptions = {
  binaryPath: "llama-server",
  modelPath: "",
  port: 8384,
  healthCheckIntervalMs: 5000,
  idleUnloadMs: 60_000,
};

const MAX_RESTART_RETRIES = 5;
const STARTUP_GRACE_MS = 60_000;

/**
 * Build platform-specific spawn options. On Linux the llama-server binary may
 * sit next to required shared libraries (libllama.so) — we prepend the binary
 * directory to LD_LIBRARY_PATH so the dynamic linker finds them. macOS uses
 * @loader_path-relative install names and Windows uses the binary directory as
 * a DLL search path automatically, so no extra env is needed there.
 */
export function buildSpawnEnv(
  binaryPath: string,
  baseEnv: NodeJS.ProcessEnv = process.env,
): NodeJS.ProcessEnv {
  if (process.platform !== "linux") return { ...baseEnv };
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

  constructor(options: Partial<SidecarOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
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

  async start(resetRetries = false): Promise<void> {
    if (this._isRunning) return;
    if (resetRetries) this.restartCount = 0;

    if (!this.options.modelPath) {
      throw new Error("Model path is required to start the sidecar");
    }

    const spawnOpts: SpawnOptions = {
      env: buildSpawnEnv(this.options.binaryPath),
      // Detach on POSIX so we can deliver SIGTERM/SIGKILL to the whole process
      // group; on Windows leave the default tied to the parent.
      detached: process.platform !== "win32",
      stdio: ["ignore", "pipe", "pipe"],
    };
    this.process = spawn(
      this.options.binaryPath,
      [
        "--model",
        this.options.modelPath,
        "--port",
        this.options.port.toString(),
        "--host",
        "127.0.0.1",
      ],
      spawnOpts,
    );

    this.process.on("exit", (code) => {
      this._isRunning = false;
      this.stopHealthCheck();
      this.stopIdleMonitor();
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
    this._isRunning = false;
    this._isTerminating = false;
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
 */
function sendSignal(
  child: ChildProcess,
  signal: NodeJS.Signals,
): void {
  if (process.platform === "win32") {
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
