/**
 * IPC handlers for the `kchat:*` channels.
 *
 * Mounts the Node-side `KchatAuthService` / `KchatClient` (in
 * `electron/kchat/`) into Tessera's IPC layer. Every handler:
 *   - Validates renderer input through the shared validators.
 *   - Sanitises responses so the KChat personal access token never
 *     crosses the renderer boundary. The token lives only in the
 *     main-process `tokenVault`; the renderer sees connection state
 *     (`disconnected | connecting | connected | error`), the
 *     authenticated user, channel/team metadata, and file metadata.
 *   - Emits audit events through the existing `bridgeLogKchat*`
 *     pass-throughs so KChat activity sits alongside source +
 *     connector events in the `tessera_audit` SQLite store.
 *
 * Feature gating: `kchat:isAvailable` returns `true` once the
 * feature ships. The renderer hides the entire KChat UI when this
 * returns `false`, so the rest of the handlers are still safe to
 * register (they'll throw "KChat token is not configured" until a
 * token is set, which is the right behaviour for a renderer that
 * accidentally calls them while disconnected).
 */

import * as os from "os";
import * as path from "path";
import * as fs from "fs/promises";
import { createHash } from "crypto";
import {
  getBridge,
  getKchatAuthService,
  setKchatBackfillImpl,
  setKchatChannelResyncImpl,
} from "../appState";
import type {
  KchatBackfillRunOutcome,
  KchatPostIngestInputInfo,
  KchatPostSearchHit,
} from "../../shared/types";
import { idempotentHandle } from "./register";
import { defaultRateLimiter, RATE_LIMIT_PROFILES } from "./rateLimiter";
import {
  assertBoolean,
  assertId,
  assertNumber,
  assertString,
} from "./validate";
import {
  KchatRequestError,
  isKchatObjectId,
} from "../kchat/kchatClient";
import { kchatChannelCacheDir } from "../kchat/kchatPaths";
import { enforceKchatServerUrl } from "../kchat/ssrfGuard";
import {
  downloadKchatFileToCache,
  readManifest,
  withChannelSyncLock,
  writeManifest,
} from "../kchat/kchatChannelSyncer";
import {
  KchatChannel,
  KchatChannelMember,
  KchatConnectionState,
  KchatFileInfo,
  KchatTeam,
} from "../kchat/kchatTypes";

/** Subset of `KchatTeam` the renderer is allowed to read. */
type RendererTeam = Pick<
  KchatTeam,
  "id" | "name" | "display_name" | "description" | "type"
>;

/** Subset of `KchatChannel` the renderer is allowed to read. */
type RendererChannel = Pick<
  KchatChannel,
  "id" | "team_id" | "name" | "display_name" | "type" | "purpose" | "header"
>;

/** Subset of `KchatChannelMember` the renderer is allowed to read. */
type RendererChannelMember = Pick<
  KchatChannelMember,
  "channel_id" | "user_id" | "roles"
>;

/** Subset of `KchatFileInfo` the renderer is allowed to read. */
type RendererFileInfo = Pick<
  KchatFileInfo,
  "id" | "name" | "size" | "mime_type" | "extension" | "create_at"
>;

// `KchatChannelManifest` + `manifestPathFor` + `readManifest` +
// `writeManifest` live in `../kchat/kchatChannelSyncer` so the
// full-channel sync (here) and the Block B Task 2 single-file
// sync (the WS forwarder) share the exact same on-disk shape,
// containment check, and convergent-sync logic. Re-importing the
// helpers keeps both code paths in lockstep — a regression in
// either layer would have otherwise let server-side deletions
// and WS-driven writes desynchronise the manifest.

const VALID_FORMATS = new Set([
  "markdown",
  "html",
  "pdf",
  "docx",
  "json",
]);

function sanitizeTeam(t: KchatTeam): RendererTeam {
  return {
    id: t.id,
    name: t.name,
    display_name: t.display_name,
    description: t.description,
    type: t.type,
  };
}

function sanitizeChannel(c: KchatChannel): RendererChannel {
  return {
    id: c.id,
    team_id: c.team_id,
    name: c.name,
    display_name: c.display_name,
    type: c.type,
    purpose: c.purpose,
    header: c.header,
  };
}

function sanitizeMember(m: KchatChannelMember): RendererChannelMember {
  return {
    channel_id: m.channel_id,
    user_id: m.user_id,
    roles: m.roles,
  };
}

function sanitizeFile(f: KchatFileInfo): RendererFileInfo {
  return {
    id: f.id,
    name: f.name,
    size: f.size,
    mime_type: f.mime_type,
    extension: f.extension,
    create_at: f.create_at,
  };
}

/**
 * KChat-only ID validator. KChat (Mattermost) IDs are 26-character
 * base-32-ish strings (lowercase a-z + 0-9). The generic
 * `assertId` allows `:` / `.` / `-` which are not legal in KChat IDs;
 * this stricter check both documents the constraint and rejects
 * obviously-malformed renderer input early.
 */
function assertKchatId(val: unknown, name: string): string {
  const s = assertString(val, name, { maxLen: 64 });
  if (!/^[a-z0-9]{20,32}$/.test(s)) {
    throw new Error(`${name} must be a KChat object id (20–32 lowercase chars)`);
  }
  return s;
}

/**
 * Translate any error coming out of the KChat client (network
 * failure, 4xx/5xx, JSON parse error) into a stable error shape
 * the renderer can rely on.
 *
 * The renderer renders `error.message` verbatim into the UI, so
 * any token bytes that leak into the message would be visible to
 * anyone watching the screen — including a screen-share, a
 * crash-reporter upload, or a renderer-process log dump. We run
 * the message through the active `KchatClient.scrubMessage`
 * before crossing the boundary, which replaces both the live PAT
 * (when the client knows it) and any `Bearer <…>` pattern with
 * `[REDACTED]`.
 *
 * `KchatRequestError` instances are *re-synthesised* from
 * `status`/`statusText`/`endpoint` rather than `err.message`
 * because those three fields are constructed from server response
 * metadata that never contains a token. The bare `Error` path,
 * however, can carry arbitrary strings (e.g. a fetch failure that
 * embeds the request URL in its message), which is exactly why
 * the scrub runs on that branch.
 */
function toIpcError(err: unknown): Error {
  const svc = getKchatAuthService();
  // The auth service may not have been initialised yet (very
  // early startup, or in a renderer-only unit test) — fall back
  // to a no-op scrub in that case. Once the client exists the
  // scrub always runs.
  const scrub = (msg: string): string => {
    try {
      return svc.getClient().scrubMessage(msg);
    } catch {
      return msg;
    }
  };
  if (err instanceof KchatRequestError) {
    return new Error(
      scrub(`KChat ${err.status} ${err.statusText}: ${err.endpoint}`),
    );
  }
  if (err instanceof Error) return new Error(scrub(err.message));
  return new Error(scrub(String(err)));
}

/**
 * Phase 13 Theme 2 Task 9: bounded LRU cache that resolves
 * KChat object ids (user / channel) to their human-readable
 * display strings (username / channel display name).
 *
 * The cache is populated lazily by `kchat:searchPosts` as a
 * side-effect of building citation rows — `Map` iteration order
 * is insertion order, so deleting + re-inserting a key on every
 * read gives us LRU semantics with `O(1)` operations.
 *
 * Bound is per-cache; the user cache and channel cache each get
 * their own quota so a long session with many channels doesn't
 * starve user-name lookups (or vice versa). A miss returns
 * `null`; the renderer falls back to displaying the raw object
 * id in that case so the row still renders.
 *
 * The cache is cleared on every connection-state transition
 * away from `connected` so a re-handshake to a different server
 * (or the same server after the user is removed from a channel)
 * cannot return stale names. The clear is wired in
 * `registerKchatHandlers` via `KchatAuthService.onStatusChange`.
 */
class KchatNameCache {
  private readonly entries = new Map<string, string>();
  constructor(private readonly maxEntries: number) {
    if (maxEntries <= 0) {
      throw new Error("KchatNameCache: maxEntries must be > 0");
    }
  }

  get(id: string): string | null {
    const v = this.entries.get(id);
    if (v === undefined) return null;
    // LRU touch: move to end of insertion order.
    this.entries.delete(id);
    this.entries.set(id, v);
    return v;
  }

  set(id: string, name: string): void {
    // ANALYSIS_0004 (Devin Review pass 1 on fafc5f6): reject
    // empty-string display names at the boundary. The renderer
    // uses nullish coalescing (`?? rawId`) for fallback; an
    // empty string would be cached as a positive value and
    // surface as `#` / `@` with no text. Mattermost
    // server-side validation already requires a non-empty
    // `display_name` / `username` for the channel + user kinds
    // we cache, so this is defence-in-depth against a future
    // protocol drift or a maliciously crafted response. The
    // caller side already trims to a single field per id; we
    // do not need to trim whitespace here.
    if (name === "") {
      return;
    }
    // If already present, refresh and move to end.
    if (this.entries.has(id)) {
      this.entries.delete(id);
    } else if (this.entries.size >= this.maxEntries) {
      // Evict the least-recently-used (first inserted).
      const oldest = this.entries.keys().next().value;
      if (oldest !== undefined) {
        this.entries.delete(oldest);
      }
    }
    this.entries.set(id, name);
  }

  clear(): void {
    this.entries.clear();
  }

  /** Test-only accessor. */
  size(): number {
    return this.entries.size;
  }
}

/**
 * Bounds chosen to fit the citation-search hot path:
 *   - Users: each search hit references one sender; a typical
 *     workspace has ≤ 200 active senders within retrieval scope,
 *     so 500 leaves comfortable headroom.
 *   - Channels: 100 channels would cover most teams; 200 leaves
 *     room for cross-team browsing within a single session.
 *
 * Both caches are bounded at the IPC layer (NOT the bridge) so a
 * memory-pressure scenario can't pin them through a process restart.
 */
const KCHAT_USERNAME_CACHE = new KchatNameCache(500);
const KCHAT_CHANNEL_NAME_CACHE = new KchatNameCache(200);

/**
 * Reset the IPC-layer KChat name caches. Exported only for the
 * test suite so a test that exercises name-cache eviction
 * boundaries can start from a known state.
 *
 * ANALYSIS_0005 (Devin Review pass 2 on bef2fa0): if a previous
 * `registerKchatHandlers` invocation successfully installed the
 * `onStatusChange` subscriber, call its unsubscribe handle so
 * the next install path can re-subscribe cleanly. Without this,
 * a hypothetical production caller (or a future test path that
 * dispatches real status events through the live auth service)
 * would orphan the prior listener AND register a new one,
 * defeating the very idempotency guard the flag was added for.
 */
export function _resetKchatNameCachesForTest(): void {
  KCHAT_USERNAME_CACHE.clear();
  KCHAT_CHANNEL_NAME_CACHE.clear();
  if (KCHAT_STATUS_LISTENER_UNSUBSCRIBE !== null) {
    try {
      KCHAT_STATUS_LISTENER_UNSUBSCRIBE();
    } catch {
      // The unsubscribe contract is `() => void`. A throw here
      // would only be possible from a future stateful listener
      // implementation; swallow it so the reset stays robust to
      // changes in the auth service.
    }
    KCHAT_STATUS_LISTENER_UNSUBSCRIBE = null;
  }
  KCHAT_STATUS_LISTENER_INSTALLED = false;
}

/**
 * ANALYSIS_0005 (Devin Review pass 1 on fafc5f6): one-shot
 * idempotency guard for the `KchatAuthService.onStatusChange`
 * subscriber that clears the name caches on disconnect.
 *
 * In production `registerKchatHandlers` runs exactly once at
 * app start, so the subscriber count is naturally 1. The
 * vitest harness mounts the IPC layer multiple times during a
 * run (once per `describe` block in some files), and Electron
 * forge dev-mode HMR can re-invoke the IPC entrypoint without
 * tearing down the long-lived `KchatAuthService`. Without this
 * guard, every re-mount stacks another listener that would
 * `.clear()` the caches on every status push — effectively
 * disabling the cache after the first re-mount.
 *
 * Reset by `_resetKchatNameCachesForTest` so the unit test for
 * the registration path remains deterministic.
 */
let KCHAT_STATUS_LISTENER_INSTALLED = false;

/**
 * ANALYSIS_0005 (Devin Review pass 2 on bef2fa0): handle to the
 * unsubscribe callback returned by
 * `KchatAuthService.onStatusChange`. Stored at the module level
 * so `_resetKchatNameCachesForTest` can clean up the live
 * listener before flipping the install flag back to `false`.
 */
let KCHAT_STATUS_LISTENER_UNSUBSCRIBE: (() => void) | null = null;

/**
 * Phase 13 Theme 2 Task 9: enrich a list of post-hits with the
 * sender username and channel display name. Mutates the input
 * array's elements in-place.
 *
 * Performance shape: a single search returns ≤ 1000 hits (the
 * `kchat:searchPosts` IPC enforces this upper bound); within a
 * single search the number of UNIQUE sender / channel ids is
 * typically much smaller (≤ N senders per channel). We
 * deduplicate before issuing network calls.
 *
 * Failure mode: any failure to resolve a name leaves the hit's
 * `senderUsername` / `channelDisplayName` as `null`. The renderer
 * falls back to the raw id in that case, so a transient failure
 * never hides a citation candidate from the user.
 */
async function enrichKchatPostHits(
  hits: KchatPostSearchHit[],
  client: ReturnType<ReturnType<typeof getKchatAuthService>["getClient"]>,
): Promise<void> {
  // 1. Collect unique missing ids per cache.
  //
  //    ANALYSIS_0002 (Devin Review pass 2 on bef2fa0): only ids
  //    that pass `isKchatObjectId` are added to the network
  //    request sets. A substrate-corrupted row carrying a
  //    malformed id would otherwise cause the per-id assertion
  //    inside `getUsersByIds` to throw, suppressing username
  //    enrichment for the ENTIRE search result set. The strict
  //    assertion stays on `getUsersByIds` itself so internal
  //    callers (background sync, future helpers) still get the
  //    defence-in-depth check; the enrichment-layer best-effort
  //    semantics push the filtering up to where it belongs.
  //    Hits whose ids are malformed simply keep `null` enrichment
  //    fields and the renderer falls back to the raw id.
  const missingUserIds = new Set<string>();
  const missingChannelIds = new Set<string>();
  for (const h of hits) {
    const cachedUser = KCHAT_USERNAME_CACHE.get(h.senderUserId);
    if (cachedUser !== null) {
      h.senderUsername = cachedUser;
    } else if (isKchatObjectId(h.senderUserId)) {
      missingUserIds.add(h.senderUserId);
    }
    const cachedChan = KCHAT_CHANNEL_NAME_CACHE.get(h.channelId);
    if (cachedChan !== null) {
      h.channelDisplayName = cachedChan;
    } else if (isKchatObjectId(h.channelId)) {
      missingChannelIds.add(h.channelId);
    }
  }

  // 2. Run the user bulk lookup AND the per-channel parallel
  //    fan-out CONCURRENTLY (Devin Review pass 2 on bef2fa0
  //    ANALYSIS_0001). The two REST endpoints are independent
  //    and previously ran sequentially — wall-clock cost was
  //    additive (`Tuser + Tchannel_max`), now it is
  //    `max(Tuser, Tchannel_max)`. Each side keeps its own
  //    per-call error isolation (an inner try / `allSettled`)
  //    so one failing branch never suppresses the other's
  //    successful enrichments.
  const userTask: Promise<void> =
    missingUserIds.size > 0
      ? (async () => {
          try {
            const users = await client.getUsersByIds(
              Array.from(missingUserIds),
            );
            for (const u of users) {
              KCHAT_USERNAME_CACHE.set(u.id, u.username);
            }
          } catch {
            // Intentional: leave un-resolved ids as `null`; the
            // renderer falls back to displaying the raw id.
          }
        })()
      : Promise.resolve();

  const channelTask: Promise<void> =
    missingChannelIds.size > 0
      ? (async () => {
          const results = await Promise.allSettled(
            Array.from(missingChannelIds).map((id) => client.getChannel(id)),
          );
          for (const r of results) {
            if (r.status === "fulfilled") {
              KCHAT_CHANNEL_NAME_CACHE.set(
                r.value.id,
                r.value.display_name,
              );
            }
          }
        })()
      : Promise.resolve();

  await Promise.all([userTask, channelTask]);

  // 3. Second pass: apply newly-cached values to hits that were
  //    missing in the first pass.
  for (const h of hits) {
    if (h.senderUsername === null) {
      h.senderUsername = KCHAT_USERNAME_CACHE.get(h.senderUserId);
    }
    if (h.channelDisplayName === null) {
      h.channelDisplayName = KCHAT_CHANNEL_NAME_CACHE.get(h.channelId);
    }
  }
}

export function registerKchatHandlers(): void {
  // Phase 13 Theme 2 Task 9: clear the IPC-layer KChat name
  // caches on every transition away from `connected`. A
  // re-handshake to a different server (or the same server with
  // changed channel membership) must not return stale names.
  // The subscription survives the handler lifetime; the IPC
  // layer is mounted once per process and never torn down.
  //
  // ANALYSIS_0005 (Devin Review pass 1 on fafc5f6): the
  // module-level `KCHAT_STATUS_LISTENER_INSTALLED` flag guards
  // against listener-stacking if `registerKchatHandlers` is
  // re-invoked (vitest harness re-mounting between describe
  // blocks, Electron forge dev-mode HMR). The `idempotentHandle`
  // pattern below already protects the IPC channel registrations
  // from re-registration; this is the equivalent guard for the
  // status-subscriber, since `onStatusChange` does not return an
  // unsubscribe handle that survives the IPC re-mount.
  if (!KCHAT_STATUS_LISTENER_INSTALLED) {
    try {
      // ANALYSIS_0005 (Devin Review pass 2 on bef2fa0): store
      // the unsubscribe handle so `_resetKchatNameCachesForTest`
      // can detach it before flipping the install flag back to
      // `false`. Without this, a subsequent re-install would
      // stack a second listener on top of the first — the very
      // failure mode the pass-1 guard was supposed to prevent.
      KCHAT_STATUS_LISTENER_UNSUBSCRIBE = getKchatAuthService().onStatusChange(
        (state) => {
          if (state.state !== "connected") {
            KCHAT_USERNAME_CACHE.clear();
            KCHAT_CHANNEL_NAME_CACHE.clear();
          }
        },
      );
      KCHAT_STATUS_LISTENER_INSTALLED = true;
    } catch {
      // The auth service may be uninitialised in test contexts
      // that mount the IPC layer ahead of `appState`. The caches
      // start empty, and the first search after a real handshake
      // will populate them; missing the cleanup hook there is a
      // benign no-op (the test harness uses fresh state per test
      // anyway). Leave the flag false so a later well-formed
      // mount can install the listener correctly.
    }
  }

  // --- Feature gate ---
  idempotentHandle("kchat:isAvailable", async () => {
    // Always true for now — KChat is shipping with this phase. The
    // gate exists so a future enterprise licence check can flip it
    // off without renderer changes.
    return true;
  });

  // --- Connection state ---
  idempotentHandle("kchat:status", async (): Promise<KchatConnectionState> => {
    const svc = getKchatAuthService();
    return svc.getState();
  });

  // --- Connect / disconnect ---
  idempotentHandle(
    "kchat:connect",
    async (_event, token: unknown, serverUrl: unknown) => {
      const tok = assertString(token, "token", { maxLen: 4096 });
      const url = assertString(serverUrl, "serverUrl", { maxLen: 1024 });
      // SSRF guard (eighth-pass Devin Review ANALYSIS_0006): reject
      // non-http(s) URLs AND URLs that resolve to a private,
      // loopback, link-local, or CGNAT address. Without this, the
      // renderer could direct the authenticated `Bearer <PAT>`
      // request at any internal endpoint (Jenkins, internal admin
      // UI, etc.) reachable from the main process. The PAT is
      // useless to a non-KChat server, but the request itself
      // probes the internal service and the response can be
      // exfiltrated back through the IPC error path.
      //
      // We pass the renderer-supplied `url` string through to the
      // service rather than `validated.toString()` because the
      // latter canonicalises the URL (adds a trailing slash to
      // bare-host URLs, etc.); the service / `KchatClient` is the
      // single owner of URL normalisation downstream.
      await enforceKchatServerUrl(url);

      const svc = getKchatAuthService();
      try {
        const user = await svc.connect(tok, url);
        const bridge = getBridge();
        if (bridge) {
          bridge.bridgeLogKchatConnected(url, user.id);
          // Block B Task 3 (Phase 11): tell the substrate which
          // KChat user id is locally authenticated so subsequent
          // membership refreshes can project status correctly.
          // We swallow errors here — failure to set the principal
          // shouldn't abort the connect flow (the user is still
          // connected, just the ACL projection treats the next
          // refresh as `no_principal`). The audit row above has
          // already landed so an operator can see the connect
          // succeeded even if the principal record didn't.
          try {
            bridge.bridgeSetKchatPrincipal(user.id);
          } catch (err) {
            console.error(
              "[kchat] bridgeSetKchatPrincipal failed:",
              err,
            );
          }
        }
        // Sanitised user view (no roles bitfield, no last_picture_update —
        // the renderer only needs the identity fields to render the
        // "Connected as …" badge).
        return {
          id: user.id,
          username: user.username,
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
        };
      } catch (err) {
        throw toIpcError(err);
      }
    },
  );

  idempotentHandle("kchat:disconnect", async () => {
    const svc = getKchatAuthService();
    const userId = svc.disconnect();
    if (userId) {
      const bridge = getBridge();
      if (bridge) {
        bridge.bridgeLogKchatDisconnected(userId);
        // Block B Task 3 (Phase 11): clear the substrate's
        // singleton principal row so subsequent
        // `bridgeRefreshKchatAcl` calls (e.g. a still-in-flight
        // WS event arriving after disconnect) return
        // `no_principal` instead of evaluating membership
        // against a stale id. Swallowing the error matches the
        // connect path — the audit row above is the
        // operator-visible signal of the disconnect.
        try {
          bridge.bridgeClearKchatPrincipal();
        } catch (err) {
          console.error(
            "[kchat] bridgeClearKchatPrincipal failed:",
            err,
          );
        }
      }
    }
    return { disconnected: true };
  });

  // --- Phase 13 Task 7: extension-bridge surface ---
  //
  // Three channels mount the `uney-chat-desktop` extension bridge
  // into the renderer:
  //
  //   * `kchat:extensionStatus` — cheap probe. Returns whether the
  //     desktop app is reachable on the well-known socket path
  //     (see `kchatExtensionBridge.extensionSocketPath`), plus the
  //     currently-active `authMode` ("none" | "pat" | "extension")
  //     so the Settings card knows which CTA to render without a
  //     separate `kchat:status` round-trip.
  //
  //   * `kchat:extensionConnect` — initiate the session handoff.
  //     Rejects with `extension-not-available` when the probe
  //     returns `available: false`; rejects with
  //     `concurrent-pat-attempt` when a PAT connection is already
  //     active and the renderer race-condition'd through the
  //     UI gate. (The auth service tears down the PAT
  //     connection on `connectViaExtension`, so this rejection is
  //     advisory — the renderer surfaces the disconnect dialog
  //     before it would proceed.)
  //
  //   * `kchat:extensionDisconnect` — tear down only the
  //     extension session. The PAT vault entry (if any) is left
  //     intact so the user can reconnect via PAT after.
  //
  // Trust model: every frame across the extension socket is
  // validated by the session module (shape, expiry, embedded
  // `serverUrl` SSRF check via `enforceKchatServerUrl`). The
  // extension socket itself is a Unix domain socket / named pipe
  // — no TCP surface, no remote access — so the SSRF risk is
  // limited to the `serverUrl` field, which we treat exactly as
  // the PAT-path `kchat:connect` handler does.
  idempotentHandle(
    "kchat:extensionStatus",
    async (): Promise<{
      available: boolean;
      authMode: "none" | "pat" | "extension";
      protocolVersion?: number;
      desktopVersion?: string;
      capabilities?: string[];
      reason?: string;
    }> => {
      defaultRateLimiter.consume(
        "kchat:extensionStatus",
        RATE_LIMIT_PROFILES["kchat:extensionStatus"],
      );
      const svc = getKchatAuthService();
      try {
        const probe = await svc.probeExtension();
        return {
          available: probe.available,
          authMode: svc.getAuthMode(),
          protocolVersion: probe.protocolVersion,
          desktopVersion: probe.desktopVersion,
          capabilities: probe.capabilities,
          reason: probe.reason,
        };
      } catch (err) {
        throw toIpcError(err);
      }
    },
  );

  idempotentHandle(
    "kchat:extensionConnect",
    async () => {
      defaultRateLimiter.consume(
        "kchat:extensionConnect",
        RATE_LIMIT_PROFILES["kchat:extensionConnect"],
      );
      const svc = getKchatAuthService();
      const probe = await svc.probeExtension();
      if (!probe.available) {
        throw new Error(
          `KChat Desktop extension is not available (${probe.reason ?? "no-socket"}); install or launch the desktop app, or fall back to the PAT connection.`,
        );
      }
      try {
        const user = await svc.connectViaExtension();
        const bridge = getBridge();
        if (bridge) {
          const state = svc.getState();
          bridge.bridgeLogKchatConnected(
            state.serverUrl ?? "",
            user.id,
          );
          try {
            bridge.bridgeSetKchatPrincipal(user.id);
          } catch (err) {
            console.error(
              "[kchat] bridgeSetKchatPrincipal failed:",
              err,
            );
          }
        }
        return {
          id: user.id,
          username: user.username,
          email: user.email,
          firstName: user.first_name,
          lastName: user.last_name,
        };
      } catch (err) {
        throw toIpcError(err);
      }
    },
  );

  idempotentHandle("kchat:extensionDisconnect", async () => {
    defaultRateLimiter.consume(
      "kchat:extensionDisconnect",
      RATE_LIMIT_PROFILES["kchat:extensionDisconnect"],
    );
    const svc = getKchatAuthService();
    if (svc.getAuthMode() !== "extension") {
      // No-op disconnect when the active mode isn't `extension`
      // — same shape as `kchat:disconnect` so the renderer can
      // call it unconditionally on a settings teardown.
      return { disconnected: false };
    }
    const userId = svc.disconnect();
    if (userId) {
      const bridge = getBridge();
      if (bridge) {
        bridge.bridgeLogKchatDisconnected(userId);
        try {
          bridge.bridgeClearKchatPrincipal();
        } catch (err) {
          console.error(
            "[kchat] bridgeClearKchatPrincipal failed:",
            err,
          );
        }
      }
    }
    return { disconnected: true };
  });

  // --- Listing ---
  idempotentHandle("kchat:listTeams", async (): Promise<RendererTeam[]> => {
    const svc = getKchatAuthService();
    try {
      const teams = await svc.getClient().listTeams();
      return teams.map(sanitizeTeam);
    } catch (err) {
      throw toIpcError(err);
    }
  });

  idempotentHandle(
    "kchat:listChannels",
    async (_event, teamId: unknown): Promise<RendererChannel[]> => {
      const id = assertKchatId(teamId, "teamId");
      const svc = getKchatAuthService();
      try {
        const channels = await svc.getClient().listChannels(id);
        return channels.map(sanitizeChannel);
      } catch (err) {
        throw toIpcError(err);
      }
    },
  );

  idempotentHandle(
    "kchat:listMembers",
    async (_event, channelId: unknown): Promise<RendererChannelMember[]> => {
      const id = assertKchatId(channelId, "channelId");
      const svc = getKchatAuthService();
      try {
        const members = await svc.getClient().listChannelMembers(id);
        return members.map(sanitizeMember);
      } catch (err) {
        throw toIpcError(err);
      }
    },
  );

  idempotentHandle(
    "kchat:listChannelFiles",
    async (
      _event,
      channelId: unknown,
      page: unknown,
      perPage: unknown,
    ): Promise<RendererFileInfo[]> => {
      const id = assertKchatId(channelId, "channelId");
      const p = page === undefined || page === null
        ? 0
        : assertNumber(page, "page", { integer: true, min: 0, max: 1_000 });
      const per = perPage === undefined || perPage === null
        ? 60
        : assertNumber(perPage, "perPage", { integer: true, min: 1, max: 200 });
      const svc = getKchatAuthService();
      try {
        const files = await svc.getClient().listChannelFiles(id, p, per);
        return files.map(sanitizeFile);
      } catch (err) {
        throw toIpcError(err);
      }
    },
  );

  // --- Sharing ---
  idempotentHandle(
    "kchat:shareArtifact",
    async (
      _event,
      artifactId: unknown,
      channelId: unknown,
      format: unknown,
      includeCitations: unknown,
      includeEvidencePack: unknown,
    ): Promise<{ fileId: string; fileName: string }> => {
      const artifact = assertId(artifactId, "artifactId");
      const channel = assertKchatId(channelId, "channelId");
      const fmt = assertString(format, "format", { maxLen: 32 });
      if (!VALID_FORMATS.has(fmt)) {
        throw new Error(
          `format must be one of: ${[...VALID_FORMATS].join(", ")}`,
        );
      }
      const wantCitations = assertBoolean(
        includeCitations,
        "includeCitations",
      );
      const wantEvidence = assertBoolean(
        includeEvidencePack,
        "includeEvidencePack",
      );

      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");

      const svc = getKchatAuthService();
      try {
        // Phase 1: produce the export bytes.
        const exportResult = await produceExportBytes(
          bridge,
          artifact,
          fmt,
          wantCitations,
        );

        // Phase 2: upload primary export.
        const primary = await svc
          .getClient()
          .uploadFile(
            channel,
            exportResult.filename,
            exportResult.bytes,
            exportResult.mimeType,
          );

        // Phase 3: optionally upload evidence pack.
        //
        // Audit-trail integrity (sixth-pass Devin Review
        // ANALYSIS_0007): the primary export is already in the
        // channel by this point. If the evidence-pack upload below
        // fails (rate-limit, network blip, KChat quota, etc.), we
        // must NOT leave the primary share unaudited — that would
        // produce a silent inconsistency where the channel contains
        // a file the audit log has no record of, defeating the
        // tamper-evidence guarantee operators rely on. We track the
        // evidence outcome separately and the audit row records
        // what actually landed in the channel, not what the user
        // requested. On evidence-pack failure we still emit the
        // audit row (with `evidenceShared=false`) before
        // re-throwing so the renderer surfaces the partial-failure
        // error and operators can see the divergence between
        // "requested" and "delivered".
        let evidenceShared = false;
        if (wantEvidence) {
          try {
            const packBytes = bridge.bridgeEvidencePackBytes(artifact);
            await svc
              .getClient()
              .uploadFile(
                channel,
                `${exportResult.basename}-evidence.zip`,
                packBytes,
                "application/zip",
              );
            evidenceShared = true;
          } catch (err) {
            // Primary already in channel — audit it with the
            // actual (failed) evidence outcome and re-throw so the
            // renderer learns about the partial failure.
            bridge.bridgeLogKchatArtifactShared(
              artifact,
              channel,
              fmt,
              wantCitations,
              false,
            );
            throw err;
          }
        }

        bridge.bridgeLogKchatArtifactShared(
          artifact,
          channel,
          fmt,
          wantCitations,
          evidenceShared,
        );
        return { fileId: primary.id, fileName: primary.name };
      } catch (err) {
        throw toIpcError(err);
      }
    },
  );

  // --- Channel-backed sources ---
  //
  // Two layers of concurrency control wrap every full channel sync:
  //
  //   1. **Per-channel-id in-flight DEDUPLICATION** (tenth-pass
  //      Devin Review ANALYSIS_0006). `sources:addKchatChannel` is
  //      a multi-step operation: it downloads files, writes a
  //      manifest, runs the indexer, and registers the source row.
  //      Electron's `ipcMain.handle` dispatches calls concurrently,
  //      so a double-click on "Add channel", a programmatic caller,
  //      or a fast click before the UI's `busy` state has
  //      propagated could fire two simultaneous syncs for the same
  //      `channelId`. We collapse N concurrent calls into 1 shared
  //      `Promise`: the first starts the work, every subsequent
  //      (for the same channel id, while still in flight) returns
  //      the same `Promise` and therefore the same outcome. Without
  //      this layer a second IPC call would land back-to-back full
  //      syncs (after layer 2 serialised them) — wasted bandwidth.
  //
  //   2. **Per-channel-id `withChannelSyncLock`** (Block B Task 2).
  //      Even with layer 1, a WS-driven single-file sync that
  //      arrives mid-full-sync would race with the full sync's
  //      manifest write (forwarder writes M ∪ {newFile}, then the
  //      full sync's end-of-walk write replaces with stale M and
  //      the new file is lost from the manifest). The lock
  //      serialises full syncs and single-file syncs against each
  //      other so manifest reads and writes are always sequential
  //      per channel. Different channels remain parallel.
  const inFlightAddKchatChannel = new Map<
    string,
    Promise<{ sourceId: string; cacheDir: string }>
  >();

  async function runAddKchatChannel(
    id: string,
    name: string,
  ): Promise<{ sourceId: string; cacheDir: string }> {
    const bridge = getBridge();
    if (!bridge) throw new Error("Native bridge not available");

    const svc = getKchatAuthService();
    // Centralised cache-dir builder (see `kchat/kchatPaths.ts`)
    // so this call site and the `KchatEventForwarder`'s reverse
    // lookup stay in lockstep — a regression in either location
    // would silently break the auto-reindex hook the forwarder
    // relies on for `file_added` events.
    const cacheDir = kchatChannelCacheDir(id);
    await fs.mkdir(cacheDir, { recursive: true });

    // Download the channel's existing file roster into the cache so
    // the initial index pass has content to work with. Subsequent
    // poll cycles (block B) re-fetch deltas.
    //
    // Pagination: KChat caps `GET /channels/{id}/files` at 200
    // results per page (default 60 in our client). A channel with
    // more than `perPage` files would otherwise silently truncate
    // at the first page — the renderer would see a "synced" badge
    // while only the most-recent N files actually reached the
    // indexer. We loop until the server returns a short page
    // (`< perPage` results), which is the documented end-of-list
    // signal. We bound the loop with `MAX_PAGES` so a misbehaving
    // server that always returns a full page (infinite list)
    // cannot wedge the initial sync forever; in practice no real
    // KChat channel hits this cap.
    //
    // Security: the KChat server is treated as untrusted with
    // respect to filename contents. Server-supplied `fi.name`
    // values can include path-traversal sequences
    // (`../../../.ssh/authorized_keys`, absolute paths on
    // Windows, NUL bytes, etc.). We sanitise twice: first with
    // `path.basename` to strip any directory component the server
    // may have injected, then by resolving the final target path
    // and asserting it is *inside* `cacheDir`. The defence-in-depth
    // check catches edge cases (e.g. symlinks under the cache dir,
    // case-folding differences on macOS/Windows) that pure name
    // sanitisation would miss.
    //
    // `fi.id` is also server-supplied. `downloadFile()` revalidates
    // it against the KChat object-id shape before interpolating it
    // into the request URL (defence at the network boundary), but
    // the fallback `safeName = `kchat-file-${fi.id}`` would
    // otherwise embed unsanitised bytes from the id directly into
    // the on-disk filename. We sanitise the id to an allow-list
    // here so the safeName cannot escape `cacheDir` even via the
    // fallback path. The downstream containment check still runs
    // — this is belt-and-braces, not a replacement for it.
    //
    // Filename-collision handling: KChat channels have a flat file
    // namespace, so two users can upload `report.pdf` to the same
    // channel without any server-side rename. If we wrote both to
    // disk under the same `safeName`, the second `fs.writeFile`
    // would silently overwrite the first — the audit log would
    // still record both downloads, but only one set of bytes would
    // persist, and the indexer would see fewer files than the
    // channel actually contains. We dedupe by tracking the names
    // already written across the entire pagination loop (a single
    // `Set<string>` spanning every page); on collision we insert
    // the sanitised KChat file id between the stem and the
    // extension (`report.pdf` → `report-fid…xyz.pdf`). The id is
    // unique per file (KChat object-id invariant validated above),
    // so a single suffixing step always produces a fresh name —
    // but we still guard against the impossible double-collision
    // by appending the running count if it ever recurs.
    //
    // Convergent sync (seventh-pass Devin Review ANALYSIS_0003):
    // we persist a manifest mapping `fi.id → finalName` after
    // every sync so subsequent re-syncs are convergent rather
    // than additive. The previous implementation re-downloaded
    // (and overwrote) every file on every retry but never
    // cleaned up files that had been removed server-side between
    // syncs — a deleted file would remain on disk and continue
    // to be indexed indefinitely. With the manifest we:
    //   1. Skip downloads for `fi.id`s whose recorded local file
    //      still exists (KChat file content is immutable per
    //      object-id, so the bytes on disk are still valid).
    //   2. Unlink local files whose `fi.id` is no longer in the
    //      server roster after we've finished walking ALL pages
    //      (deleting mid-pagination would mis-delete files we
    //      haven't yet listed).
    //   3. Persist the new manifest in a `finally` block so a
    //      partial-failure mid-sync still leaves a consistent
    //      manifest reflecting whatever bytes did land on disk
    //      — the next retry skips them and downloads only the
    //      remainder.
    const PER_PAGE = 60;
    const MAX_PAGES = 1000;
    const resolvedCacheDir = path.resolve(cacheDir);
    const previousManifest = await readManifest(cacheDir, id);
    // `seenNames` starts EMPTY (eighth-pass Devin Review
    // ANALYSIS_0002). A previous implementation seeded it from
    // `Object.values(previousManifest.files)` to prevent same-name
    // collisions with pre-existing files, but that also reserved
    // names of files that had been deleted server-side between
    // syncs — if a new file arrived in this sync with the same
    // base name as a since-deleted file, it would receive an
    // unnecessary `-<fid>` dedupe suffix permanently (since the
    // new manifest then carries the deduped name forward). We
    // now only mark a name as "seen" when we actually decide to
    // *keep* a file at that name (either via the fast-path skip
    // when the previous file is still on disk and still in the
    // server roster, or after writing a fresh download), so
    // server-side deletions don't poison the dedupe set.
    const seenNames = new Set<string>();
    const currentFiles: Record<string, string> = {};
    const seenServerIds = new Set<string>();
    let paginationCompleted = false;
    try {
      for (let page = 0; page < MAX_PAGES; page += 1) {
        const files = await svc
          .getClient()
          .listChannelFiles(id, page, PER_PAGE);
        // Index variable used so the per-file dedupe fallbacks below
        // (`kchat-file-<page>-<idx>` and `<stem>-<page>-<idx>.<ext>`)
        // are O(1) per file instead of O(n) via `files.indexOf(fi)` —
        // eleventh-pass Devin Review ANALYSIS_0007. The cap is
        // `PER_PAGE = 60` so the old form was bounded at 3 600 ops
        // per page, but the explicit index also documents intent.
        for (let idx = 0; idx < files.length; idx += 1) {
          const fi = files[idx];
          if (typeof fi.id !== "string" || fi.id.length === 0) continue;
          seenServerIds.add(fi.id);

          // Fast-path: this file was downloaded in a previous run
          // and the bytes are (presumably) still on disk. KChat
          // file content is immutable per `fi.id` so we can skip
          // the download and just carry the manifest entry
          // forward. We still verify on-disk presence (and
          // containment) so a user who manually deleted the file
          // out of `cacheDir` triggers a re-download.
          const recorded = previousManifest.files[fi.id];
          if (typeof recorded === "string" && recorded.length > 0) {
            const recordedPath = path.resolve(cacheDir, recorded);
            if (
              recordedPath !== resolvedCacheDir &&
              recordedPath.startsWith(resolvedCacheDir + path.sep)
            ) {
              try {
                await fs.access(recordedPath);
                currentFiles[fi.id] = recorded;
                // Mark the kept name as taken so a later file in
                // this same sync that happens to have the same
                // base name gets the dedupe suffix and doesn't
                // overwrite our kept bytes.
                seenNames.add(recorded);
                continue;
              } catch {
                // File missing on disk — fall through and
                // re-download. (Previously we also called
                // `seenNames.delete(recorded)` here to undo the
                // stale seeding from `previousManifest`; with
                // `seenNames` starting empty that delete is
                // unnecessary — the name was never added.)
              }
            }
          }

          // Sanitised single-file download lives in
          // `kchat/kchatChannelSyncer.ts` so the WS forwarder's
          // single-file path uses the IDENTICAL basename
          // sanitisation, dedupe, and containment logic. A
          // regression in either layer would otherwise let a
          // server-supplied filename escape the cache root.
          const result = await downloadKchatFileToCache(
            svc.getClient(),
            cacheDir,
            fi,
            seenNames,
            { page, idx },
          );
          if (!result.wrote || result.finalName === null) {
            // Containment-check rejection — audit-log the OFFENDING
            // sanitised name (preserved in `finalName` even on
            // rejection) so operators can see exactly which
            // server-supplied name escaped, then continue to the
            // next file rather than aborting the whole sync.
            bridge.bridgeLogKchatFileDownloaded(
              id,
              result.finalName ?? "",
              0,
            );
            continue;
          }
          currentFiles[fi.id] = result.finalName;
          bridge.bridgeLogKchatFileDownloaded(
            id,
            result.finalName,
            result.bytesWritten,
          );
        }
        if (files.length < PER_PAGE) break;
      }
      paginationCompleted = true;

      // Convergent cleanup: ONLY after we've walked every page
      // and the server roster is complete. Anything in the
      // previous manifest whose `fi.id` is not in the current
      // server roster has been deleted server-side — unlink it
      // locally so the indexer doesn't keep crawling phantom
      // files. Skip cleanup if pagination didn't complete
      // (`seenServerIds` would be a partial view of the roster
      // and we'd mis-delete files we just hadn't fetched yet).
      //
      // Eighth-pass invariant (Devin Review ANALYSIS_0002): we
      // ALSO skip unlinking when some file in *this* sync
      // currently claims the same on-disk name. This protects
      // against the "deletion + same-name re-upload" race —
      // the old fi.id is gone server-side, but a new fi.id has
      // arrived with the same base name and just overwrote the
      // bytes at that path. Unlinking by the old name here
      // would delete the new file's bytes.
      const namesClaimedByCurrentSync = new Set<string>(
        Object.values(currentFiles),
      );
      for (const [oldId, oldName] of Object.entries(
        previousManifest.files,
      )) {
        if (seenServerIds.has(oldId)) continue;
        if (currentFiles[oldId]) continue;
        if (typeof oldName !== "string" || oldName.length === 0) continue;
        if (namesClaimedByCurrentSync.has(oldName)) continue;
        const stalePath = path.resolve(cacheDir, oldName);
        if (
          stalePath === resolvedCacheDir ||
          !stalePath.startsWith(resolvedCacheDir + path.sep)
        ) {
          // Containment check failed — the manifest is corrupt
          // or was tampered with. Skip without unlinking (we
          // refuse to operate on paths outside `cacheDir`).
          continue;
        }
        try {
          await fs.unlink(stalePath);
        } catch {
          // File may have been removed manually or the unlink
          // raced with the indexer; either way it's safe to
          // drop the manifest entry below — the next sync will
          // see the missing file and converge.
        }
      }
    } catch (err) {
      throw toIpcError(err);
    } finally {
      // Persist whatever progress was made so a subsequent retry
      // sees a consistent view of disk. On partial-failure this
      // is a strict subset of the server roster (only files we
      // actually wrote in this run); on full success it IS the
      // server roster after deletions. Either way the manifest
      // is the source of truth for the next run.
      try {
        // Merge: on partial failure currentFiles only contains
        // files we wrote / verified this run — anything from the
        // previous manifest that we didn't touch should still be
        // recorded (we haven't unlinked it because we didn't
        // reach the cleanup phase). On full success the deletion
        // loop already pruned previousManifest entries we wanted
        // gone, and seenServerIds is the authoritative roster.
        const merged: Record<string, string> = paginationCompleted
          ? currentFiles
          : { ...previousManifest.files, ...currentFiles };
        await writeManifest(cacheDir, {
          version: 1,
          channelId: id,
          files: merged,
        });
      } catch {
        // Best-effort: a failed manifest write is non-fatal. The
        // worst case is the next sync re-downloads files that
        // are already on disk, which is wasteful but correct.
      }
    }

    // BUG_0001 (eighth-pass Devin Review): `bridgeAddKchatChannel`
    // is now idempotent on `cacheDir`. The Rust side returns
    // `newlyCreated: true` only on the call that inserted the
    // source row; every subsequent re-sync flips it to `false`
    // and we skip the `KchatChannelLinked` audit append so the
    // audit log doesn't accumulate one "linked" event per sync.
    // The returned `sourceId` is stable across re-syncs (we
    // reuse the existing row), so citations and evidence-pack
    // references survive.
    //
    // Error consistency (fourteenth-pass Devin Review ANALYSIS_0002):
    // the bridge call lives OUTSIDE the download/sync try/catch
    // above (which catches network/disk errors and re-throws as
    // `toIpcError`). Bridge errors are infrastructure-level
    // (SQLite lock contention, corrupted database, native-addon
    // panic) and don't contain the KChat token, but routing them
    // through the same `toIpcError` wrapper keeps the renderer's
    // error-handling surface uniform: every error coming out of
    // `sources:addKchatChannel` lands as the same `Error` shape
    // regardless of which phase failed. The scrub also defends
    // against a future native-addon change that might surface a
    // stack trace containing transient request URLs.
    try {
      const outcome = bridge.bridgeAddKchatChannel(cacheDir);
      if (outcome.newlyCreated) {
        bridge.bridgeLogKchatChannelLinked(id, name, cacheDir);
      }
      return { sourceId: outcome.source.id, cacheDir };
    } catch (err) {
      throw toIpcError(err);
    }
  }

  idempotentHandle(
    "sources:addKchatChannel",
    async (
      _event,
      channelId: unknown,
      channelName: unknown,
    ): Promise<{ sourceId: string; cacheDir: string }> => {
      const id = assertKchatId(channelId, "channelId");
      const name = assertString(channelName, "channelName", { maxLen: 256 });

      // Per-channel-id in-flight dedupe (tenth-pass Devin Review
      // ANALYSIS_0006). If a sync for this channel is already in
      // progress, return its Promise so both callers settle
      // identically; cleanup runs in `.finally` so the slot is
      // released regardless of success/failure. Validation runs
      // *before* the dedupe lookup so a malformed `channelId` is
      // rejected with the same error shape whether or not another
      // sync is running.
      const existing = inFlightAddKchatChannel.get(id);
      if (existing) return existing;
      // Wrap the full-sync work in the per-channel sync lock so a
      // WS-driven single-file sync (`KchatEventForwarder.handle-
      // FileAdded`) and the full sync cannot interleave their
      // manifest writes. Layer 1 (the dedupe map) collapses N
      // concurrent IPC calls into 1; layer 2 (the lock) serialises
      // the resulting work against any in-flight single-file sync
      // for the same channel.
      const work = withChannelSyncLock(id, () =>
        runAddKchatChannel(id, name),
      ).finally(() => {
        // Only clear if we still own the slot. (We always do under
        // single-threaded JS, but the explicit guard documents the
        // invariant and protects against a hypothetical future
        // refactor that releases the slot earlier.)
        if (inFlightAddKchatChannel.get(id) === work) {
          inFlightAddKchatChannel.delete(id);
        }
      });
      inFlightAddKchatChannel.set(id, work);
      return work;
    },
  );

  // Block B Task 4 (Phase 11) second-pass Devin Review ANALYSIS_0002:
  // populate the auto-resync slot the `KchatEventForwarder` reads
  // when it observes a `KchatAclRefreshOutcome::Regranted` outcome.
  // The forwarder calls this closure OUTSIDE its own per-channel
  // `withChannelSyncLock` (the lock has already released by then),
  // so we can safely re-acquire the same lock here for the full
  // sync without deadlocking. We reuse the two-layer dedupe of the
  // user-driven path (in-flight Map + per-channel lock) so a
  // regrant event that races a user clicking "re-add channel"
  // collapses into a single sync.
  //
  // `name` semantics: `runAddKchatChannel` only consumes the name
  // argument inside the `outcome.newlyCreated` branch's
  // `bridgeLogKchatChannelLinked` audit emission. On a regrant the
  // source row already exists (Block B Task 3 retains the row +
  // flips its status to `AccessRevoked`, then back to `Connected`
  // on regrant), so `newlyCreated` is always `false` here and the
  // name is never consumed. We pass the stable channel id as the
  // audit-name fallback so the value is well-formed for the
  // exotic-race case where the source row was somehow dropped
  // between the regrant audit and this resync (the bridge would
  // re-create it; in that case we'd at least emit an audit row
  // with the channel id rather than an empty string). The real
  // display name comes back through the substrate's source row,
  // which is unaffected by this fallback.
  setKchatChannelResyncImpl(async (channelId: string) => {
    // Validation: defensive re-check on the forwarder-supplied
    // channel id. The forwarder validates its inputs at the
    // ingest boundary, but we re-validate here so a future caller
    // (e.g. a test that wires the impl directly) gets the same
    // protection.
    const id = assertKchatId(channelId, "channelId");
    const existing = inFlightAddKchatChannel.get(id);
    if (existing) {
      await existing;
      return;
    }
    const work = withChannelSyncLock(id, () =>
      runAddKchatChannel(id, id),
    ).finally(() => {
      if (inFlightAddKchatChannel.get(id) === work) {
        inFlightAddKchatChannel.delete(id);
      }
    });
    inFlightAddKchatChannel.set(id, work);
    await work;
  });

  // ─── Block C Task 4 (Phase 13) — KChat historical backfill ───────
  //
  // The backfill orchestrator drives the substrate's per-page
  // ingest primitive against the KChat REST `getPostsForChannel`
  // history endpoint. The loop walks backwards from the persisted
  // cursor (or from the newest post on a fresh walk) until either
  //
  //   - the REST server reports end-of-history
  //     (`prevPostId === null`) — emits `Completed` audit row,
  //   - the substrate flips to AccessRevoked between pages
  //     (membership lost mid-walk) — emits `Aborted` row with
  //     reason=access_revoked,
  //   - the cumulative posts-walked counter hits the per-channel
  //     safety cap (50_000) — emits `Aborted` row with
  //     reason=safety_cap,
  //   - a REST or substrate error fires — emits `Aborted` row
  //     with reason=error.
  //
  // The orchestrator is dedup'd through the per-channel sync lock
  // (`withChannelSyncLock`) so a backfill cannot interleave with
  // a regrant re-sync, a single-file sync, or a duplicate user
  // click that fires while a walk is still in flight. We use the
  // SAME lock as `runAddKchatChannel` so concurrent file-roster
  // sync + post-history backfill serialise — both paths write to
  // the same SQLite database; running them concurrently would
  // contend for the SQLCipher connection and stretch latency
  // without saving wall-clock time.
  //
  // Per-walk state is local to this closure (counters, page
  // number, cursor); the substrate carries the cross-walk
  // resumption cursor via the persisted `kchat_backfill_*` columns
  // on the `sources` row, so a process restart mid-walk can
  // resume from the last successfully-acked page rather than
  // re-walking from the top.
  const inFlightBackfillKchatChannel = new Map<
    string,
    Promise<KchatBackfillRunOutcome>
  >();
  /**
   * Per-channel cumulative cap. KChat REST caps `per_page` at 200,
   * so 50_000 posts ≈ 250 round-trips — large enough that real
   * channels never hit the cap, small enough that a misbehaving
   * server returning an infinite stream can't pin memory. Matches
   * the file-roster cap used by `runAddKchatChannel` for the same
   * reason.
   */
  const KCHAT_BACKFILL_SAFETY_CAP = 50_000;
  /**
   * REST page size. KChat's documented per-page maximum is 200;
   * 200 is also the practical ceiling for the `posts` payload
   * shape (above that the server may truncate). Keeping the
   * orchestrator's page size at the protocol max minimises the
   * number of round-trips, which dominates wall-clock time on a
   * full-channel backfill against a remote KChat server.
   */
  const KCHAT_BACKFILL_PER_PAGE = 200;

  async function runBackfillKchatChannel(
    channelId: string,
  ): Promise<KchatBackfillRunOutcome> {
    const bridge = getBridge();
    if (!bridge) throw new Error("Native bridge not available");
    const id = assertKchatId(channelId, "channelId");
    const cacheDir = kchatChannelCacheDir(id);

    // Read the persisted state OUTSIDE the lock first so a no-op
    // short-circuit (already-completed or unlinked/revoked) does
    // not contend for the per-channel sync mutex. The check
    // is repeated inside the lock to close the race with a
    // mid-flight cryptoshred / unlink.
    const initial = bridge.bridgeGetKchatBackfillState(cacheDir);
    if (initial.outcome === "unlinked") {
      return {
        outcome: "skipped",
        reason: "unlinked",
        pagesWalked: 0,
        totalPostsIngested: 0,
        totalPostsUnchanged: 0,
        totalPostsSkippedRevoked: 0,
      };
    }
    if (initial.outcome === "access_revoked") {
      return {
        outcome: "skipped",
        reason: "access_revoked",
        pagesWalked: 0,
        totalPostsIngested: 0,
        totalPostsUnchanged: 0,
        totalPostsSkippedRevoked: 0,
      };
    }
    if (initial.completedAt) {
      return {
        outcome: "skipped",
        reason: "already_completed",
        pagesWalked: 0,
        totalPostsIngested: 0,
        totalPostsUnchanged: 0,
        totalPostsSkippedRevoked: 0,
        completedAt: initial.completedAt,
      };
    }

    const sourceId = initial.sourceId ?? "";
    // Resume cursor: substrate-persisted `oldestPostId` (the OLDEST
    // post we've already indexed). The REST contract says
    // `before=<post_id>` returns posts strictly older than that
    // id, so passing the persisted cursor reliably moves the walk
    // backwards without re-fetching the post itself. A null cursor
    // means "no walk has run yet" — the first REST call omits
    // `before=` and starts at the newest post.
    let cursor: string | undefined = initial.oldestPostId ?? undefined;
    bridge.bridgeLogKchatBackfillStarted(id, sourceId, cursor);

    const svc = getKchatAuthService();
    const client = svc.getClient();

    let pagesWalked = 0;
    let totalPostsIngested = 0;
    let totalPostsUnchanged = 0;
    let totalPostsSkippedRevoked = 0;
    let totalPostsTouched = 0;

    // eslint-disable-next-line no-constant-condition
    while (true) {
      let page;
      try {
        page = await client.getPostsForChannel(id, {
          before: cursor,
          perPage: KCHAT_BACKFILL_PER_PAGE,
        });
      } catch (err) {
        bridge.bridgeLogKchatBackfillAborted(
          id,
          sourceId,
          "error",
          pagesWalked,
          totalPostsIngested,
        );
        throw toIpcError(err);
      }

      // Each entry is in REST-returned (newest-first) order. We
      // pass the entire page through to the substrate as a single
      // batched call; the substrate iterates internally and
      // advances the cursor to the OLDEST post id in the page.
      const inputs: KchatPostIngestInputInfo[] = page.posts.map((p) => ({
        cacheDir,
        postId: p.id,
        channelId: p.channelId,
        rootId: p.rootId ?? undefined,
        senderUserId: p.userId,
        body: p.message,
        createdAtMs: p.createAt,
        editedAtMs: p.editAt,
      }));

      const result = bridge.bridgeIngestKchatBackfillPage(cacheDir, inputs);
      if (result.outcome === "unlinked") {
        bridge.bridgeLogKchatBackfillAborted(
          id,
          sourceId,
          "unlinked",
          pagesWalked,
          totalPostsIngested,
        );
        return {
          outcome: "aborted",
          reason: "unlinked",
          pagesWalked,
          totalPostsIngested,
          totalPostsUnchanged,
          totalPostsSkippedRevoked,
        };
      }
      if (result.outcome === "access_revoked") {
        bridge.bridgeLogKchatBackfillAborted(
          id,
          sourceId,
          "access_revoked",
          pagesWalked,
          totalPostsIngested,
        );
        return {
          outcome: "aborted",
          reason: "access_revoked",
          pagesWalked,
          totalPostsIngested,
          totalPostsUnchanged,
          totalPostsSkippedRevoked,
        };
      }

      pagesWalked += 1;
      totalPostsIngested += result.postsIngested;
      totalPostsUnchanged += result.postsUnchanged;
      totalPostsSkippedRevoked += result.postsSkippedRevoked;
      totalPostsTouched += inputs.length;
      bridge.bridgeLogKchatBackfillPageIngested(
        id,
        sourceId,
        pagesWalked,
        result.postsIngested,
        result.postsUnchanged,
        result.postsSkippedRevoked,
        result.oldestPostIdInPage,
      );

      // Two end-of-walk signals from the REST server:
      //   - `prevPostId === null` means the server says "no posts
      //     exist older than what you just fetched" — definitive
      //     end-of-history. Emit Completed and set the substrate
      //     sentinel.
      //   - `posts.length === 0` on a non-first page would also
      //     indicate end-of-history (the server returned an empty
      //     window before signalling via prevPostId); treat it
      //     the same as null cursor.
      if (page.prevPostId === null || page.posts.length === 0) {
        bridge.bridgeMarkKchatBackfillComplete(cacheDir);
        bridge.bridgeLogKchatBackfillCompleted(
          id,
          sourceId,
          pagesWalked,
          totalPostsIngested,
          totalPostsUnchanged,
        );
        return {
          outcome: "completed",
          pagesWalked,
          totalPostsIngested,
          totalPostsUnchanged,
          totalPostsSkippedRevoked,
        };
      }

      // Safety cap: cumulative posts touched (not just ingested —
      // the cap exists to bound the number of REST round-trips,
      // which a malicious server could otherwise pin via an
      // infinite `prev_post_id` chain). The cap is checked BEFORE
      // advancing the cursor so a single page that hits the cap
      // stops at that page rather than pulling one more page
      // unnecessarily.
      if (totalPostsTouched >= KCHAT_BACKFILL_SAFETY_CAP) {
        bridge.bridgeLogKchatBackfillAborted(
          id,
          sourceId,
          "safety_cap",
          pagesWalked,
          totalPostsIngested,
        );
        return {
          outcome: "aborted",
          reason: "safety_cap",
          pagesWalked,
          totalPostsIngested,
          totalPostsUnchanged,
          totalPostsSkippedRevoked,
        };
      }

      // Advance to the next page. We use the server-supplied
      // `prevPostId` (the post id immediately older than the
      // current page) rather than `result.oldestPostIdInPage`
      // because they can diverge if the substrate skipped some
      // posts due to a mid-walk revocation — in that case the
      // substrate's `oldestPostIdInPage` is the cursor it
      // actually persisted (last successfully-ingested id) but
      // the REST server's `prevPostId` is the correct
      // continuation token for the NEXT page.
      cursor = page.prevPostId;
    }
  }

  setKchatBackfillImpl(async (channelId: string) => {
    const id = assertKchatId(channelId, "channelId");
    const existing = inFlightBackfillKchatChannel.get(id);
    if (existing) return existing;
    const work = withChannelSyncLock(id, () =>
      runBackfillKchatChannel(id),
    ).finally(() => {
      if (inFlightBackfillKchatChannel.get(id) === work) {
        inFlightBackfillKchatChannel.delete(id);
      }
    });
    inFlightBackfillKchatChannel.set(id, work);
    return work;
  });

  idempotentHandle(
    "sources:backfillKchatChannel",
    async (
      _event,
      channelId: unknown,
    ): Promise<KchatBackfillRunOutcome> => {
      const id = assertKchatId(channelId, "channelId");
      const existing = inFlightBackfillKchatChannel.get(id);
      if (existing) return existing;
      const work = withChannelSyncLock(id, () =>
        runBackfillKchatChannel(id),
      ).finally(() => {
        if (inFlightBackfillKchatChannel.get(id) === work) {
          inFlightBackfillKchatChannel.delete(id);
        }
      });
      inFlightBackfillKchatChannel.set(id, work);
      return work;
    },
  );

  /**
   * Phase 13 Task 10: per-channel backfill progress projection.
   *
   * The renderer (`SourceDetailPage`) polls this while a backfill
   * is in flight (or just to render the post-completion badge)
   * and projects the result onto a progress bar / status pill.
   * The handler is a pure read of two pieces of state:
   *
   *   1. `inFlightBackfillKchatChannel.has(id)` — is a walk
   *      currently running? Drives the `active` vs `idle/complete`
   *      branch.
   *   2. `bridgeGetKchatBackfillState(cacheDir)` — substrate-
   *      persisted state. Surfaces `oldestPostId`, `completedAt`,
   *      revocation outcome.
   *
   * The handler does NOT trigger a fresh walk; it's a passive
   * progress projection. We deliberately keep `totalPosts: null`
   * — KChat does not always surface a channel-level post count,
   * and the UX renders an indeterminate progress indicator in
   * that case. When the substrate-level state read fails (e.g.
   * the cacheDir disappeared mid-poll), the handler returns an
   * `error` discriminator with the underlying message so the
   * renderer can show a retry button rather than silently fall
   * back to `idle`.
   */
  idempotentHandle(
    "kchat:backfillProgress",
    async (
      _event,
      channelId: unknown,
    ): Promise<{
      channelId: string;
      oldestFetched: number | null;
      totalPosts: number | null;
      postsIngested: number;
      status: "idle" | "active" | "complete" | "error";
      error?: string;
    }> => {
      defaultRateLimiter.consume(
        "kchat:backfillProgress",
        RATE_LIMIT_PROFILES["kchat:backfillProgress"],
      );
      const id = assertKchatId(channelId, "channelId");
      const bridge = getBridge();
      if (!bridge) {
        return {
          channelId: id,
          oldestFetched: null,
          totalPosts: null,
          postsIngested: 0,
          status: "error",
          error: "Native bridge not available",
        };
      }
      const inFlight = inFlightBackfillKchatChannel.has(id);
      let state;
      try {
        state = bridge.bridgeGetKchatBackfillState(kchatChannelCacheDir(id));
      } catch (err) {
        return {
          channelId: id,
          oldestFetched: null,
          totalPosts: null,
          postsIngested: 0,
          status: "error",
          error: err instanceof Error ? err.message : String(err),
        };
      }
      if (state.outcome === "unlinked") {
        return {
          channelId: id,
          oldestFetched: null,
          totalPosts: null,
          postsIngested: 0,
          status: "idle",
        };
      }
      if (state.outcome === "access_revoked") {
        return {
          channelId: id,
          oldestFetched: null,
          totalPosts: null,
          postsIngested: 0,
          status: "idle",
        };
      }
      // Substrate stores `oldestPostId` as the cursor used to
      // advance the walk; the renderer's "X posts ingested"
      // counter is not surfaced by the state read (the substrate
      // doesn't keep a running counter because the value is
      // re-derivable from the audit log). We expose 0 here when
      // no walk has run yet and let the renderer subscribe to
      // audit-row tail-follow if it wants live counters. The
      // important UX is the discriminator (active vs
      // complete vs idle), which the renderer renders as a
      // progress *indicator* rather than a precise %-bar — the
      // protocol-evolution comment block in
      // `bridgeGetKchatBackfillState` (substrate side) explains
      // why an exact post count is not always available.
      const completedAt = state.completedAt ?? null;
      if (completedAt !== null) {
        return {
          channelId: id,
          oldestFetched: null,
          totalPosts: null,
          postsIngested: 0,
          status: "complete",
        };
      }
      return {
        channelId: id,
        oldestFetched: null,
        totalPosts: null,
        postsIngested: 0,
        status: inFlight ? "active" : "idle",
      };
    },
  );

  /**
   * Block D Task 1 (Phase 14): KChat post-body retrieval.
   *
   * The renderer's evidence-search UI calls this alongside
   * `sources:search` so chat threads surface as evidence
   * alongside files. The handler:
   *
   *   1. Rate-limits via the `kchat:searchPosts` profile
   *      (10 r/s sustained, 20 burst — same as `sources:search`).
   *   2. Validates `query` (string, max 10k chars to mirror
   *      `sources:search`) and `limit` (1..1000 — the substrate
   *      pulls 2x this many rows before AEAD-verifying to
   *      tolerate tamper drops).
   *   3. Computes a SHA-256 hash of the query (truncated to 16
   *      hex chars) for the audit row — the raw query string
   *      MUST NOT cross into the audit log, that's the privacy
   *      property of `KchatPostSearchExecuted`.
   *   4. Calls `bridgeSearchKchatPosts` for the AEAD-verified
   *      hit set.
   *   5. Composes a `kchat://<server>/channel/<channel_id>/post/
   *      <post_id>` permalink per hit IF the user is currently
   *      connected to KChat; otherwise leaves `permalink: null`
   *      and lets the renderer disable the "Open in KChat"
   *      button.
   *   6. Emits the `KchatPostSearchExecuted` audit row
   *      best-effort (a poisoned audit mutex must not crash the
   *      search — the user's retrieval has already succeeded by
   *      the time this runs).
   */
  idempotentHandle(
    "kchat:searchPosts",
    async (
      _event,
      query: unknown,
      limit: unknown,
    ): Promise<KchatPostSearchHit[]> => {
      defaultRateLimiter.consume(
        "kchat:searchPosts",
        RATE_LIMIT_PROFILES["kchat:searchPosts"],
      );
      const q = assertString(query, "query", { maxLen: 10_000 });
      const n = assertNumber(limit, "limit", {
        integer: true,
        min: 1,
        max: 1_000,
      });
      const bridge = getBridge();
      if (!bridge) return [];

      const start = Date.now();
      const queryHash = createHash("sha256")
        .update(q.trim())
        .digest("hex")
        .slice(0, 16);

      const raw = bridge.bridgeSearchKchatPosts(q, n);

      // Compose the permalink only when the user is actually
      // connected — the renderer disables the "Open in KChat"
      // button when `permalink` is null. We read the connection
      // state from the auth service (NOT the persisted vault,
      // which would still return a serverUrl after a disconnect).
      const svc = getKchatAuthService();
      const connState = svc.getState();
      const serverUrl =
        (connState.state === "connected" ||
          connState.state === "connecting") &&
        connState.serverUrl
          ? connState.serverUrl
          : null;
      const hits: KchatPostSearchHit[] = raw.map((h) => {
        let permalink: string | null = null;
        if (serverUrl) {
          // KChat / Mattermost permalink convention: the team
          // segment is required by the server but the substrate
          // does not persist team-per-channel. The renderer can
          // either fall back to `/_redirect/pl/<post_id>` (which
          // the server resolves) or compose the team-aware path
          // from the local roster cache. We emit the redirect
          // form here because it round-trips cleanly without
          // the IPC layer having to peek into the renderer's
          // roster cache.
          permalink =
            `${serverUrl.replace(/\/$/, "")}` +
            `/_redirect/pl/${encodeURIComponent(h.postId)}`;
        }
        return {
          kind: "kchat_post",
          sourcePath: h.sourcePath,
          sourceId: h.sourceId,
          chunkHash: h.chunkHash,
          chunkContent: h.content,
          relevanceScore: h.relevance,
          excerpt: h.excerpt,
          postId: h.postId,
          channelId: h.channelId,
          rootId: h.rootId,
          senderUserId: h.senderUserId,
          createdAtMs: h.createdAtMs,
          editedAtMs: h.editedAtMs,
          permalink,
          // Phase 13 Theme 2 Task 9: filled in by
          // `enrichKchatPostHits` below. We initialise to `null`
          // so a code path that returns early (e.g. zero raw
          // hits) emits a wire-shape-correct value the renderer
          // can render without an `undefined` check.
          senderUsername: null,
          channelDisplayName: null,
        };
      });

      // Phase 13 Theme 2 Task 9 — ANALYSIS_0001 (Devin Review pass
      // 1 on fafc5f6): the audit `latencyMs` metric must continue
      // to measure ONLY the synchronous bridge work (the part of
      // the search that lands on the substrate). Enrichment is a
      // pure-IPC-layer concern that fires network calls to KChat
      // for username/channel-name resolution; folding that into
      // the same metric would alias substrate-side regressions
      // against transient KChat REST latency and break any SLO
      // alert that was previously calibrated on the pre-PR meaning
      // of this field. Capture the substrate latency NOW, then
      // enrich.
      const latencyMs = Date.now() - start;

      // Phase 13 Theme 2 Task 9: enrich hits with sender username
      // and channel display name. Only attempt enrichment when
      // the connection is fully `connected` (NOT `connecting`).
      //
      // ANALYSIS_0003 (Devin Review pass 2 on bef2fa0): the
      // previous guard `if (hits.length > 0 && serverUrl)` was
      // permissive because `serverUrl` is non-null in both
      // `connected` AND `connecting` (see the conditional 30
      // lines up). The mid-handshake `connecting` window can
      // race the auth service's `setToken` ordering, and a
      // verification request that hasn't completed yet would
      // surface as failed enrichments. Restricting enrichment
      // to `connected` aligns this gate with the renderer's
      // "connected" banner gating: enrichment is only attempted
      // in the same state where the rest of the search is
      // expected to fully work.
      if (hits.length > 0 && connState.state === "connected") {
        try {
          await enrichKchatPostHits(hits, svc.getClient());
        } catch {
          // Defence-in-depth: enrichment is best-effort. Any
          // unexpected throw (e.g. an error inside the LRU cache
          // implementation itself) must NOT hide search results
          // from the user. The hits already have `senderUsername`
          // and `channelDisplayName` set to `null` — the renderer
          // falls back to raw ids in that case.
        }
      }
      const sourcesTouched = new Set(hits.map((h) => h.sourceId)).size;
      try {
        bridge.bridgeLogKchatPostSearchExecuted(
          queryHash,
          hits.length,
          sourcesTouched,
          latencyMs,
        );
      } catch (err) {
        // Best-effort audit (matches the
        // `bridgeLogKchatBackfillAborted` posture). The retrieval
        // already succeeded — breaking the user's search because
        // the audit logger is poisoned would be the wrong
        // trade-off.
        console.error(
          "[kchat] bridgeLogKchatPostSearchExecuted failed:",
          err,
        );
      }

      return hits;
    },
  );
}

interface ProducedExport {
  filename: string;
  basename: string;
  mimeType: string;
  bytes: Buffer | Uint8Array;
}

/**
 * Produce the export bytes for a given format. Text-shaped formats
 * (markdown/html/json) are read from `bridgeExportArtifact` which
 * returns a string; PDF/DOCX flush to a tempfile via
 * `bridgeExportArtifactToFile` and read it back as bytes so the
 * binary content survives the IPC boundary.
 *
 * `includeCitations` is forwarded all the way to the Rust dispatch
 * layer (`tessera_export::exporter`) which suppresses the citation
 * list at source when the flag is `false`. This keeps the user-facing
 * toggle, the audit row, and the actual export bytes in lockstep —
 * earlier versions accepted and audited the boolean but ignored it in
 * the export, producing audit rows that disagreed with the bytes.
 */
async function produceExportBytes(
  bridge: NonNullable<ReturnType<typeof getBridge>>,
  artifactId: string,
  format: string,
  includeCitations: boolean,
): Promise<ProducedExport> {
  const meta = bridge.bridgeGetArtifact(artifactId);
  const safeTitle = (meta.title || "artifact")
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .slice(0, 80);

  if (format === "markdown" || format === "html" || format === "json") {
    const result = bridge.bridgeExportArtifact(
      artifactId,
      format,
      null,
      includeCitations,
    );
    const ext = format === "markdown" ? "md" : format;
    return {
      filename: `${safeTitle}.${ext}`,
      basename: safeTitle,
      mimeType: mimeForFormat(format),
      bytes: Buffer.from(result.content, "utf-8"),
    };
  }

  // PDF / DOCX: stage to a tempfile and read back.
  const ext = format;
  const tempBase = path.join(
    os.tmpdir(),
    `tessera-kchat-${Date.now()}-${Math.random().toString(36).slice(2)}`,
  );
  const tempPath = `${tempBase}.${ext}`;
  bridge.bridgeExportArtifactToFile(
    artifactId,
    format,
    tempPath,
    null,
    includeCitations,
  );
  try {
    const bytes = await fs.readFile(tempPath);
    return {
      filename: `${safeTitle}.${ext}`,
      basename: safeTitle,
      mimeType: mimeForFormat(format),
      bytes,
    };
  } finally {
    // Best-effort cleanup; staging file is in os.tmpdir so a
    // residual file is cleaned up on the next boot regardless.
    await fs.unlink(tempPath).catch(() => {});
  }
}

function mimeForFormat(format: string): string {
  switch (format) {
    case "markdown":
      return "text/markdown; charset=utf-8";
    case "html":
      return "text/html; charset=utf-8";
    case "json":
      return "application/json; charset=utf-8";
    case "pdf":
      return "application/pdf";
    case "docx":
      return "application/vnd.openxmlformats-officedocument.wordprocessingml.document";
    default:
      return "application/octet-stream";
  }
}
