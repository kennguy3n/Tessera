/**
 * uney-chat-desktop extension event bridge.
 *
 * Phase 13 Task 3. Receives event frames from the desktop app
 * over the extension socket (see `kchatExtensionBridge.ts`) and
 * maps them to Tessera's existing `KchatWebSocketEventView`
 * shape so the downstream consumers (`KchatEventForwarder` ➜
 * renderer push, `KchatSidebarSection` reconciliation poll) keep
 * working unchanged.
 *
 * The desktop app emits *native* event names following its
 * `src/core/ports/kchat/events.ts` contract:
 *
 *   - `message:received` / `message:edited` / `message:deleted`
 *   - `conversation:participant_added` /
 *     `conversation:participant_removed` /
 *     `conversation:deleted` / `conversation:updated`
 *   - `presence:changed`
 *   - `auth:link_status_changed`
 *
 * Tessera's substrate + renderer already consume Mattermost-v4
 * names (`posted`, `post_edited`, `post_deleted`, `file_added`,
 * `user_added`, `user_removed`, `channel_member_updated`,
 * `channel_deleted`, …). To avoid a churn through the whole
 * forwarder + audit + substrate stack, this module translates at
 * the source: every desktop-app event becomes a synthetic
 * Mattermost-style `KchatWebSocketEvent` envelope, and the
 * existing dispatch path takes it from there.
 *
 * The translation table is intentionally conservative — only
 * events Tessera's downstream actually reacts to are mapped, and
 * mapped events carry the original event name in
 * `data._extension_native_event` for audit + diagnostics.
 * Unrecognised events surface as a no-op so a desktop-app
 * version bump doesn't accidentally inject events the substrate
 * has no handler for.
 *
 * The desktop app *may* also emit pre-translated Mattermost-style
 * events directly (e.g. as a courtesy when running against a
 * Mattermost-compatible KChat backend). In that case the
 * passthrough branch hands the frame to the forwarder verbatim.
 */

import type {
  EventFrame,
  ExtensionConnection,
} from "./kchatExtensionBridge";
import type {
  KchatWebSocketEvent,
} from "./kchatTypes";

/**
 * Mattermost-style event names Tessera's downstream understands
 * (filter set in `kchatEventForwarder.ts`). Anything outside
 * this set is dropped — extending the set is a coordinated
 * change with the forwarder, not a one-sided change here.
 */
const MATTERMOST_EVENT_ALLOWLIST: ReadonlySet<string> = new Set([
  "posted",
  "post_edited",
  "post_deleted",
  "file_added",
  "user_added",
  "user_removed",
  "channel_member_updated",
  "channel_created",
  "channel_deleted",
  "channel_updated",
  "reaction_added",
  "reaction_removed",
  "typing",
  "presence_changed",
  "hello",
  "status_change",
]);

/**
 * Desktop-app native event → Mattermost-style event translation
 * table. The right-hand side names the Mattermost event the
 * downstream consumes; the left-hand side is the wire name the
 * desktop app emits per `uney-chat-desktop`'s port contract.
 *
 * `null` means "drop this event silently" — we keep the entry so
 * the translation table doubles as documentation.
 */
const NATIVE_TO_MATTERMOST: Record<string, string | null> = {
  "message:received": "posted",
  "message:edited": "post_edited",
  "message:deleted": "post_deleted",
  "message:reaction_added": "reaction_added",
  "message:reaction_removed": "reaction_removed",
  "message:read": null, // No Mattermost equivalent; not currently consumed.
  "conversation:created": "channel_created",
  "conversation:updated": "channel_updated",
  "conversation:deleted": "channel_deleted",
  "conversation:participant_added": "user_added",
  "conversation:participant_removed": "user_removed",
  "conversation:participant_role_updated": "channel_member_updated",
  "presence:changed": "presence_changed",
  // Auth-link / refresh events are handled by the session module
  // directly (see `kchatExtensionSession.ts`) and never reach the
  // substrate-facing forwarder.
  "auth:link_status_changed": null,
  "auth:user_authenticated": null,
  // File-attachment events. The desktop app emits a dedicated
  // event when a file is uploaded into a conversation; the
  // forwarder's `file_added` handler (Phase 12 Block B Task 2)
  // takes it from there.
  "file:added": "file_added",
};

/**
 * Map a single `EventFrame` to a Mattermost-style
 * `KchatWebSocketEvent`, or `null` if the event should be
 * dropped.
 *
 * Exported for the unit-test suite.
 */
export function translateExtensionEvent(
  frame: EventFrame,
): KchatWebSocketEvent | null {
  if (!frame || frame.type !== "event") return null;
  const original = frame.event;
  // Pre-translated passthrough — the desktop app may emit
  // events already in Mattermost form (e.g. running against a
  // Mattermost-compatible KChat backend), in which case we
  // forward unchanged after a lightweight allowlist check.
  if (MATTERMOST_EVENT_ALLOWLIST.has(original)) {
    return toMattermostEnvelope(original, frame);
  }
  if (!(original in NATIVE_TO_MATTERMOST)) {
    // Unknown event — drop. The translation table is the
    // single source of truth; extending it is a coordinated
    // change with the forwarder.
    return null;
  }
  const mapped = NATIVE_TO_MATTERMOST[original];
  if (mapped === null) return null;
  return toMattermostEnvelope(mapped, frame);
}

function toMattermostEnvelope(
  mattermostEvent: string,
  frame: EventFrame,
): KchatWebSocketEvent {
  // Keep the original desktop-app event name in `_extension_native_event`
  // so the audit row + diagnostics can distinguish a translated
  // event from a native Mattermost event (without changing the
  // public wire shape downstream).
  const data: Record<string, unknown> = {
    ...(frame.data || {}),
    _extension_native_event: frame.event,
  };
  return {
    event: mattermostEvent,
    data,
    broadcast: {
      channel_id: frame.channelId ?? undefined,
      team_id: frame.teamId ?? undefined,
      user_id: frame.userId ?? undefined,
    },
    seq: typeof frame.seq === "number" ? frame.seq : 0,
  };
}

/**
 * Bridge a single `ExtensionConnection`'s event stream to an
 * existing `KchatWebSocketEvent` dispatcher. The dispatcher is
 * typically `KchatClient`'s internal `wsListeners` fan-out (which
 * the `KchatEventForwarder` already subscribes to) — bridging
 * here means the forwarder sees extension-bridged events as if
 * they came off the native WebSocket.
 *
 * Returns a teardown function that unsubscribes the event
 * listener.
 *
 * **Trust boundary**: every translated event has its data field
 * passed through verbatim. The substrate-side parsers
 * (`bridge_ingest_kchat_post`, `bridge_refresh_kchat_acl`) already
 * validate the post envelope and channel-member shapes; the
 * extension bridge does NOT relax those checks.
 */
export function attachExtensionEvents(
  connection: ExtensionConnection,
  dispatch: (event: KchatWebSocketEvent) => void,
): () => void {
  return connection.onEvent((frame) => {
    const translated = translateExtensionEvent(frame);
    if (!translated) return;
    try {
      dispatch(translated);
    } catch {
      // Dispatch failures are absorbed at the source — the
      // forwarder's audit-on-throw path (see
      // `kchatEventForwarder.ts`) handles substrate errors;
      // bubbling them out of the socket data handler would
      // close the connection and break unrelated events.
    }
  });
}
