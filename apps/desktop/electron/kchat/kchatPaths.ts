/**
 * Path helpers for the KChat connector.
 *
 * The KChat connector keeps a local on-disk cache of each linked
 * channel's downloaded files at a deterministic location:
 *
 *   `~/.tessera/kchat-channels/<channelId>/`
 *
 * This convention is referenced in two places — the
 * `sources:addKchatChannel` IPC handler (which writes downloaded
 * files into the directory and registers it as a
 * `SourceType::Kchat` source), and the `KchatEventForwarder`
 * (which uses it to map a `file_added` WebSocket event back to
 * the source row so the indexer can be triggered immediately
 * rather than waiting for a manual refresh). Centralising the
 * builder here prevents the two call sites from drifting; a
 * regression in either location would otherwise cause the
 * forwarder to mis-locate the source on every event, silently
 * suppressing auto-reindex.
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
