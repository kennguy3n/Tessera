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
      // Reject anything that isn't an http(s) URL; KChat does not
      // accept non-TLS connections in production.
      if (!/^https?:\/\//i.test(url)) {
        throw new Error("serverUrl must start with http:// or https://");
      }

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
        if (wantEvidence) {
          const packBytes = bridge.bridgeEvidencePackBytes(artifact);
          await svc
            .getClient()
            .uploadFile(
              channel,
              `${exportResult.basename}-evidence.zip`,
              packBytes,
              "application/zip",
            );
        }

        bridge.bridgeLogKchatArtifactShared(
          artifact,
          channel,
          fmt,
          wantCitations,
          wantEvidence,
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
      try {
        const PER_PAGE = 60;
        const MAX_PAGES = 1000;
        const resolvedCacheDir = path.resolve(cacheDir);
        for (let page = 0; page < MAX_PAGES; page += 1) {
          const files = await svc
            .getClient()
            .listChannelFiles(id, page, PER_PAGE);
          for (const fi of files) {
            const baseName = path.basename(fi.name);
            const sanitisedId =
              typeof fi.id === "string"
                ? fi.id.replace(/[^a-zA-Z0-9_-]/g, "_")
                : "";
            const idFallback = sanitisedId
              ? `kchat-file-${sanitisedId}`
              : `kchat-file-${page}-${files.indexOf(fi)}`;
            const safeName =
              baseName && baseName !== "." && baseName !== ".."
                ? baseName
                : idFallback;
            const targetPath = path.resolve(cacheDir, safeName);
            if (
              targetPath !== resolvedCacheDir &&
              !targetPath.startsWith(resolvedCacheDir + path.sep)
            ) {
              // The sanitised path still escaped — skip and audit-log
              // the rejection so operators can see a misbehaving
              // server. We continue to the next file rather than
              // aborting the entire sync.
              bridge.bridgeLogKchatFileDownloaded(id, safeName, 0);
              continue;
            }
            const bytes = await svc.getClient().downloadFile(fi.id);
            await fs.writeFile(targetPath, bytes);
            bridge.bridgeLogKchatFileDownloaded(
              id,
              safeName,
              bytes.byteLength,
            );
          }
          if (files.length < PER_PAGE) break;
        }
      } catch (err) {
        throw toIpcError(err);
      }

      const source = bridge.bridgeAddKchatChannel(cacheDir);
      bridge.bridgeLogKchatChannelLinked(id, name, cacheDir);
      return { sourceId: source.id, cacheDir };
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
