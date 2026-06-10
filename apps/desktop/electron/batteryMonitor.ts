/**
 * Battery-awareness for the Electron main process (LW-3).
 *
 * Tessera's heavy subsystems — SLM synthesis, speculative warm-up, and
 * non-critical background connector sync — should not burn a laptop's
 * battery when it is low or discharging. This module polls the host's
 * power state on a slow cadence (default {@link DEFAULT_BATTERY_POLL_MS})
 * and exposes three cheap, synchronous predicates the gating call-sites
 * read:
 *
 *   - {@link isBatteryLow}  — on battery AND at/below the 20% threshold
 *   - {@link isOnBattery}   — discharging on battery (not plugged in)
 *   - {@link isCharging}    — plugged in and charging / charged
 *
 * Design rules:
 *
 *   1. **Fail open.** A desktop with no battery, a probe that errors, a
 *      parse that yields nothing, or the window before the first poll
 *      completes all resolve to "AC always" — gating NEVER fires on
 *      uncertainty. Blocking a user's generation because `pmset` was
 *      slow once would be a far worse failure than letting one
 *      generation run on a low battery.
 *   2. **Off the hot path.** Probing shells out (`pmset` / `wmic`) or
 *      reads sysfs; that work happens on the poll interval and the
 *      result is cached. The predicates the scheduler / IPC handlers
 *      call are pure reads of the cached snapshot.
 *   3. **Platform parsers are pure and exported** so they can be unit
 *      tested against captured fixtures without real hardware.
 */
import { execFile } from "child_process";
import { promisify } from "util";
import { readFile, readdir } from "fs/promises";

const execFileAsync = promisify(execFile);

export interface BatteryStatus {
  /**
   * `false` means the host has no battery (desktop / server / VM) — it is
   * always on AC and must never be gated. `true` means a battery is
   * present regardless of whether it is currently charging.
   */
  hasBattery: boolean;
  /** Discharging on battery power (not plugged in). */
  isOnBattery: boolean;
  /** Plugged in and charging or already full. */
  isCharging: boolean;
  /** Charge level 0–100, or `null` when the level is unknown. */
  percent: number | null;
}

/** Poll cadence for the background power-state probe. */
export const DEFAULT_BATTERY_POLL_MS = 60_000;

/** At/below this charge level (while on battery) {@link isBatteryLow} is true. */
export const LOW_BATTERY_THRESHOLD_PERCENT = 20;

/**
 * The fail-open snapshot: a host that is always on AC. Used as the
 * pre-first-poll value and the fallback whenever a probe throws or
 * yields nothing parseable.
 */
// Frozen, mirroring the other module-level config constants
// (`DEFAULT_EXTERNAL_PROVIDER`, `DEFAULT_HYBRID_SEARCH_CONFIG`): a
// shared fail-open default must never be mutable, or a stray
// `AC_ALWAYS.hasBattery = true` from any importer would silently flip
// gating on for the whole process.
export const AC_ALWAYS: BatteryStatus = Object.freeze({
  hasBattery: false,
  isOnBattery: false,
  isCharging: true,
  percent: null,
});

// `AC_ALWAYS` is frozen, so sharing it by reference as the pre-first-poll
// value is safe; the first `setCurrent` replaces it with its own frozen
// snapshot regardless.
let current: BatteryStatus = AC_ALWAYS;
let pollHandle: ReturnType<typeof setInterval> | null = null;
let inFlight: Promise<void> | null = null;

/**
 * Replace the cached snapshot with a FROZEN, independently-owned copy.
 * Single choke point for every write to `current` so that:
 *   - `getBatteryStatus()` can hand `current` straight to callers and a
 *     stray `getBatteryStatus().percent = 100` throws in strict mode
 *     instead of silently corrupting the cache for all later predicate
 *     reads (`isBatteryLow()` / `isOnBattery()` / `isCharging()`);
 *   - the cache is detached from the probe/parser's transient object and
 *     from the shared `AC_ALWAYS` constant.
 * `BatteryStatus` is flat (all primitives), so a shallow freeze is fully
 * immutable.
 */
function setCurrent(next: BatteryStatus): void {
  current = Object.freeze({ ...next });
}

/**
 * The most recent power-state snapshot. Cached, never throws, and
 * immutable — the returned object is frozen (see {@link setCurrent}), so
 * callers can read it freely but cannot corrupt the shared cache.
 */
export function getBatteryStatus(): BatteryStatus {
  return current;
}

/**
 * True only when we are confident the device is running on a low
 * battery. Requires a present battery, a discharging state, and a known
 * level at/below {@link LOW_BATTERY_THRESHOLD_PERCENT}. An unknown level
 * (`percent === null`) does NOT count as low — fail open.
 */
export function isBatteryLow(): boolean {
  return (
    current.hasBattery &&
    current.isOnBattery &&
    current.percent !== null &&
    current.percent <= LOW_BATTERY_THRESHOLD_PERCENT
  );
}

/** True when discharging on battery (a present battery, not charging). */
export function isOnBattery(): boolean {
  return current.hasBattery && current.isOnBattery;
}

/** True when plugged in (charging, full, or no battery at all). */
export function isCharging(): boolean {
  return current.isCharging;
}

// ---------------------------------------------------------------------------
// Pure platform parsers (exported for unit tests)
// ---------------------------------------------------------------------------

/**
 * Parse `pmset -g batt` (macOS). Sample discharging output:
 *
 * ```
 * Now drawing from 'Battery Power'
 *  -InternalBattery-0 (id=4259939)\t83%; discharging; 4:32 remaining present: true
 * ```
 *
 * On AC the first line reads `Now drawing from 'AC Power'` and the
 * battery line's state is `charging` / `charged`. A desktop Mac emits no
 * `-InternalBattery` line at all → no battery present.
 */
export function parsePmsetOutput(stdout: string): BatteryStatus {
  const batteryLine = stdout
    .split("\n")
    .find((l) => /-InternalBattery|-Battery/i.test(l));
  if (!batteryLine) return { ...AC_ALWAYS };

  const pctMatch = batteryLine.match(/(\d+)%/);
  const percent = pctMatch ? Number(pctMatch[1]) : null;
  // `pmset` reports `discharging`, `charging`, `charged`, or
  // `finishing charge`. Only `discharging` means we're on battery.
  const discharging = /;\s*discharging/i.test(batteryLine);
  return {
    hasBattery: true,
    isOnBattery: discharging,
    isCharging: !discharging,
    percent,
  };
}

/**
 * Parse the `Win32_Battery` `BatteryStatus` / `EstimatedChargeRemaining`
 * fields on Windows. Accepts BOTH the legacy `wmic … /format:list` shape
 * (`Key=Value`) and the modern PowerShell `Get-CimInstance … | Format-List`
 * shape (`Key : Value`), so the same parser serves both probes (see
 * {@link probeWindows}). Samples:
 *
 * ```
 * BatteryStatus=1                 // wmic /format:list
 * EstimatedChargeRemaining=74
 *
 * BatteryStatus            : 1    // PowerShell Format-List
 * EstimatedChargeRemaining : 74
 * ```
 *
 * `BatteryStatus` is the Win32_Battery availability code: `1` =
 * discharging, `2` = on AC line power. Empty output (neither key appears)
 * means no battery device → desktop.
 */
export function parseWmicBatteryOutput(stdout: string): BatteryStatus {
  const statusMatch = stdout.match(/BatteryStatus\s*[:=]\s*(\d+)/i);
  const pctMatch = stdout.match(/EstimatedChargeRemaining\s*[:=]\s*(\d+)/i);
  if (!statusMatch && !pctMatch) return { ...AC_ALWAYS };

  const statusCode = statusMatch ? Number(statusMatch[1]) : null;
  const percent = pctMatch ? Number(pctMatch[1]) : null;
  // Code 1 = "Discharging"; 2 = "On AC". Every other documented code
  // (3 Fully Charged, 4 Low, 5 Critical, 6 Charging, 7 Charging+High,
  // 8 Charging+Low, 9 Charging+Critical, 10 Undefined, 11 Partially
  // Charged) implies the unit is connected to line power.
  const discharging = statusCode === 1;
  return {
    hasBattery: true,
    isOnBattery: discharging,
    isCharging: !discharging,
    percent,
  };
}

/**
 * Build a {@link BatteryStatus} from Linux sysfs `power_supply` reads.
 * `capacity` is 0–100; `status` is one of `Charging` / `Discharging` /
 * `Full` / `Not charging` / `Unknown`.
 */
export function parseSysfsBattery(
  capacityRaw: string,
  statusRaw: string,
): BatteryStatus {
  const pct = Number(capacityRaw.trim());
  const percent = Number.isFinite(pct) ? pct : null;
  const status = statusRaw.trim().toLowerCase();
  const discharging = status === "discharging";
  return {
    hasBattery: true,
    isOnBattery: discharging,
    isCharging: !discharging,
    percent,
  };
}

// ---------------------------------------------------------------------------
// Platform probes (impure; each resolves to AC_ALWAYS on any failure)
// ---------------------------------------------------------------------------

async function probeMac(): Promise<BatteryStatus> {
  const { stdout } = await execFileAsync("pmset", ["-g", "batt"], {
    timeout: 4000,
  });
  return parsePmsetOutput(stdout);
}

async function probeWindowsPowerShell(): Promise<BatteryStatus> {
  const { stdout } = await execFileAsync(
    "powershell",
    [
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-CimInstance Win32_Battery | Select-Object BatteryStatus,EstimatedChargeRemaining | Format-List",
    ],
    { timeout: 4000 },
  );
  return parseWmicBatteryOutput(stdout);
}

async function probeWindowsWmic(): Promise<BatteryStatus> {
  const { stdout } = await execFileAsync(
    "wmic",
    [
      "path",
      "Win32_Battery",
      "get",
      "BatteryStatus,EstimatedChargeRemaining",
      "/format:list",
    ],
    { timeout: 4000 },
  );
  return parseWmicBatteryOutput(stdout);
}

/**
 * Windows power-state probe. Prefers PowerShell `Get-CimInstance
 * Win32_Battery` — the modern, supported API present on every Windows
 * 8+ host — and falls back to legacy `wmic` only when the PowerShell
 * invocation itself fails. `wmic` was deprecated in Windows 10 21H1 and
 * is absent from recent Windows 11 builds, so leading with it would make
 * battery awareness silently inoperative (fail-open) on most current
 * machines; leading with CIM keeps the feature working there while wmic
 * still covers older hosts that may lack the CIM cmdlet.
 *
 * Critically, the fallback fires only when the FIRST probe *throws*
 * (command missing / blocked). A PowerShell probe that succeeds but
 * returns no battery (a desktop) is authoritative AC_ALWAYS and must NOT
 * fall through to wmic — otherwise we'd double-probe every desktop on
 * each poll.
 */
async function probeWindows(): Promise<BatteryStatus> {
  try {
    return await probeWindowsPowerShell();
  } catch {
    return await probeWindowsWmic();
  }
}

async function probeLinux(): Promise<BatteryStatus> {
  const base = "/sys/class/power_supply";
  let entries: string[];
  try {
    entries = await readdir(base);
  } catch {
    return { ...AC_ALWAYS };
  }
  const bat = entries.find((e) => /^BAT/i.test(e));
  if (!bat) return { ...AC_ALWAYS };
  const [capacity, status] = await Promise.all([
    readFile(`${base}/${bat}/capacity`, "utf8"),
    readFile(`${base}/${bat}/status`, "utf8").catch(() => "Unknown"),
  ]);
  return parseSysfsBattery(capacity, status);
}

/**
 * Run the platform-appropriate probe and update the cached snapshot.
 * Never throws and never leaves a stale low-battery reading on error:
 * any failure resolves the snapshot to {@link AC_ALWAYS} (fail open).
 * Concurrent calls coalesce onto the in-flight probe.
 */
export async function refreshBatteryStatus(): Promise<BatteryStatus> {
  if (inFlight) {
    await inFlight;
    return current;
  }
  inFlight = (async () => {
    try {
      let next: BatteryStatus;
      switch (process.platform) {
        case "darwin":
          next = await probeMac();
          break;
        case "win32":
          next = await probeWindows();
          break;
        case "linux":
          next = await probeLinux();
          break;
        default:
          next = { ...AC_ALWAYS };
      }
      setCurrent(next);
    } catch (e) {
      // Fail open: a probe error must never gate the user. Reset to
      // AC_ALWAYS rather than retaining a possibly-stale "low" reading.
      setCurrent(AC_ALWAYS);
      console.error("[battery] probe failed; assuming AC power:", e);
    }
  })().finally(() => {
    inFlight = null;
  });
  await inFlight;
  return current;
}

/**
 * Start the background poll. Runs one immediate probe so the first
 * gating decision after boot uses real data rather than the optimistic
 * default, then re-probes every `pollMs`. Idempotent.
 */
export function startBatteryMonitor(
  pollMs: number = DEFAULT_BATTERY_POLL_MS,
): void {
  if (pollHandle) return;
  void refreshBatteryStatus();
  pollHandle = setInterval(() => {
    void refreshBatteryStatus();
  }, pollMs);
  // Don't keep the event loop (and thus the process) alive solely for
  // the battery poll — mirrors how the app's other timers behave on
  // shutdown.
  pollHandle.unref?.();
}

/** Stop the background poll and reset to the fail-open default. */
export function stopBatteryMonitor(): void {
  if (pollHandle) {
    clearInterval(pollHandle);
    pollHandle = null;
  }
  // Reset to the fail-open default through the single frozen-snapshot
  // choke point (see {@link setCurrent}).
  setCurrent(AC_ALWAYS);
}

/**
 * Test-only seam to set the cached snapshot directly, bypassing the
 * platform probe. Used by unit tests for the scheduler / IPC gating
 * paths so they can assert behaviour at a chosen battery level without
 * stubbing `child_process`.
 */
export function __setBatteryStatusForTests(status: BatteryStatus): void {
  setCurrent(status);
}
