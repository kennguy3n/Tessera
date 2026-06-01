/**
 * IPC handlers for the `sources:*` channels.
 *
 * Sources are the indexed origins (local folders, single files, remote
 * connector roots) that the artifact generator can search and cite
 * against. This module owns the renderer-facing CRUD + search APIs;
 * the heavy indexing pipeline lives in `crates/tessera_sources` and is
 * reached through the N-API bridge.
 */
import * as fs from "node:fs/promises";
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

  // bulk re-index entrypoint. Replaces the
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

  // per-source health summary for the Settings page
  // dashboard. Aggregates last-sync time, sync status traffic-light
  // (healthy / warning / error), indexed chunk count, and an on-disk
  // storage estimate. The handler runs as a single IPC round-trip so
  // the renderer can show a stable grid even with dozens of sources.
  //
  // We compute storage as `sum(stat(path).size)` over every indexed
  // file (NOT over the source root). For local sources this is the
  // exact byte cost the user pays in chunks; for connector sources
  // (Drive, OneDrive, Notion, etc.) the indexed-file rows hold the
  // most recent snapshot blob written to the local mirror, so the
  // sum still maps to "disk used by Tessera for this source".
  //
  // Errors are absorbed per source — a failing `stat` (e.g. file
  // moved by the user since last index) demotes that source to
  // status `warning` and contributes 0 to its storage tally but
  // does NOT fail the whole report. The renderer renders the
  // partial result; a fully unavailable bridge throws.
  idempotentHandle("sources:healthReport", async () => {
    const bridge = getBridge();
    if (!bridge) {
      throw new Error("Native bridge not available");
    }
    // `fs` (from `node:fs/promises`) is statically imported at the
    // top of the file. Previously this handler used a dynamic
    // `await import(...)` to keep the import off the cold-path,
    // but Node already caches dynamic-import resolution and the
    // remaining microtask yield was per-call dead weight — every
    // other handler in this file imports its deps statically, so
    // hoisting `fs` to the top normalises the style with no
    // observable behaviour change. 
    const sources = bridge.bridgeListSources();
    const items = await Promise.all(
      sources.map(async (src) => {
        let chunkCount = 0;
        let storageBytes = 0;
        let statErrors = 0;
        try {
          const detail = bridge.bridgeGetSourceDetail(src.id);
          for (const file of detail.files) {
            chunkCount += file.chunkCount;
            try {
              const st = await fs.stat(file.path);
              storageBytes += st.size;
            } catch {
              // File missing / unreadable since last index — count
              // as a stat error so we can flag the source as
              // `warning`. We still report the chunk count from
              // the index because the chunks ARE in our DB.
              statErrors += 1;
            }
          }
        } catch {
          // bridgeGetSourceDetail failed entirely (e.g. row was
          // removed between list and detail). Surface as an error
          // status with no chunk/byte data.
          return {
            sourceId: src.id,
            sourceType: src.sourceType,
            path: src.path,
            lastIndexed: src.lastIndexed,
            status: src.status,
            health: "error" as const,
            chunkCount: 0,
            storageBytes: 0,
            staleFiles: 0,
          };
        }
        // Health classification:
        //   * `error`           — backing status is "error" / "access_revoked"
        //   * `warning`         — backing status is "indexing" OR any
        //                         indexed file failed to stat OR no
        //                         lastIndexed timestamp on disk yet
        //   * `healthy`         — backing status is "indexed" /
        //                         "connected" AND no stale files
        // The order matters: error > warning > healthy. A source with
        // both error status AND missing files is still classified as
        // `error` (the worse signal wins).
        let health: "healthy" | "warning" | "error";
        if (src.status === "error" || src.status === "access_revoked") {
          health = "error";
        } else if (
          src.status === "indexing" ||
          statErrors > 0 ||
          src.lastIndexed === null
        ) {
          health = "warning";
        } else {
          health = "healthy";
        }
        return {
          sourceId: src.id,
          sourceType: src.sourceType,
          path: src.path,
          lastIndexed: src.lastIndexed,
          status: src.status,
          health,
          chunkCount,
          storageBytes,
          staleFiles: statErrors,
        };
      }),
    );
    return {
      generatedAt: new Date().toISOString(),
      sources: items,
    };
  });
}
