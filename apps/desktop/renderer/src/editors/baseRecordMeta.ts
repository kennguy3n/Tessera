/**
 * Pure helpers for per-record metadata: the intrinsic
 * created/modified timestamps that back the `created_time` /
 * `modified_time` field types, and the comments timeline shown in the
 * expand-record modal.
 *
 * Kept React-free and side-effect-free (apart from `makeRecordId` /
 * `Date.now`, which are the same non-determinism the rest of the
 * editor already tolerates) so the contracts can be unit-tested in
 * isolation, mirroring the `baseEditorHelpers` / `baseFormulaEngine`
 * split. The component layer (`BaseEditor.tsx`) stays a thin shell
 * that calls these.
 */
import {
  RECORD_CREATED_KEY,
  RECORD_MODIFIED_KEY,
  RECORD_COMMENTS_KEY,
  type BaseComment,
  type BaseRecord,
} from "./baseEditorTypes";
import { makeRecordId } from "./baseEditorHelpers";

/** Current time as an ISO-8601 string. Single chokepoint so tests can
 *  stub `Date` once and every metadata write becomes deterministic. */
export function nowIso(): string {
  return new Date().toISOString();
}

/**
 * Stamp a freshly-created record with `__created` / `__modified`
 * metadata. Idempotent for `__created` (never overwrites an existing
 * creation time — e.g. when a record is re-inserted via undo), always
 * refreshes `__modified`. Returns a new object; never mutates `record`.
 */
export function withCreatedMeta(
  record: BaseRecord,
  iso: string = nowIso(),
): BaseRecord {
  return {
    ...record,
    [RECORD_CREATED_KEY]: record[RECORD_CREATED_KEY] ?? iso,
    [RECORD_MODIFIED_KEY]: iso,
  };
}

/**
 * Bump a record's `__modified` timestamp (and backfill `__created` if
 * a legacy record never had one). Returns a new object; never mutates.
 */
export function touchModified(
  record: BaseRecord,
  iso: string = nowIso(),
): BaseRecord {
  return {
    ...record,
    [RECORD_CREATED_KEY]: record[RECORD_CREATED_KEY] ?? iso,
    [RECORD_MODIFIED_KEY]: iso,
  };
}

/** Read the comments array off a record, tolerating legacy / hand-edited
 *  shapes (missing, null, non-array, or array with junk elements). */
export function getComments(record: BaseRecord): BaseComment[] {
  const raw = record[RECORD_COMMENTS_KEY];
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (c): c is BaseComment =>
      !!c &&
      typeof c === "object" &&
      typeof (c as BaseComment).id === "string" &&
      typeof (c as BaseComment).body === "string",
  );
}

/**
 * Append a comment to a record's timeline. Empty / whitespace-only
 * bodies are rejected (returns the record unchanged) so the UI can
 * call this unconditionally. Adding a comment also bumps `__modified`
 * — a comment is activity on the record. Returns a new object.
 */
export function addComment(
  record: BaseRecord,
  author: string,
  body: string,
  iso: string = nowIso(),
): BaseRecord {
  const trimmed = body.trim();
  if (trimmed === "") return record;
  const comment: BaseComment = {
    id: makeRecordId(),
    author: author.trim() || "You",
    body: trimmed,
    createdAt: iso,
  };
  return {
    ...record,
    [RECORD_COMMENTS_KEY]: [...getComments(record), comment],
    [RECORD_CREATED_KEY]: record[RECORD_CREATED_KEY] ?? iso,
    [RECORD_MODIFIED_KEY]: iso,
  };
}

/** Remove a comment by id. Returns the same reference when nothing
 *  matched so React can skip re-rendering. */
export function removeComment(
  record: BaseRecord,
  commentId: string,
): BaseRecord {
  const comments = getComments(record);
  const next = comments.filter((c) => c.id !== commentId);
  if (next.length === comments.length) return record;
  return { ...record, [RECORD_COMMENTS_KEY]: next };
}

/**
 * Format an ISO timestamp for display. `includeTime` controls whether
 * the clock time is shown (used by `date` fields with
 * `dateIncludeTime`, and always-on for created/modified).
 *
 * Invalid / empty input renders as the empty string rather than
 * "Invalid Date" so a half-typed or legacy value degrades gracefully.
 * Uses the host locale via `toLocaleString`, matching how the rest of
 * the renderer presents dates.
 */
export function formatTimestamp(
  iso: unknown,
  includeTime: boolean,
): string {
  if (typeof iso !== "string" || iso.trim() === "") return "";
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso);
  return includeTime
    ? d.toLocaleString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
        hour: "2-digit",
        minute: "2-digit",
      })
    : d.toLocaleDateString(undefined, {
        year: "numeric",
        month: "short",
        day: "numeric",
      });
}
