/**
 * TypeScript types for the subset of the KChat (Mattermost v4) REST
 * + WebSocket API surface that Tessera uses.
 *
 * Only the fields Tessera reads are typed. KChat returns a much
 * wider payload for each entity — keeping the shape narrow here
 * avoids accidentally widening the IPC contract to fields we never
 * validate against on the renderer side.
 *
 * **Renderer-safety**: every type in this file is plain data (no
 * tokens, no internal client state). The renderer process imports
 * these for typing the IPC responses it consumes; the actual KChat
 * personal access token lives only inside the main-process
 * `tokenVault` and never crosses the IPC bridge.
 */

/** A KChat user as returned by `GET /api/v4/users/me`. */
export interface KchatUser {
  id: string;
  username: string;
  email: string;
  first_name: string;
  last_name: string;
  /** Server-side avatar version; bumped when the user changes their picture. */
  last_picture_update?: number;
  /** Roles the user holds at the system level, e.g. `"system_user"`. */
  roles: string;
}

/** A KChat team as returned by `GET /api/v4/users/{id}/teams`. */
export interface KchatTeam {
  id: string;
  name: string;
  display_name: string;
  description?: string;
  type: "O" | "I"; // O=open, I=invite-only
  create_at: number;
  update_at: number;
}

/** A KChat channel as returned by `GET /api/v4/teams/{id}/channels`. */
export interface KchatChannel {
  id: string;
  team_id: string;
  name: string;
  display_name: string;
  /** `O` (open), `P` (private), `D` (direct), `G` (group). */
  type: "O" | "P" | "D" | "G";
  header?: string;
  purpose?: string;
  /** Server-side message-count snapshot (cheap unread indicator). */
  total_msg_count: number;
  create_at: number;
  update_at: number;
}

/** A KChat channel member relation. */
export interface KchatChannelMember {
  channel_id: string;
  user_id: string;
  /** Comma-separated role list, e.g. `"channel_user channel_admin"`. */
  roles: string;
  last_viewed_at: number;
  msg_count: number;
}

/** File metadata as returned by `GET /api/v4/channels/{id}/files`. */
export interface KchatFileInfo {
  id: string;
  user_id: string;
  channel_id?: string;
  /** Original filename including extension. */
  name: string;
  /** Byte length on the server. */
  size: number;
  /** MIME type as detected by the server. */
  mime_type: string;
  /** Lower-case extension without the leading dot. */
  extension: string;
  create_at: number;
  update_at: number;
}

/** Payload for `POST /api/v4/files` — file-upload response. */
export interface KchatFileUploadResponse {
  file_infos: KchatFileInfo[];
}

/**
 * WebSocket event envelope. KChat sends `{ event, data, broadcast,
 * seq }` for every server-pushed message. We only consume a handful
 * of event types — the rest are surfaced as raw `unknown` payloads
 * so future code paths can opt in by narrowing on `event`.
 */
export interface KchatWebSocketEvent {
  event: string;
  data: Record<string, unknown>;
  broadcast: {
    channel_id?: string;
    team_id?: string;
    user_id?: string;
    omit_users?: Record<string, boolean>;
  };
  seq: number;
}

/** Narrowed `posted` event payload (new message in a channel). */
export interface KchatPostedEvent {
  channel_display_name: string;
  channel_name: string;
  channel_type: string;
  post: string; // JSON-stringified post; clients parse on demand
  sender_name: string;
  team_id: string;
}

/**
 * Narrowed `post_edited` event payload. KChat surfaces the
 * stringified updated post; the substrate uses the post id +
 * channel id + new body to re-chunk under the existing
 * `indexed_files` row. The wire shape mirrors `posted` closely;
 * we declare it as a distinct interface so the forwarder can
 * route the two events to different bridge entry points
 * (`bridge_ingest_kchat_post` vs `bridge_edit_kchat_post`)
 * without ambiguity at the call site.
 *
 * Block C Task 1 (Phase 7).
 */
export interface KchatPostEditedEvent {
  channel_display_name: string;
  channel_name: string;
  channel_type: string;
  post: string;
  sender_name: string;
  team_id: string;
}

/**
 * Narrowed `post_deleted` event payload. KChat does not
 * resurface the body on delete, so this carries only the
 * stringified post envelope (the substrate uses `post.id` +
 * `post.channel_id` to find the row).
 *
 * Block C Task 1 (Phase 7).
 */
export interface KchatPostDeletedEvent {
  channel_display_name?: string;
  channel_name?: string;
  channel_type?: string;
  post: string;
  team_id?: string;
}

/**
 * Sanitised view of a single KChat post body. Returned by
 * [`KchatClient.getPost`] and as the array element of
 * [`KchatPostListPage`]. Mirrors the small subset of fields the
 * substrate ingestion path actually consumes — full KChat
 * `Post` envelopes carry ~20 metadata fields most of which we
 * never store.
 *
 * Block C Task 1 (Phase 8).
 */
export interface KchatPostInfo {
  id: string;
  channelId: string;
  /** Root id for thread replies; `null` for top-level posts. */
  rootId: string | null;
  /** Author user id. */
  userId: string;
  /** Post body as KChat stores it (no markdown-stripping). */
  message: string;
  /** Server-side create timestamp (ms since epoch). */
  createAt: number;
  /**
   * Server-side last-edit timestamp (ms since epoch); `0` for
   * posts that have never been edited. The substrate uses this
   * to disambiguate stale `post_edited` deliveries from real
   * edits via the message-hash check, but the column is still
   * surfaced here so renderer-side audit views can render the
   * "(edited)" marker without a substrate round-trip.
   */
  editAt: number;
}

/**
 * Pagination result from [`KchatClient.getPostsForChannel`]. The
 * `hasMore` flag is `true` whenever the request returned a full
 * page; the caller advances by passing `beforeId` set to the
 * oldest post id in the current page (chronological-descending
 * cursor). Mirrors the contract KChat's `GET
 * /channels/{id}/posts` returns under the `prev_post_id` cursor
 * model, but flattened to the field names the renderer + audit
 * surfaces consume.
 *
 * Block C Task 1 (Phase 8).
 */
export interface KchatPostListPage {
  posts: KchatPostInfo[];
  /** Cursor for the next-older page; `null` when no more posts. */
  prevPostId: string | null;
  /** Cursor for the next-newer page; `null` at the channel head. */
  nextPostId: string | null;
  /** `true` when the server signalled there are older posts to fetch. */
  hasMore: boolean;
}

/** Narrowed `channel_member_updated` event payload. */
export interface KchatChannelMemberUpdatedEvent {
  channelMember: KchatChannelMember;
}

/** Narrowed `user_added` / `user_removed` event payloads. */
export interface KchatChannelMembershipEvent {
  user_id: string;
  team_id?: string;
  /** Present on `user_removed` only. */
  remover_id?: string;
}

/**
 * Sanitised view of the authenticated KChat user surfaced to the
 * renderer through `KchatConnectionState`. Uses camelCase to
 * match the rest of the renderer-facing surface (`KchatUserView`,
 * the result of `kchat:connect`) — earlier revisions used
 * snake_case here and forced the renderer to special-case the
 * connection-state shape. Keeping a single canonical case avoids
 * "did you mean first_name or firstName?" mistakes at every call
 * site.
 */
export interface KchatConnectedUserView {
  id: string;
  username: string;
  email: string;
  firstName: string;
  lastName: string;
}

/**
 * Connection state surfaced to the renderer via `kchat:status`.
 * `error` carries a human-readable reason when `state === "error"`.
 *
 * Phase 13 Task 4: `authMode` distinguishes the PAT-backed
 * connection (operator pasted a personal access token in the
 * Settings card) from the extension-bridge connection (Tessera
 * delegated auth to a locally-running `uney-chat-desktop`
 * instance). The renderer uses this to swap the "Connected via
 * PAT" / "Connected via KChat Desktop" affordance in the
 * Settings card and the sidebar connectivity indicator without
 * having to hit a separate IPC channel. `"none"` is the value
 * surfaced while disconnected so the discriminator is total
 * rather than optional — every consumer either branches on
 * `state` first (and ignores `authMode`) or branches on both.
 *
 * `extensionAvailable` is the cached output of the latest
 * extension-bridge probe (see `kchatExtensionBridge.ts`). The
 * Settings card uses it to decide whether to show the
 * "Connect via KChat Desktop" primary action; the value is
 * refreshed on every `kchat:status` read so the UX picks up a
 * desktop-app launch without a Tessera restart.
 */
export interface KchatConnectionState {
  state: "disconnected" | "connecting" | "connected" | "error";
  user?: KchatConnectedUserView;
  serverUrl?: string;
  error?: string;
  /** ISO-8601 timestamp of the last successful health check. */
  lastHealthyAt?: string;
  /**
   * Phase 13 Task 4 — `"none"` when `state === "disconnected"`,
   * `"pat"` when connected via personal access token,
   * `"extension"` when connected via the `uney-chat-desktop`
   * extension bridge. Field is optional on the type so the
   * internal `KchatClient` (which knows nothing about auth mode)
   * can emit transitions without filling it in; the
   * `KchatAuthService` wrapper always sets it before the state
   * crosses the IPC boundary, so renderer-side reads can safely
   * default `undefined → "none"`.
   */
  authMode?: "none" | "pat" | "extension";
  /**
   * Phase 13 Task 4 — last cached extension-bridge availability.
   * Optional for the same reason as `authMode`; the
   * `KchatAuthService.getState()` wrapper supplies the value
   * before it reaches the renderer.
   */
  extensionAvailable?: boolean;
}

/**
 * Renderer-safe projection of a [`KchatWebSocketEvent`] surfaced
 * by the main process over the `kchat:event` push channel. The
 * shape is a narrowed subset of the full wire envelope — the
 * `omit_users` map is dropped (it carries internal KChat-server
 * routing metadata that no renderer surface inspects) and the
 * remaining fields are flattened so the renderer doesn't have to
 * reach into `broadcast.*` to find the channel id.
 *
 * `data` is preserved as an opaque `Record<string, unknown>` so
 * downstream code can opt into event-specific narrowings (e.g.
 * the `KchatPostedEvent`-style shapes already declared above) on
 * a case-by-case basis without forcing every consumer through a
 * discriminated-union match.
 *
 * `event` is left as a free-form `string` rather than a union
 * because KChat's WebSocket protocol is open-ended: new server
 * builds add new event names regularly, and the forwarder's
 * filter set (defined in `kchatEventForwarder.ts`) is the
 * single source of truth for which subset reaches the renderer.
 */
export interface KchatWebSocketEventView {
  /**
   * Wire-level event name (`posted`, `file_added`,
   * `channel_member_updated`, `channel_created`, …). The
   * renderer should treat any unrecognised value as a no-op
   * rather than throwing — the forwarder may broaden the
   * filter set without a coordinated renderer release.
   */
  event: string;
  /**
   * Originating channel id when the KChat server tagged the
   * broadcast envelope with one. Many event types (`hello`,
   * `status_change`) carry no channel scope and surface as
   * `null`.
   */
  channelId: string | null;
  /** Originating team id when present in the broadcast envelope. */
  teamId: string | null;
  /** Originating user id when present in the broadcast envelope. */
  userId: string | null;
  /**
   * Monotonically-increasing sequence number assigned by the
   * KChat server. A gap (`seq` jumps by more than 1) signals the
   * server dropped an intermediate event before delivering it to
   * the WebSocket; clients reconcile by re-querying REST. The
   * renderer's reconciliation poll (`KchatSidebarSection`'s
   * 30 s fallback) closes the gap automatically.
   */
  seq: number;
  /** Opaque event-specific payload. Type narrowed per-event by consumers. */
  data: Record<string, unknown>;
}
