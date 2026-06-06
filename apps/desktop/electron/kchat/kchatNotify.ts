/**
 * Pure decision layer for the KChat new-post notification bridge
 * (Session 8 Task 3).
 *
 * {@link buildPostNotification} decides whether an inbound `posted`
 * WebSocket event should raise a native OS notification and, if so,
 * what the title/body should be. Keeping the policy here — free of
 * Electron's `Notification` and the forwarder's state — makes the
 * routing rules unit-testable: the forwarder calls this, and only
 * delivers via the OS when it returns non-null.
 *
 * Rules (all must hold to notify):
 *   - the post is brand-new (`isEdit === false`); edits and
 *     deletions never notify.
 *   - the originating channel is in the user's watched set.
 *   - the author is not the local user (no self-notifications).
 *   - the message has visible text (a file-only post with an empty
 *     body produces no notification — the file lands via the
 *     file-sync path instead).
 */

/** Max characters shown in a notification body before truncation. */
export const NOTIFICATION_BODY_MAX = 240;

export interface PostNotificationInput {
  channelId: string;
  channelName?: string | null;
  senderUserId: string;
  senderUsername?: string | null;
  message: string;
  isEdit: boolean;
  /** The locally-authenticated user's id, or null if unknown. */
  selfUserId: string | null;
  /** Whether the channel is in the user's watched set. */
  watched: boolean;
}

export interface PostNotification {
  title: string;
  body: string;
  channelId: string;
}

function truncate(text: string, max: number): string {
  if (text.length <= max) return text;
  // Reserve one char for the ellipsis so the result stays within
  // `max`.
  return `${text.slice(0, Math.max(0, max - 1)).trimEnd()}…`;
}

/**
 * Build the notification payload for an inbound post, or `null`
 * when the post should not raise a notification. See module doc
 * for the rules.
 */
export function buildPostNotification(
  input: PostNotificationInput,
): PostNotification | null {
  if (input.isEdit) return null;
  if (!input.watched) return null;
  if (input.selfUserId !== null && input.senderUserId === input.selfUserId) {
    return null;
  }

  const body = input.message.trim();
  if (body.length === 0) return null;

  const who =
    input.senderUsername && input.senderUsername.trim().length > 0
      ? input.senderUsername.trim()
      : "New message";
  const where =
    input.channelName && input.channelName.trim().length > 0
      ? input.channelName.trim()
      : null;
  const title = where ? `${who} in ${where}` : who;

  return {
    title,
    body: truncate(body, NOTIFICATION_BODY_MAX),
    channelId: input.channelId,
  };
}
