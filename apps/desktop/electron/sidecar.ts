import { ChildProcess, spawn } from "child_process";

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

export class ModelSidecar {
  private process: ChildProcess | null = null;
  private options: SidecarOptions;
  private healthCheckTimer: ReturnType<typeof setInterval> | null = null;
  private idleTimer: ReturnType<typeof setTimeout> | null = null;
  private lastRequestTime: number = 0;
  private _isRunning: boolean = false;

  constructor(options: Partial<SidecarOptions> = {}) {
    this.options = { ...DEFAULT_OPTIONS, ...options };
  }

  get isRunning(): boolean {
    return this._isRunning;
  }

  get endpoint(): string {
    return `http://127.0.0.1:${this.options.port}`;
  }

  async start(): Promise<void> {
    if (this._isRunning) return;

    if (!this.options.modelPath) {
      throw new Error("Model path is required to start the sidecar");
    }

    this.process = spawn(this.options.binaryPath, [
      "--model",
      this.options.modelPath,
      "--port",
      this.options.port.toString(),
      "--host",
      "127.0.0.1",
    ]);

    this.process.on("exit", (code) => {
      this._isRunning = false;
      if (code !== 0 && code !== null) {
        setTimeout(() => this.start(), 3000);
      }
    });

    this.process.on("error", () => {
      this._isRunning = false;
    });

    this._isRunning = true;
    this.lastRequestTime = Date.now();
    this.startHealthCheck();
    this.startIdleMonitor();
  }

  async stop(): Promise<void> {
    this.stopHealthCheck();
    this.stopIdleMonitor();

    if (this.process) {
      this.process.kill("SIGTERM");
      await new Promise<void>((resolve) => {
        const timeout = setTimeout(() => {
          if (this.process) this.process.kill("SIGKILL");
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

  private startHealthCheck(): void {
    this.healthCheckTimer = setInterval(async () => {
      if (this._isRunning) {
        const healthy = await this.healthCheck();
        if (!healthy && this._isRunning) {
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
      if (idleTime > this.options.idleUnloadMs && this._isRunning) {
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
