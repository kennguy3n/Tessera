/**
 * Unit tests for the backup presentation helpers. Pure functions, so
 * these pin the exact rendered strings the Settings → Backup card and
 * the HomePage indicator depend on (a drift here is a visible UI bug).
 */
import { describe, it, expect } from "vitest";
import { formatBytes, formatRelativeTime } from "../formatBackup";

describe("formatBytes", () => {
  it("renders whole bytes with no decimals", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(1)).toBe("1 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(1023)).toBe("1023 B");
  });

  it("uses binary (1024) steps with one decimal for larger units", () => {
    expect(formatBytes(1024)).toBe("1.0 KB");
    expect(formatBytes(1536)).toBe("1.5 KB");
    expect(formatBytes(1024 * 1024)).toBe("1.0 MB");
    expect(formatBytes(Math.round(1.4 * 1024 * 1024))).toBe("1.4 MB");
    expect(formatBytes(1024 * 1024 * 1024)).toBe("1.0 GB");
    expect(formatBytes(1024 ** 4)).toBe("1.0 TB");
  });

  it("clamps to the largest unit for very large inputs", () => {
    // 5 PB still renders in TB rather than overflowing the unit ladder.
    expect(formatBytes(5 * 1024 ** 5)).toBe("5120.0 TB");
  });

  it("collapses negative / non-finite inputs to 0 B", () => {
    expect(formatBytes(-1)).toBe("0 B");
    expect(formatBytes(Number.NaN)).toBe("0 B");
    expect(formatBytes(Number.POSITIVE_INFINITY)).toBe("0 B");
  });
});

describe("formatRelativeTime", () => {
  const now = 1_000_000_000_000;

  it("renders sub-30s deltas as 'just now'", () => {
    expect(formatRelativeTime(now, now)).toBe("just now");
    expect(formatRelativeTime(now - 5_000, now)).toBe("just now");
    expect(formatRelativeTime(now - 29_000, now)).toBe("just now");
  });

  it("renders minute / hour / day granularity", () => {
    expect(formatRelativeTime(now - 60_000, now)).toBe("1m ago");
    expect(formatRelativeTime(now - 5 * 60_000, now)).toBe("5m ago");
    expect(formatRelativeTime(now - 2 * 60 * 60_000, now)).toBe("2h ago");
    expect(formatRelativeTime(now - 3 * 24 * 60 * 60_000, now)).toBe("3d ago");
  });

  it("collapses a future timestamp (clock skew) to 'just now'", () => {
    expect(formatRelativeTime(now + 60_000, now)).toBe("just now");
  });
});
