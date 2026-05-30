/**
 * Phase 15 Task 9 — `sidecarPidRegistry.ts` regression suite.
 *
 * The reaper is a high-blast-radius primitive: it issues SIGKILL to
 * PIDs read from a file on disk. A regression here could kill the
 * user's text editor, GPU driver helper, or some unrelated process
 * that happens to hold a PID we recorded yesterday. The tests pin
 * every safety check before exercising the kill path:
 *
 *   1. Missing PID directory → no-op (`scanned: 0`).
 *   2. Malformed PID file → file removed, no kill.
 *   3. PID belongs to a long-dead process → file removed, no kill.
 *   4. PID belongs to a live process whose name MISMATCHES the
 *      recorded binary → file removed, no kill. This is the
 *      core PID-reuse defence.
 *   5. PID belongs to a live process whose name MATCHES → SIGKILL
 *      delivered, file removed.
 *
 * For case 5 we spawn a real `sleep 60` child, record its PID
 * against `sleep` as the binary name, then call the reaper and
 * assert the child dies. This is the only way to verify the kill
 * path end-to-end without mocking `process.kill`, which would
 * defeat the point of the test.
 *
 * Why no test for `process.platform === "win32"`: the Linux CI
 * runner is the canonical environment, and the per-platform
 * `processName` branch is structurally trivial (a different shell-
 * out wrapper around the same algorithm). The macOS / Linux paths
 * are both exercised by the cross-platform `ps` fallback test
 * (`processName` falls through to it on macOS and uses /proc on
 * Linux).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import * as fs from "fs/promises";
// Synchronous fs surface for the two tests that need sync I/O
// inside the `expect()` chain (sanitiser + idempotent-overwrite).
// Hoisted here so we can use a real ESM import instead of
// `require("fs")`, which `@typescript-eslint/no-require-imports`
// rejects under strict lint mode.
import * as fsSync from "fs";
import * as os from "os";
import * as path from "path";
import { spawn } from "child_process";
import {
  writePidFileSync,
  clearPidFileSync,
  reapOrphanedSidecars,
  setPidDirOverrideForTests,
} from "../sidecarPidRegistry";

let tempDir: string;

beforeEach(async () => {
  tempDir = await fs.mkdtemp(path.join(os.tmpdir(), "tessera-pidreg-"));
  setPidDirOverrideForTests(tempDir);
});

afterEach(async () => {
  setPidDirOverrideForTests(null);
  await fs.rm(tempDir, { recursive: true, force: true });
});

describe("sidecarPidRegistry: write / clear round-trip", () => {
  it("creates the directory + writes a parseable PID file", async () => {
    writePidFileSync("text", 12345, "/path/to/llama-server");
    const entries = await fs.readdir(tempDir);
    expect(entries).toEqual(["text.pid"]);
    const body = await fs.readFile(path.join(tempDir, "text.pid"), "utf-8");
    expect(body).toBe("12345\nllama-server\n");
  });

  it("overwrites a prior PID file (idempotent restart)", () => {
    writePidFileSync("text", 1000, "/bin/llama-server");
    writePidFileSync("text", 2000, "/bin/llama-server");
    writePidFileSync("text", 3000, "/bin/llama-server");
    const body = fsSync.readFileSync(
      path.join(tempDir, "text.pid"),
      "utf-8",
    );
    expect(body).toBe("3000\nllama-server\n");
  });

  it("removes a present PID file via clearPidFileSync", async () => {
    writePidFileSync("text", 42, "/bin/llama-server");
    clearPidFileSync("text");
    const entries = await fs.readdir(tempDir);
    expect(entries).toEqual([]);
  });

  it("clearPidFileSync is a no-op for a missing PID file", () => {
    expect(() => clearPidFileSync("never-existed")).not.toThrow();
  });

  it("sanitises label characters that would escape the dir", () => {
    writePidFileSync("../escape/attempt", 99, "/bin/x");
    // Whatever filename we landed on, it MUST be inside tempDir
    // — the sanitiser strips path separators, so the resulting
    // file is one item directly under tempDir.
    const entries = fsSync.readdirSync(tempDir);
    expect(entries.length).toBe(1);
    expect(entries[0]).not.toContain("/");
    expect(entries[0]).not.toContain("\\");
  });
});

describe("sidecarPidRegistry: reaper safety", () => {
  it("returns scanned: 0 when the directory doesn't exist", async () => {
    // Aim the override at a not-yet-created dir.
    const nonexistent = path.join(tempDir, "no", "such", "dir");
    setPidDirOverrideForTests(nonexistent);
    const outcome = await reapOrphanedSidecars();
    expect(outcome.scanned).toBe(0);
    expect(outcome.killed).toEqual([]);
    expect(outcome.skipped).toEqual([]);
  });

  it("removes malformed PID files without killing anything", async () => {
    await fs.writeFile(path.join(tempDir, "broken.pid"), "not a number\n");
    const outcome = await reapOrphanedSidecars();
    expect(outcome.scanned).toBe(1);
    expect(outcome.killed).toEqual([]);
    expect(outcome.skipped[0].reason).toMatch(/malformed|invalid/);
    // Stale malformed file should be removed so we don't keep
    // checking it on every launch.
    const remaining = await fs.readdir(tempDir);
    expect(remaining).toEqual([]);
  });

  it("removes PID files whose process is already exited", async () => {
    // Use PID 999999 which is exceedingly unlikely to exist on
    // any test runner. A 1-in-32768 false negative is acceptable
    // for the test.
    await fs.writeFile(
      path.join(tempDir, "ghost.pid"),
      `999999\nllama-server\n`,
    );
    const outcome = await reapOrphanedSidecars();
    expect(outcome.scanned).toBe(1);
    expect(outcome.killed).toEqual([]);
    expect(outcome.skipped[0].reason).toMatch(/process already exited/);
    const remaining = await fs.readdir(tempDir);
    expect(remaining).toEqual([]);
  });

  it("refuses to kill a PID whose process name doesn't match (PID reuse defence)", async () => {
    // Spawn a real `sleep` and record it as if it were
    // llama-server. The reaper MUST refuse to kill it because the
    // name doesn't match. The sleep process must STILL be alive
    // after the reaper returns.
    const child = spawn("sleep", ["30"], { detached: false });
    try {
      // Wait until spawn settles.
      await new Promise<void>((resolve) =>
        child.once("spawn", () => resolve()),
      );
      const pid = child.pid;
      expect(typeof pid).toBe("number");
      await fs.writeFile(
        path.join(tempDir, "mismatched.pid"),
        `${pid}\nllama-server\n`,
      );
      const outcome = await reapOrphanedSidecars();
      expect(outcome.scanned).toBe(1);
      expect(outcome.killed).toEqual([]);
      expect(outcome.skipped[0].reason).toMatch(/pid reused/);
      // The sleep process must still be alive — the reaper must
      // NOT have signalled it.
      expect(child.killed).toBe(false);
      expect(child.exitCode).toBeNull();
    } finally {
      child.kill("SIGKILL");
    }
  });

  it("kills a confirmed orphan whose process name matches the recorded binary", async () => {
    // Spawn a real `sleep` and record it as if it were `sleep`
    // — the reaper SHOULD kill it.
    const child = spawn("sleep", ["30"], { detached: false });
    let exited = false;
    child.once("exit", () => {
      exited = true;
    });
    await new Promise<void>((resolve) => child.once("spawn", () => resolve()));
    const pid = child.pid!;
    await fs.writeFile(
      path.join(tempDir, "real-orphan.pid"),
      `${pid}\nsleep\n`,
    );
    const outcome = await reapOrphanedSidecars();
    expect(outcome.scanned).toBe(1);
    expect(outcome.killed).toHaveLength(1);
    expect(outcome.killed[0].pid).toBe(pid);
    // The PID file must be gone after the kill.
    const remaining = await fs.readdir(tempDir);
    expect(remaining).toEqual([]);
    // Wait briefly for the kernel to deliver the signal + Node
    // to fire the 'exit' event. 500 ms is generous enough that
    // a flaky scheduler doesn't false-fail.
    await new Promise<void>((resolve) => setTimeout(resolve, 500));
    expect(exited).toBe(true);
  });
});
