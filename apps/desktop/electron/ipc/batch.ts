/**
 * Phase 15 Task 6 — IPC batch operation primitives.
 *
 * The bulk re-index and bulk export channels need consistent
 * semantics across both domains:
 *
 *   - Bounded batch size so a runaway renderer can't queue a
 *     100 000-item batch and OOM the bridge.
 *   - Per-item error isolation so one failure doesn't abort the
 *     rest of the batch — the renderer needs the partial-success
 *     summary, not a single bubbled `Error`.
 *   - Optional rate-limiter consumption keyed on the batch as a
 *     whole (one token per call) rather than per item, so a 100-
 *     item batch isn't blocked by a per-item-token limiter that
 *     was sized for one-shot calls.
 *   - A serialisable per-item result shape so the renderer's
 *     `Promise.all`-equivalent path can iterate the response and
 *     surface a toast / dialog per failure without rehydrating an
 *     `Error` instance.
 *
 * The two batch channels (`sources:batchReindex`,
 * `artifacts:batchExport`) both call [`runBatch`], parameterised
 * on the per-item handler. Keeping the contract here means a
 * future third batch channel (e.g. `templates:batchInstall`) gets
 * the same semantics for free.
 */

/**
 * Hard cap on the number of items in a single batch call.
 *
 * The cap is "an order of magnitude above any realistic UI
 * action" — the largest practical bulk action a user might trigger
 * is "re-index every source after a connector schema change",
 * which on a power user's workspace tops out around ~50 sources.
 * 256 leaves plenty of room for "select all" workflows without
 * letting a compromised renderer DOS the bridge.
 */
export const BATCH_MAX_ITEMS = 256;

/**
 * Per-item result shape returned to the renderer.
 *
 * - `ok` true: `value` is the per-item handler's return value.
 * - `ok` false: `error` is the handler's error message; `value`
 *   is `undefined`.
 *
 * Discriminated union (rather than `value: T | null`) so the
 * renderer's `result.ok` narrowing in TypeScript works without
 * an extra `result.error == null` check.
 */
export type BatchItemResult<T> =
  | { id: string; ok: true; value: T }
  | { id: string; ok: false; error: string };

/**
 * Aggregate response for a batch call.
 *
 * - `total`: number of items submitted.
 * - `succeeded`: count of `ok: true` entries.
 * - `failed`: count of `ok: false` entries.
 * - `results`: per-item outcomes in input order, so the renderer
 *   can render "row 7 of 12 failed" without a second round-trip.
 */
export interface BatchResponse<T> {
  total: number;
  succeeded: number;
  failed: number;
  results: BatchItemResult<T>[];
}

/**
 * Run `handler` on each `id` in `ids`, isolating per-item errors
 * into the per-item result shape.
 *
 * Sequential rather than parallel because every batch path today
 * funnels into a single-threaded native bridge call (Rust-side
 * `SourceManager` is `&mut self`-locked under a `Mutex`).
 * Issuing N concurrent `Promise`s would queue against the same
 * mutex anyway, paying microtask overhead with no throughput win.
 * If a future native bridge becomes truly multi-threaded, the
 * sequential `for/await` here is the right migration point.
 */
export async function runBatch<T>(
  ids: string[],
  handler: (id: string) => Promise<T>,
): Promise<BatchResponse<T>> {
  const results: BatchItemResult<T>[] = [];
  let succeeded = 0;
  let failed = 0;
  for (const id of ids) {
    try {
      const value = await handler(id);
      results.push({ id, ok: true, value });
      succeeded += 1;
    } catch (e) {
      results.push({
        id,
        ok: false,
        error: e instanceof Error ? e.message : String(e),
      });
      failed += 1;
    }
  }
  return { total: ids.length, succeeded, failed, results };
}
