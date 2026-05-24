import { app } from "electron";
import * as fs from "fs";
import * as path from "path";

/**
 * Tessera structured logger.
 *
 * Writes JSON-lines records to `~/.tessera/logs/tessera-N.log`.
 * Rotation keeps the most recent 5 files at up to ~10 MB each so
 * disk usage stays bounded. Each log line is a single JSON object
 * containing a millisecond timestamp, level, message, and any
 * structured fields the caller passes in.
 *
 * The logger is process-local: the main process writes through the
 * file handle directly, and the renderer is expected to log via
 * `console.*` which Chrome surfaces in DevTools. Crash and error
 * boundary IPC handlers (see ipc.ts) forward renderer crashes to
 * the main-process logger so they end up on disk too.
 *
 * Why JSONL: it is trivial to grep, easy to import into pandas /
 * jq, and survives partial-line writes if the process crashes mid-
 * write. We avoid third-party deps (electron-log, winston) for the
 * tiny scope we need; that also keeps the snapshot small.
 */

export type LogLevel = "debug" | "info" | "warn" | "error";

const LEVEL_PRIORITY: Record<LogLevel, number> = {
  debug: 0,
  info: 1,
  warn: 2,
  error: 3,
};

interface LoggerOptions {
  dir?: string;
  maxFileBytes?: number;
  maxFiles?: number;
  minLevel?: LogLevel;
}

const DEFAULT_OPTS: Required<Omit<LoggerOptions, "dir">> = {
  maxFileBytes: 10 * 1024 * 1024, // 10 MB per file
  maxFiles: 5,
  minLevel: "info",
};

export interface Logger {
  log(level: LogLevel, message: string, fields?: Record<string, unknown>): void;
  debug(message: string, fields?: Record<string, unknown>): void;
  info(message: string, fields?: Record<string, unknown>): void;
  warn(message: string, fields?: Record<string, unknown>): void;
  error(message: string, fields?: Record<string, unknown>): void;
  /** Path to the current active log file. */
  filePath(): string;
  /** Directory that contains the rotated log files. */
  dirPath(): string;
}

function resolveDefaultDir(): string {
  // `app.getPath('userData')` is `~/.config/Tessera` on Linux, the
  // Application Support folder on macOS, and AppData on Windows.
  // We append a `logs` subdir so users can grep / zip easily, and
  // so a future "Export Diagnostics" feature can package the entire
  // directory without scooping unrelated files.
  try {
    return path.join(app.getPath("userData"), "logs");
  } catch {
    // `app` is unavailable in non-Electron contexts (e.g. unit tests
    // that import this module directly). Fall back to a tempdir so
    // the logger remains usable.
    return path.join(process.cwd(), ".tessera-logs");
  }
}

export function createLogger(options: LoggerOptions = {}): Logger {
  const dir = options.dir ?? resolveDefaultDir();
  const opts = { ...DEFAULT_OPTS, ...options };

  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });

  const activePath = path.join(dir, "tessera.log");

  function rotateIfNeeded() {
    let size = 0;
    try {
      size = fs.statSync(activePath).size;
    } catch {
      return;
    }
    if (size < opts.maxFileBytes) return;

    // Shift `tessera.log -> tessera.1.log -> tessera.2.log -> …`
    // and drop the oldest. We rename in reverse order so we never
    // clobber an existing file mid-rotation.
    for (let i = opts.maxFiles - 1; i >= 1; i -= 1) {
      const src = i === 1 ? activePath : path.join(dir, `tessera.${i - 1}.log`);
      const dst = path.join(dir, `tessera.${i}.log`);
      try {
        if (fs.existsSync(src)) fs.renameSync(src, dst);
      } catch {
        // Best-effort. Rotation should not block writes.
      }
    }
  }

  function write(record: Record<string, unknown>) {
    try {
      rotateIfNeeded();
      fs.appendFileSync(activePath, `${JSON.stringify(record)}\n`, "utf8");
    } catch {
      // If disk is full or permissions are wrong, we don't want to
      // crash the main process. Swallow the failure — the user will
      // still see logs in the DevTools console.
    }
  }

  function log(
    level: LogLevel,
    message: string,
    fields?: Record<string, unknown>,
  ): void {
    if (LEVEL_PRIORITY[level] < LEVEL_PRIORITY[opts.minLevel]) return;
    const record: Record<string, unknown> = {
      ts: new Date().toISOString(),
      level,
      message,
      ...(fields ?? {}),
    };
    write(record);
    const consoleFn =
      level === "error"
        ? console.error
        : level === "warn"
          ? console.warn
          : console.log;
    consoleFn(`[tessera][${level}] ${message}`, fields ?? "");
  }

  return {
    log,
    debug: (m, f) => log("debug", m, f),
    info: (m, f) => log("info", m, f),
    warn: (m, f) => log("warn", m, f),
    error: (m, f) => log("error", m, f),
    filePath: () => activePath,
    dirPath: () => dir,
  };
}

let singleton: Logger | null = null;
export function getLogger(): Logger {
  if (singleton === null) singleton = createLogger();
  return singleton;
}
