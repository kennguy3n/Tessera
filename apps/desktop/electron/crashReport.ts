/**
 * Renderer crash-report persistence.
 *
 * When a renderer error boundary catches a render-time exception it
 * forwards a structured report over IPC (`diagnostics:reportCrash`).
 * The renderer is the untrusted web context and cannot touch the disk,
 * so the main process owns this file. Reports are written to
 * `crash-report.json` in the same directory the structured logger uses
 * (`<userData>/logs`), so a future "Export Diagnostics" feature can zip
 * the whole folder.
 *
 * The file holds a bounded, newest-last JSON array of reports rather
 * than a single object: a crash loop (the same boundary throwing on
 * every re-render) would otherwise clobber the one piece of evidence we
 * have. The array is capped at `MAX_REPORTS` so the file stays small.
 *
 * Every write is best-effort. Disk-full / permission errors are
 * swallowed (and surfaced via the logger's console path) because
 * failing to write a crash report must never itself crash the main
 * process or block the renderer's error UI.
 */
import * as fs from "fs";
import * as path from "path";

import { getLogger } from "./logger";
import type { RendererCrashReport } from "../shared/types";

/** Newest-last cap on retained reports. */
export const MAX_REPORTS = 50;

/** File name written inside the log directory. */
export const CRASH_REPORT_FILENAME = "crash-report.json";

/** Hard cap on any single stored string field, to bound file growth. */
const MAX_FIELD_LEN = 16 * 1024;

function clampString(value: unknown, max: number): string {
  if (typeof value !== "string") return "";
  return value.length > max ? value.slice(0, max) : value;
}

/**
 * Coerce an untrusted IPC payload into a well-formed
 * {@link RendererCrashReport}. Missing / wrong-typed fields are
 * defaulted rather than rejected so a partial report is still recorded.
 */
export function normalizeCrashReport(
  raw: Partial<RendererCrashReport> | null | undefined,
): RendererCrashReport {
  const r = raw ?? {};
  const timestamp =
    typeof r.timestamp === "string" && r.timestamp.length > 0
      ? r.timestamp
      : new Date().toISOString();
  return {
    component: clampString(r.component, 256) || "unknown",
    error: clampString(r.error, MAX_FIELD_LEN),
    stack: clampString(r.stack, MAX_FIELD_LEN),
    timestamp: clampString(timestamp, 64),
  };
}

function readExisting(filePath: string): RendererCrashReport[] {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(text);
    if (Array.isArray(parsed)) {
      return parsed.filter(
        (e): e is RendererCrashReport =>
          typeof e === "object" && e !== null && "component" in e,
      );
    }
    // Tolerate an older single-object file by lifting it into the array.
    if (typeof parsed === "object" && parsed !== null) {
      return [parsed as RendererCrashReport];
    }
  } catch {
    // Missing or corrupt file — start fresh.
  }
  return [];
}

/**
 * Append a normalized crash report to `crash-report.json` in `dir`
 * (defaults to the logger's directory) and mirror it to the logger.
 * Returns the absolute path written, or `null` if the write failed.
 */
export function recordCrashReport(
  raw: Partial<RendererCrashReport> | null | undefined,
  dir?: string,
): string | null {
  const report = normalizeCrashReport(raw);
  const logger = getLogger();

  logger.error("renderer crash", {
    component: report.component,
    crashError: report.error,
    stack: report.stack,
    timestamp: report.timestamp,
  });

  const targetDir = dir ?? logger.dirPath();
  const filePath = path.join(targetDir, CRASH_REPORT_FILENAME);

  try {
    if (!fs.existsSync(targetDir)) {
      fs.mkdirSync(targetDir, { recursive: true });
    }
    const reports = readExisting(filePath);
    reports.push(report);
    const bounded = reports.slice(-MAX_REPORTS);
    // Atomic-ish write: a torn write would otherwise corrupt the only
    // crash evidence we have. Write to a sibling temp then rename.
    const tmp = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmp, `${JSON.stringify(bounded, null, 2)}\n`, "utf8");
    fs.renameSync(tmp, filePath);
    return filePath;
  } catch {
    // Best-effort; the logger already captured the crash above.
    return null;
  }
}
