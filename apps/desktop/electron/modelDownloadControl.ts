/**
 * Per-capability registry of in-flight, cancellable model downloads.
 *
 * Bridges the `runtime:cancelDownload` IPC (fired by the
 * ModelDownloadBanner's "Skip — work without AI" affordance) to the
 * `AbortSignal` threaded through `downloadModel`. A download registers
 * a fresh `AbortController` for its capability slot before it starts and
 * deregisters it when the call settles; `cancel(capability)` aborts
 * whatever is in flight (and anything queued) for that slot.
 *
 * Why a `Set` per slot rather than a single controller: the per-slot
 * download lock in `modelManagement` serialises *mutation*, but a second
 * start (e.g. a banner "Retry") can be QUEUED behind an in-flight
 * download on the same slot. Both hold their own controller for the
 * window where one is transferring and the other is waiting on the lock.
 * Keying by a set means a single "Skip" click aborts every download
 * targeting that slot — the active one (mid-transfer) AND any queued one
 * (which then short-circuits before mutating the filesystem). Last-
 * writer-wins on a single-controller map would strand the queued
 * download as un-cancellable.
 *
 * The registry is process-global and in-memory: there is exactly one
 * main process, downloads never cross process boundaries, and a crash
 * tears down every in-flight transfer anyway, so there is nothing to
 * persist.
 */
import {
  DownloadAbortedError,
  type ModelCapability,
} from "./modelManagement";

export class DownloadCancellationRegistry {
  private readonly inFlight = new Map<ModelCapability, Set<AbortController>>();

  /**
   * Register a new in-flight download for `capability` and return its
   * `AbortController`. The caller passes `controller.signal` into
   * `downloadModel` and MUST call {@link end} (in a `finally`) once the
   * download settles so the slot never retains a completed controller.
   */
  begin(capability: ModelCapability): AbortController {
    const controller = new AbortController();
    let set = this.inFlight.get(capability);
    if (!set) {
      set = new Set();
      this.inFlight.set(capability, set);
    }
    set.add(controller);
    return controller;
  }

  /**
   * Deregister a controller previously returned by {@link begin}. Safe
   * to call more than once and safe to call for a controller that was
   * already aborted by {@link cancel}. Removes the slot's set entirely
   * once empty so an idle slot leaves no residue.
   */
  end(capability: ModelCapability, controller: AbortController): void {
    const set = this.inFlight.get(capability);
    if (!set) return;
    set.delete(controller);
    if (set.size === 0) this.inFlight.delete(capability);
  }

  /**
   * Abort every in-flight (and queued) download for `capability`.
   * Returns `true` iff at least one not-yet-aborted download was
   * interrupted, so the IPC caller can distinguish "stopped a transfer"
   * from "nothing was downloading" (idempotent no-op). Aborting with a
   * {@link DownloadAbortedError} reason lets downstream code classify
   * the cancellation as deliberate rather than a network failure.
   */
  cancel(capability: ModelCapability): boolean {
    const set = this.inFlight.get(capability);
    if (!set || set.size === 0) return false;
    let aborted = false;
    // Snapshot before iterating: `abort()` may synchronously drive the
    // download's `finally` → `end()`, which mutates `set`.
    for (const controller of [...set]) {
      if (!controller.signal.aborted) {
        controller.abort(
          new DownloadAbortedError("Download cancelled by user"),
        );
        aborted = true;
      }
    }
    return aborted;
  }

  /** True iff a download is currently registered for `capability`. */
  isActive(capability: ModelCapability): boolean {
    const set = this.inFlight.get(capability);
    return set !== undefined && set.size > 0;
  }

  /**
   * Drop all registrations WITHOUT aborting. Test seam only — lets a
   * suite start from a clean registry without leaking controllers
   * across cases. Production code never clears the registry.
   */
  reset(): void {
    this.inFlight.clear();
  }
}

/**
 * Process-global registry shared by the recommended-model download path
 * (`downloadRecommendedModel`), the explicit `runtime:downloadModel`
 * handler, and the `runtime:cancelDownload` handler.
 */
export const downloadCancellations = new DownloadCancellationRegistry();
