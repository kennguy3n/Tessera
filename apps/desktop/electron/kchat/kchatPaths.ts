/**
 * Path helpers for the KChat connector.
 *
 * The KChat connector keeps a local on-disk cache of each linked
 * channel's downloaded files at a deterministic location:
 *
 *   `~/.tessera/kchat-channels/<channelId>/`
 *
 * The sole consumer today is the `sources:addKchatChannel` IPC
 * handler (`electron/ipc/kchat.ts`), which writes downloaded files
 * into the directory and registers it as a `SourceType::Kchat`
 * source. The helper is still exported from a dedicated module so
 * any future caller that needs to refer to the same cache dir
 * (for example, an auto-reindex path triggered from the WS
 * forwarder once `runAddKchatChannel` is extracted into a shared
 * service — see the top-of-file doc on `kchatEventForwarder.ts`)
 * has a single source of truth and cannot drift.
 *
 * An earlier draft of this file claimed the forwarder also
 * imported this helper to map a `file_added` event back to a
 * source row, but the second/third-pass Devin Review on PR #43
 * removed that lookup as dead code (the file isn't on disk at
 * `file_added` time, so the lookup never produced useful output).
 * The note is preserved here so a future contributor doesn't try
 * to re-introduce the same dead surface — the right way to wire
 * auto-reindex is to share the existing `runAddKchatChannel`
 * pipeline, not to add a per-event source-registry lookup back
 * onto this helper.
 *
 * The helper is purely synchronous and only depends on `os` /
 * `path`, so it stays cheap to import from hot-path code.
 */
import * as os from "os";
import * as path from "path";

/**
 * Return the absolute on-disk cache directory for a KChat
 * channel given its `channelId`. The directory itself is created
 * on demand by `sources:addKchatChannel` via `fs.mkdir({ recursive: true })`
 * — callers of this helper should NOT assume the directory exists.
 *
 * `channelId` is treated as an opaque token: the caller is
 * responsible for validating the id shape (the existing IPC
 * handler validates via `assertId`/`isKchatObjectId` before
 * reaching `runAddKchatChannel`, and the forwarder only ever
 * receives channel ids that the KChat server itself emitted on
 * the WebSocket broadcast envelope). We intentionally do NOT
 * re-validate here so a future test fixture can supply a synthetic
 * id without tripping the production allowlist.
 */
export function kchatChannelCacheDir(channelId: string): string {
  return path.join(os.homedir(), ".tessera", "kchat-channels", channelId);
}
