/**
 * Unit tests for the new-post notification decision layer
 * (Session 8 Task 3) — `buildPostNotification`.
 */
import { describe, it, expect } from "vitest";
import {
  buildPostNotification,
  NOTIFICATION_BODY_MAX,
  type PostNotificationInput,
} from "../kchat/kchatNotify";

function input(over: Partial<PostNotificationInput> = {}): PostNotificationInput {
  return {
    channelId: "c1",
    channelName: "general",
    senderUserId: "u2",
    senderUsername: "bob",
    message: "hello team",
    isEdit: false,
    selfUserId: "u1",
    watched: true,
    ...over,
  };
}

describe("buildPostNotification", () => {
  it("builds a notification for a new watched post from another user", () => {
    const n = buildPostNotification(input());
    expect(n).not.toBeNull();
    expect(n!.title).toBe("bob in general");
    expect(n!.body).toBe("hello team");
    expect(n!.channelId).toBe("c1");
  });

  it("suppresses edits", () => {
    expect(buildPostNotification(input({ isEdit: true }))).toBeNull();
  });

  it("suppresses posts in unwatched channels", () => {
    expect(buildPostNotification(input({ watched: false }))).toBeNull();
  });

  it("suppresses the local user's own posts", () => {
    expect(
      buildPostNotification(input({ senderUserId: "u1", selfUserId: "u1" })),
    ).toBeNull();
  });

  it("still notifies when selfUserId is unknown (null)", () => {
    const n = buildPostNotification(input({ selfUserId: null }));
    expect(n).not.toBeNull();
  });

  it("suppresses empty / whitespace-only bodies (file-only posts)", () => {
    expect(buildPostNotification(input({ message: "   " }))).toBeNull();
    expect(buildPostNotification(input({ message: "" }))).toBeNull();
  });

  it("falls back to a generic title when the username is missing", () => {
    const n = buildPostNotification(
      input({ senderUsername: null, channelName: null }),
    );
    expect(n!.title).toBe("New message");
  });

  it("omits the channel suffix when the channel name is missing", () => {
    const n = buildPostNotification(input({ channelName: "  " }));
    expect(n!.title).toBe("bob");
  });

  it("truncates an over-long body to the cap with an ellipsis", () => {
    const long = "x".repeat(NOTIFICATION_BODY_MAX + 50);
    const n = buildPostNotification(input({ message: long }));
    expect(n!.body.length).toBeLessThanOrEqual(NOTIFICATION_BODY_MAX);
    expect(n!.body.endsWith("…")).toBe(true);
  });
});
