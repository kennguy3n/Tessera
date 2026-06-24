import { afterEach, describe, expect, it } from "vitest";
import {
  AC_ALWAYS,
  LOW_BATTERY_THRESHOLD_PERCENT,
  __setBatteryStatusForTests,
  getBatteryStatus,
  isBatteryLow,
  isCharging,
  isOnBattery,
  parsePmsetOutput,
  parseSysfsBattery,
  parseWmicBatteryOutput,
  stopBatteryMonitor,
} from "../batteryMonitor";

// Reset the module-level cached snapshot after every test so a status
// set by one test never leaks into the next (the predicates all read
// the shared `current` snapshot).
afterEach(() => {
  stopBatteryMonitor();
});

describe("parsePmsetOutput (macOS)", () => {
  it("parses a discharging laptop with a charge level", () => {
    const out = [
      "Now drawing from 'Battery Power'",
      " -InternalBattery-0 (id=4259939)\t83%; discharging; 4:32 remaining present: true",
    ].join("\n");
    expect(parsePmsetOutput(out)).toEqual({
      hasBattery: true,
      isOnBattery: true,
      isCharging: false,
      percent: 83,
    });
  });

  it("parses a charging laptop as on AC", () => {
    const out = [
      "Now drawing from 'AC Power'",
      " -InternalBattery-0 (id=4259939)\t64%; charging; 1:12 remaining present: true",
    ].join("\n");
    expect(parsePmsetOutput(out)).toEqual({
      hasBattery: true,
      isOnBattery: false,
      isCharging: true,
      percent: 64,
    });
  });

  it("treats 'charged' (full, plugged in) as not on battery", () => {
    const out =
      " -InternalBattery-0 (id=4259939)\t100%; charged; 0:00 remaining present: true";
    const s = parsePmsetOutput(out);
    expect(s.isOnBattery).toBe(false);
    expect(s.isCharging).toBe(true);
    expect(s.percent).toBe(100);
  });

  it("reports no battery (AC always) for a desktop with no InternalBattery line", () => {
    expect(parsePmsetOutput("Now drawing from 'AC Power'\n")).toEqual(
      AC_ALWAYS,
    );
  });
});

describe("parseWmicBatteryOutput (Windows)", () => {
  it("parses discharging (BatteryStatus=1)", () => {
    const out = "BatteryStatus=1\nEstimatedChargeRemaining=74\n";
    expect(parseWmicBatteryOutput(out)).toEqual({
      hasBattery: true,
      isOnBattery: true,
      isCharging: false,
      percent: 74,
    });
  });

  it("parses on-AC (BatteryStatus=2) as charging", () => {
    const out = "BatteryStatus=2\nEstimatedChargeRemaining=90\n";
    const s = parseWmicBatteryOutput(out);
    expect(s.isOnBattery).toBe(false);
    expect(s.isCharging).toBe(true);
    expect(s.percent).toBe(90);
  });

  it("treats a charging code (6) as on line power, not battery", () => {
    const out = "BatteryStatus=6\nEstimatedChargeRemaining=40\n";
    const s = parseWmicBatteryOutput(out);
    expect(s.isOnBattery).toBe(false);
    expect(s.isCharging).toBe(true);
  });

  it("reports no battery (AC always) when wmic emits no keys (desktop)", () => {
    expect(parseWmicBatteryOutput("\r\n\r\n")).toEqual(AC_ALWAYS);
  });

  it("parses PowerShell Get-CimInstance Format-List output (colon separator)", () => {
    // The modern probe shells out to `Get-CimInstance Win32_Battery |
    // Format-List`, which emits `Key : Value` rather than wmic's
    // `Key=Value`. The same parser must handle both separators.
    const out =
      "\r\nBatteryStatus            : 1\r\nEstimatedChargeRemaining : 12\r\n\r\n";
    expect(parseWmicBatteryOutput(out)).toEqual({
      hasBattery: true,
      isOnBattery: true,
      isCharging: false,
      percent: 12,
    });
  });

  it("parses PowerShell on-AC Format-List output", () => {
    const out =
      "BatteryStatus            : 2\r\nEstimatedChargeRemaining : 88\r\n";
    const s = parseWmicBatteryOutput(out);
    expect(s.isOnBattery).toBe(false);
    expect(s.isCharging).toBe(true);
    expect(s.percent).toBe(88);
  });
});

describe("parseSysfsBattery (Linux)", () => {
  it("parses a discharging battery", () => {
    expect(parseSysfsBattery("15\n", "Discharging\n")).toEqual({
      hasBattery: true,
      isOnBattery: true,
      isCharging: false,
      percent: 15,
    });
  });

  it("parses a charging battery as on AC", () => {
    const s = parseSysfsBattery("55", "Charging");
    expect(s.isOnBattery).toBe(false);
    expect(s.isCharging).toBe(true);
    expect(s.percent).toBe(55);
  });

  it("treats 'Full' as not on battery", () => {
    const s = parseSysfsBattery("100", "Full");
    expect(s.isOnBattery).toBe(false);
    expect(s.isCharging).toBe(true);
  });

  it("yields a null percent for a non-numeric capacity", () => {
    expect(parseSysfsBattery("unknown", "Discharging").percent).toBeNull();
  });
});

describe("predicates read the cached snapshot", () => {
  it("isBatteryLow is true only when present + discharging + at/below threshold", () => {
    __setBatteryStatusForTests({
      hasBattery: true,
      isOnBattery: true,
      isCharging: false,
      percent: LOW_BATTERY_THRESHOLD_PERCENT,
    });
    expect(isBatteryLow()).toBe(true);
    expect(isOnBattery()).toBe(true);
    expect(isCharging()).toBe(false);
  });

  it("isBatteryLow is false just above the threshold", () => {
    __setBatteryStatusForTests({
      hasBattery: true,
      isOnBattery: true,
      isCharging: false,
      percent: LOW_BATTERY_THRESHOLD_PERCENT + 1,
    });
    expect(isBatteryLow()).toBe(false);
    expect(isOnBattery()).toBe(true);
  });

  it("fails open: low percent but charging is NOT low (plugged in)", () => {
    __setBatteryStatusForTests({
      hasBattery: true,
      isOnBattery: false,
      isCharging: true,
      percent: 5,
    });
    expect(isBatteryLow()).toBe(false);
    expect(isOnBattery()).toBe(false);
    expect(isCharging()).toBe(true);
  });

  it("fails open: unknown percent while discharging is NOT low", () => {
    __setBatteryStatusForTests({
      hasBattery: true,
      isOnBattery: true,
      isCharging: false,
      percent: null,
    });
    expect(isBatteryLow()).toBe(false);
  });

  it("fails open: no battery (desktop) is never low and reads as charging", () => {
    __setBatteryStatusForTests({ ...AC_ALWAYS });
    expect(isBatteryLow()).toBe(false);
    expect(isOnBattery()).toBe(false);
    expect(isCharging()).toBe(true);
  });
});

describe("stopBatteryMonitor", () => {
  it("resets the cached snapshot back to the fail-open default", () => {
    __setBatteryStatusForTests({
      hasBattery: true,
      isOnBattery: true,
      isCharging: false,
      percent: 3,
    });
    expect(isBatteryLow()).toBe(true);
    stopBatteryMonitor();
    expect(getBatteryStatus()).toEqual(AC_ALWAYS);
    expect(isBatteryLow()).toBe(false);
  });
});
