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
import { promises as dnsPromises } from "dns";
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
import { KchatRequestError } from "../kchat/kchatClient";
import { kchatChannelCacheDir } from "../kchat/kchatPaths";
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

/**
 * Parse a numeric token in any of the forms `getaddrinfo` accepts
 * for IPv4 octets / 32-bit dword arguments and return the parsed
 * value, or `null` if the token does not match any accepted form.
 *
 * Accepted:
 *   - `"0"` or any non-zero decimal that does NOT start with `0`
 *   - `"0o…"` / leading-zero decimal interpreted as octal (`017` → 15)
 *   - `"0x…"` / `"0X…"` hex
 *
 * Rejected: empty string, signed values, anything containing `_`
 * or whitespace, scientific notation. We deliberately do not accept
 * BigInt-style suffixes because Node's URL parser strips them.
 *
 * Used by `isPrivateOrLoopbackHost` to recognise the non-dotted-
 * decimal IPv4 forms that `getaddrinfo` will happily resolve but
 * the dotted-decimal regex misses (eleventh-pass Devin Review
 * ANALYSIS_0002):
 *   - hex single-integer: `http://0x7f000001/`
 *   - octal dotted: `http://0177.0.0.1/`
 *   - decimal single-integer: `http://2130706433/`
 *   - 2-part / 3-part forms (`http://127.1/`, `http://10.0.65535/`)
 *
 * The DNS layer at `enforceKchatServerUrl` already covers most of
 * these because `dns.lookup` calls `getaddrinfo` which canonicalises
 * them to dotted-decimal — but the literal check is the first line
 * of defence and should not lean on the DNS layer alone.
 */
function parseIpv4Token(tok: string): number | null {
  if (tok.length === 0) return null;
  if (/[^0-9a-fA-FxX]/.test(tok)) return null;
  let n: number;
  if (/^0[xX]/.test(tok)) {
    if (!/^0[xX][0-9a-fA-F]+$/.test(tok)) return null;
    n = Number.parseInt(tok.slice(2), 16);
  } else if (tok.length > 1 && tok.startsWith("0")) {
    if (!/^0[0-7]+$/.test(tok)) return null;
    n = Number.parseInt(tok.slice(1), 8);
  } else {
    if (!/^[0-9]+$/.test(tok)) return null;
    n = Number.parseInt(tok, 10);
  }
  return Number.isFinite(n) && n >= 0 ? n : null;
}

/**
 * Canonicalise any of the IPv4 forms `getaddrinfo` accepts to
 * `[a, b, c, d]` (each 0–255), or `null` if `s` is not a valid IPv4
 * literal under those rules. Handles:
 *   - 4-part dotted (`127.0.0.1`)        → [127, 0, 0, 1]
 *   - 3-part (`127.0.1`)                 → [127, 0, 0, 1]   (last token is a 16-bit dword)
 *   - 2-part (`127.1`)                   → [127, 0, 0, 1]   (last token is a 24-bit dword)
 *   - 1-part single integer (`2130706433` or `0x7f000001`) → [127, 0, 0, 1]
 *   - hex/octal tokens within any of the above
 *
 * Anything else returns `null` (caller falls through to the IPv6 /
 * DNS-name path).
 */
function parseIpv4(s: string): [number, number, number, number] | null {
  if (s.length === 0) return null;
  const parts = s.split(".");
  if (parts.length > 4) return null;
  const nums: number[] = [];
  for (const p of parts) {
    const v = parseIpv4Token(p);
    if (v === null) return null;
    nums.push(v);
  }
  // Per-token width limits. For the dotted forms, all but the last
  // token must fit in a byte; the last token holds the remaining
  // bits (8 / 16 / 24 / 32 depending on `nums.length`).
  for (let i = 0; i < nums.length - 1; i++) {
    if (nums[i] > 0xff) return null;
  }
  const last = nums[nums.length - 1];
  const lastMaxBits = (5 - nums.length) * 8; // 4-part:8, 3-part:16, 2-part:24, 1-part:32
  if (last < 0 || last > 2 ** lastMaxBits - 1) return null;
  // Each octet comes from an explicit token when one is available
  // (`nums[i]`) and otherwise falls back to the corresponding byte of
  // `last`. The 1-part case (single integer) takes all four bytes
  // from `last`; the 2-part case takes byte 0 from `nums[0]` and
  // bytes 1–3 from `last`; the 3-part case takes bytes 0–1 from
  // `nums[0..1]` and bytes 2–3 from `last`; the 4-part case takes
  // bytes 0–2 from `nums[0..2]` and byte 3 from `last`. The
  // unified shape avoids the redundant `(last >>> N) & 0xff` ternary
  // branches the older form had (twelfth-pass Devin Review
  // ANALYSIS_0001).
  const a = nums.length >= 2 ? nums[0] : (last >>> 24) & 0xff;
  const b = nums.length >= 3 ? nums[1] : (last >>> 16) & 0xff;
  const c = nums.length >= 4 ? nums[2] : (last >>> 8) & 0xff;
  const d = last & 0xff;
  return [a, b, c, d];
}

/**
 * Return `true` when `hostname` is a literal IP in private,
 * loopback, link-local, or otherwise reserved RFC-1918-style space
 * — or one of the reserved hostnames (`localhost`,
 * `*.localhost`). These targets are never legitimate KChat servers
 * (KChat is a hosted multi-tenant service) so refusing to direct
 * an authenticated `Authorization: Bearer <PAT>` request at them
 * is safe; the goal is to prevent the renderer (or a user pasting
 * a crafted URL) from using the KChat connection to probe internal
 * services on the operator's network (SSRF — eighth-pass Devin
 * Review ANALYSIS_0006).
 *
 * Coverage:
 *   - IPv4 loopback (127.0.0.0/8), 0.0.0.0/8
 *   - RFC1918 private space (10/8, 172.16/12, 192.168/16)
 *   - RFC6598 CGNAT (100.64/10)
 *   - Link-local (169.254/16)
 *   - All of the above in their non-dotted-decimal encodings (hex,
 *     octal, single-integer, 2-/3-part dotted) — eleventh-pass
 *     Devin Review ANALYSIS_0002.
 *   - IPv6 loopback (::1, ::) and unspecified
 *   - IPv6 unique-local (fc00::/7 → `fc*`, `fd*`)
 *   - IPv6 link-local (fe80::/10 → `fe80:`)
 *   - IPv4-mapped IPv6 (`::ffff:<ipv4>`) recurses into the v4 check
 *
 * Not covered: DNS rebinding. We check the hostname literal (here)
 * and the DNS-resolved A/AAAA records at connect time
 * (`enforceKchatServerUrl`), but a malicious DNS server could
 * return different IPs on subsequent requests. Mitigation: KChat
 * uses HTTPS in production, so a rebinding to an internal HTTP
 * service fails the TLS handshake. A defense-in-depth pinned-IP
 * dispatcher would close this gap; out of scope for this PR.
 */
function isPrivateOrLoopbackHost(hostname: string): boolean {
  // Strip surrounding brackets from IPv6 literals (`new URL` keeps
  // them in `hostname` for bracketed v6, depending on Node version).
  const h = hostname.replace(/^\[|\]$/g, "").toLowerCase();
  if (h === "localhost" || h.endsWith(".localhost")) return true;
  // IPv4 (any form: dotted-decimal, dotted-hex, dotted-octal, 1-/
  // 2-/3-part dotted, single integer). `parseIpv4` returns the
  // canonicalised [a, b, c, d] octets so the prefix tests below
  // work uniformly regardless of how the address was typed.
  const v4 = parseIpv4(h);
  if (v4) {
    const [a, b] = v4;
    if (a === 0) return true; // 0.0.0.0/8 (current network / unspecified)
    if (a === 127) return true; // 127.0.0.0/8 loopback
    if (a === 10) return true; // 10.0.0.0/8 private
    if (a === 172 && b >= 16 && b <= 31) return true; // 172.16.0.0/12 private
    if (a === 192 && b === 168) return true; // 192.168.0.0/16 private
    if (a === 169 && b === 254) return true; // 169.254.0.0/16 link-local
    if (a === 100 && b >= 64 && b <= 127) return true; // 100.64.0.0/10 CGNAT
    return false;
  }
  if (h === "::1" || h === "::") return true;
  // IPv6 prefix checks are gated on `h.includes(":")` so they cannot
  // misfire on regular DNS hostnames that happen to begin with the
  // same two letters (`fcc.example.com`, `fdic.gov`, `fe80-corp.io`,
  // …). Hostnames in DNS-name form never contain `:`, while every
  // IPv6 literal contains at least one. ninth-pass Devin Review
  // BUG_0001 caught this when the `fc`/`fd` prefix match was
  // unconditional and rejected `fchat.example.com`-style domains.
  const isV6Literal = h.includes(":");
  if (isV6Literal) {
    if (h.startsWith("fe80:")) return true; // IPv6 link-local
    if (h.startsWith("fc") || h.startsWith("fd")) return true; // ULA fc00::/7
  }
  // IPv4-mapped IPv6 (RFC 4291 §2.5.5.2) covers BOTH textual forms:
  //   * `::ffff:127.0.0.1`  — dotted-decimal tail (legacy form most
  //     humans type and what `inet_pton` emits)
  //   * `::ffff:7f00:1`     — two-hextet tail (compact hex form, the
  //     canonical IPv6-text encoding when the tool isn't aware of the
  //     mapped-IPv4 special case; e.g. some browsers and resolvers
  //     produce this). Twelfth-pass Devin Review ANALYSIS_0002 caught
  //     that the previous regex only matched the dotted-decimal form,
  //     so `http://[::ffff:7f00:1]/` (loopback) silently fell through
  //     the literal-check and relied on the DNS layer alone.
  //
  // We accept any IPv6 literal whose final two hextets canonicalise
  // into a 32-bit IPv4 address (e.g. `::ffff:7f00:1` → 0x7f000001 →
  // 127.0.0.1) and recurse the IPv4 check on the canonicalised dotted
  // form. The first match (decimal-tail) keeps the existing fast path
  // for the human-typed form; the second match (hex-tail) covers the
  // tool-emitted form. Other compressed `::` forms with embedded
  // private/loopback IPv4 don't exist because the v4 octets only
  // round-trip through the `::ffff:` prefix.
  const mappedDec = h.match(
    /^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/,
  );
  if (mappedDec) return isPrivateOrLoopbackHost(mappedDec[1]);
  const mappedHex = h.match(/^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/);
  if (mappedHex) {
    const hi = Number.parseInt(mappedHex[1], 16);
    const lo = Number.parseInt(mappedHex[2], 16);
    if (
      Number.isFinite(hi) &&
      Number.isFinite(lo) &&
      hi <= 0xffff &&
      lo <= 0xffff
    ) {
      const a = (hi >>> 8) & 0xff;
      const b = hi & 0xff;
      const c = (lo >>> 8) & 0xff;
      const d = lo & 0xff;
      return isPrivateOrLoopbackHost(`${a}.${b}.${c}.${d}`);
    }
  }
  return false;
}

/**
 * Validate a renderer-supplied `serverUrl` before opening a KChat
 * connection. Throws if the URL is malformed, uses a non-http(s)
 * scheme, points at a literal private/loopback IP, or DNS-resolves
 * to one. Operators can opt out of the SSRF guard (e.g. to point
 * at a dev KChat instance on `127.0.0.1`) by setting the env var
 * `TESSERA_KCHAT_ALLOW_INTERNAL=1` before launching the desktop
 * app; the guard is on by default in production builds.
 */
async function enforceKchatServerUrl(rawUrl: string): Promise<URL> {
  let parsed: URL;
  try {
    parsed = new URL(rawUrl);
  } catch {
    throw new Error("serverUrl is not a valid URL");
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    throw new Error("serverUrl must use http:// or https://");
  }
  const allowInternal = process.env.TESSERA_KCHAT_ALLOW_INTERNAL === "1";
  if (allowInternal) {
    return parsed;
  }
  if (isPrivateOrLoopbackHost(parsed.hostname)) {
    throw new Error(
      "serverUrl points at a private, loopback, or link-local address; refusing to connect to internal targets. Set TESSERA_KCHAT_ALLOW_INTERNAL=1 to override (dev only).",
    );
  }
  // Resolve the hostname and reject if any A/AAAA record lands in
  // private/loopback space. This catches the case of a public-
  // looking hostname (e.g. `kchat.example.com`) that resolves to
  // `10.0.0.5` via DNS (intranet split-horizon or a malicious DNS
  // server pointed at internal infrastructure).
  //
  // Fail-closed on DNS errors (ninth-pass Devin Review
  // ANALYSIS_0002): a previous version of this guard swallowed
  // *all* `dns.lookup` failures — the rationale was that the
  // subsequent `fetch` would surface a clearer ENOTFOUND. The bot
  // pointed out that a malicious/slow DNS server could time out
  // *our* lookup but still respond to `fetch`'s lookup with a
  // private IP, bypassing the rebinding mitigation entirely. We
  // now distinguish:
  //   * `ENOTFOUND` / `EAI_NONAME` — the host genuinely does not
  //     exist; the network layer would fail too, so allow the
  //     attempt through so the user sees the network-layer error
  //     (and to avoid a confusing "refusing to connect" message
  //     for typos and offline cases).
  //   * any other DNS error (timeout, refused, server-side error,
  //     unexpected throw) — fail-closed and require the user to
  //     retry or opt out via `TESSERA_KCHAT_ALLOW_INTERNAL=1`.
  //     This is the correct posture for an SSRF guard: "if we
  //     can't verify the destination, refuse to send the PAT."
  try {
    const addrs = await dnsPromises.lookup(parsed.hostname, { all: true });
    for (const a of addrs) {
      if (isPrivateOrLoopbackHost(a.address)) {
        throw new Error(
          `serverUrl resolves to a private/loopback address (${a.address}); refusing to connect to internal targets. Set TESSERA_KCHAT_ALLOW_INTERNAL=1 to override (dev only).`,
        );
      }
    }
  } catch (err) {
    // Re-throw our own "private/loopback" error untouched.
    if (
      err instanceof Error &&
      err.message.startsWith("serverUrl resolves to a private")
    ) {
      throw err;
    }
    // Allow ENOTFOUND through — host doesn't exist, the network
    // layer will report it. Fail-closed on any other DNS error so
    // a slow/hostile DNS resolver cannot bypass the rebinding
    // mitigation.
    const code =
      err && typeof err === "object" && "code" in err
        ? String((err as { code: unknown }).code)
        : "";
    if (code === "ENOTFOUND" || code === "EAI_NONAME") {
      // Host doesn't exist — let `fetch` surface the network error.
      return parsed;
    }
    throw new Error(
      `serverUrl could not be validated against the SSRF guard (DNS error: ${code || "unknown"}); refusing to connect. Retry once the DNS resolver is reachable, or set TESSERA_KCHAT_ALLOW_INTERNAL=1 to override (dev only).`,
    );
  }
  return parsed;
}

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

export function registerKchatHandlers(): void {
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
        };
      });

      const latencyMs = Date.now() - start;
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
