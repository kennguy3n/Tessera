/**
 * IPC handlers for the `audit:*` channels.
 *
 * Read-only API over the `tessera_audit` SQLite store. The
 * renderer renders a "recent activity" list on Settings and (per
 * Phase 11 Task 6) a filtered KChat-events list, both of which
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

import type { IpcMainInvokeEvent } from "electron";
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
}
