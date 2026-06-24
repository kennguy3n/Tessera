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

function isReportShaped(e: unknown): e is RendererCrashReport {
  // Defense-in-depth filter that runs before `readExisting` normalizes
  // each survivor: it decides whether a parsed value is a report at all,
  // not whether its fields are well-typed (normalization handles that).
  // Require a string `component` — the field that anchors a real report
  // and that `normalizeCrashReport` always writes. A bare `{}`, a
  // primitive, or a `{component: 42}` carries no recoverable identity, so
  // normalizing it would only manufacture an "unknown" junk entry; drop
  // it instead.
  return (
    typeof e === "object" &&
    e !== null &&
    typeof (e as { component?: unknown }).component === "string"
  );
}

function readExisting(filePath: string): RendererCrashReport[] {
  try {
    const text = fs.readFileSync(filePath, "utf8");
    const parsed: unknown = JSON.parse(text);
    // An array is the current format; tolerate an older single-object
    // file by treating it as a one-element array. Drop anything that
    // isn't report-shaped (junk objects, primitives), then normalize the
    // survivors: retained entries are re-serialized on the next write, so
    // normalizing here heals a field that was hand-edited or written by
    // an older build (a non-string `error`/`stack`, an oversized field, a
    // missing one) instead of persisting it verbatim. Entries this module
    // wrote are already normalized, so normalization is a no-op for them.
    const entries: unknown[] = Array.isArray(parsed) ? parsed : [parsed];
    return entries.filter(isReportShaped).map((e) => normalizeCrashReport(e));
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
    try {
      fs.writeFileSync(tmp, `${JSON.stringify(bounded, null, 2)}\n`, "utf8");
      fs.renameSync(tmp, filePath);
    } catch (err) {
      // The rename can fail (e.g. weaker cross-platform atomicity on
      // Windows when the target exists). Don't leave the temp file as
      // debris — best-effort unlink before giving up.
      try {
        fs.rmSync(tmp, { force: true });
      } catch {
        // Nothing more we can do.
      }
      throw err;
    }
    return filePath;
  } catch {
    // Best-effort; the logger already captured the crash above.
    return null;
  }
}
