import { describe, it, expect, vi, afterEach } from "vitest";
import { render, screen, waitFor } from "@testing-library/react";
import ResourceUsageCard from "../components/ResourceUsageCard";
import type { ResourceUsage } from "../types/ipc";

function snapshot(overrides: Partial<ResourceUsage> = {}): ResourceUsage {
  return {
    resourceMode: "lightweight",
    memory: {
      rssBytes: 248 * 1024 * 1024,
      heapUsedBytes: 0,
      heapTotalBytes: 0,
      externalBytes: 0,
    },
    slm: {
      text: { running: false, endpoint: null },
      vision: { running: false, endpoint: null },
      imagegen: { state: "unloaded" },
    },
    connections: { writers: 1, readers: 2 },
    indexing: { deferredForMemory: false, pressure: null },
    battery: {
      hasBattery: false,
      isOnBattery: false,
      isCharging: true,
      percent: null,
      gating: false,
    },
    ...overrides,
  };
}

afterEach(() => {
  window.tessera.resources.getUsage = vi
    .fn()
    .mockResolvedValue(snapshot());
});

describe("ResourceUsageCard", () => {
  it("shows the measuring placeholder until the first snapshot arrives", () => {
    window.tessera.resources.getUsage = vi
      .fn()
      .mockReturnValue(new Promise(() => {})); // never resolves
    render(<ResourceUsageCard />);
    expect(screen.getByTestId("resource-usage-loading")).toBeInTheDocument();
  });

  it("renders the idle lightweight snapshot", async () => {
    window.tessera.resources.getUsage = vi
      .fn()
      .mockResolvedValue(snapshot());
    render(<ResourceUsageCard />);
    await waitFor(() =>
      expect(screen.getByTestId("resource-usage-body")).toBeInTheDocument(),
    );
    expect(screen.getByTestId("resource-usage-rss")).toHaveTextContent(
      "248 MB",
    );
    expect(screen.getByTestId("resource-usage-mode")).toHaveTextContent(
      "Lightweight",
    );
    expect(screen.getByTestId("resource-usage-slm-text")).toHaveTextContent(
      "Not loaded",
    );
    expect(
      screen.getByTestId("resource-usage-slm-imagegen"),
    ).toHaveTextContent("Not loaded");
    expect(
      screen.getByTestId("resource-usage-connections"),
    ).toHaveTextContent("1 writer + 2 readers");
    expect(screen.getByTestId("resource-usage-indexing")).toHaveTextContent(
      "Idle",
    );
    expect(screen.getByTestId("resource-usage-battery")).toHaveTextContent(
      "On AC power",
    );
    expect(
      screen.queryByTestId("resource-usage-battery-gating"),
    ).not.toBeInTheDocument();
  });

  it("shows a loaded text model with GB-scale memory", async () => {
    window.tessera.resources.getUsage = vi.fn().mockResolvedValue(
      snapshot({
        memory: {
          rssBytes: 1.5 * 1024 * 1024 * 1024,
          heapUsedBytes: 0,
          heapTotalBytes: 0,
          externalBytes: 0,
        },
        slm: {
          text: { running: true, endpoint: "http://127.0.0.1:8384" },
          vision: { running: false, endpoint: null },
          imagegen: { state: "unloaded" },
        },
      }),
    );
    render(<ResourceUsageCard />);
    await waitFor(() =>
      expect(screen.getByTestId("resource-usage-slm-text")).toHaveTextContent(
        "Loaded",
      ),
    );
    expect(screen.getByTestId("resource-usage-rss")).toHaveTextContent(
      "1.5 GB",
    );
  });

  it("crosses to GB at the 1023.5 MB rounding boundary (never '1024 MB')", async () => {
    window.tessera.resources.getUsage = vi.fn().mockResolvedValue(
      snapshot({
        memory: {
          // 1023.5 MB rounds to 1024 — must render as GB, not "1024 MB".
          rssBytes: 1023.5 * 1024 * 1024,
          heapUsedBytes: 0,
          heapTotalBytes: 0,
          externalBytes: 0,
        },
      }),
    );
    render(<ResourceUsageCard />);
    await waitFor(() =>
      expect(screen.getByTestId("resource-usage-body")).toBeInTheDocument(),
    );
    const rss = screen.getByTestId("resource-usage-rss");
    expect(rss).toHaveTextContent("1.0 GB");
    expect(rss).not.toHaveTextContent("1024 MB");
  });

  it("explains active battery gating", async () => {
    window.tessera.resources.getUsage = vi.fn().mockResolvedValue(
      snapshot({
        battery: {
          hasBattery: true,
          isOnBattery: true,
          isCharging: false,
          percent: 12,
          gating: true,
        },
      }),
    );
    render(<ResourceUsageCard />);
    await waitFor(() =>
      expect(screen.getByTestId("resource-usage-battery")).toHaveTextContent(
        "12% (on battery)",
      ),
    );
    expect(
      screen.getByTestId("resource-usage-battery-gating"),
    ).toBeInTheDocument();
  });

  it("shows the paused indexing state under memory pressure", async () => {
    window.tessera.resources.getUsage = vi.fn().mockResolvedValue(
      snapshot({
        indexing: {
          deferredForMemory: true,
          pressure: {
            paused: true,
            rssBytes: 520 * 1024 * 1024,
            highWaterMarkBytes: 500 * 1024 * 1024,
            lowWaterMarkBytes: 400 * 1024 * 1024,
          },
        },
      }),
    );
    render(<ResourceUsageCard />);
    await waitFor(() =>
      expect(
        screen.getByTestId("resource-usage-indexing"),
      ).toHaveTextContent("Paused (memory pressure)"),
    );
  });
});
