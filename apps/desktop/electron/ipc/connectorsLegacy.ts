/**
 * IPC handlers that bridge the unified multi-provider connector
 * dispatcher (`registerConnectorHandlers` in
 * `./connectors/handlers.ts`) and the three legacy
 * `connectors:gdrive:*` picker handlers that still expose
 * Drive-specific concepts (folder IDs, MIME-type filtering) the
 * generic dispatcher doesn't model.
 *
 * The Drive picker handlers must share the SAME `IpcContext` the
 * unified dispatcher uses for token refresh, rate-limiting, and
 * logging — otherwise calls through the two paths could see different
 * cached tokens and the rate limiter would be silently bypassed. The
 * shared context comes from `getConnectorContext()` in `./shared.ts`.
 */
import { getLogger } from "../logger";
import {
  isNetworkError,
  registerConnectorHandlers,
  runConnectorSync,
} from "./connectors/handlers";
import { RateLimitError } from "./rateLimiter";
import { assertOptionalString } from "./validate";
import { GdriveSelectedItemsSchema } from "./schemas";
import { idempotentHandle } from "./register";
import { getConnectorContext, getValidAccessToken } from "./shared";

export function registerConnectorsLegacyHandlers(): void {
  // Wire up the unified `connectors:authenticate/sync/disconnect/...`
  // dispatcher that handles every provider (Google Drive, OneDrive,
  // Notion, Jira, Confluence, Figma).
  registerConnectorHandlers(getConnectorContext());

  // The three `connectors:gdrive:*` picker handlers below are
  // intentionally not part of the multi-provider dispatcher — they
  // expose Drive folder IDs / MIME-type filtering / export semantics
  // that don't generalise. `idempotentHandle` itself does the
  // remove-then-attach dance, so a separate per-channel
  // `removeHandler` loop is no longer needed.
  idempotentHandle(
    "connectors:gdrive:listFiles",
    async (_event, folderIdRaw?: unknown, pageTokenRaw?: unknown) => {
      // Validate both renderer-supplied parameters before they touch
      // any downstream code. `assertOptionalString` (a) makes this
      // handler consistent with the validation pattern the rest of
      // the IPC layer uses, (b) caps the payload size at the shared
      // `DEFAULT_MAX_STRING_LEN`, and (c) gives a descriptive throw
      // instead of an opaque downstream error if the renderer sends
      // garbage. The opaque-id check via `assertId` would be too
      // strict for both inputs — Drive folder IDs ARE alphanumeric
      // today but Drive's API accepts the literal token `root` and
      // is otherwise free to widen the character set, and pageTokens
      // are deliberately opaque server-generated cursors whose
      // internal format we don't constrain.
      const folderId =
        assertOptionalString(folderIdRaw, "folderId", { maxLen: 256 }) ??
        undefined;
      const pageToken =
        assertOptionalString(pageTokenRaw, "pageToken", { maxLen: 4096 }) ??
        undefined;
      // Resolve a fresh access token *before* consuming the
      // rate-limit budget. Order matters: a disconnected user, an
      // expired token, or a network glitch must surface as
      // `NotConnectedError` / soft-offline without ever debiting the
      // 10-per-second listFiles bucket. If the rate-limit consume
      // ran first, ten user-driven retries against a stale auth
      // state would exhaust the budget and the renderer would see
      // "rate-limited" messaging stacked on top of the real
      // (auth/network) error.
      let accessToken: string;
      try {
        accessToken = await getValidAccessToken("google_drive");
      } catch (err) {
        // A refresh-token exchange that fails because the host has
        // no network must surface as soft-offline (same contract as
        // `runConnectorSync`'s offline branch) rather than throwing
        // a raw `fetch failed` that the picker would render as
        // "Auth expired". Non-network refresh errors (4xx from
        // Google, missing credentials, NotConnectedError) still
        // propagate so the renderer prompts re-auth.
        if (isNetworkError(err)) {
          getLogger().warn(
            "gdrive listFiles token refresh hit network failure",
            { error: (err as Error).message },
          );
          return { nextPageToken: null, files: [], offline: true };
        }
        throw err;
      }

      // Defence-in-depth rate limit on Drive file-listing calls. The
      // renderer's `DriveFilePicker` debounces user input, but a
      // buggy effect loop or a misbehaving renderer-side test could
      // still hammer this handler — and Drive's per-user quota
      // (1,000 queries per 100 seconds) is global to the OAuth
      // client, so once burned the next *legitimate* user has a
      // degraded experience. 10/s is well above any human-driven
      // navigation rate but tight enough to neutralise a runaway
      // loop. The sync handler uses a much stricter 1/30s budget
      // because each sync involves dozens of API calls.
      try {
        getConnectorContext().rateLimiter.consume(
          "connectors:gdrive:listFiles",
          { tokensPerInterval: 10, intervalMs: 1_000 },
        );
      } catch (err) {
        if (err instanceof RateLimitError) {
          throw new Error(
            `Drive file listing is rate-limited. Wait ${Math.ceil(
              err.retryAfterMs / 1000,
            )}s and try again.`,
          );
        }
        throw err;
      }

      const sanitizedFolderId = (folderId ?? "root")
        .replace(/\\/g, "\\\\")
        .replace(/'/g, "\\'");
      const query = `'${sanitizedFolderId}' in parents and trashed = false`;
      const params = new URLSearchParams({
        q: query,
        fields:
          "nextPageToken,files(id,name,mimeType,size,modifiedTime,parents)",
        pageSize: "100",
        orderBy: "folder,name",
      });
      if (pageToken) params.set("pageToken", pageToken);

      let resp: Response;
      try {
        resp = await fetch(
          `https://www.googleapis.com/drive/v3/files?${params.toString()}`,
          {
            headers: { Authorization: `Bearer ${accessToken}` },
          },
        );
      } catch (err) {
        // `fetch` rejecting without a status object is the canonical
        // signal of transport failure (DNS, TCP, TLS). Map to soft-
        // offline so the picker shows the same "Offline" affordance
        // the connector status bar already shows, rather than a raw
        // error banner.
        getLogger().warn("gdrive listFiles fetch hit network failure", {
          error: (err as Error).message,
        });
        return { nextPageToken: null, files: [], offline: true };
      }

      if (!resp.ok) {
        const text = await resp.text();
        throw new Error(`Drive API error: HTTP ${resp.status} — ${text}`);
      }

      const data = (await resp.json()) as {
        nextPageToken?: string;
        files: Array<{
          id: string;
          name: string;
          mimeType: string;
          size?: string;
          modifiedTime?: string;
          parents?: string[];
        }>;
      };

      return {
        nextPageToken: data.nextPageToken ?? null,
        files: data.files.map((f) => ({
          id: f.id,
          name: f.name,
          mimeType: f.mimeType,
          size: Number(f.size ?? "0"),
          modifiedTime: f.modifiedTime ?? null,
          isFolder: f.mimeType === "application/vnd.google-apps.folder",
          parentId: f.parents?.[0] ?? null,
        })),
      };
    },
  );

  idempotentHandle(
    "connectors:gdrive:selectItems",
    async (_event, items: unknown) => {
      const parsed = GdriveSelectedItemsSchema.parse(items);
      return parsed.map((item) => ({
        id: item.id,
        name: item.name,
        mimeType: item.mimeType,
        selected: true,
      }));
    },
  );

  idempotentHandle(
    "connectors:gdrive:sync",
    async (
      _event,
      selectedFileIds?: unknown,
    ): Promise<{
      added: number;
      modified: number;
      removed: number;
      status: string;
    }> => {
      let ids: string[] | undefined;
      if (selectedFileIds !== undefined && selectedFileIds !== null) {
        if (!Array.isArray(selectedFileIds)) {
          throw new Error("selectedFileIds must be an array of strings");
        }
        ids = selectedFileIds.map((id, i) => {
          if (typeof id !== "string") {
            throw new Error(
              `selectedFileIds[${i}] must be a string (got ${typeof id})`,
            );
          }
          return id;
        });
      }
      // Delegate to the shared `runConnectorSync` wrapper that backs
      // the new multi-provider `connectors:sync` channel. This keeps
      // the legacy gdrive channel on the *same* rate limit and the
      // *same* network-error -> `{ status: "offline" }` semantics
      // every other provider gets.
      return runConnectorSync(getConnectorContext(), "google_drive", {
        selectedFileIds: ids,
      });
    },
  );
}
