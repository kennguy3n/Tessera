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

export function registerDiagnosticsHandlers(): void {
  // Best-effort, write-only surface. We never throw back at the
  // renderer: it is already rendering its crash UI and a rejected
  // promise there would be noise. Validation failures fall through to
  // `recordCrashReport`'s normalisation, which defaults bad fields.
  idempotentHandle(
    "diagnostics:reportCrash",
    async (_event, raw: unknown): Promise<void> => {
      const parsed = RendererCrashReportSchema.safeParse(raw);
      recordCrashReport(parsed.success ? parsed.data : null);
    },
  );
}
