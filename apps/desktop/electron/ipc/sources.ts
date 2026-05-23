/**
 * IPC handlers for the `sources:*` channels.
 *
 * Sources are the indexed origins (local folders, single files, remote
 * connector roots) that the artifact generator can search and cite
 * against. This module owns the renderer-facing CRUD + search APIs;
 * the heavy indexing pipeline lives in `crates/tessera_sources` and is
 * reached through the N-API bridge.
 */
import { getBridge } from "../appState";
import { assertId, assertNumber, assertString } from "./validate";
import { idempotentHandle } from "./register";

export function registerSourcesHandlers(): void {
  idempotentHandle(
    "sources:addLocalFolder",
    async (_event, folderPath: unknown) => {
      const validated = assertString(folderPath, "folderPath", {
        maxLen: 4096,
      });
      const bridge = getBridge();
      if (bridge) {
        return bridge.bridgeAddLocalFolder(validated);
      }
      throw new Error("Native bridge not available");
    },
  );

  idempotentHandle("sources:addLocalFile", async (_event, filePath: unknown) => {
    const validated = assertString(filePath, "filePath", { maxLen: 4096 });
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeAddLocalFile(validated);
    }
    throw new Error("Native bridge not available");
  });

  idempotentHandle("sources:list", async () => {
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeListSources();
    }
    return [];
  });

  idempotentHandle("sources:remove", async (_event, id: unknown) => {
    const validated = assertId(id, "sourceId");
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeRemoveSource(validated);
    }
    throw new Error("Native bridge not available");
  });

  idempotentHandle(
    "sources:search",
    async (_event, query: unknown, limit: unknown) => {
      const q = assertString(query, "query", { maxLen: 10_000 });
      const n = assertNumber(limit, "limit", {
        integer: true,
        min: 1,
        max: 1_000,
      });
      const bridge = getBridge();
      if (bridge) {
        const results = bridge.bridgeSearchSources(q, n);
        return results.map((r) => ({
          sourcePath: r.sourcePath,
          sourceId: r.sourceId,
          chunkHash: r.chunkHash,
          chunkContent: r.content,
          relevanceScore: r.relevance,
          excerpt: r.excerpt,
        }));
      }
      return [];
    },
  );

  idempotentHandle("sources:getDetail", async (_event, id: unknown) => {
    const validated = assertId(id, "sourceId");
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeGetSourceDetail(validated);
    }
    throw new Error("Native bridge not available");
  });

  idempotentHandle("sources:reindex", async (_event, id: unknown) => {
    const validated = assertId(id, "sourceId");
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeReindexSource(validated);
    }
    throw new Error("Native bridge not available");
  });

  idempotentHandle(
    "sources:getIndexingProgress",
    async (_event, id: unknown) => {
      const validated = assertId(id, "sourceId");
      const bridge = getBridge();
      if (bridge) {
        return bridge.bridgeGetIndexingProgress(validated);
      }
      throw new Error("Native bridge not available");
    },
  );
}
