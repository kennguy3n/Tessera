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
 *
 * Keep this value in lock-step with the Rust constant (currently 2,
 * lowered from 4 in LW-5 for the single-user desktop profile). A
 * mismatch makes the dashboard misreport the reader-connection count.
 */
const MAX_READ_POOL_SIZE = 2;

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

/**
 * Run one defended sub-read. A transparency surface must never be able
 * to destabilise the app it reports on, so any throw from a subsystem
 * read degrades to that section's conservative default (and is logged
 * once) instead of rejecting the whole `resources:getUsage` poll. This
 * is the runtime guarantee behind the module-level contract: a single
 * failing subsystem blanks only its own section, not the snapshot.
 */
function defend<T>(label: string, read: () => T, fallback: T): T {
  try {
    return read();
  } catch (err) {
    console.warn(
      `[Tessera] resources:getUsage ${label} read failed; reporting conservative default:`,
      err instanceof Error ? err.message : String(err),
    );
    return fallback;
  }
}

// Conservative section defaults. These bias toward "least capable /
// fail-open" so the dashboard under-promises rather than misreports
// when a subsystem read fails: memory zeros, sidecars stopped, indexing
// admitted (not falsely shown as blocked), and battery gating off.
//
// They are `Object.freeze`d (including the nested SLM slots, which
// `defend()` returns by reference on a failed per-capability read) so the
// fail-open contract is self-enforcing: a future code path that retained
// and mutated a returned snapshot before it crossed IPC could otherwise
// permanently corrupt the fallback for every subsequent poll. Freezing
// turns that latent hazard into a structural impossibility rather than
// relying on call-site discipline.
const MEMORY_FALLBACK: ResourceUsage["memory"] = Object.freeze({
  rssBytes: 0,
  heapUsedBytes: 0,
  heapTotalBytes: 0,
  externalBytes: 0,
});
const SLM_FALLBACK: ResourceUsage["slm"] = Object.freeze({
  text: Object.freeze({ running: false, endpoint: null }),
  vision: Object.freeze({ running: false, endpoint: null }),
  imagegen: Object.freeze({ state: "unloaded" }),
});
const INDEXING_FALLBACK: ResourceUsage["indexing"] = Object.freeze({
  deferredForMemory: false,
  pressure: null,
});
const BATTERY_FALLBACK: ResourceUsage["battery"] = Object.freeze({
  hasBattery: false,
  isOnBattery: false,
  isCharging: false,
  percent: null,
  gating: false,
});

export function registerResourcesHandlers(): void {
  idempotentHandle("resources:getUsage", async (): Promise<ResourceUsage> => {
    return {
      resourceMode: defend(
        "resourceMode",
        () => loadConfig().resourceMode,
        "lightweight",
      ),
      memory: defend(
        "memory",
        () => {
          const mem = process.memoryUsage();
          return {
            rssBytes: mem.rss,
            heapUsedBytes: mem.heapUsed,
            heapTotalBytes: mem.heapTotal,
            externalBytes: mem.external,
          };
        },
        MEMORY_FALLBACK,
      ),
      // Each capability is defended independently so a corrupt read of
      // one slot (e.g. the vision registry) can't blank the other two —
      // a healthy running text model must stay visible on the dashboard
      // even if the vision peek throws.
      slm: {
        text: defend(
          "slm.text",
          () => sidecarSnapshot(getModelSidecar()),
          SLM_FALLBACK.text,
        ),
        vision: defend(
          "slm.vision",
          () => sidecarSnapshot(getVisionSidecar()),
          SLM_FALLBACK.vision,
        ),
        imagegen: defend(
          "slm.imagegen",
          () => ({ state: getDiffusionSidecarState().state }),
          SLM_FALLBACK.imagegen,
        ),
      },
      connections: {
        writers: 1,
        // `readPoolSize()` is already internally defended (it guards
        // `availableParallelism()`), so it never throws here.
        readers: readPoolSize(),
      },
      indexing: defend(
        "indexing",
        () => {
          const pressure = memoryPressureSnapshot();
          return {
            deferredForMemory: isIndexingDeferredForMemory(),
            pressure: pressure
              ? {
                  paused: pressure.paused,
                  rssBytes: pressure.rssBytes,
                  highWaterMarkBytes: pressure.highWaterMarkBytes,
                  lowWaterMarkBytes: pressure.lowWaterMarkBytes,
                }
              : null,
          };
        },
        INDEXING_FALLBACK,
      ),
      battery: defend(
        "battery",
        () => {
          const battery = getBatteryStatus();
          return {
            hasBattery: battery.hasBattery,
            isOnBattery: battery.isOnBattery,
            isCharging: battery.isCharging,
            percent: battery.percent,
            gating: isBatteryLow(),
          };
        },
        BATTERY_FALLBACK,
      ),
    };
  });
}
