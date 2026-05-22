/**
 * Regression tests for `isNetworkError`.
 *
 * The predicate decides whether a failure inside `connectors:sync`
 * should be surfaced as an "Offline" status (and silently swallowed)
 * vs. propagated as a hard error the renderer must show to the user.
 *
 * The bug this test prevents (Devin Review wave 3, finding BUG_0001):
 * the previous regex `/fetch failed|network|connect/i` matched the
 * bare token `connect`, which also appears inside the auth-state
 * error message `"${provider} is not connected — authenticate first"`.
 * That made every sync attempt against a disconnected provider silently
 * return `{ status: "offline" }`, so the user saw an Offline badge
 * forever instead of being told to re-authenticate.
 */

import { describe, it, expect, vi } from "vitest";

// Mock electron before importing the module under test.
vi.mock("electron", () => ({
  app: { getPath: vi.fn().mockReturnValue("/tmp") },
  ipcMain: { handle: vi.fn() },
  shell: { openExternal: vi.fn() },
}));

import {
  NetworkError,
  NotConnectedError,
  isNetworkError,
} from "../ipc/connectors/handlers";

describe("isNetworkError", () => {
  it("returns false for `NotConnectedError` even when its message contains 'connect'", () => {
    const err = new NotConnectedError(
      "google_drive is not connected — authenticate first",
    );
    expect(isNetworkError(err)).toBe(false);
  });

  it("returns false for `NotConnectedError` when message contains 'reconnect'", () => {
    const err = new NotConnectedError(
      "onedrive access token expired and refresh is not available — re-authenticate",
    );
    expect(isNetworkError(err)).toBe(false);
  });

  it("returns true for the dedicated `NetworkError` class", () => {
    expect(isNetworkError(new NetworkError("anything"))).toBe(true);
  });

  it.each([
    // libc / Node
    ["EAI_AGAIN"],
    ["ENOTFOUND"],
    ["ETIMEDOUT"],
    ["ECONNREFUSED"],
    ["ECONNRESET"],
    ["ENETUNREACH"],
    ["EHOSTUNREACH"],
    ["EPIPE"],
    // undici (Node 18+ fetch) — ANALYSIS_0008
    ["UND_ERR_SOCKET"],
    ["UND_ERR_CONNECT_TIMEOUT"],
    ["UND_ERR_HEADERS_TIMEOUT"],
    ["UND_ERR_BODY_TIMEOUT"],
    ["UND_ERR_REQ_RETRY"],
    // Node fetch / Electron — ANALYSIS_0008
    ["ERR_NETWORK"],
    ["ERR_NETWORK_CHANGED"],
    ["ERR_NETWORK_IO_SUSPENDED"],
    ["ERR_INTERNET_DISCONNECTED"],
    ["ERR_NAME_NOT_RESOLVED"],
    ["ERR_CONNECTION_REFUSED"],
    ["ERR_CONNECTION_RESET"],
    ["ERR_CONNECTION_ABORTED"],
    ["ERR_CONNECTION_CLOSED"],
    ["ERR_CONNECTION_TIMED_OUT"],
    ["ERR_CONNECTION_FAILED"],
    ["ERR_SOCKET_CONNECTION_TIMEOUT"],
    ["ERR_SOCKET_NOT_CONNECTED"],
    ["ERR_TIMED_OUT"],
  ])("returns true for syscall code %s", (code) => {
    const err = Object.assign(new Error("something"), { code });
    expect(isNetworkError(err)).toBe(true);
  });

  it("returns true when the syscall code is hidden under `cause`", () => {
    const err = Object.assign(new Error("fetch failed"), {
      cause: { code: "ECONNREFUSED" },
    });
    expect(isNetworkError(err)).toBe(true);
  });

  it.each([
    ["fetch failed"],
    ["Network error: socket closed"],
    ["Network unreachable"],
    ["Network is offline"],
    ["Connection refused by remote host"],
    ["Connection reset by peer"],
    ["Connection timed out"],
    ["DNS lookup failed for accounts.google.com"],
    ["getaddrinfo ENOTFOUND api.notion.com"],
    ["socket hang up"],
  ])("returns true for transport message %j", (msg) => {
    expect(isNetworkError(new Error(msg))).toBe(true);
  });

  it.each([
    ["google_drive is not connected — authenticate first"],
    ["onedrive client credentials missing — re-authenticate"],
    ["jira disconnect failed"],
    ["please reconnect to figma"],
    ["user is connected to a different workspace"],
    ["already connected"],
  ])("returns false for non-network message %j", (msg) => {
    expect(isNetworkError(new Error(msg))).toBe(false);
  });

  it("returns false for HTTP / API errors with a status code", () => {
    const err = Object.assign(new Error("HTTP 401 Unauthorized"), {
      code: "HTTP_401",
    });
    expect(isNetworkError(err)).toBe(false);
  });

  it.each([[null], [undefined], ["string error"], [42], [true]])(
    "returns false for non-object value %j",
    (v) => {
      expect(isNetworkError(v as unknown)).toBe(false);
    },
  );

  it("returns false for a plain Error with an empty message", () => {
    expect(isNetworkError(new Error(""))).toBe(false);
  });

  it("does NOT match the substring 'connect' inside 'connected' / 'disconnect' / 'reconnect'", () => {
    // These are the exact strings the previous regex matched
    // incorrectly, which caused the swallow-auth-error bug.
    const cases = [
      "is not connected",
      "is connected",
      "has been disconnected",
      "must reconnect",
      "disconnect failed",
      "reconnect to your account",
    ];
    for (const msg of cases) {
      expect(
        isNetworkError(new Error(msg)),
        `should NOT classify '${msg}' as network`,
      ).toBe(false);
    }
  });
});
