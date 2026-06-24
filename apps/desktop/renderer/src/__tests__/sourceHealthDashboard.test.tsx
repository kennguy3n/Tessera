/**
 * SourceHealthDashboard component tests.
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
import type { SourceApi, SourceHealthReport } from "../../../shared/types";

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
      expect(screen.getByText(/No sources connected yet/i)).toBeInTheDocument();
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
      expect(screen.getByTestId("source-health-row-src-h")).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("source-health-badge-healthy"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId("source-health-badge-warning"),
    ).toBeInTheDocument();
    expect(screen.getByTestId("source-health-badge-error")).toBeInTheDocument();
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
    // The mock's call count increments synchronously (before the
    // awaited promise resolves and `setLoading(false)` runs), so the
    // assertion above can pass while `loading` is still true and the
    // Refresh button is `disabled`. Clicking a disabled button is a
    // no-op, which raced into an intermittent CI failure ("expected 2
    // calls, got 1"). Wait for the initial load to settle — i.e. the
    // button to become enabled, exactly as a real user must — before
    // clicking.
    await waitFor(() => {
      expect(screen.getByRole("button", { name: /refresh/i })).toBeEnabled();
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

  // Devin Review PR #70 regression: when a successful
  // initial load is followed by a failed refresh, the table is kept
  // (graceful degradation) but the user must be told the data is
  // stale via (1) updated banner copy citing the freshness, (2)
  // `aria-describedby` linking the table to the banner, (3) a
  // `data-stale` attribute the styles use to dim the table.
  it("marks the table as stale and updates the banner when a refresh fails after a successful load", async () => {
    const initialReport = makeReport([
      {
        sourceId: "src-1",
        path: "/docs/initial",
        health: "healthy",
        chunkCount: 10,
      },
    ]);
    const healthReport = vi
      .fn()
      .mockResolvedValueOnce(initialReport)
      .mockRejectedValueOnce(new Error("refresh boom"));
    const api = {
      ...makeApi(initialReport),
      healthReport,
    } as unknown as SourceApi;
    render(<SourceHealthDashboard api={api} />);
    // Wait for the initial successful load to render the row.
    await waitFor(() => {
      expect(screen.getByTestId("source-health-row-src-1")).toBeInTheDocument();
    });
    expect(screen.queryByRole("alert")).toBeNull();
    // The table is fresh on first paint — not yet marked stale.
    const tableFresh = screen.getByRole("table");
    expect(tableFresh.getAttribute("data-stale")).toBeNull();
    // Trigger the refresh which will reject.
    fireEvent.click(screen.getByRole("button", { name: /refresh/i }));
    // After the failed refresh: row still there, error banner cites
    // stale data, table flagged data-stale + aria-describedby.
    await waitFor(() => {
      expect(screen.getByRole("alert")).toHaveTextContent(
        /Failed to refresh source health: refresh boom\. Showing data from/i,
      );
    });
    expect(screen.getByTestId("source-health-row-src-1")).toBeInTheDocument();
    const tableStale = screen.getByRole("table");
    expect(tableStale.getAttribute("data-stale")).toBe("true");
    expect(tableStale.getAttribute("aria-describedby")).toBe(
      "source-health-error",
    );
  });

  // Devin Review PR #70 follow-up regression: when the
  // bridge is unavailable (transient renderer<->main init window, or
  // `SettingsPage` mounted from a test that didn't override `api`),
  // the card body used to render completely empty — header + Refresh
  // button with no status text. The fix surfaces a "Bridge not
  // available" error in the standard error banner so the user gets a
  // clear explanation, and the Refresh button stays clickable so the
  // user can retry once the bridge initialises.
  it("surfaces a clear error banner when the bridge is unavailable instead of rendering an empty card body", async () => {
    // Save and clear `window.tessera` to simulate the bridge being
    // unavailable. We restore it in `finally` so other tests in the
    // file are not affected.
    const originalTessera = (window as unknown as { tessera?: unknown })
      .tessera;
    (window as unknown as { tessera?: unknown }).tessera = undefined;
    try {
      // Mount the component WITHOUT an `api` prop so it falls back to
      // `window.tessera?.sources`, which we have just made undefined.
      render(<SourceHealthDashboard />);
      // The banner must mention "Bridge not available" so a screen
      // reader / sighted user is told the failure mode explicitly,
      // not a blank card body.
      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent(
          /Bridge not available/i,
        );
      });
      // The Refresh button must NOT be disabled (otherwise the user
      // could not retry once the bridge initialises). `loading=false`
      // after the early-return path means the button label says
      // "Refresh", not "Refreshing…".
      const refreshBtn = screen.getByRole("button", { name: /refresh/i });
      expect(refreshBtn).not.toBeDisabled();
      expect(refreshBtn).toHaveTextContent(/Refresh$/);
      // No table / no rows should render — the report is null.
      expect(screen.queryByRole("table")).toBeNull();
    } finally {
      (window as unknown as { tessera?: unknown }).tessera = originalTessera;
    }
  });

  /**
   * Devin Review PR #70 follow-up (BUG).
   *
   * Scenario: `window.tessera` is undefined when the component first
   * mounts (renderer<->preload init race), but becomes defined a
   * moment later. The Refresh button must self-heal — clicking it
   * after the bridge is live must load the report normally.
   *
   * Before the fix, the component captured
   * `sources = api ?? window.tessera?.sources` at render time and
   * the `refresh` callback closed over it via `[sources]`. With
   * `window.tessera` undefined on mount and the component not
   * re-rendering (no state change, no prop change), the closure
   * stayed stuck on `sources=undefined` forever. Clicking Refresh
   * just called the stale closure and surfaced "Bridge not
   * available" again, even though the bridge was now live.
   *
   * After the fix, `sources` is resolved INSIDE the `refresh`
   * callback on every invocation, so the next click picks up the
   * newly-available `window.tessera.sources`.
   */
  it("Refresh button self-heals when window.tessera becomes available after mount", async () => {
    const originalTessera = (window as unknown as { tessera?: unknown })
      .tessera;
    (window as unknown as { tessera?: unknown }).tessera = undefined;
    try {
      // Mount with the bridge unavailable.
      render(<SourceHealthDashboard />);
      await waitFor(() => {
        expect(screen.getByRole("alert")).toHaveTextContent(
          /Bridge not available/i,
        );
      });
      // Bridge becomes available — install a real mock on the same
      // global the component reads from.
      const report = makeReport([
        {
          sourceId: "src-late",
          path: "/docs/late-bridge-source",
          health: "healthy",
          chunkCount: 7,
        },
      ]);
      const lateApi = makeApi(report);
      (window as unknown as { tessera: { sources: SourceApi } }).tessera = {
        sources: lateApi,
      };
      // User clicks Refresh — fix makes the next call pick up the
      // newly-defined `window.tessera.sources` instead of using a
      // stale `undefined` closure.
      const refreshBtn = screen.getByRole("button", { name: /refresh/i });
      fireEvent.click(refreshBtn);
      // The "Bridge not available" banner must clear and a real
      // table row must appear. Without the fix, the alert stays
      // mounted because the stale closure hits the error branch
      // again.
      await waitFor(() => {
        expect(screen.queryByRole("alert")).toBeNull();
      });
      expect(screen.getByText("/docs/late-bridge-source")).toBeInTheDocument();
      expect(
        screen.getByTestId("source-health-row-src-late"),
      ).toBeInTheDocument();
      expect(lateApi.healthReport).toHaveBeenCalledTimes(1);
    } finally {
      (window as unknown as { tessera?: unknown }).tessera = originalTessera;
    }
  });
});
