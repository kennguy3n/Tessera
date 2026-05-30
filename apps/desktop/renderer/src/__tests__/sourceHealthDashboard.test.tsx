/**
 * Phase 15 Task 22 — SourceHealthDashboard component tests.
 *
 * Exercises the renderer-side rendering of the `sources:healthReport`
 * IPC envelope: the three traffic-light health classes (healthy /
 * warning / error), empty-state rendering when there are no sources,
 * the refresh button wiring, and bytes/relative-time formatting at
 * boundary values. The IPC handler itself (which does the on-disk
 * `fs.stat` walks + the bridge call) is covered separately by
 * `apps/desktop/electron/__tests__/sourceHealthReport.test.ts`.
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import SourceHealthDashboard from "../components/SourceHealthDashboard";
import type {
  SourceApi,
  SourceHealthReport,
} from "../../../shared/types";

function makeReport(
  overrides: Partial<SourceHealthReport["sources"][number]>[],
): SourceHealthReport {
  return {
    generatedAt: new Date().toISOString(),
    sources: overrides.map((o, i) => ({
      sourceId: o.sourceId ?? `src-${i}`,
      sourceType: o.sourceType ?? "local_folder",
      path: o.path ?? `/docs/${i}`,
      // `??` coalesces null AND undefined, so a caller passing
      // `lastIndexed: null` (the "never indexed" state) would
      // otherwise be silently upgraded to a fresh timestamp. Use
      // an `in` check so explicit null survives.
      lastIndexed:
        "lastIndexed" in o ? o.lastIndexed! : new Date().toISOString(),
      status: o.status ?? "indexed",
      health: o.health ?? "healthy",
      chunkCount: o.chunkCount ?? 0,
      storageBytes: o.storageBytes ?? 0,
      staleFiles: o.staleFiles ?? 0,
    })),
  };
}

function makeApi(report: SourceHealthReport): SourceApi {
  return {
    addLocalFolder: vi.fn(),
    addLocalFile: vi.fn(),
    listSources: vi.fn(),
    removeSource: vi.fn(),
    searchSources: vi.fn(),
    getDetail: vi.fn(),
    reindex: vi.fn(),
    batchReindex: vi.fn(),
    getIndexingProgress: vi.fn(),
    backfillEmbeddings: vi.fn(),
    getEmbeddingProgress: vi.fn(),
    healthReport: vi.fn().mockResolvedValue(report),
  } as unknown as SourceApi;
}

describe("SourceHealthDashboard", () => {
  it("renders the empty state when no sources are connected", async () => {
    const api = makeApi(makeReport([]));
    render(<SourceHealthDashboard api={api} />);
    await waitFor(() => {
      expect(
        screen.getByText(/No sources connected yet/i),
      ).toBeInTheDocument();
    });
    expect(api.healthReport).toHaveBeenCalledTimes(1);
  });

  it("renders healthy / warning / error rows with traffic-light badges", async () => {
    const api = makeApi(
      makeReport([
        {
          sourceId: "src-h",
          path: "/healthy",
          health: "healthy",
          chunkCount: 42,
          storageBytes: 1024 * 1024 * 5,
          lastIndexed: new Date(Date.now() - 60_000 * 5).toISOString(),
        },
        {
          sourceId: "src-w",
          path: "/warning",
          health: "warning",
          chunkCount: 7,
          storageBytes: 1024 * 12,
          staleFiles: 2,
        },
        {
          sourceId: "src-e",
          path: "/error",
          health: "error",
          chunkCount: 0,
          storageBytes: 0,
          lastIndexed: null,
        },
      ]),
    );
    render(<SourceHealthDashboard api={api} />);
    await waitFor(() => {
      expect(
        screen.getByTestId("source-health-row-src-h"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("source-health-badge-healthy"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("source-health-badge-warning"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("source-health-badge-error"),
    ).toBeInTheDocument();
    // The error row reports "Never" for its missing lastIndexed.
    const errorRow = screen.getByTestId("source-health-row-src-e");
    expect(errorRow).toHaveTextContent(/Never/);
  });

  it("formats storageBytes using 1024-base KB/MB/GB", async () => {
    const api = makeApi(
      makeReport([
        {
          sourceId: "tiny",
          path: "/tiny",
          storageBytes: 0,
        },
        {
          sourceId: "kb",
          path: "/kb",
          storageBytes: 2048,
        },
        {
          sourceId: "mb",
          path: "/mb",
          storageBytes: 5 * 1024 * 1024,
        },
        {
          sourceId: "gb",
          path: "/gb",
          storageBytes: 3 * 1024 * 1024 * 1024,
        },
      ]),
    );
    render(<SourceHealthDashboard api={api} />);
    await waitFor(() => {
      expect(screen.getByTestId("source-health-row-tiny")).toBeInTheDocument();
    });
    expect(screen.getByTestId("source-health-row-tiny")).toHaveTextContent(
      /0 B/,
    );
    expect(screen.getByTestId("source-health-row-kb")).toHaveTextContent(
      /2\.0 KB/,
    );
    expect(screen.getByTestId("source-health-row-mb")).toHaveTextContent(
      /5\.0 MB/,
    );
    expect(screen.getByTestId("source-health-row-gb")).toHaveTextContent(
      /3\.0 GB/,
    );
  });

  it("re-fetches when the Refresh button is clicked", async () => {
    const api = makeApi(makeReport([]));
    render(<SourceHealthDashboard api={api} />);
    await waitFor(() => {
      expect(api.healthReport).toHaveBeenCalledTimes(1);
    });
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    await waitFor(() => {
      expect(api.healthReport).toHaveBeenCalledTimes(2);
    });
  });

  it("renders an alert when the IPC call rejects", async () => {
    const api = {
      ...makeApi(makeReport([])),
      healthReport: vi.fn().mockRejectedValue(new Error("ipc boom")),
    } as unknown as SourceApi;
    render(<SourceHealthDashboard api={api} />);
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(/ipc boom/);
    });
  });
});
