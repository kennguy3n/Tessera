/**
 * LW-6: cross-connector sync concurrency gate.
 *
 * Connector syncs are network + CPU + disk heavy: each one fetches
 * file/page deltas over the wire, extracts text, writes to the sync
 * directory, and re-indexes through the bridge. A user clicking "Sync
 * Now" on several connector cards in quick succession (or a future
 * "Sync all" affordance) would otherwise fan out that work in
 * parallel and spike RSS, network, and disk all at once — exactly the
 * background cost the lightweight resource principle is meant to
 * eliminate.
 *
 * This queue bounds how many connector syncs run at the same time:
 *
 *   - `lightweight` (default): cap 1 — syncs run strictly one at a
 *     time on a single logical background lane, so a multi-connector
 *     "sync all" drains sequentially with a flat resource profile.
 *   - `performance`: cap 3 — a few syncs may overlap to finish a bulk
 *     refresh faster on a machine the user has explicitly told us to
 *     treat as unconstrained.
 *
 * Same-provider double-syncs are already prevented one layer up by the
 * per-provider `1 / 30s` rate limiter in `runConnectorSync`, so this
 * gate only needs to bound *cross*-provider concurrency.
 *
 * The capacity is read from `getCapacity()` on every acquire (not
 * cached) so toggling Lightweight/Performance in Settings takes effect
 * for the next sync without a restart.
 */

import type { ResourceMode } from "../../../shared/types";

/**
 * Maximum number of connector syncs allowed to run concurrently, by
 * resource mode. Lightweight pins a single background lane; performance
 * permits a small fan-out.
 */
export const SYNC_CONCURRENCY: Record<ResourceMode, number> = {
  lightweight: 1,
  performance: 3,
};

/**
 * A small async semaphore with a capacity that can change at runtime.
 *
 * `run` admits a task immediately when a slot is free, otherwise parks
 * it FIFO until a running task releases a slot. A released slot is
 * handed directly to the next waiter (the slot count is transferred
 * inside `release`), so a burst of releases can never admit more
 * waiters than the capacity allows — the classic "wake N, each then
 * increments" over-admission race is avoided by accounting for the
 * slot at wake time rather than in the woken continuation.
 */
export class ConnectorSyncQueue {
  /** Number of tasks currently holding a slot. */
  private active = 0;
  /** FIFO-ordered resolvers for tasks waiting on a slot. */
  private readonly waiters: Array<() => void> = [];

  /**
   * @param getCapacity Resolves the *current* max concurrency. Called
   *   on every acquire so a runtime resource-mode change is honoured
   *   without restarting the process.
   */
  constructor(private readonly getCapacity: () => number) {}

  /** Tasks currently running. Exposed for assertions/diagnostics. */
  get activeCount(): number {
    return this.active;
  }

  /** Tasks parked waiting for a slot. Exposed for assertions. */
  get pendingCount(): number {
    return this.waiters.length;
  }

  /**
   * Run `task` once a concurrency slot is available, releasing the slot
   * when it settles (resolve OR reject). The task's result/rejection is
   * propagated unchanged.
   */
  async run<T>(task: () => Promise<T>): Promise<T> {
    await this.acquire();
    try {
      return await task();
    } finally {
      this.release();
    }
  }

  private async acquire(): Promise<void> {
    // Capacity is read live: a `getCapacity()` of at least 1 must hold
    // for progress, which `SYNC_CONCURRENCY` guarantees for every mode.
    if (this.active < this.getCapacity()) {
      this.active += 1;
      return;
    }
    // No free slot: park FIFO. `release` will claim a slot on our
    // behalf and then resolve us, so we must NOT re-increment `active`
    // here once woken.
    await new Promise<void>((resolve) => {
      this.waiters.push(resolve);
    });
  }

  private release(): void {
    this.active -= 1;
    // Hand the freed slot to the next waiter, but only if capacity
    // still allows (it may have shrunk via a Performance -> Lightweight
    // toggle). We claim the slot here, before resolving, so a synchronous
    // run of multiple releases cannot wake more waiters than there are
    // slots. If capacity GREW while waiters were parked, they are woken
    // one-per-release rather than in a burst — a benign, conservative
    // under-admission that self-heals as in-flight syncs complete.
    if (this.waiters.length > 0 && this.active < this.getCapacity()) {
      this.active += 1;
      const next = this.waiters.shift();
      if (next) next();
    }
  }
}
