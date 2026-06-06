/**
 * IPC handlers for renderer diagnostics.
 *
 * Channel:
 *   - `diagnostics:reportCrash` (report: RendererCrashReport) -> void
 *
 * The renderer's error boundaries call this when a descendant component
 * throws during render. The handler validates the payload and persists
 * it via `electron/crashReport.ts`. Kept in its own per-domain module to
 * match the pattern every other IPC area uses (see `register.ts`).
 */
import { idempotentHandle } from "./register";
import { RendererCrashReportSchema } from "./schemas";
import { recordCrashReport } from "../crashReport";
import type { RendererCrashReport } from "../../shared/types";

export function registerDiagnosticsHandlers(): void {
  // Best-effort, write-only surface. We never throw back at the
  // renderer: it is already rendering its crash UI and a rejected
  // promise there would be noise.
  //
  // On a validation failure we do NOT drop the report — we hand the raw
  // payload to `recordCrashReport`, whose `normalizeCrashReport` clamps
  // every field to the storage caps and defaults the rest. This means an
  // oversized field (e.g. a stack larger than the schema bound) is
  // truncated rather than causing the whole crash — including the valid
  // component and message — to be lost as "unknown". The schema bound
  // still keeps the typed happy path from retaining pathological inputs.
  idempotentHandle(
    "diagnostics:reportCrash",
    async (_event, raw: unknown): Promise<void> => {
      const parsed = RendererCrashReportSchema.safeParse(raw);
      let payload: Partial<RendererCrashReport> | null;
      if (parsed.success) {
        payload = parsed.data;
      } else if (
        typeof raw === "object" &&
        raw !== null &&
        !Array.isArray(raw)
      ) {
        // A plain object that is out of bounds (e.g. oversized stack).
        // Salvage it: normalize truncates each field instead of
        // discarding the whole report. Arrays are excluded — they have
        // no report-shaped fields, so recording one would only add a
        // junk "unknown" entry, not salvage anything.
        payload = raw as Partial<RendererCrashReport>;
      } else {
        // Not a report-shaped object (primitive, null, or array).
        payload = null;
      }
      recordCrashReport(payload);
    },
  );
}
