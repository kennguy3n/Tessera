/**
 * Phase 15 Task 9: orphaned-sidecar reaper + PID-file registry.
 *
 * Two failure modes this protects against:
 *
 *   1. **Hard parent crash** — Electron's main process is killed
 *      (SIGKILL, kernel OOM, power loss) without going through the
 *      normal `will-quit` → `stop()` shutdown sequence. The
 *      `process.on("exit")` synchronous-SIGKILL fallback inside
 *      `sidecar.ts` does NOT run in that case because Node never
 *      gets a chance to fire its exit handler. The detached sidecar
 *      (POSIX) survives the parent and lingers as an orphan,
 *      consuming GPU memory and holding ports 8384/8385/8386.
 *   2. **App relaunch race** — the user double-clicks the app icon
 *      after a hard crash and the new Tessera tries to bind
 *      llama-server on port 8384, but the orphan sidecar still
 *      owns the port. Without this reaper, the new app shows
 *      "model unavailable" until the user discovers + kills the
 *      orphan by hand.
 *
 * Mitigation: every spawned sidecar writes a PID file under
 * `<userData>/<PID_DIR>/<label>.pid` immediately after `spawn`
 * succeeds, and removes the PID file in its own `stop()` /
 * `exit` handlers. At main-process startup (BEFORE any sidecar is
 * spawned), we scan the PID directory, verify each recorded PID is
 * (a) still alive AND (b) carrying a process name that looks like
 * the sidecar binary, and SIGKILL any that match. The "looks like"
 * verification is the safety net against PID reuse: if PID 12345
 * was our llama-server yesterday but is some unrelated user
 * process today, we MUST NOT kill it.
 *
 * Why a file-system registry rather than an `electron-store` entry:
 *
 *   * The registry needs to survive a SIGKILL of the writer — an
 *     in-memory store flushed on `before-quit` does not.
 *   * The registry needs to be readable by a fresh Tessera process
 *     before any other state is loaded (it runs before
 *     `initAppState`), so it cannot depend on the IPC bridge or
 *     the SQLite DB being ready.
 *   * A single small text file per sidecar is the simplest thing
 *     that supports both requirements and is trivially debuggable
 *     by hand (`cat ~/Library/Application\ Support/Tessera/tessera-sidecar-pids/text.pid`).
 */
import * as fs from "fs";
import * as fsp from "fs/promises";
import * as path from "path";
import { execFileSync } from "child_process";
import { app } from "electron";

/**
 * Subdirectory under Electron's `userData` that holds the per-
 * sidecar PID files. Lifted to a constant for test parity.
 */
const PID_DIR = "tessera-sidecar-pids";

/** Override hook for tests; matches the recovery module's pattern. */
let pidDirOverride: string | null = null;

/**
 * Inject a custom PID directory for tests. Production code always
 * resolves through {@link pidDirFor}, which prefers the override
 * when present and falls back to `<userData>/<PID_DIR>` otherwise.
 *
 * Pass `null` to clear the override at test teardown.
 */
export function setPidDirOverrideForTests(dir: string | null): void {
  pidDirOverride = dir;
}

function pidDirFor(): string {
  if (pidDirOverride !== null) return pidDirOverride;
  return path.join(app.getPath("userData"), PID_DIR);
}

function pidFilePathFor(label: string): string {
  const safe = label.replace(/[^A-Za-z0-9_.-]/g, "_");
  return path.join(pidDirFor(), `${safe}.pid`);
}

/**
 * Record a freshly-spawned sidecar's PID. Called immediately after
 * `child_process.spawn()` returns a non-undefined `pid`.
 *
 * Synchronous on purpose: we must guarantee the PID file is on
 * disk before we return control to the caller. If the caller
 * crashes between `spawn()` and our async write completing, the
 * reaper would miss the orphan on next launch.
 *
 * Writes the binary's basename alongside the PID so the reaper
 * can cross-check process identity. Format:
 *
 *   ```
 *   <pid>\n<binary-basename>\n
 *   ```
 *
 * Compact, human-readable, and impossible to misparse — a future
 * Tessera that doesn't recognise the format would silently skip
 * the file (treated as malformed) rather than mis-kill.
 */
export function writePidFileSync(
  label: string,
  pid: number,
  binaryPath: string,
): void {
  const dir = pidDirFor();
  fs.mkdirSync(dir, { recursive: true });
  const file = pidFilePathFor(label);
  const body = `${pid}\n${path.basename(binaryPath)}\n`;
  // Use writeFileSync directly — atomic-write via rename buys
  // nothing here because a half-written PID file (`<pid>\n<bin`)
  // is still parsed by the reaper as "malformed → skip", which is
  // the same outcome as a missing file (no kill attempted).
  fs.writeFileSync(file, body, { mode: 0o600 });
}

/**
 * Remove a sidecar's PID file. Called from `sidecar.stop()` and
 * from the `process.on("exit")` synchronous fallback so the file
 * disappears the moment the child does.
 *
 * Synchronous + `ENOENT`-swallowing so it can run from any
 * shutdown path without async hazards.
 */
export function clearPidFileSync(label: string): void {
  const file = pidFilePathFor(label);
  try {
    fs.unlinkSync(file);
  } catch (e: unknown) {
    if (
      e !== null &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code?: string }).code === "ENOENT"
    ) {
      return;
    }
    // Any other error (EACCES, EBUSY) is logged but not thrown —
    // the parent is exiting, and a stale PID file will be reaped
    // next launch anyway.
    console.warn(
      `[tessera] failed to clear sidecar PID file for ${label}:`,
      e,
    );
  }
}

/**
 * Check whether a PID is currently alive.
 *
 * Uses POSIX `kill(pid, 0)` (signal 0 is the "permission probe" —
 * it does nothing if the process exists, raises EPERM if you
 * cannot signal it, raises ESRCH if there is no such process).
 * On Windows `process.kill` with signal 0 has the same semantics
 * via the equivalent OpenProcess+CloseHandle dance, so this
 * works cross-platform without conditional code.
 */
function isProcessAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e: unknown) {
    if (
      e !== null &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code?: string }).code === "EPERM"
    ) {
      // EPERM means the process exists but we can't signal it.
      // For our use case (reaping our own children that we spawned
      // with our own UID), EPERM should never happen — but if it
      // does, treat it as "alive but not ours" and refuse to kill.
      return true;
    }
    return false;
  }
}

/**
 * Cross-platform process-name probe. Returns the executable basename
 * for the given PID, or null if we can't determine it (process gone,
 * permission denied, unsupported platform).
 *
 * Implementation:
 *   * Linux: read `/proc/<pid>/comm` (kernel-reported task name).
 *   * macOS / other POSIX: `ps -o comm= -p <pid>` shell-out.
 *   * Windows: `tasklist /FI "PID eq <pid>" /FO CSV /NH` shell-out.
 *
 * Identical pattern to the safe-RSS probe in `tessera_sources/mem.rs`
 * — a tiny shell-out per app startup is invisible cost (the reaper
 * runs at most once per launch and only against PIDs we suspect are
 * orphans).
 */
function processName(pid: number): string | null {
  if (process.platform === "linux") {
    try {
      const buf = fs.readFileSync(`/proc/${pid}/comm`, "utf-8");
      return buf.trim();
    } catch {
      return null;
    }
  }
  if (process.platform === "win32") {
    try {
      const out = execFileSync(
        "tasklist",
        ["/FI", `PID eq ${pid}`, "/FO", "CSV", "/NH"],
        { encoding: "utf-8", timeout: 2000 },
      );
      // Output line: `"image.exe","12345","Console","1","12,345 K"`
      const m = /^"([^"]+)"/.exec(out.trim());
      return m ? m[1].trim() : null;
    } catch {
      return null;
    }
  }
  // macOS + other POSIX
  try {
    const out = execFileSync("ps", ["-o", "comm=", "-p", String(pid)], {
      encoding: "utf-8",
      timeout: 2000,
    });
    return out.trim() || null;
  } catch {
    return null;
  }
}

/**
 * Loose-equality binary-name comparison.
 *
 * `processName` returns the kernel's `comm` value, which on Linux
 * is truncated to 15 bytes; on macOS `ps -o comm=` returns the
 * full argv[0] basename; on Windows it includes the `.exe`
 * extension. We normalise all three to a basename without
 * extension, then check whether one is a prefix of the other.
 *
 * Examples that should match:
 *   * recorded: `llama-server` ⟷ Linux comm: `llama-server` (=)
 *   * recorded: `llama-server.exe` ⟷ Windows tasklist: `llama-server.exe` (=)
 *   * recorded: `sd-server` ⟷ Linux comm: `sd-server` (=)
 *   * recorded: `llama-server` ⟷ macOS comm: `llama-server` (=)
 *   * recorded: `LongNamedBinary` ⟷ Linux comm: `LongNamedBina` (15-byte truncation; prefix match)
 *
 * Examples that should NOT match:
 *   * recorded: `llama-server` ⟷ alive proc: `bash` — reject.
 *   * recorded: `llama-server` ⟷ alive proc: `Code Helper` — reject.
 */
function binariesMatch(recorded: string, actual: string): boolean {
  const norm = (s: string) =>
    path.basename(s).replace(/\.exe$/i, "").toLowerCase();
  const r = norm(recorded);
  const a = norm(actual);
  if (r === a) return true;
  // Tolerate the Linux `comm` 15-byte truncation: if either is a
  // prefix of the other with length ≥ 5, treat as a match. The
  // length floor avoids false positives like "sd" matching
  // "sd-server".
  if (r.length >= 5 && a.startsWith(r)) return true;
  if (a.length >= 5 && r.startsWith(a)) return true;
  return false;
}

/**
 * Result type for {@link reapOrphanedSidecars}. Returned (not just
 * logged) so the will-quit tests + the startup smoke test can
 * assert specific outcomes.
 */
export interface ReapOutcome {
  scanned: number;
  killed: { label: string; pid: number; binary: string }[];
  skipped: { label: string; reason: string }[];
}

/**
 * Main-process startup hook. Walks the PID directory, kills any
 * lingering sidecar processes left over from a prior crashed
 * launch, and cleans up the corresponding PID files.
 *
 * Safety checks before issuing SIGKILL:
 *   1. The PID file is well-formed (parseable PID + binary basename).
 *   2. The recorded PID is alive (`process.kill(pid, 0)`).
 *   3. The currently-running process at that PID has a comm/image
 *      name that {@link binariesMatch} agrees with the recorded
 *      binary. PID reuse is the bogeyman here — without this
 *      check we'd happily SIGKILL the user's text editor if it
 *      happened to inherit yesterday's sidecar PID.
 *
 * Returns a {@link ReapOutcome} describing what happened. Production
 * uses the return only for telemetry / logging; tests assert on it.
 *
 * Idempotent and safe to call multiple times — calling against a
 * clean directory is a no-op that returns `{ scanned: 0, ... }`.
 */
export async function reapOrphanedSidecars(): Promise<ReapOutcome> {
  const dir = pidDirFor();
  const outcome: ReapOutcome = { scanned: 0, killed: [], skipped: [] };

  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch (e: unknown) {
    if (
      e !== null &&
      typeof e === "object" &&
      "code" in e &&
      (e as { code?: string }).code === "ENOENT"
    ) {
      // Directory doesn't exist yet — first ever launch, nothing
      // to reap. Create it lazily on the next writePidFileSync.
      return outcome;
    }
    throw e;
  }

  for (const entry of entries) {
    if (!entry.endsWith(".pid")) continue;
    outcome.scanned += 1;
    const label = entry.slice(0, -".pid".length);
    const fullPath = path.join(dir, entry);
    let body: string;
    try {
      body = await fsp.readFile(fullPath, "utf-8");
    } catch {
      outcome.skipped.push({ label, reason: "unreadable" });
      continue;
    }
    const lines = body.split("\n").map((l) => l.trim()).filter(Boolean);
    if (lines.length < 2) {
      outcome.skipped.push({ label, reason: "malformed" });
      await fsp.unlink(fullPath).catch(() => undefined);
      continue;
    }
    const pid = Number(lines[0]);
    const recordedBinary = lines[1];
    if (!Number.isInteger(pid) || pid <= 0) {
      outcome.skipped.push({ label, reason: "invalid pid" });
      await fsp.unlink(fullPath).catch(() => undefined);
      continue;
    }
    if (!isProcessAlive(pid)) {
      outcome.skipped.push({ label, reason: "process already exited" });
      await fsp.unlink(fullPath).catch(() => undefined);
      continue;
    }
    const actualBinary = processName(pid);
    if (actualBinary === null) {
      // Process exists but we can't read its name — be conservative
      // and skip rather than risk killing a foreign process.
      outcome.skipped.push({ label, reason: "could not read process name" });
      continue;
    }
    if (!binariesMatch(recordedBinary, actualBinary)) {
      // PID was reused by a different program. DO NOT KILL —
      // remove the stale file so we don't keep checking it.
      outcome.skipped.push({
        label,
        reason: `pid reused (recorded=${recordedBinary}, actual=${actualBinary})`,
      });
      await fsp.unlink(fullPath).catch(() => undefined);
      continue;
    }
    // Confirmed orphan: same PID, same binary, alive. Kill it.
    try {
      process.kill(pid, "SIGKILL");
      outcome.killed.push({ label, pid, binary: actualBinary });
    } catch (e) {
      outcome.skipped.push({
        label,
        reason: `kill failed: ${e instanceof Error ? e.message : String(e)}`,
      });
    }
    await fsp.unlink(fullPath).catch(() => undefined);
  }

  return outcome;
}
