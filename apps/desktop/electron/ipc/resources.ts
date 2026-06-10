/**
 * LW-12: read-only resource-usage snapshot for the Settings →
 * Performance "Resource usage" card.
 *
 * Channel:
 *   - `resources:getUsage` () -> ResourceUsage
 *
 * This is a pure aggregation point: it reads the live state the other
 * LW subsystems already own (model sidecars, resource mode, battery
 * monitor, indexing RSS watchdog) and the main process's own memory
 * footprint, and returns one structured-clone-safe snapshot. It owns no
 * state, starts nothing, and never throws back at the renderer — a
 * transparency surface must never be able to destabilise the app it is
 * reporting on, so each sub-read is defended and degrades to a
 * conservative default.
 */
import { availableParallelism } from "node:os";
import { idempotentHandle } from "./register";
import { getModelSidecar, getVisionSidecar, getDiffusionSidecarState } from "../appState";
import {
  getBatteryStatus,
  isBatteryLow,
} from "../batteryMonitor";
import {
  isIndexingDeferredForMemory,
  memoryPressureSnapshot,
} from "../memoryWatchdog";
import { loadConfig } from "../config";
import type {
  ResourceUsage,
  ResourceUsageSidecar,
} from "../../shared/types";

/**
 * Upper bound on the SQLCipher read pool. MIRRORS
 * `tessera_core::db::MAX_READ_POOL_SIZE` (see
 * `crates/tessera_core/src/db.rs`). The bridge sizes the pool as
 * `min(available_parallelism, MAX_READ_POOL_SIZE)` at open time
 * (`default_read_pool_size()`) but does not export the resulting value,
 * so the dashboard re-derives it from the same formula. This constant
 * is the single cross-FFI coupling point; a future bridge getter that
 * returns the live pool size would remove the need to mirror it here.
 */
const MAX_READ_POOL_SIZE = 4;

/**
 * The read pool is built with at least one reader (the
 * `available_parallelism()` failure fallback is 1) and capped at
 * {@link MAX_READ_POOL_SIZE}. `availableParallelism()` throws on no
 * platform it supports, but guard it anyway so a transparency read can
 * never fail.
 */
function readPoolSize(): number {
  let parallelism = 1;
  try {
    parallelism = availableParallelism();
  } catch {
    parallelism = 1;
  }
  return Math.max(1, Math.min(parallelism, MAX_READ_POOL_SIZE));
}

/** Snapshot one llama-server-style sidecar without constructing it. */
function sidecarSnapshot(
  sidecar: { isRunning: boolean; endpoint: string } | null,
): ResourceUsageSidecar {
  // `get*Sidecar()` is the non-constructing peek (LW-1): a sidecar that
  // has never been started is `null`, which reports as stopped without
  // forcing lazy construction just to inspect it.
  if (sidecar && sidecar.isRunning) {
    return { running: true, endpoint: sidecar.endpoint };
  }
  return { running: false, endpoint: null };
}

export function registerResourcesHandlers(): void {
  idempotentHandle("resources:getUsage", async (): Promise<ResourceUsage> => {
    const mem = process.memoryUsage();
    const battery = getBatteryStatus();
    const pressure = memoryPressureSnapshot();

    return {
      resourceMode: loadConfig().resourceMode,
      memory: {
        rssBytes: mem.rss,
        heapUsedBytes: mem.heapUsed,
        heapTotalBytes: mem.heapTotal,
        externalBytes: mem.external,
      },
      slm: {
        text: sidecarSnapshot(getModelSidecar()),
        vision: sidecarSnapshot(getVisionSidecar()),
        imagegen: { state: getDiffusionSidecarState().state },
      },
      connections: {
        writers: 1,
        readers: readPoolSize(),
      },
      indexing: {
        deferredForMemory: isIndexingDeferredForMemory(),
        pressure: pressure
          ? {
              paused: pressure.paused,
              rssBytes: pressure.rssBytes,
              highWaterMarkBytes: pressure.highWaterMarkBytes,
              lowWaterMarkBytes: pressure.lowWaterMarkBytes,
            }
          : null,
      },
      battery: {
        hasBattery: battery.hasBattery,
        isOnBattery: battery.isOnBattery,
        isCharging: battery.isCharging,
        percent: battery.percent,
        gating: isBatteryLow(),
      },
    };
  });
}
