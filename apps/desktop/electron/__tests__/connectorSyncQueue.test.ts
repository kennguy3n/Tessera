/**
 * LW-6: unit tests for the cross-connector sync concurrency gate.
 *
 * These exercise `ConnectorSyncQueue` directly (no electron / config /
 * bridge) so the concurrency invariants are pinned independently of the
 * `runConnectorSync` wiring: at most `capacity` tasks run at once, FIFO
 * admission order, slots are released on both resolve and reject, and a
 * live capacity change is honoured on the next acquire.
 */

import { describe, it, expect } from "vitest";
import {
  ConnectorSyncQueue,
  SYNC_CONCURRENCY,
} from "../ipc/connectors/syncQueue";

/** A manually-resolvable promise so a test can hold a "sync" in flight. */
function deferred<T = void>(): {
  promise: Promise<T>;
  resolve: (v: T) => void;
  reject: (e: unknown) => void;
} {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

describe("SYNC_CONCURRENCY", () => {
  it("pins the lightweight=1 / performance=3 caps", () => {
    // Product decision (LW-6): one background lane when lightweight,
    // a small fan-out when the user opts into performance. If someone
    // changes these, this test should make them justify it.
    expect(SYNC_CONCURRENCY.lightweight).toBe(1);
    expect(SYNC_CONCURRENCY.performance).toBe(3);
  });
});

describe("ConnectorSyncQueue", () => {
  it("runs tasks immediately while under capacity and returns results", async () => {
    const q = new ConnectorSyncQueue(() => 2);
    await expect(q.run(async () => "a")).resolves.toBe("a");
    await expect(q.run(async () => 42)).resolves.toBe(42);
    expect(q.activeCount).toBe(0);
    expect(q.pendingCount).toBe(0);
  });

  it("caps concurrency at 1 in the lightweight profile (serial)", async () => {
    const q = new ConnectorSyncQueue(() => 1);
    const order: string[] = [];
    const d1 = deferred();
    const d2 = deferred();

    const p1 = q.run(async () => {
      order.push("start1");
      await d1.promise;
      order.push("end1");
    });
    const p2 = q.run(async () => {
      order.push("start2");
      await d2.promise;
      order.push("end2");
    });

    // Let microtasks settle: only task 1 may have started.
    await Promise.resolve();
    await Promise.resolve();
    expect(order).toEqual(["start1"]);
    expect(q.activeCount).toBe(1);
    expect(q.pendingCount).toBe(1);

    d1.resolve();
    await p1;
    // Task 2 only starts after task 1 fully releases its slot.
    await Promise.resolve();
    expect(order).toEqual(["start1", "end1", "start2"]);

    d2.resolve();
    await p2;
    expect(order).toEqual(["start1", "end1", "start2", "end2"]);
    expect(q.activeCount).toBe(0);
  });

  it("allows up to 3 concurrent tasks in the performance profile", async () => {
    const q = new ConnectorSyncQueue(() => 3);
    let running = 0;
    let peak = 0;
    const deferreds = Array.from({ length: 5 }, () => deferred());

    const tasks = deferreds.map((d) =>
      q.run(async () => {
        running += 1;
        peak = Math.max(peak, running);
        await d.promise;
        running -= 1;
      }),
    );

    await Promise.resolve();
    await Promise.resolve();
    // Exactly 3 admitted, 2 parked.
    expect(running).toBe(3);
    expect(q.activeCount).toBe(3);
    expect(q.pendingCount).toBe(2);

    deferreds.forEach((d) => d.resolve());
    await Promise.all(tasks);
    expect(peak).toBe(3);
    expect(running).toBe(0);
    expect(q.activeCount).toBe(0);
  });

  it("admits parked tasks in FIFO order", async () => {
    const q = new ConnectorSyncQueue(() => 1);
    const started: number[] = [];
    const blocker = deferred();

    // First task holds the only slot.
    const p0 = q.run(async () => {
      started.push(0);
      await blocker.promise;
    });
    // Enqueue 1,2,3 while the slot is held — they should start in order.
    const rest = [1, 2, 3].map((n) =>
      q.run(async () => {
        started.push(n);
      }),
    );

    await Promise.resolve();
    expect(started).toEqual([0]);

    blocker.resolve();
    await Promise.all([p0, ...rest]);
    expect(started).toEqual([0, 1, 2, 3]);
  });

  it("releases the slot even when a task rejects", async () => {
    const q = new ConnectorSyncQueue(() => 1);
    await expect(
      q.run(async () => {
        throw new Error("sync boom");
      }),
    ).rejects.toThrow("sync boom");
    // Slot must be freed so the next sync isn't wedged forever.
    expect(q.activeCount).toBe(0);
    await expect(q.run(async () => "ok")).resolves.toBe("ok");
  });

  it("honours a live capacity change on the next acquire", async () => {
    let capacity = 1;
    const q = new ConnectorSyncQueue(() => capacity);
    let running = 0;
    let peak = 0;
    const d = Array.from({ length: 3 }, () => deferred());

    const t0 = q.run(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await d[0].promise;
      running -= 1;
    });
    await Promise.resolve();
    expect(q.activeCount).toBe(1);
    expect(q.pendingCount).toBe(0);

    // Two more arrive while capacity is still 1 -> both park.
    const t1 = q.run(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await d[1].promise;
      running -= 1;
    });
    const t2 = q.run(async () => {
      running += 1;
      peak = Math.max(peak, running);
      await d[2].promise;
      running -= 1;
    });
    await Promise.resolve();
    expect(q.pendingCount).toBe(2);

    // User switches to performance; capacity grows. The first release
    // wakes one waiter; the model deliberately wakes one-per-release.
    capacity = 3;
    d[0].resolve();
    await Promise.resolve();
    await Promise.resolve();
    // After t0 releases, one parked task is admitted (active back to 1).
    expect(q.activeCount).toBe(1);
    expect(q.pendingCount).toBe(1);

    d[1].resolve();
    d[2].resolve();
    await Promise.all([t0, t1, t2]);
    expect(running).toBe(0);
    expect(q.activeCount).toBe(0);
  });
});
