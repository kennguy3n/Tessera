/**
 * KChat WebSocket → renderer + audit forwarder.
 *
 * Block B Task 1 (Phase 11). The Block A sidebar polled
 * `kchat:listChannelFiles` every 30 s to discover newly uploaded
 * files; the design comment at
 * `renderer/src/components/KchatSidebarSection.tsx:12-17`
 * flagged push-based delivery as the intended next iteration.
 * This forwarder is that pipeline.
 *
 * Responsibilities:
 *
 *   1. Subscribe to {@link KchatClient.onWebSocketEvent} once at
 *      start, then for every accepted event:
 *
 *      a. Project the raw envelope to a renderer-safe view
 *         ({@link KchatWebSocketEventView}) — drops the
 *         server-routing `omit_users` map and flattens
 *         `broadcast.*` so the renderer never has to reach into
 *         a nested object.
 *
 *      b. Push the view into a per-renderer-window ring buffer
 *         (drop-oldest, 100-event cap) and drain on the next
 *         microtask to `webContents.send("kchat:event", view)`.
 *         The ring buffer is the architectural backpressure
 *         guard: even though Electron's `webContents.send` is
 *         async-fire-and-forget today, the buffer enforces
 *         deterministic drop semantics — under burst load the
 *         OLDEST event is dropped, not whichever event happens
 *         to lose the race to a saturated underlying Chromium
 *         IPC channel. That shape matches the renderer's
 *         reconciliation contract (the 30 s sidebar poll closes
 *         any gap on the next tick).
 *
 *      c. Audit every `file_added` event via
 *         `bridgeLogKchatFileEventReceived`. The audit row
 *         records the event name, originating channel id,
 *         server-supplied file id, and a `triggered_reindex`
 *         boolean. Block B Task 2 (this commit) now flips that
 *         flag from "always false" to actually reflect whether
 *         the targeted single-file sync (step `d`) accepted the
 *         event — `true` iff the channel is linked as a
 *         `SourceType::Kchat` source AND the indexer ingested
 *         the freshly downloaded file. Other event types
 *         (chat `posted`, membership changes, presence) are
 *         NOT audited at the per-event granularity — that
 *         would flood the audit log with content most operators
 *         don't want to grep.
 *
 *      d. **Targeted single-file sync** (Block B Task 2). On
 *         `file_added`, after the audit step above, the
 *         forwarder fetches the file metadata from the KChat
 *         REST endpoint, downloads the bytes into the channel's
 *         local cache dir under a sanitised + deduped basename
 *         (`kchatChannelSyncer.downloadKchatFileToCache`), then
 *         calls `bridgeIndexKchatFile(cacheDir, basename)` to
 *         have the substrate index ONLY that file (an O(1)
 *         reindex of the newly arrived document, vs. the
 *         O(files-in-channel) full walk the 30 s sidebar
 *         reconciliation poll performs).
 *
 *         All single-file work runs under
 *         `withChannelSyncLock(channelId)` so it cannot race
 *         with a concurrent full sync (`runAddKchatChannel`
 *         in `ipc/kchat.ts`) — both paths share the manifest
 *         and `seenNames` dedupe set via the syncer module,
 *         and the lock serialises their writes. A full sync
 *         already in progress when the WS event arrives will
 *         complete first; if it happens to include the new
 *         file (very likely, since the full sync re-walks the
 *         server roster), `bridgeIndexKchatFile` short-circuits
 *         on the content-hash dedupe path in the substrate and
 *         no duplicate work happens.
 *
 *         An unlinked channel (no `SourceType::Kchat` source
 *         row for the cache dir) early-exits before any
 *         download — the bridge call is an O(log n) lookup on
 *         the composite `idx_sources_type_path` index — and
 *         the audit row records `triggered_reindex=false` for
 *         the event.
 *
 *   2. Window lifecycle cleanup: when a renderer window closes,
 *      its ring buffer is released so the forwarder doesn't
 *      retain a slot for a destroyed `webContents` indefinitely.
 *
 *   3. Disposal: on `dispose()` the forwarder unsubscribes from
 *      the client and clears all buffers. Used by tests; in
 *      production the forwarder's lifetime is the app process.
 *
 * Threading model: the main process is single-threaded JS, so
 * the forwarder does not need locking. The ring buffer is a
 * plain `Array` capped at {@link RING_BUFFER_CAP} entries.
 */

import * as fs from "fs/promises";
import * as path from "path";
import { BrowserWindow } from "electron";
import type { NativeBridge } from "../appState";
import type { KchatClient } from "./kchatClient";
import {
  downloadKchatFileToCache,
  readManifest,
  secureDeleteChannelArtifacts,
  withChannelSyncLock,
  writeManifest,
} from "./kchatChannelSyncer";
import { kchatChannelCacheDir } from "./kchatPaths";
import type {
  KchatConnectionState,
  KchatWebSocketEvent,
  KchatWebSocketEventView,
} from "./kchatTypes";
import type {
  KchatAclRefreshOutcomeInfo,
  KchatConnectionStateView,
  KchatPostIngestInputInfo,
  KchatRevokeOutcomeInfo,
  KchatWebSocketEventPayload,
} from "../../shared/types";

/**
 * Compile-time structural equivalence check between the main-
 * process `KchatWebSocketEventView` (the shape this forwarder
 * sends over `kchat:event`) and the renderer-facing
 * `KchatWebSocketEventPayload` (the shape the preload bridge
 * surfaces to renderer consumers). Electron's
 * `webContents.send` is structurally typed at the wire — the
 * receiver gets whatever shape the sender pushed, regardless of
 * the declared TypeScript types on either side. If the two
 * interfaces ever drift (a field is renamed in one but not the
 * other, a new field is added to one only, an existing field
 * changes optionality), renderers would silently receive a
 * stale-typed payload and the bug would surface only when a
 * `.someNewField` access on the renderer side returns
 * `undefined` at runtime.
 *
 * Two bidirectional assignment functions force the type
 * checker to prove each shape is assignable to the other. A
 * divergence on either side fails `tsc --noEmit` immediately
 * with a precise field-level diagnostic, well before the
 * payload reaches IPC. The functions are intentionally not
 * exported, never called, and have no runtime cost — the
 * declarations live solely as a tripwire. Third-pass Devin
 * Review on PR #43 (`ANALYSIS_pr-review-job-...0006`).
 *
 * DO NOT REMOVE these declarations as "dead code" — they have
 * no runtime cost (the const declarations are erased by tsc;
 * the `void` expressions emit no bytecode), and removing them
 * silently disables the compile-time drift check. Twelfth-pass
 * Devin Review on PR #43 (`ANALYSIS_pr-review-job-...0006`)
 * flagged that a future ESLint rule change marking these as
 * unused could lead a contributor to delete them. The
 * `eslint-disable-next-line` markers below pin the suppression
 * to this specific use rather than relying on a global rule.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time IPC drift tripwire; DO NOT REMOVE
const _assertViewIsPayload = (
  v: KchatWebSocketEventView,
): KchatWebSocketEventPayload => v;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time IPC drift tripwire; DO NOT REMOVE
const _assertPayloadIsView = (
  p: KchatWebSocketEventPayload,
): KchatWebSocketEventView => p;
void _assertViewIsPayload;
void _assertPayloadIsView;

/**
 * Equivalent tripwire for the connection-state shape. The
 * forwarder pushes `KchatConnectionState` (the main-process
 * `kchatTypes.ts` interface) directly over `kchat:status`, and
 * renderer consumers — the preload bridge, `KchatSidebarSection`,
 * `KchatSettingsCard` — receive it as `KchatConnectionStateView`
 * (the `shared/types.ts` interface). Because IPC is structurally
 * typed at the wire the two declarations must stay
 * bi-assignable; without this check a future field added to one
 * side only (or a renamed `lastHealthyAt`, or a tightened union
 * on `state`) would compile cleanly on both sides and ship a
 * latent shape drift to the renderer at runtime. The pattern
 * matches the WS event check above. Fourth-pass Devin Review on
 * PR #43 (`ANALYSIS_pr-review-job-...0001`).
 *
 * DO NOT REMOVE — see the rationale on the WS event tripwire
 * above. Twelfth-pass Devin Review hardened the lint suppression
 * to be local rather than relying on a global rule.
 */
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time IPC drift tripwire; DO NOT REMOVE
const _assertConnectionStateIsView = (
  s: KchatConnectionState,
): KchatConnectionStateView => s;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time IPC drift tripwire; DO NOT REMOVE
const _assertConnectionStateViewIsState = (
  v: KchatConnectionStateView,
): KchatConnectionState => v;
void _assertConnectionStateIsView;
void _assertConnectionStateViewIsState;

/**
 * Block B Task 4 (Phase 11): drift tripwires for the bridge
 * cryptoshred outcome shapes. The `@napi(object)` structs in
 * `crates/tessera_bridge/src/sources.rs`
 * (`KchatRevokeOutcomeInfo`, `KchatAclRefreshOutcomeInfo`) are
 * the source of truth — napi-rs auto-converts their snake_case
 * fields to camelCase when emitting the JS-side typings. The
 * matching TS interfaces in `apps/desktop/shared/types.ts` are a
 * MANUAL mirror: a future field rename / new field on the Rust
 * side compiles cleanly on both sides today and only surfaces at
 * runtime when the forwarder reads `result.chunksDropped` and
 * gets `undefined`.
 *
 * This forwarder is the only consumer of those outcomes (the IPC
 * handler in `ipc/kchat.ts` does not destructure the count
 * fields), so we declare a forwarder-local "View" interface for
 * each outcome — derived only from the fields the forwarder
 * actually reads — and assert bidirectional assignability with
 * the shared-types declaration. Adding a field on the bridge
 * side without also updating shared/types now breaks the
 * forwarder build: the local View misses the field, so the
 * `_assertInfoIsView` direction fails. Conversely, removing a
 * field on the bridge side without updating the forwarder breaks
 * the runtime expectation — caught by the regression test
 * "dispatches a revoked outcome with the shred audit row".
 *
 * Catches: forwarder-local mirror ↔ shared/types drift. Does NOT
 * catch silent Rust-side renames where shared/types is updated
 * but the napi struct field name is not — that drift class needs
 * a runtime test against the real bridge, which `kchatIpc.test.ts`
 * provides via the explicit mock-return-shape literals on
 * `bridgeRevokeKchatSource` / `bridgeRefreshKchatAcl`.
 *
 * DO NOT REMOVE — same rationale as the WS event tripwire above.
 */
interface KchatRevokeOutcomeView {
  outcome: "revoked" | "already_revoked" | "unlinked";
  chunksDropped: number;
  filesDropped: number;
  // Block C Task 2 (Phase 12): chat-post + DEK observability
  // surface threaded through bridge → forwarder → audit logger
  // alongside the existing chunks/files counts.
  postsDropped: number;
  dekDropped: boolean;
  // Fifth-pass Devin Review fix
  // (ANALYSIS_pr-review-job-ef3c7d6c..._0001): VACUUM observability
  // surface threaded through bridge → forwarder → audit logger.
  vacuumSucceeded: boolean;
  vacuumError?: string;
}
interface KchatAclRefreshOutcomeView {
  outcome:
    | "granted"
    | "regranted"
    | "revoked"
    | "unlinked"
    | "no_principal";
  memberCount: number;
  principalPresent: boolean;
  chunksDropped: number;
  filesDropped: number;
  // Block C Task 2 (Phase 12): see `KchatRevokeOutcomeView` above.
  postsDropped: number;
  dekDropped: boolean;
  // Fifth-pass Devin Review fix
  // (ANALYSIS_pr-review-job-ef3c7d6c..._0001): see
  // `KchatRevokeOutcomeView` above.
  vacuumSucceeded: boolean;
  vacuumError?: string;
}
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time IPC drift tripwire; DO NOT REMOVE
const _assertRevokeInfoIsView = (
  i: KchatRevokeOutcomeInfo,
): KchatRevokeOutcomeView => i;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time IPC drift tripwire; DO NOT REMOVE
const _assertRevokeViewIsInfo = (
  v: KchatRevokeOutcomeView,
): KchatRevokeOutcomeInfo => v;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time IPC drift tripwire; DO NOT REMOVE
const _assertAclRefreshInfoIsView = (
  i: KchatAclRefreshOutcomeInfo,
): KchatAclRefreshOutcomeView => i;
// eslint-disable-next-line @typescript-eslint/no-unused-vars -- compile-time IPC drift tripwire; DO NOT REMOVE
const _assertAclRefreshViewIsInfo = (
  v: KchatAclRefreshOutcomeView,
): KchatAclRefreshOutcomeInfo => v;
void _assertRevokeInfoIsView;
void _assertRevokeViewIsInfo;
void _assertAclRefreshInfoIsView;
void _assertAclRefreshViewIsInfo;

/**
 * Per-renderer-window cap on the ring buffer. 100 events is
 * enough to cover a multi-second burst on a busy channel
 * (`posted` events arrive faster than `file_added`, but neither
 * exceeds tens of events per second in practice) while bounding
 * worst-case memory at ~100 × ~200 B per JSON view = ~20 KB per
 * window. A slow renderer cannot grow the buffer past this
 * cap — the oldest event is dropped on overflow.
 *
 * Implementation note: the buffer is a plain JS `Array` and
 * drop-oldest is `Array.prototype.shift()`, which is O(n) per
 * drop. At `RING_BUFFER_CAP = 100` the worst-case cost of a
 * fully-saturated buffer is ~10,000 element moves per drain,
 * which is well inside the per-tick budget. If this cap is
 * ever increased past ~1000 the shape should switch to a
 * pointer-based circular buffer (write/read indices over a
 * fixed-size array) — the shift cost crosses the renderer-
 * tick budget around that scale. See Devin Review thread
 * `ANALYSIS_pr-review-job-…_0004` on PR #43 for the analysis.
 */
export const RING_BUFFER_CAP = 100;

/**
 * IPC channel name carrying renderer-safe KChat WS events. The
 * preload bridge subscribes via `subscribeIpc<KchatWebSocketEventPayload>("kchat:event", cb)`.
 * Renamed across the codebase will break Block B Task 1, so the
 * constant lives here.
 */
export const KCHAT_EVENT_CHANNEL = "kchat:event";

/**
 * IPC channel name carrying KChat connection-state transitions
 * (`disconnected` ↔ `connecting` ↔ `connected` ↔ `error`). The
 * preload bridge subscribes via
 * `subscribeIpc<KchatConnectionStateView>("kchat:status", cb)`.
 *
 * NOTE: the same channel name is also bound to an
 * `ipcMain.handle("kchat:status", ...)` invoke handler. Electron
 * routes `invoke`/`handle` (request-response) and `send`/`on`
 * (push) on separate tables, so the two coexist cleanly — the
 * `invoke` returns the current state on demand, while the
 * `send` notifies subscribers of transitions. Mirrors the
 * `updates:status` precedent in `autoUpdater.ts`.
 */
export const KCHAT_STATUS_CHANNEL = "kchat:status";

/**
 * Per-window forwarder state. Tracks the FIFO ring buffer of
 * pending event views and a running count of events the
 * forwarder had to drop because the buffer was at cap when the
 * event arrived. The drop count is exposed for tests and could
 * be surfaced in a future Settings diagnostics view.
 *
 * `drainScheduled` collapses repeated `scheduleDrain` calls
 * within a single synchronous run into one microtask — without
 * this guard, every WS event in a burst would queue its own
 * microtask, multiplying the per-burst scheduling overhead and
 * defeating the point of the buffer.
 */
interface WindowState {
  buffer: KchatWebSocketEventView[];
  dropped: number;
  drainScheduled: boolean;
}

/**
 * Project a raw WebSocket envelope to the renderer-safe view.
 * Centralised so the projection logic is testable without
 * standing up a full forwarder, and so the audit / reindex
 * paths can rely on the same flattened fields.
 *
 * The trust boundary is `KchatClient.handleWsMessage` — it validates
 * the parsed envelope (event/broadcast shape) before invoking any
 * listener, so by the time this function runs `raw.broadcast` is
 * guaranteed to be a non-null object. We still use optional chaining
 * on `raw.broadcast?.*` as a belt-and-braces guard so the projection
 * remains a total function even if a future caller bypasses the
 * client's validation (for example by passing a hand-rolled fixture
 * straight into the forwarder in a test). Fifth-pass Devin Review on
 * PR #43 (`ANALYSIS_pr-review-job-...0001`).
 *
 * Pure: no I/O, no side effects.
 */
export function toRendererEventView(
  raw: KchatWebSocketEvent,
): KchatWebSocketEventView {
  return {
    event: raw.event,
    channelId: raw.broadcast?.channel_id ?? null,
    teamId: raw.broadcast?.team_id ?? null,
    userId: raw.broadcast?.user_id ?? null,
    seq: raw.seq,
    data: raw.data,
  };
}

/**
 * Narrowed shape extracted from a KChat WS `posted` /
 * `post_edited` / `post_deleted` event's stringified `post`
 * payload. KChat embeds the full post envelope as a JSON
 * string on `data.post`; we parse it just-in-time inside the
 * forwarder so the validation lives next to the consumer that
 * cares.
 *
 * Block C Task 1 (Phase 12).
 */
interface ParsedPostPayload {
  id: string;
  channelId: string;
  rootId: string | null;
  userId: string;
  message: string;
  createAt: number;
  editAt: number;
}

/**
 * Parse a WS post envelope out of `view.data`. Returns `null`
 * on malformed input — the forwarder routes that case to a
 * `no_post` audit row so the failure is observable without
 * wedging the event loop.
 *
 * Tolerates the two known wire shapes:
 *   - `data.post` as a JSON string (the canonical shape KChat
 *     sends today).
 *   - `data.post` as an already-parsed object (defensive — keeps
 *     the forwarder forwards-compatible if KChat ever pre-parses
 *     server-side, and matches what our test fixtures emit).
 *
 * Block C Task 1 (Phase 12).
 */
export function parsePostPayload(
  data: Record<string, unknown>,
): ParsedPostPayload | null {
  const raw = data.post;
  let obj: Record<string, unknown> | null = null;
  if (typeof raw === "string" && raw.length > 0) {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (parsed !== null && typeof parsed === "object") {
        obj = parsed as Record<string, unknown>;
      }
    } catch {
      return null;
    }
  } else if (raw !== null && typeof raw === "object") {
    obj = raw as Record<string, unknown>;
  }
  if (obj === null) return null;

  const id = typeof obj.id === "string" ? obj.id : null;
  const channelId =
    typeof obj.channel_id === "string" ? obj.channel_id : null;
  const userId = typeof obj.user_id === "string" ? obj.user_id : null;
  const message = typeof obj.message === "string" ? obj.message : null;
  const createAt = typeof obj.create_at === "number" ? obj.create_at : null;
  const editAt = typeof obj.edit_at === "number" ? obj.edit_at : 0;
  const rootIdRaw = obj.root_id;
  const rootId =
    typeof rootIdRaw === "string" && rootIdRaw.length > 0 ? rootIdRaw : null;

  if (
    id === null ||
    channelId === null ||
    userId === null ||
    message === null ||
    createAt === null
  ) {
    return null;
  }
  return { id, channelId, rootId, userId, message, createAt, editAt };
}

/**
 * KChat WebSocket forwarder. Construct one per app process,
 * start it after `getKchatAuthService()` has been initialised,
 * dispose on shutdown / between tests.
 */
export class KchatEventForwarder {
  private readonly windowStates = new Map<number, WindowState>();
  private unsubscribeWs: (() => void) | null = null;
  private unsubscribeStatus: (() => void) | null = null;
  /**
   * Reference to the client passed to `start()`. The forwarder
   * retains it so the Block B Task 2 single-file sync
   * (`handleFileAdded`) can call `client.getFileInfo` /
   * `client.downloadFile` without re-resolving via the auth
   * service (which would create a circular `appState` ↔
   * `kchatEventForwarder` import — exactly the cycle the ninth-
   * pass Devin Review on PR #43 told us to avoid). Cleared on
   * `dispose()`.
   */
  private client: KchatClient | null = null;
  /**
   * Set to `true` by `dispose()`, reset to `false` by `start()`.
   *
   * The forwarder defers per-window drains to a microtask via
   * `queueMicrotask` so a burst of synchronous WS events
   * accumulates in the ring buffer before draining. `queueMicrotask`
   * is unconditional — once scheduled, the JS runtime provides no
   * mechanism to cancel it. The drain closure captures a
   * `WindowState` reference and a `BrowserWindow` reference, both
   * of which `dispose()` releases. Without this flag, a drain that
   * was scheduled before `dispose()` ran but fired after would
   * touch the cleared state and attempt `webContents.send` on a
   * stale window — at best a no-op, at worst a "send to released
   * window" diagnostic in tests that recycle the forwarder.
   *
   * The guard lives at the top of `drainWindow` (the microtask
   * body) so any in-flight drain bails out cleanly once disposed.
   * `start()` resets the flag so a forwarder disposed between tests
   * (or hot-reload in dev) can be re-attached and resume
   * delivering. Fourth-pass Devin Review on PR #43
   * (`ANALYSIS_pr-review-job-...0005`).
   */
  private disposed = false;
  private windowDestroyHandlers: Array<{
    win: BrowserWindow;
    handler: () => void;
  }> = [];
  /**
   * Pluggable enumerator. Production uses
   * `BrowserWindow.getAllWindows()`; tests inject a fake so the
   * forwarder can be exercised without standing up an Electron
   * renderer. Stored as a field rather than a constructor arg
   * so existing call sites that pass no arguments stay
   * supported.
   */
  private listWindows: () => BrowserWindow[];
  /**
   * Pluggable accessor for the native bridge.
   *
   * Production wires this to `appState.getBridge` so the forwarder
   * can call `bridge.bridgeLogKchatFileEventReceived(...)` for
   * `file_added` audit rows. The accessor is a function (not a
   * bridge handle) because the bridge can transition between
   * `null` and a real handle across the app lifecycle
   * (initialization, hot-reload, test reset), and the forwarder
   * must always observe the current value at call time — not a
   * snapshot from construction.
   *
   * Storing it as an injected accessor (rather than
   * `import { getBridge } from "../appState"`) eliminates the
   * `appState` ↔ `kchatEventForwarder` circular module
   * dependency that ninth-pass Devin Review on PR #43
   * (`ANALYSIS_pr-review-job-...0003`) flagged as fragile. The
   * cycle was safe today because neither side touched the other's
   * exports during module initialization, but any future
   * top-level access (e.g. a module-level constant derived from
   * `getBridge()`) would have triggered a partially-initialized-
   * module bug that's notoriously hard to debug. Inverting the
   * dependency via DI makes the relationship one-way: `appState`
   * imports the forwarder class, the forwarder imports only the
   * `NativeBridge` type, and the function reference flows
   * downward at construction time.
   *
   * Tests inject their own accessor (a closure over a mock
   * bridge or a `() => null` for the no-bridge code path) so the
   * forwarder can be exercised without standing up the full
   * native loader.
   */
  private readonly getBridgeFn: () => NativeBridge | null;
  /**
   * Block B Task 4 (Phase 11) second-pass Devin Review
   * ANALYSIS_0002: optional fire-and-forget hook the forwarder
   * invokes when `handleMembershipEvent` resolves the ACL
   * refresh to `outcome === "regranted"`. Production wires this
   * to the IPC handler's full-channel-sync flow (see
   * `ipc/kchat.ts` → `setKchatChannelResyncImpl`) so a principal
   * who is re-added to a channel after a previous cryptoshred
   * automatically gets the channel re-indexed — the original
   * draft of this PR documented the auto-resync but never
   * actually wired it, leaving the source stuck in `Connected`
   * status with zero searchable content. The callback runs
   * OUTSIDE `withChannelSyncLock` because the resync path takes
   * the same lock; calling it inside would deadlock. We
   * fire-and-forget so the event handler can return promptly
   * (the resync may walk hundreds of files and is unrelated to
   * the audit-row emission we're about to do).
   *
   * The DI default is a no-op so unit tests don't need to wire
   * the callback unless they're exercising the regrant path.
   */
  private readonly scheduleChannelResync: (
    channelId: string,
  ) => Promise<void>;

  constructor(
    options: {
      listWindows?: () => BrowserWindow[];
      getBridge?: () => NativeBridge | null;
      scheduleChannelResync?: (channelId: string) => Promise<void>;
    } = {},
  ) {
    this.listWindows =
      options.listWindows ?? (() => BrowserWindow.getAllWindows());
    // The DI default is `() => null` so a forwarder constructed
    // without explicit wiring (e.g. in a unit test that doesn't
    // care about audit logging) is silent on the audit path
    // instead of crashing on a missing import. Production code in
    // `appState.getKchatAuthService()` wires the real
    // `getBridge` accessor through, so file_added audit rows are
    // logged via the native bridge as before.
    this.getBridgeFn = options.getBridge ?? (() => null);
    this.scheduleChannelResync =
      options.scheduleChannelResync ?? (() => Promise.resolve());
  }

  /**
   * Bind the forwarder to a connected `KchatClient`. Safe to
   * call exactly once per forwarder instance; the second call
   * is a no-op so `KchatAuthService.connect` can call `start`
   * defensively without double-subscribing.
   *
   * `start` does NOT take ownership of the client's lifecycle —
   * the auth service still owns connect/disconnect; the
   * forwarder just attaches a listener. Disposing the
   * forwarder removes the listener cleanly even while the
   * client stays connected.
   */
  start(client: KchatClient): void {
    if (this.unsubscribeWs || this.unsubscribeStatus) return;
    // Re-arm after a previous `dispose()` so a forwarder that
    // was disposed (between tests, or during a hot-reload in
    // dev) can be re-started cleanly. Without this, `disposed`
    // would stay sticky after the first dispose and silently
    // drop every subsequent event.
    this.disposed = false;
    this.client = client;
    this.unsubscribeWs = client.onWebSocketEvent((event) => {
      try {
        this.handleEvent(event);
      } catch (err) {
        // The forwarder is a fire-and-forget side channel; a
        // single bad event (malformed payload, audit log error,
        // window-list throw) MUST NOT propagate back into the
        // client's WS reader loop, otherwise an attacker who
        // controls a single message can wedge the entire
        // connection. Errors are swallowed and logged so the
        // forwarder degrades to "no live updates" instead of
        // taking the WS down.
        console.error("[KchatEventForwarder] handleEvent failed:", err);
      }
    });
    this.unsubscribeStatus = client.onStatusChange((state) => {
      try {
        this.handleStatusChange(state);
      } catch (err) {
        // Same fire-and-forget rationale as the WS listener.
        console.error(
          "[KchatEventForwarder] handleStatusChange failed:",
          err,
        );
      }
    });
  }

  /**
   * Remove all listeners and clear all per-window state. The
   * forwarder can be re-`start`ed after disposal with a fresh
   * (or the same) client. Tests rely on this to reset between
   * cases.
   */
  dispose(): void {
    this.disposed = true;
    if (this.unsubscribeWs) {
      this.unsubscribeWs();
      this.unsubscribeWs = null;
    }
    if (this.unsubscribeStatus) {
      this.unsubscribeStatus();
      this.unsubscribeStatus = null;
    }
    for (const { win, handler } of this.windowDestroyHandlers) {
      try {
        win.removeListener("closed", handler);
      } catch {
        // Window may already be destroyed; ignore.
      }
    }
    this.windowDestroyHandlers = [];
    this.windowStates.clear();
    this.client = null;
  }

  /**
   * Snapshot of pending events for `windowId`, in oldest-first
   * order. Exposed for tests so they can assert ring-buffer
   * semantics without spinning up an Electron renderer.
   */
  getPendingForWindow(windowId: number): KchatWebSocketEventView[] {
    return [...(this.windowStates.get(windowId)?.buffer ?? [])];
  }

  /**
   * Number of events the forwarder had to drop because
   * `windowId`'s ring buffer was at cap. Exposed for tests and
   * future diagnostics surfaces.
   */
  getDroppedCountForWindow(windowId: number): number {
    return this.windowStates.get(windowId)?.dropped ?? 0;
  }

  private handleEvent(raw: KchatWebSocketEvent): void {
    const view = toRendererEventView(raw);

    // Step 1: broadcast to every renderer window. We enumerate
    // through the pluggable `listWindows` callback so tests can
    // exercise this without an actual BrowserWindow.
    const windows = this.listWindows();
    for (const win of windows) {
      if (win.isDestroyed()) continue;
      this.deliverToWindow(win, view);
    }

    // Step 2: side-effect path — audit on `file_added`.
    //
    // The broadcast above is enqueued into the per-window ring
    // buffer and drained on the next microtask via
    // `queueMicrotask` (see `scheduleDrain`). The bridge calls in
    // `handleFileAdded` therefore complete BEFORE the drain
    // delivers events to the renderer. Bridge calls here are:
    //   - one indexed SQLite SELECT (the cache-dir source lookup,
    //     used only to populate the audit row's `channel_linked`
    //     flag), and
    //   - one append-only audit-log INSERT.
    //
    // Both are short and synchronous; they share the napi worker
    // pool's lock but never the renderer's event loop. The
    // earlier draft also called `bridgeReindexSource` here, but
    // that was removed in the second-pass Devin Review sweep
    // (BUG_pr-review-job-...0001 + ANALYSIS_pr-review-job-...0001
    // on PR #43): the new file hasn't been downloaded into the
    // cache directory at the moment a `file_added` event arrives,
    // so the reindex would walk an empty diff under a mutex,
    // doing nothing while blocking the worker thread. File
    // ingestion still happens reliably via the
    // `sources:addKchatChannel` 30 s reconciliation poll — see
    // the top-of-file doc block.
    if (view.event === "file_added") {
      this.handleFileAdded(view).catch((err) => {
        // The reindex / audit path is best-effort. A failure
        // here MUST NOT prevent future events from being
        // forwarded, so we swallow and log.
        console.error(
          "[KchatEventForwarder] file_added side-effect failed:",
          err,
        );
      });
    }

    // Block B Task 3 (Phase 11): membership / channel events
    // drive the per-channel ACL projection so a user who loses
    // access to a KChat channel can no longer retrieve evidence
    // from it in subsequent corpus searches.
    //
    //   - `user_added` / `user_removed` / `channel_member_updated`
    //     → refresh the cached roster via `GET /channels/{id}/members`
    //     and let the substrate compare against the locally-
    //     authenticated principal (status transitions to
    //     `AccessRevoked` if the principal is no longer a member,
    //     or back to `Indexed` if a previously-revoked principal
    //     was re-added).
    //   - `channel_archived` / `channel_deleted` → explicit
    //     revoke (no roster to fetch, the channel is gone).
    //   - `channel_updated` → refresh roster as well; KChat
    //     uses this for visibility / archive transitions and we
    //     don't trust the body, only the membership snapshot.
    if (
      view.event === "user_added" ||
      view.event === "user_removed" ||
      view.event === "channel_member_updated" ||
      view.event === "channel_updated"
    ) {
      this.handleMembershipEvent(view).catch((err) => {
        console.error(
          "[KchatEventForwarder] membership side-effect failed:",
          err,
        );
      });
    } else if (
      view.event === "channel_archived" ||
      view.event === "channel_deleted"
    ) {
      this.handleChannelGoneEvent(view).catch((err) => {
        console.error(
          "[KchatEventForwarder] channel-gone side-effect failed:",
          err,
        );
      });
    } else if (view.event === "posted") {
      // Block C Task 1 (Phase 12): a new chat post; ingest the
      // body so retrieval can surface it alongside the channel's
      // file evidence. Body parsing + AEAD sealing happens
      // under `withChannelSyncLock` inside `handlePostedEvent`.
      this.handlePostedEvent(view).catch((err) => {
        console.error(
          "[KchatEventForwarder] posted side-effect failed:",
          err,
        );
      });
    } else if (view.event === "post_edited") {
      // Block C Task 1 (Phase 12): a chat post body was edited;
      // re-chunk under the same indexed_file row so retrieval
      // surfaces the latest text without leaving an orphan
      // ciphertext copy.
      this.handlePostEditedEvent(view).catch((err) => {
        console.error(
          "[KchatEventForwarder] post_edited side-effect failed:",
          err,
        );
      });
    } else if (view.event === "post_deleted") {
      // Block C Task 1 (Phase 12): a chat post was deleted;
      // drop the bookkeeping row + sealed chunks so retrieval
      // can no longer surface the body.
      this.handlePostDeletedEvent(view).catch((err) => {
        console.error(
          "[KchatEventForwarder] post_deleted side-effect failed:",
          err,
        );
      });
    }
  }

  private deliverToWindow(
    win: BrowserWindow,
    view: KchatWebSocketEventView,
  ): void {
    const windowId = win.id;
    let state = this.windowStates.get(windowId);
    if (!state) {
      state = { buffer: [], dropped: 0, drainScheduled: false };
      this.windowStates.set(windowId, state);
      // Attach a one-shot "closed" handler so we release the
      // per-window state when the renderer goes away. Without
      // this the map would grow unboundedly across the app
      // lifetime as windows open and close (popups, devtools).
      const handler = () => {
        this.windowStates.delete(windowId);
        // Self-clean from the handler list so a second
        // `closed` event (defensive; shouldn't happen) doesn't
        // double-decrement.
        this.windowDestroyHandlers = this.windowDestroyHandlers.filter(
          (h) => h.win !== win,
        );
      };
      // `closed` fires after the window is unusable; we don't
      // try to drain the buffer at that point — the renderer
      // is already gone.
      win.once("closed", handler);
      this.windowDestroyHandlers.push({ win, handler });
    }

    // Drop-oldest ring buffer. We push first then trim so the
    // newest event always lands in the buffer (the "drop
    // oldest" guarantee). Drain is deferred to the next
    // microtask via `scheduleDrain` so a sequential burst of
    // WS events accumulates in the buffer rather than
    // serialising one-at-a-time through `webContents.send`. If
    // the burst exceeds `RING_BUFFER_CAP` the oldest events
    // are dropped before the renderer ever sees them, bounding
    // memory and giving the reconciliation poll a chance to
    // catch up.
    state.buffer.push(view);
    while (state.buffer.length > RING_BUFFER_CAP) {
      state.buffer.shift();
      state.dropped += 1;
    }
    this.scheduleDrain(win, state);
  }

  private scheduleDrain(win: BrowserWindow, state: WindowState): void {
    if (state.drainScheduled) return;
    state.drainScheduled = true;
    queueMicrotask(() => {
      state.drainScheduled = false;
      this.drainWindow(win, state);
    });
  }

  private drainWindow(win: BrowserWindow, state: WindowState): void {
    // The microtask captures `state` + `win` references that
    // outlive `dispose()` — see the field comment on `disposed`.
    // If the forwarder has since been disposed (between the
    // schedule and the drain), clear the buffer and bail out
    // rather than touching a stale `webContents`. This keeps
    // post-dispose sends from leaking into tests that recycle
    // the forwarder, and matches the guarantee callers rely on:
    // "once `dispose()` returns, no further events are sent".
    if (this.disposed) {
      state.buffer.length = 0;
      return;
    }
    if (win.isDestroyed()) {
      // Renderer went away between schedule and drain. Drop
      // the buffer — the `closed` handler will release the
      // state slot shortly.
      state.buffer.length = 0;
      return;
    }
    while (state.buffer.length > 0) {
      const next = state.buffer.shift()!;
      try {
        win.webContents.send(KCHAT_EVENT_CHANNEL, next);
      } catch (err) {
        // `webContents.send` throws if the renderer is gone.
        // Drop the rest of the buffer for this window — the
        // `closed` handler above will run shortly and release
        // the state slot.
        console.error(
          "[KchatEventForwarder] webContents.send failed:",
          err,
        );
        state.buffer.length = 0;
        break;
      }
    }
  }

  private handleStatusChange(state: KchatConnectionState): void {
    // Status changes are sparse (a handful per session) so the
    // ring-buffer drop-oldest contract is unnecessary; we
    // broadcast directly. The renderer receives the same
    // sanitised view the `kchat:status` invoke handler returns,
    // so the push channel and the pull endpoint are payload-
    // compatible — a renderer that uses both never has to
    // reconcile two different shapes.
    const windows = this.listWindows();
    for (const win of windows) {
      if (win.isDestroyed()) continue;
      try {
        win.webContents.send(KCHAT_STATUS_CHANNEL, state);
      } catch (err) {
        // Same fire-and-forget rationale as the WS path. A
        // window that has gone away mid-broadcast must not
        // block delivery to the surviving windows.
        console.error(
          "[KchatEventForwarder] status send failed:",
          err,
        );
      }
    }
  }

  /**
   * Side-effect path for `file_added` events: targeted single-
   * file sync + audit row.
   *
   * Block B Task 2 (Phase 11) — Block A and Task 1 audited the
   * event but did nothing else; the file would land in the
   * index only when the next 30 s sidebar reconciliation poll
   * happened to call `runAddKchatChannel` (which re-walks the
   * channel roster and indexes anything new). Task 2 closes
   * that latency gap with a targeted O(1) sync: download the
   * one new file, write it under a sanitised name into the
   * channel's cache dir, and tell the substrate to index that
   * one file.
   *
   * Implementation outline (all inside the per-channel sync
   * lock so the full sync and any concurrent single-file syncs
   * for the same channel cannot interleave):
   *
   *   1. Resolve `channelId` and `fileId` from the event view.
   *      Drop the event if either is missing — a malformed WS
   *      payload should never be allowed to throw out of the
   *      forwarder.
   *   2. Compute `cacheDir = kchatChannelCacheDir(channelId)`
   *      and ask the substrate via
   *      `bridgeIsKchatChannelLinked(cacheDir)` whether a
   *      `SourceType::Kchat` source row exists for this
   *      channel. Unlinked channels short-circuit: audit
   *      `triggered_reindex=false` and return — there is no
   *      indexer state to update.
   *   3. Under `withChannelSyncLock(channelId)`:
   *      a. Re-check linked status (paranoia in case
   *         `bridgeRemoveSource` raced between steps 2 and 3).
   *      b. `client.getFileInfo(fileId)` to resolve the
   *         server-supplied `name` / `extension` / `size`.
   *      c. Read the channel's manifest. If `fi.id` is already
   *         recorded AND the on-disk file still exists, skip
   *         the download (KChat file content is immutable per
   *         object-id) and proceed to step (e) with the
   *         recorded name.
   *      d. Otherwise call `downloadKchatFileToCache` with a
   *         `seenNames` set seeded from the manifest's values
   *         so the new file cannot collide with an
   *         already-stored basename.
   *      e. Write the updated manifest before the index call
   *         so a partial-failure mid-sync still records the
   *         bytes that landed on disk; the indexer's next
   *         full-sync pass would otherwise re-download the
   *         file.
   *      f. Call `bridgeIndexKchatFile(cacheDir, basename)`
   *         and observe the outcome.
   *   4. Audit `bridgeLogKchatFileEventReceived` with
   *      `triggered_reindex = outcome.wasLinked && outcome.indexed`
   *      — i.e. the indexer actually accepted the event,
   *      not just that we audited it.
   *
   * Errors at every step are caught and audit `triggered_reindex=false`
   * so a transient REST failure / disk error / containment
   * rejection still surfaces in the audit log with the correct
   * semantics. Errors never propagate back into the forwarder's
   * fire-and-forget event loop.
   */
  private async handleFileAdded(
    view: KchatWebSocketEventView,
  ): Promise<void> {
    const bridge = this.getBridgeFn();
    if (!bridge) {
      // Tests sometimes run the forwarder without a bridge.
      // No bridge = no source store and no audit log to write.
      // Drop silently.
      return;
    }

    const channelId = view.channelId;
    const fileId =
      typeof view.data.file_id === "string" ? view.data.file_id : null;
    const client = this.client;

    // Trust-boundary validation: an event with a missing channel
    // id or file id can't drive a targeted sync — drop it
    // silently (the audit log still records the event below).
    if (channelId === null || fileId === null || client === null) {
      this.safeAuditFileAdded(bridge, view.event, channelId, fileId, false);
      return;
    }

    // Linked-channel fast path: skip the WS-driven sync entirely
    // when no source row exists for `cacheDir`. The bridge call
    // is an O(log n) lookup on `idx_sources_type_path`, so the
    // unlinked-channel case (the majority of `file_added`
    // events: a user uploads to a channel they haven't linked
    // as a corpus source) costs ~one SQLite SELECT and no I/O.
    const cacheDir = kchatChannelCacheDir(channelId);
    let isLinked = false;
    try {
      isLinked = bridge.bridgeIsKchatChannelLinked(cacheDir);
    } catch (err) {
      console.error(
        "[KchatEventForwarder] bridgeIsKchatChannelLinked failed:",
        err,
      );
    }
    if (!isLinked) {
      this.safeAuditFileAdded(bridge, view.event, channelId, fileId, false);
      return;
    }

    let triggeredReindex = false;
    try {
      triggeredReindex = await withChannelSyncLock(channelId, async () => {
        // Re-check linked status under the lock — a concurrent
        // `bridgeRemoveSource` may have unlinked the channel
        // between the pre-lock check and the lock acquisition.
        if (!bridge.bridgeIsKchatChannelLinked(cacheDir)) return false;

        // Make sure `cacheDir` exists. The full-sync path
        // creates it; in production the forwarder will only
        // reach here for an already-linked source (cacheDir
        // exists). Belt-and-braces for tests that exercise
        // the forwarder without running the full sync first.
        await fs.mkdir(cacheDir, { recursive: true });

        const fi = await client.getFileInfo(fileId);

        const manifest = await readManifest(cacheDir, channelId);
        // Seed `seenNames` from the manifest's recorded names so
        // a single-file sync cannot overwrite the bytes of a
        // file the previous full sync wrote.
        const seenNames = new Set<string>(Object.values(manifest.files));

        let finalName: string | null = null;
        const recorded = manifest.files[fi.id];
        if (typeof recorded === "string" && recorded.length > 0) {
          // Fast-path: the previous full sync already wrote this
          // file. Verify the bytes are still on disk; if they
          // are, skip the download and proceed straight to the
          // index call (the substrate's content-hash dedupe
          // will short-circuit if the file hasn't changed,
          // since KChat content is immutable per object-id).
          //
          // Defence-in-depth containment: the manifest is a
          // human-readable sidecar JSON file. While we write it
          // with already-sanitised names, an attacker with
          // filesystem access could tamper with it to inject
          // an escaping path (`..`, absolute prefix, etc.). We
          // re-validate the recorded name against `cacheDir`
          // BEFORE calling `fs.access` so we don't even probe
          // the existence of a path outside the cache directory
          // (probing alone is an information leak). This mirrors
          // the IPC handler's containment check on the same
          // manifest-supplied value.
          const resolvedCacheDir = path.resolve(cacheDir);
          const recordedPath = path.resolve(cacheDir, recorded);
          if (
            recordedPath !== resolvedCacheDir &&
            recordedPath.startsWith(resolvedCacheDir + path.sep)
          ) {
            try {
              await fs.access(recordedPath);
              finalName = recorded;
            } catch {
              // Bytes missing on disk — fall through and
              // re-download. `seenNames` already contains
              // `recorded`; remove it so the dedupe logic
              // doesn't suffix the re-download into a
              // different name.
              seenNames.delete(recorded);
            }
          } else {
            // Manifest entry escapes `cacheDir`. Refuse the
            // fast-path entirely — fall through to the download
            // path so `downloadKchatFileToCache` re-runs the
            // full sanitise+dedupe+containment pipeline and
            // (almost certainly) lands on a different,
            // contained name. Drop the tampered name from
            // `seenNames` so the dedupe logic doesn't suffix
            // the legitimate download.
            seenNames.delete(recorded);
          }
        }

        if (finalName === null) {
          const result = await downloadKchatFileToCache(
            client,
            cacheDir,
            fi,
            seenNames,
          );
          if (!result.wrote || result.finalName === null) {
            // Containment-check rejection (the server-supplied
            // name escaped `cacheDir` even after sanitisation
            // and dedupe). Audit-log the OFFENDING sanitised
            // name (preserved in `result.finalName` even on
            // rejection) so operators see exactly which name
            // escaped, then short-circuit. The `?? ""`
            // fallback covers the unreachable case where the
            // syncer couldn't even construct a basename.
            try {
              bridge.bridgeLogKchatFileDownloaded(
                channelId,
                result.finalName ?? "",
                0,
              );
            } catch {
              /* audit failure is non-fatal */
            }
            return false;
          }
          finalName = result.finalName;
          try {
            bridge.bridgeLogKchatFileDownloaded(
              channelId,
              finalName,
              result.bytesWritten,
            );
          } catch {
            /* audit failure is non-fatal */
          }
          // Persist the manifest before the index call so a
          // partial-failure mid-sync still records the bytes
          // that landed on disk. The next full sync would
          // otherwise re-download.
          await writeManifest(cacheDir, {
            ...manifest,
            files: { ...manifest.files, [fi.id]: finalName },
          });
        }

        // Substrate index of one file only. Returns
        // `{ wasLinked, indexed, sourceId }` — `wasLinked` is
        // always `true` here (we re-checked above) but is
        // surfaced for completeness; `indexed` is `false` if
        // the substrate's hash dedupe found the same content
        // already indexed.
        const outcome = bridge.bridgeIndexKchatFile(cacheDir, finalName);
        return outcome.wasLinked && outcome.indexed;
      });
    } catch (err) {
      // Any error inside the lock — REST failure, disk error,
      // bridge throw — degrades to `triggered_reindex=false`.
      // The audit row still lands so operators can correlate
      // the failure with the WS event.
      console.error(
        "[KchatEventForwarder] single-file sync failed:",
        err,
      );
      triggeredReindex = false;
    }

    this.safeAuditFileAdded(
      bridge,
      view.event,
      channelId,
      fileId,
      triggeredReindex,
    );
  }

  /**
   * Audit-log `bridgeLogKchatFileEventReceived` while swallowing
   * any throw — the audit path is best-effort and must never
   * wedge the forwarder. Used at every exit point of
   * `handleFileAdded` (early returns, lock-protected work, error
   * paths) so the field semantics stay consistent.
   */
  private safeAuditFileAdded(
    bridge: NativeBridge,
    event: string,
    channelId: string | null,
    fileId: string | null,
    triggeredReindex: boolean,
  ): void {
    try {
      bridge.bridgeLogKchatFileEventReceived(
        event,
        channelId,
        fileId,
        triggeredReindex,
      );
    } catch (err) {
      console.error(
        "[KchatEventForwarder] audit log failed:",
        err,
      );
    }
  }

  /**
   * Block B Task 3 (Phase 11): side-effect path for membership
   * change events (`user_added`, `user_removed`,
   * `channel_member_updated`, `channel_updated`).
   *
   * Sequence:
   *   1. Drop if the event has no channel id (some KChat events
   *      tag a team without a channel; nothing to project).
   *   2. Drop if no KChat client is attached (the forwarder is
   *      running before `start()` wired one up, or after
   *      `dispose()` released it).
   *   3. Skip the linked-channel fast path: if no
   *      `SourceType::Kchat` source exists for `cacheDir`, no
   *      roster to persist and no status to update — but still
   *      emit the audit row with `outcome=unlinked` so an
   *      operator sees the no-op in the trail.
   *   4. Under `withChannelSyncLock(channelId)`:
   *      a. Re-check linked-status (a concurrent unlink may
   *         have raced this event into the queue).
   *      b. Walk the paginated `listChannelMembers` endpoint
   *         to build the full authoritative roster. The page
   *         size matches `kchatClient.listChannelMembers`'s
   *         default (200) — channels with thousands of
   *         members still resolve in a small number of pages
   *         and pagination keeps the JSON payload bounded.
   *      c. Hand the roster to `bridgeRefreshKchatAcl`. The
   *         substrate persists the rows atomically and
   *         projects status (`granted` / `regranted` /
   *         `revoked` / `unlinked` / `no_principal`).
   *      d. Emit the `KchatAclRefreshed` audit row with the
   *         projection outcome.
   *      e. If the outcome was `revoked`, ALSO emit
   *         `KchatChannelAccessRevoked` with
   *         `reason=principal_missing_from_roster` so the
   *         audit log has the same explanatory short-code
   *         shape every revocation path produces.
   *
   * Errors at every step degrade to `outcome=unlinked` on the
   * audit row and never propagate back into the forwarder's
   * fire-and-forget event loop. The lock + atomic roster
   * replace prevent a partial update from leaving the ACL row
   * set in a half-deleted state.
   */
  private async handleMembershipEvent(
    view: KchatWebSocketEventView,
  ): Promise<void> {
    const bridge = this.getBridgeFn();
    if (!bridge) return;

    const channelId = view.channelId;
    const client = this.client;
    if (channelId === null || client === null) {
      this.safeAuditAclRefreshed(bridge, view.event, channelId, 0, false, "unlinked");
      return;
    }

    const cacheDir = kchatChannelCacheDir(channelId);
    let isLinked = false;
    try {
      isLinked = bridge.bridgeIsKchatChannelLinked(cacheDir);
    } catch (err) {
      console.error(
        "[KchatEventForwarder] bridgeIsKchatChannelLinked failed:",
        err,
      );
    }
    if (!isLinked) {
      this.safeAuditAclRefreshed(bridge, view.event, channelId, 0, false, "unlinked");
      return;
    }

    let outcome: "granted" | "regranted" | "revoked" | "unlinked" | "no_principal" =
      "unlinked";
    let memberCount = 0;
    let principalPresent = false;
    // Block B Task 4 (Phase 11): cryptoshred counters captured
    // from the bridge's `KchatAclRefreshOutcomeInfo` so the
    // post-lock audit pair (`KchatChannelAccessRevoked` +
    // `KchatSourceCryptoshredded`) can use them. Default 0 so
    // the unlinked / no_principal / error paths still emit a
    // well-formed (zero-count) shred row when applicable; we
    // gate emission on `outcome === "revoked"` below.
    let chunksDropped = 0;
    let filesDropped = 0;
    // Block C Task 2 (Phase 12): chat-post + DEK counters captured
    // from the bridge's `KchatAclRefreshOutcomeInfo`. Default 0 /
    // false so non-revoke + unlinked paths still emit a
    // well-formed (zero-count) shred row when applicable.
    let postsDropped = 0;
    let dekDropped = false;
    // Block B Task 4 (Phase 11) third-pass Devin Review fix:
    // filesystem-scrub outcome captured from
    // `secureDeleteChannelArtifacts` so the audit row records
    // both substrate-side (chunks/files dropped) AND filesystem-side
    // (cache dir + manifest removed) observability. Default
    // `fsScrubSucceeded=true` for non-revoke outcomes — the
    // helper isn't called on those paths, so trivially "succeeded"
    // is the correct semantic (nothing to scrub means scrub
    // didn't fail).
    let fsScrubSucceeded = true;
    let fsScrubError: string | undefined;
    // Fifth-pass Devin Review fix
    // (ANALYSIS_pr-review-job-ef3c7d6c..._0001): substrate-side
    // `VACUUM` outcome surfaced via `KchatAclRefreshOutcomeInfo`.
    // A `false` is not a scrub failure (the row-level DELETE +
    // UPDATE already committed under `secure_delete = ON`) but the
    // audit row must record it so operators can grep for
    // `vacuum_succeeded=false` and re-run `VACUUM` manually.
    let vacuumSucceeded = true;
    let vacuumError: string | undefined;

    try {
      const result = await withChannelSyncLock(channelId, async () => {
        // Re-check linked status under the lock — a concurrent
        // `bridgeRemoveSource` may have unlinked the channel
        // between the pre-lock check and the lock acquisition.
        if (!bridge.bridgeIsKchatChannelLinked(cacheDir)) {
          return {
            outcome: "unlinked" as const,
            memberCount: 0,
            principalPresent: false,
            chunksDropped: 0,
            filesDropped: 0,
            postsDropped: 0,
            dekDropped: false,
            fsScrubSucceeded: true,
            fsScrubError: undefined as string | undefined,
            vacuumSucceeded: true,
            vacuumError: undefined as string | undefined,
          };
        }

        // Build the full member roster across paginated
        // responses. KChat's `/channels/{id}/members` returns
        // up to `perPage` rows per call; the page size matches
        // the client default (200). We stop when a page comes
        // back shorter than `perPage` or when the cumulative
        // size would exceed the safety cap (50_000 rows;
        // channels with more members are pathological and
        // would suggest a misconfigured server or a malicious
        // payload that re-routes a teamwide all-hands).
        const perPage = 200;
        const safetyCap = 50_000;
        const members: { userId: string; role: string }[] = [];
        let page = 0;
        // eslint-disable-next-line no-constant-condition
        while (true) {
          const batch = await client.listChannelMembers(
            channelId,
            page,
            perPage,
          );
          for (const m of batch) {
            members.push({ userId: m.user_id, role: m.roles });
          }
          if (batch.length < perPage) break;
          if (members.length >= safetyCap) break;
          page += 1;
        }

        const r = bridge.bridgeRefreshKchatAcl(cacheDir, members);
        // Block B Task 4 (Phase 11): on the revoke path the
        // substrate runs its inline cryptoshred under the SAME
        // per-channel lock we're already holding here, so the
        // filesystem scrub below cannot race a concurrent full
        // sync or single-file syncer write. We delete the cache
        // directory + manifest sidecar AFTER the substrate scrub
        // returns so a crash between the two phases leaves the
        // (now-orphaned) on-disk files behind — reviewable by
        // an operator — rather than scrubbing files referenced
        // by still-live substrate rows.
        //
        // Asymmetry vs. `handleChannelGoneEvent` (third-pass Devin
        // Review ANALYSIS_0005): the channel-gone path gates the
        // filesystem scrub on `outcome !== "unlinked"`, which
        // covers both `revoked` and `already_revoked`. We gate on
        // `=== "revoked"` here because `refresh_kchat_acl` (the
        // membership/ACL path) does NOT have an `already_revoked`
        // outcome — see `KchatAclRefreshOutcome` in the bridge
        // crate vs. `KchatRevokeOutcome` returned by
        // `bridgeRevokeKchatSource`. The substrate's
        // `refresh_kchat_acl` always reports `Revoked` when the
        // principal is missing (it idempotently re-deletes the
        // ACL rows + re-runs the cryptoshred), so the two enums
        // intentionally diverge: ACL refresh has no concept of
        // "this was already revoked last time" because it always
        // re-does the work. The channel-gone path explicitly
        // distinguishes the two because the backfill case (no
        // source row → `unlinked`) must NOT scrub the cache dir
        // (we never created it).
        let scrubSucceeded = true;
        let scrubError: string | undefined;
        if (r.outcome === "revoked") {
          const scrub = await secureDeleteChannelArtifacts(cacheDir);
          scrubSucceeded = scrub.cacheDirRemoved && scrub.manifestRemoved;
          scrubError = scrub.error;
        }
        return {
          outcome: r.outcome,
          memberCount: r.memberCount,
          principalPresent: r.principalPresent,
          chunksDropped: r.chunksDropped,
          filesDropped: r.filesDropped,
          postsDropped: r.postsDropped,
          dekDropped: r.dekDropped,
          fsScrubSucceeded: scrubSucceeded,
          fsScrubError: scrubError,
          vacuumSucceeded: r.vacuumSucceeded,
          vacuumError: r.vacuumError,
        };
      });
      outcome = result.outcome;
      memberCount = result.memberCount;
      principalPresent = result.principalPresent;
      chunksDropped = result.chunksDropped;
      filesDropped = result.filesDropped;
      postsDropped = result.postsDropped;
      dekDropped = result.dekDropped;
      fsScrubSucceeded = result.fsScrubSucceeded;
      fsScrubError = result.fsScrubError;
      vacuumSucceeded = result.vacuumSucceeded;
      vacuumError = result.vacuumError;
    } catch (err) {
      console.error(
        "[KchatEventForwarder] ACL refresh failed:",
        err,
      );
      outcome = "unlinked";
    }

    this.safeAuditAclRefreshed(
      bridge,
      view.event,
      channelId,
      memberCount,
      principalPresent,
      outcome,
    );

    if (outcome === "revoked") {
      this.safeAuditAccessRevoked(
        bridge,
        channelId,
        "principal_missing_from_roster",
      );
      // Block B Task 4 (Phase 11): pair every revoke transition
      // with the cryptoshred row so an operator can correlate
      // "status changed" with "evidence scrubbed" in the audit
      // trail. The chunks/files counts come from the bridge's
      // KchatAclRefreshOutcomeInfo — substrate-authoritative.
      this.safeAuditSourceCryptoshredded(
        bridge,
        channelId,
        "principal_missing_from_roster",
        chunksDropped,
        filesDropped,
        postsDropped,
        dekDropped,
        fsScrubSucceeded,
        fsScrubError,
        vacuumSucceeded,
        vacuumError,
      );
    } else if (outcome === "regranted") {
      // Block B Task 4 (Phase 11) second-pass Devin Review
      // ANALYSIS_0002: a regrant transitions the source from
      // `AccessRevoked` to `Connected` because the earlier revoke
      // cryptoshredded every chunk + indexed_file row. Without
      // an automatic re-sync, the source stays in `Connected`
      // indefinitely with zero indexed content — appearing
      // broken in the UI. We schedule a full channel re-sync
      // here so the indexer walks the channel's file roster
      // again, downloads + chunks every file, and promotes the
      // status through `Indexing` → `Indexed` on its own (the
      // same flow used for a freshly-linked channel).
      //
      // Fire-and-forget: the resync may walk hundreds of files
      // and we don't want to block the event-handler's audit-
      // row emission. We run it OUTSIDE `withChannelSyncLock`
      // (the lock has already released here) because the resync
      // path takes the same per-channel lock internally; nesting
      // would deadlock. Errors are logged but not propagated —
      // a transient REST failure leaves the source in
      // `Connected` until the next regrant event or manual
      // re-add, which is the same recovery shape as a failed
      // initial sync.
      void this.scheduleChannelResync(channelId).catch((err) => {
        console.error(
          "[KchatEventForwarder] regrant re-sync failed for channel",
          channelId,
          err,
        );
      });
    }
  }

  /**
   * Block B Task 3 (Phase 11): side-effect path for
   * `channel_archived` / `channel_deleted` events.
   *
   * Sequence:
   *   1. Drop if the event has no channel id (defensive — the
   *      KChat server always tags these events with a
   *      `broadcast.channel_id`, but we never assume).
   *   2. Drop if no bridge is attached.
   *   3. Under `withChannelSyncLock(channelId)`, call
   *      `bridgeRevokeKchatSource(cacheDir)`. The substrate
   *      transitions the source to `AccessRevoked` (or returns
   *      `already_revoked` if a previous event already did so,
   *      or `unlinked` if the channel was never linked as a
   *      corpus source).
   *   4. Emit `KchatChannelAccessRevoked` with the matching
   *      `reason=channel_archived` / `channel_deleted` short
   *      code so operators can answer "when did this channel
   *      become unreachable, and why" without consulting the
   *      KChat server's own log.
   *
   * `already_revoked` and `unlinked` outcomes still emit the
   * audit row — operators want to see the event arrived
   * (otherwise a repeated server-side archive event would
   * silently drop). Errors degrade silently; the source row
   * stays in whatever state it was already in.
   */
  private async handleChannelGoneEvent(
    view: KchatWebSocketEventView,
  ): Promise<void> {
    const bridge = this.getBridgeFn();
    if (!bridge) return;
    const channelId = view.channelId;
    if (channelId === null) return;

    const cacheDir = kchatChannelCacheDir(channelId);
    const reason =
      view.event === "channel_archived"
        ? "channel_archived"
        : "channel_deleted";

    // Block B Task 4 (Phase 11): the bridge's
    // `KchatRevokeOutcomeInfo` carries cryptoshred counts on
    // BOTH `revoked` and `already_revoked` outcomes (the
    // substrate runs the (idempotent) shred on every revoke
    // path, including the re-revoke backfill path for Task 3-era
    // soft-revoked sources). We capture the counts here, emit
    // the filesystem scrub under the lock, then audit both the
    // status-transition row AND the shred row outside the lock.
    //
    // The default is the `unlinked` outcome with zero counts so
    // a thrown error inside the lock falls through to the same
    // no-shred-row audit shape as a real `unlinked` outcome.
    // Block B Task 4 (Phase 11) third-pass Devin Review fix:
    // capture the filesystem-scrub result alongside the substrate
    // counts so the audit row records BOTH halves of the
    // observability surface. `unlinked` outcomes trivially
    // succeed (the helper isn't called when there's nothing to
    // scrub).
    let result: KchatRevokeOutcomeInfo & {
      fsScrubSucceeded: boolean;
      fsScrubError: string | undefined;
    } = {
      outcome: "unlinked",
      chunksDropped: 0,
      filesDropped: 0,
      postsDropped: 0,
      dekDropped: false,
      fsScrubSucceeded: true,
      fsScrubError: undefined,
      vacuumSucceeded: true,
      vacuumError: undefined,
    };
    try {
      result = await withChannelSyncLock(channelId, async () => {
        const r = bridge.bridgeRevokeKchatSource(cacheDir);
        // Filesystem scrub mirrors the substrate's evidence scrub.
        // We delete the cache dir + manifest sidecar on every
        // outcome that isn't `unlinked` — `unlinked` means no
        // source row ever existed, so there's no shred contract
        // to honour and nothing on disk we created.
        let scrubSucceeded = true;
        let scrubError: string | undefined;
        if (r.outcome !== "unlinked") {
          const scrub = await secureDeleteChannelArtifacts(cacheDir);
          scrubSucceeded = scrub.cacheDirRemoved && scrub.manifestRemoved;
          scrubError = scrub.error;
        }
        return {
          ...r,
          fsScrubSucceeded: scrubSucceeded,
          fsScrubError: scrubError,
        };
      });
    } catch (err) {
      console.error(
        "[KchatEventForwarder] explicit revoke failed:",
        err,
      );
    }
    const outcome = result.outcome;
    const chunksDropped = result.chunksDropped;
    const filesDropped = result.filesDropped;
    const postsDropped = result.postsDropped;
    const dekDropped = result.dekDropped;
    const fsScrubSucceeded = result.fsScrubSucceeded;
    const fsScrubError = result.fsScrubError;
    // Fifth-pass Devin Review fix
    // (ANALYSIS_pr-review-job-ef3c7d6c..._0001): pass through the
    // substrate's Phase 5 `VACUUM` outcome onto the audit row so a
    // `vacuum_succeeded=false` from the bridge surfaces as
    // `vacuum_succeeded=false` in the audit trail (instead of being
    // hidden behind a default-true that masked the degraded state).
    const vacuumSucceeded = result.vacuumSucceeded;
    const vacuumError = result.vacuumError;

    // Always emit the access-revoked audit row even when the
    // bridge returned `unlinked` / `already_revoked` — the
    // operator-visible semantics are "we saw the event", not
    // "we changed state".
    this.safeAuditAccessRevoked(bridge, channelId, reason);

    // Block B Task 4 (Phase 11): pair the access-revoked row
    // with the cryptoshred row whenever a substrate-side scrub
    // ran. We skip `unlinked` because no source existed; for
    // `revoked` and `already_revoked` the shred always ran (the
    // already_revoked counts will be zero on a previously
    // scrubbed source, which is the operator-visible signal that
    // the backfill found nothing to do).
    if (outcome === "revoked" || outcome === "already_revoked") {
      this.safeAuditSourceCryptoshredded(
        bridge,
        channelId,
        reason,
        chunksDropped,
        filesDropped,
        postsDropped,
        dekDropped,
        fsScrubSucceeded,
        fsScrubError,
        vacuumSucceeded,
        vacuumError,
      );
    }
  }

  /**
   * Block C Task 1 (Phase 12): side-effect path for `posted` WS
   * events. Sequence:
   *   1. Drop if missing channel id / client / bridge.
   *   2. Skip the linked-channel fast path: no source row, no
   *      ingestion.
   *   3. Parse the stringified post body out of `view.data.post`.
   *   4. Under `withChannelSyncLock(channelId)`, call
   *      `bridgeIngestKchatPost`. The substrate handles dedupe,
   *      chunking, AEAD sealing under the per-source DEK, and
   *      bookkeeping atomically.
   *   5. Emit `KchatPostIngested` audit row with the substrate's
   *      outcome short-code + chunk count.
   *
   * `cacheDir` is the per-channel cache directory the file-ingest
   * path also uses; the substrate keys per-source DEKs by source
   * row id, not by path, so the two paths share the same DEK as
   * long as they share the same source row.
   */
  private async handlePostedEvent(
    view: KchatWebSocketEventView,
  ): Promise<void> {
    await this.handlePostIngestEvent(view, /* isEdit */ false);
  }

  /**
   * Block C Task 1 (Phase 12): side-effect path for `post_edited`
   * WS events. Routes to `bridgeEditKchatPost` (which under the
   * hood is the same substrate code path as ingest — KChat
   * doesn't pre-track which post id was edited, only the new
   * body — but routes to a distinct audit event so the trail
   * can distinguish "first delivery" from "edit").
   */
  private async handlePostEditedEvent(
    view: KchatWebSocketEventView,
  ): Promise<void> {
    await this.handlePostIngestEvent(view, /* isEdit */ true);
  }

  /**
   * Shared ingest + edit body. Pulls the post out of the WS
   * payload, validates ids, acquires the per-channel lock, hands
   * to the bridge, then audits.
   */
  private async handlePostIngestEvent(
    view: KchatWebSocketEventView,
    isEdit: boolean,
  ): Promise<void> {
    const bridge = this.getBridgeFn();
    if (!bridge) return;

    const channelId = view.channelId;
    if (channelId === null) return;

    const parsed = parsePostPayload(view.data);
    if (parsed === null) {
      // Malformed event — log a "no_post" audit so operators
      // can grep for it without leaving a silent drop.
      const evt = isEdit ? "post_edited" : "posted";
      this.safeAuditPostIngested(bridge, channelId, "", "no_post", 0, isEdit);
      void evt;
      return;
    }

    const cacheDir = kchatChannelCacheDir(channelId);

    // Linked-channel fast path: skip the bridge call entirely
    // when no source row exists for `cacheDir`. Saves a JSON
    // round-trip across the napi boundary on the (common)
    // unlinked-channel case.
    let isLinked = false;
    try {
      isLinked = bridge.bridgeIsKchatChannelLinked(cacheDir);
    } catch (err) {
      console.error(
        "[KchatEventForwarder] bridgeIsKchatChannelLinked failed:",
        err,
      );
    }
    if (!isLinked) {
      this.safeAuditPostIngested(
        bridge,
        channelId,
        parsed.id,
        "unlinked",
        0,
        isEdit,
      );
      return;
    }

    let outcomeShortCode = "unlinked";
    let chunkCount = 0;
    try {
      const r = await withChannelSyncLock(channelId, async () => {
        if (!bridge.bridgeIsKchatChannelLinked(cacheDir)) {
          return { outcome: "unlinked" as const, chunkCount: 0 };
        }
        const input: KchatPostIngestInputInfo = {
          cacheDir,
          postId: parsed.id,
          channelId,
          rootId: parsed.rootId ?? undefined,
          senderUserId: parsed.userId,
          body: parsed.message,
          createdAtMs: parsed.createAt,
          editedAtMs: parsed.editAt,
        };
        const out = isEdit
          ? bridge.bridgeEditKchatPost(input)
          : bridge.bridgeIngestKchatPost(input);
        return { outcome: out.outcome, chunkCount: out.chunkCount };
      });
      outcomeShortCode = r.outcome;
      chunkCount = r.chunkCount;
    } catch (err) {
      console.error(
        "[KchatEventForwarder] post ingest failed:",
        err,
      );
    }

    this.safeAuditPostIngested(
      bridge,
      channelId,
      parsed.id,
      outcomeShortCode,
      chunkCount,
      isEdit,
    );
  }

  /**
   * Block C Task 1 (Phase 12): side-effect path for `post_deleted`
   * WS events. Pulls the post id out of the WS payload, takes
   * the per-channel lock, drops the substrate evidence.
   */
  private async handlePostDeletedEvent(
    view: KchatWebSocketEventView,
  ): Promise<void> {
    const bridge = this.getBridgeFn();
    if (!bridge) return;

    const channelId = view.channelId;
    if (channelId === null) return;

    const parsed = parsePostPayload(view.data);
    if (parsed === null) {
      this.safeAuditPostDeleted(bridge, channelId, "", "no_post", 0);
      return;
    }

    const cacheDir = kchatChannelCacheDir(channelId);
    let isLinked = false;
    try {
      isLinked = bridge.bridgeIsKchatChannelLinked(cacheDir);
    } catch (err) {
      console.error(
        "[KchatEventForwarder] bridgeIsKchatChannelLinked failed:",
        err,
      );
    }
    if (!isLinked) {
      this.safeAuditPostDeleted(bridge, channelId, parsed.id, "unlinked", 0);
      return;
    }

    let outcomeShortCode = "unlinked";
    let chunksDropped = 0;
    try {
      const r = await withChannelSyncLock(channelId, async () => {
        if (!bridge.bridgeIsKchatChannelLinked(cacheDir)) {
          return { outcome: "unlinked" as const, chunksDropped: 0 };
        }
        const out = bridge.bridgeDeleteKchatPost(cacheDir, parsed.id);
        return { outcome: out.outcome, chunksDropped: out.chunksDropped };
      });
      outcomeShortCode = r.outcome;
      chunksDropped = r.chunksDropped;
    } catch (err) {
      console.error(
        "[KchatEventForwarder] post delete failed:",
        err,
      );
    }

    this.safeAuditPostDeleted(
      bridge,
      channelId,
      parsed.id,
      outcomeShortCode,
      chunksDropped,
    );
  }

  /**
   * No-throw audit append for the post-body ingest / edit path.
   * `isEdit` routes to `bridgeLogKchatPostEdited` vs
   * `bridgeLogKchatPostIngested` so the audit trail can
   * distinguish first-delivery from edit-redelivery.
   */
  private safeAuditPostIngested(
    bridge: NativeBridge,
    channelId: string,
    postId: string,
    outcome: string,
    chunkCount: number,
    isEdit: boolean,
  ): void {
    try {
      if (isEdit) {
        bridge.bridgeLogKchatPostEdited(channelId, postId, outcome, chunkCount);
      } else {
        bridge.bridgeLogKchatPostIngested(
          channelId,
          postId,
          outcome,
          chunkCount,
        );
      }
    } catch (err) {
      console.error(
        "[KchatEventForwarder] post-ingest audit log failed:",
        err,
      );
    }
  }

  /** No-throw audit append for the post-delete path. */
  private safeAuditPostDeleted(
    bridge: NativeBridge,
    channelId: string,
    postId: string,
    outcome: string,
    chunksDropped: number,
  ): void {
    try {
      bridge.bridgeLogKchatPostDeleted(
        channelId,
        postId,
        outcome,
        chunksDropped,
      );
    } catch (err) {
      console.error(
        "[KchatEventForwarder] post-delete audit log failed:",
        err,
      );
    }
  }

  /**
   * No-throw audit append for `bridgeLogKchatAclRefreshed`.
   * Mirrors the {@link safeAuditFileAdded} pattern — audit is
   * best-effort and must never wedge the forwarder.
   *
   * `eventName` is the originating WS event name so an operator
   * scanning the audit trail can see whether a refresh was
   * driven by `user_added`, `user_removed`,
   * `channel_member_updated`, or `channel_updated`. It is
   * folded into the projection outcome via the audit logger's
   * `details` formatter.
   */
  private safeAuditAclRefreshed(
    bridge: NativeBridge,
    eventName: string,
    channelId: string | null,
    memberCount: number,
    principalPresent: boolean,
    outcome: string,
  ): void {
    if (channelId === null) return;
    try {
      bridge.bridgeLogKchatAclRefreshed(
        channelId,
        memberCount,
        principalPresent,
        `${outcome}:${eventName}`,
      );
    } catch (err) {
      console.error(
        "[KchatEventForwarder] ACL refresh audit log failed:",
        err,
      );
    }
  }

  /**
   * No-throw audit append for
   * `bridgeLogKchatChannelAccessRevoked`.
   */
  private safeAuditAccessRevoked(
    bridge: NativeBridge,
    channelId: string,
    reason: string,
  ): void {
    try {
      bridge.bridgeLogKchatChannelAccessRevoked(channelId, reason);
    } catch (err) {
      console.error(
        "[KchatEventForwarder] access-revoked audit log failed:",
        err,
      );
    }
  }

  /**
   * Block B Task 4 (Phase 11): no-throw audit append for
   * `bridgeLogKchatSourceCryptoshredded`. Mirrors the
   * {@link safeAuditAccessRevoked} pattern — audit is best-effort
   * and must never wedge the forwarder. Emitted only after the
   * substrate's `bridgeRevokeKchatSource` /
   * `bridgeRefreshKchatAcl` revoke path returned its
   * cryptoshred counts so the audit row is always
   * substrate-authoritative; a zero count on `already_revoked`
   * is the operator-visible signal that the source was already
   * scrubbed (e.g. on a repeat `channel_archived` event).
   */
  private safeAuditSourceCryptoshredded(
    bridge: NativeBridge,
    channelId: string,
    reason: string,
    chunksDropped: number,
    filesDropped: number,
    postsDropped: number,
    dekDropped: boolean,
    fsScrubSucceeded: boolean,
    fsScrubError: string | undefined,
    vacuumSucceeded: boolean,
    vacuumError: string | undefined,
  ): void {
    try {
      bridge.bridgeLogKchatSourceCryptoshredded(
        channelId,
        reason,
        chunksDropped,
        filesDropped,
        postsDropped,
        dekDropped,
        fsScrubSucceeded,
        fsScrubError,
        vacuumSucceeded,
        vacuumError,
      );
    } catch (err) {
      console.error(
        "[KchatEventForwarder] cryptoshredded audit log failed:",
        err,
      );
    }
  }
}
