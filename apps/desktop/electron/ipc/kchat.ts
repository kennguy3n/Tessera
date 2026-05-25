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
import { getBridge, getKchatAuthService } from "../appState";
import { idempotentHandle } from "./register";
import {
  assertBoolean,
  assertId,
  assertNumber,
  assertString,
} from "./validate";
import { KchatRequestError } from "../kchat/kchatClient";
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

/**
 * On-disk record of which KChat files have already been downloaded
 * to a channel's local cache, and under which on-disk name.
 *
 * The manifest is the source of truth for convergent sync: on every
 * `sources:addKchatChannel` (re-)sync we (a) skip re-downloading
 * files whose `fi.id` already appears in the manifest AND whose
 * recorded on-disk file still exists, and (b) unlink any files
 * whose `fi.id` is no longer present on the server roster (server-
 * side deletion between syncs). Without the manifest the previous
 * behaviour was "download what's there, never clean up" — stale
 * files that had been removed from the channel remained on disk
 * and continued to be indexed (seventh-pass Devin Review
 * ANALYSIS_0003).
 *
 * The manifest deliberately lives OUTSIDE `cacheDir` (it sits as a
 * sibling next to the per-channel cache directory) so the indexer
 * — which scans every file inside `cacheDir` — never picks it up
 * as a corpus document.
 */
interface KchatChannelManifest {
  /** Schema version; bumped when the on-disk shape changes. */
  version: 1;
  /** Channel id the manifest belongs to (sanity-check on load). */
  channelId: string;
  /**
   * Map from KChat file id (`fi.id`) to the on-disk basename inside
   * `cacheDir` we wrote the bytes under. Recorded names are the
   * already-sanitised, already-deduped form (i.e. the same string
   * we passed to `fs.writeFile` last time around), so consumers do
   * not need to re-run the dedupe step.
   */
  files: Record<string, string>;
}

/** Path of the sidecar manifest file for a given channel cacheDir. */
function manifestPathFor(cacheDir: string): string {
  // `<parent>/<id>/` → `<parent>/<id>.manifest.json` so the manifest
  // is a sibling of `cacheDir`, never inside it. This guarantees
  // `bridgeAddKchatChannel(cacheDir)` — which scans `cacheDir` —
  // cannot accidentally index the manifest as a corpus document.
  return `${cacheDir.replace(/[/\\]$/, "")}.manifest.json`;
}

async function readManifest(
  cacheDir: string,
  channelId: string,
): Promise<KchatChannelManifest> {
  try {
    const raw = await fs.readFile(manifestPathFor(cacheDir), "utf-8");
    const parsed = JSON.parse(raw) as unknown;
    if (
      typeof parsed === "object" &&
      parsed !== null &&
      (parsed as { version?: unknown }).version === 1 &&
      (parsed as { channelId?: unknown }).channelId === channelId &&
      typeof (parsed as { files?: unknown }).files === "object" &&
      (parsed as { files: unknown }).files !== null
    ) {
      // Re-validate each entry so a tampered manifest cannot inject
      // arbitrary disk names.
      const files: Record<string, string> = {};
      for (const [k, v] of Object.entries(
        (parsed as { files: Record<string, unknown> }).files,
      )) {
        if (typeof k === "string" && typeof v === "string") files[k] = v;
      }
      return { version: 1, channelId, files };
    }
  } catch {
    // No manifest yet (first sync) or the file is unreadable / not
    // JSON / wrong shape. Treat as empty — the worst case is one
    // extra re-download of existing files on the next run.
  }
  return { version: 1, channelId, files: {} };
}

async function writeManifest(
  cacheDir: string,
  manifest: KchatChannelManifest,
): Promise<void> {
  // Write to a temp file then rename to make the manifest update
  // atomic from a crash-recovery perspective: a torn JSON file
  // would be rejected by `readManifest` and the next sync would
  // fall back to "download everything", which is wasteful but not
  // unsafe. The atomic-rename keeps the steady-state case clean.
  const target = manifestPathFor(cacheDir);
  const tmp = `${target}.tmp`;
  await fs.writeFile(tmp, JSON.stringify(manifest));
  await fs.rename(tmp, target);
}

const VALID_FORMATS = new Set([
  "markdown",
  "html",
  "pdf",
  "docx",
  "json",
]);

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
  const v4 = h.match(/^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/);
  if (v4) {
    const a = Number(v4[1]);
    const b = Number(v4[2]);
    if ([a, b, Number(v4[3]), Number(v4[4])].some((n) => n > 255)) {
      return false;
    }
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
  if (h.startsWith("fe80:")) return true; // IPv6 link-local
  if (h.startsWith("fc") || h.startsWith("fd")) return true; // ULA fc00::/7
  const mapped = h.match(/^::ffff:(\d{1,3}\.\d{1,3}\.\d{1,3}\.\d{1,3})$/);
  if (mapped) return isPrivateOrLoopbackHost(mapped[1]);
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
  // server pointed at internal infrastructure). Failure to resolve
  // is *not* a hard error here — the underlying `fetch` will
  // surface a clearer "ENOTFOUND" / "EAI_AGAIN" further down the
  // call stack — we treat lookup failure as "no internal target
  // detected by us, let the network layer decide".
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
    // Re-throw our own "private/loopback" error; swallow DNS-layer
    // errors so the connect attempt itself can surface them.
    if (
      err instanceof Error &&
      err.message.startsWith("serverUrl resolves to a private")
    ) {
      throw err;
    }
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
        if (bridge) bridge.bridgeLogKchatConnected(url, user.id);
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
      if (bridge) bridge.bridgeLogKchatDisconnected(userId);
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
  idempotentHandle(
    "sources:addKchatChannel",
    async (
      _event,
      channelId: unknown,
      channelName: unknown,
    ): Promise<{ sourceId: string; cacheDir: string }> => {
      const id = assertKchatId(channelId, "channelId");
      const name = assertString(channelName, "channelName", { maxLen: 256 });

      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");

      const svc = getKchatAuthService();
      const cacheDir = path.join(
        os.homedir(),
        ".tessera",
        "kchat-channels",
        id,
      );
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
          for (const fi of files) {
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

            const baseName = path.basename(fi.name);
            const sanitisedId = fi.id.replace(/[^a-zA-Z0-9_-]/g, "_");
            const idFallback = sanitisedId
              ? `kchat-file-${sanitisedId}`
              : `kchat-file-${page}-${files.indexOf(fi)}`;
            const safeName =
              baseName && baseName !== "." && baseName !== ".."
                ? baseName
                : idFallback;
            // Dedupe within this channel sync: if we already wrote a
            // file with this name on an earlier page (or earlier in
            // this page), suffix the sanitised id between stem and
            // extension so both files survive on disk. The fallback
            // suffix uses the running `seenNames.size` if the
            // primary `<stem>-<id>.<ext>` is also taken (shouldn't
            // happen given the object-id invariant, but the
            // containment + dedupe contract should hold even if a
            // future server change relaxes id uniqueness).
            let finalName = safeName;
            if (seenNames.has(finalName)) {
              const ext = path.extname(safeName);
              const stem = ext
                ? safeName.slice(0, safeName.length - ext.length)
                : safeName;
              const suffix = sanitisedId || `${page}-${files.indexOf(fi)}`;
              finalName = `${stem}-${suffix}${ext}`;
              if (seenNames.has(finalName)) {
                finalName = `${stem}-${suffix}-${seenNames.size}${ext}`;
              }
            }
            const targetPath = path.resolve(cacheDir, finalName);
            if (
              targetPath !== resolvedCacheDir &&
              !targetPath.startsWith(resolvedCacheDir + path.sep)
            ) {
              // The sanitised path still escaped — skip and audit-log
              // the rejection so operators can see a misbehaving
              // server. We continue to the next file rather than
              // aborting the entire sync.
              bridge.bridgeLogKchatFileDownloaded(id, finalName, 0);
              continue;
            }
            seenNames.add(finalName);
            const bytes = await svc.getClient().downloadFile(fi.id);
            await fs.writeFile(targetPath, bytes);
            currentFiles[fi.id] = finalName;
            bridge.bridgeLogKchatFileDownloaded(
              id,
              finalName,
              bytes.byteLength,
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
      const outcome = bridge.bridgeAddKchatChannel(cacheDir);
      if (outcome.newlyCreated) {
        bridge.bridgeLogKchatChannelLinked(id, name, cacheDir);
      }
      return { sourceId: outcome.source.id, cacheDir };
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
