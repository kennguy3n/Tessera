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
import {
  assertId,
  assertNumber,
  assertString,
  assertStringArray,
} from "./validate";
import { idempotentHandle } from "./register";
import { defaultRateLimiter, RATE_LIMIT_PROFILES } from "./rateLimiter";
import { BATCH_MAX_ITEMS, runBatch } from "./batch";

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

  // Phase 15 Task 6: bulk re-index entrypoint. Replaces the
  // renderer-side `Promise.all(ids.map(id => invoke('sources:reindex', id)))`
  // pattern with a single round-trip — for a 50-source workspace
  // that's a 50× reduction in IPC handshake overhead, and (more
  // importantly) the rate-limiter consumes one token for the batch
  // instead of being tripped by the 50 individual calls.
  //
  // Per-source errors are surfaced in the per-item result shape;
  // the batch never throws for a partial failure. The renderer
  // distinguishes "all failed" from "all succeeded" via the
  // `succeeded` / `failed` counts in the response.
  idempotentHandle(
    "sources:batchReindex",
    async (_event, sourceIds: unknown) => {
      const ids = assertStringArray(sourceIds, "sourceIds", {
        maxLen: BATCH_MAX_ITEMS,
        itemMaxLen: 128,
      });
      // Validate every id up-front so a single bad entry rejects
      // the whole batch synchronously (before any bridge work
      // starts). This is the more useful behaviour than per-item
      // validation errors mixed into the result vector — a
      // malformed id is almost certainly a renderer bug, not a
      // recoverable per-item failure.
      const validated = ids.map((id) => assertId(id, "sourceId"));
      const bridge = getBridge();
      if (!bridge) {
        throw new Error("Native bridge not available");
      }
      return runBatch(validated, async (id) => bridge.bridgeReindexSource(id));
    },
  );

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

  idempotentHandle(
    "sources:backfillEmbeddings",
    async (_event, batchSize: unknown) => {
      // Rate-limit defensively. The Rust side is idempotent and the
      // tracker has its own running-pass guard, but a click-mashing
      // user could otherwise queue dozens of zero-work calls here.
      defaultRateLimiter.consume(
        "sources:backfillEmbeddings",
        RATE_LIMIT_PROFILES["sources:backfillEmbeddings"],
      );
      // Optional argument — `undefined` falls through to the bridge
      // default; if the caller did pass a value it must be a small
      // positive integer (the indexer streams batches in memory so
      // anything above a few thousand would defeat the purpose).
      let validatedBatchSize: number | undefined;
      if (batchSize !== undefined && batchSize !== null) {
        validatedBatchSize = assertNumber(batchSize, "batchSize", {
          integer: true,
          min: 1,
          max: 4096,
        });
      }
      const bridge = getBridge();
      if (bridge) {
        return bridge.bridgeBackfillEmbeddings(validatedBatchSize ?? null);
      }
      throw new Error("Native bridge not available");
    },
  );

  idempotentHandle("sources:getEmbeddingProgress", async () => {
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeGetEmbeddingProgress();
    }
    // Pre-bridge fallback — return an empty idle snapshot so the
    // renderer's polling loop renders cleanly during the brief
    // window between window-ready and bridge-init.
    return {
      status: "idle" as const,
      totalChunks: 0,
      embedded: 0,
      failed: 0,
      modelId: null,
      lastError: null,
    };
  });
}
