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
 * Connection state surfaced to the renderer via `kchat:status`.
 * `error` carries a human-readable reason when `state === "error"`.
 */
export interface KchatConnectionState {
  state: "disconnected" | "connecting" | "connected" | "error";
  user?: Pick<KchatUser, "id" | "username" | "email" | "first_name" | "last_name">;
  serverUrl?: string;
  error?: string;
  /** ISO-8601 timestamp of the last successful health check. */
  lastHealthyAt?: string;
}
