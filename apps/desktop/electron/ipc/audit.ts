/**
 * IPC handlers for the `audit:*` channels.
 *
 * Read-only API over the `tessera_audit` SQLite store. The
 * renderer renders a "recent activity" list on Settings and (per
 *) a filtered KChat-events list, both of which
 * read through `audit:listRecent`. Append-side writes still come
 * exclusively from the existing `bridgeLog*` pass-throughs in
 * `appState.ts` — there is no `audit:write` channel by design, so
 * the renderer can never forge an audit row.
 *
 * Filtering is intentionally done renderer-side because:
 *   - The audit volume is bounded (kilobytes per day for a typical
 *     user; the SQLite store happily returns the top-500 rows
 *     instantly), so paginating-then-filtering wastes no real time.
 *   - Pushing filter strings through the IPC boundary would force
 *     us to validate them against a closed set of event-type names
 *     here, which would then need to be re-synchronised whenever a
 *     new audit event type is added. Filtering downstream of the
 *     read avoids that coupling.
 */

import path from "node:path";
import type { IpcMainInvokeEvent } from "electron";
import { app } from "electron";
import { getBridge } from "../appState";
import { idempotentHandle } from "./register";
import { assertNumber } from "./validate";

/**
 * Shape exposed to the renderer. Mirrors the Rust
 * `AuditEventView` in `napi_exports.rs`.
 */
export interface AuditEventDto {
  /** Opaque UUID; see `AuditEventView` in shared types. */
  id: string;
  eventType: string;
  timestamp: string;
  details: string;
}

const DEFAULT_LIMIT = 100;
const MAX_LIMIT = 500;

export function registerAuditHandlers(): void {
  idempotentHandle(
    "audit:listRecent",
    async (
      _event: IpcMainInvokeEvent,
      rawLimit: unknown,
      rawOffset: unknown,
    ): Promise<AuditEventDto[]> => {
      // Both `limit` and `offset` are optional — a renderer that
      // calls `audit:listRecent()` with no args gets the latest
      // 100 events starting at the top.
      const limit =
        rawLimit === undefined
          ? DEFAULT_LIMIT
          : assertNumber(rawLimit, "limit", {
              min: 1,
              max: MAX_LIMIT,
              integer: true,
            });
      const offset =
        rawOffset === undefined
          ? 0
          : assertNumber(rawOffset, "offset", {
              min: 0,
              max: 1_000_000,
              integer: true,
            });

      const bridge = getBridge();
      if (!bridge) {
        // Without the bridge there's no audit store to read from.
        // Return an empty list rather than throwing so the
        // renderer's "recent activity" list degrades to an empty
        // section gracefully.
        return [];
      }
      // The bridge surfaces audit rows already mapped to the DTO
      // shape (id/eventType/timestamp/details). No further mapping
      // needed beyond the JSON-safe re-shape that napi performs.
      return bridge.bridgeRecentAuditEvents(limit, offset);
    },
  );

  // ---------------------------------------------------------------------
  // audit log rotation.
  //
  // `audit:getArchives` is the read API the Settings page calls to
  // list every `audit-archive-*.jsonl.gz` file in the
  // `<userData>/audit-archives/` directory. `audit:rotate` triggers
  // a manual rotation (the same logic the future scheduled
  // background task will call). Both are intentionally kept tiny —
  // path construction lives here so the renderer never has to know
  // the userData layout, and the bridge call is a single line.
  //
  // We don't expose a way for the renderer to choose a different
  // archive directory: the path is derived from `app.getPath('userData')`
  // so user-initiated rotations always agree with scheduler-driven
  // ones (otherwise a user might rotate into directory A while the
  // scheduler rotates into directory B, leaving two disjoint
  // archive sets the UI can't render).
  function getAuditArchiveDir(): string {
    return path.join(app.getPath("userData"), "audit-archives");
  }

  idempotentHandle(
    "audit:getArchives",
    async (_event: IpcMainInvokeEvent): Promise<string[]> => {
      const bridge = getBridge();
      if (!bridge) {
        // Bridge not yet ready — degrade to empty rather than
        // throwing, matching the `audit:listRecent` posture.
        return [];
      }
      return bridge.bridgeAuditListArchives(getAuditArchiveDir());
    },
  );

  idempotentHandle(
    "audit:rotate",
    async (
      _event: IpcMainInvokeEvent,
    ): Promise<{ archivePath: string; rotatedCount: number } | null> => {
      const bridge = getBridge();
      if (!bridge) {
        return null;
      }
      return bridge.bridgeAuditRotate(getAuditArchiveDir());
    },
  );
}
