/**
 * Tests for the per-capability in-flight download cancellation registry
 * (`DownloadCancellationRegistry` in modelDownloadControl.ts).
 *
 * The registry is the bridge between the `runtime:cancelDownload` IPC
 * and the `AbortSignal` threaded through `downloadModel`. These tests
 * exercise registration lifecycle, slot-keyed cancellation (including
 * the queued-second-download case), idempotency, and the abort reason
 * that lets downstream code classify a deliberate cancellation.
 */
import { describe, it, expect } from "vitest";

import { DownloadCancellationRegistry } from "../modelDownloadControl";
import { isDownloadAbortedError } from "../modelManagement";

describe("DownloadCancellationRegistry", () => {
  it("begin returns a fresh, un-aborted controller registered as active", () => {
    const reg = new DownloadCancellationRegistry();
    expect(reg.isActive("text")).toBe(false);

    const controller = reg.begin("text");
    expect(controller.signal.aborted).toBe(false);
    expect(reg.isActive("text")).toBe(true);
  });

  it("cancel aborts the in-flight controller with a DownloadAbortedError reason", () => {
    const reg = new DownloadCancellationRegistry();
    const controller = reg.begin("text");

    const aborted = reg.cancel("text");

    expect(aborted).toBe(true);
    expect(controller.signal.aborted).toBe(true);
    expect(isDownloadAbortedError(controller.signal.reason)).toBe(true);
  });

  it("end deregisters a settled controller so the slot goes idle", () => {
    const reg = new DownloadCancellationRegistry();
    const controller = reg.begin("text");
    expect(reg.isActive("text")).toBe(true);

    reg.end("text", controller);

    expect(reg.isActive("text")).toBe(false);
    // Cancelling an idle slot is a no-op.
    expect(reg.cancel("text")).toBe(false);
  });

  it("cancel returns false when nothing is downloading (idempotent no-op)", () => {
    const reg = new DownloadCancellationRegistry();
    expect(reg.cancel("vision")).toBe(false);
  });

  it("cancel does not re-abort an already-aborted controller", () => {
    const reg = new DownloadCancellationRegistry();
    reg.begin("text");

    expect(reg.cancel("text")).toBe(true);
    // Second cancel finds only the already-aborted controller → no work.
    expect(reg.cancel("text")).toBe(false);
  });

  it("cancels every download queued on the same slot", () => {
    const reg = new DownloadCancellationRegistry();
    // An in-flight download plus a second one queued behind the per-slot
    // download lock — both must be aborted by a single Skip click.
    const first = reg.begin("text");
    const second = reg.begin("text");

    const aborted = reg.cancel("text");

    expect(aborted).toBe(true);
    expect(first.signal.aborted).toBe(true);
    expect(second.signal.aborted).toBe(true);
  });

  it("isolates cancellation per capability slot", () => {
    const reg = new DownloadCancellationRegistry();
    const text = reg.begin("text");
    const vision = reg.begin("vision");

    reg.cancel("text");

    expect(text.signal.aborted).toBe(true);
    // A vision download must not be collateral damage of a text Skip.
    expect(vision.signal.aborted).toBe(false);
    expect(reg.isActive("vision")).toBe(true);
  });

  it("end is safe to call twice and after cancel", () => {
    const reg = new DownloadCancellationRegistry();
    const controller = reg.begin("text");

    reg.cancel("text");
    reg.end("text", controller);
    // No throw on a redundant end.
    expect(() => reg.end("text", controller)).not.toThrow();
    expect(reg.isActive("text")).toBe(false);
  });

  it("reset drops registrations without aborting", () => {
    const reg = new DownloadCancellationRegistry();
    const controller = reg.begin("text");

    reg.reset();

    expect(reg.isActive("text")).toBe(false);
    // reset does not abort — it just forgets.
    expect(controller.signal.aborted).toBe(false);
  });
});
