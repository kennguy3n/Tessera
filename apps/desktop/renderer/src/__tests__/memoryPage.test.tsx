import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, waitFor, fireEvent, within, act } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import MemoryPage from "../pages/MemoryPage";
import type { SubstrateMemoryInfo } from "../types/ipc";

/**
 * Component coverage for the Memory dashboard ("what Tessera knows").
 * Exercises the IPC-backed render, the decay-bucket filter, free-text
 * search, and the pin / unpin / forget round-trips through
 * `window.tessera.substrate.*` (stubbed by the shared test setup and
 * overridden per case here).
 */

function mem(over: Partial<SubstrateMemoryInfo>): SubstrateMemoryInfo {
  return {
    id: over.id ?? "id",
    scopeId: "scope",
    observationType: over.observationType ?? "fact",
    content: over.content ?? "content",
    state: over.state ?? "canonical",
    retentionScore: over.retentionScore ?? 0.5,
    pinCount: over.pinCount ?? 0,
    retrievalCount: over.retrievalCount ?? 0,
    corroborationCount: over.corroborationCount ?? 0,
    createdAt: 0,
    lastAccessedAt: 0,
    sourceId: over.sourceId ?? "src-1",
  };
}

const SAMPLE = [
  mem({ id: "m1", content: "Atlas is the project codename", observationType: "entity", state: "canonical", retentionScore: 0.9 }),
  mem({ id: "m2", content: "Ship deadline is Q3", observationType: "fact", state: "superseded", retentionScore: 0.4 }),
  mem({ id: "m3", content: "Old archived decision", observationType: "decision", state: "archived", retentionScore: 0.1 }),
];

function renderPage() {
  return render(
    <MemoryRouter>
      <MemoryPage />
    </MemoryRouter>,
  );
}

describe("MemoryPage", () => {
  beforeEach(() => {
    window.tessera.substrate.getMemories = vi.fn().mockResolvedValue(SAMPLE);
    window.tessera.substrate.getConceptGraph = vi
      .fn()
      .mockResolvedValue('{"nodes":[],"edges":[]}');
    window.tessera.substrate.pinMemory = vi
      .fn()
      .mockImplementation(async (id: string) => mem({ id, pinCount: 1 }));
    window.tessera.substrate.unpinMemory = vi
      .fn()
      .mockImplementation(async (id: string) => mem({ id, pinCount: 0 }));
    window.tessera.substrate.forgetMemory = vi.fn().mockResolvedValue(undefined);
  });

  it("renders extracted memories with content, citation, state and retention", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("memory-list")).toBeInTheDocument(),
    );
    expect(screen.getByText("Atlas is the project codename")).toBeInTheDocument();
    expect(screen.getByTestId("memory-retention-m1")).toHaveTextContent("90% retained");
    expect(screen.getByTestId("memory-cite-m1")).toHaveTextContent(/Source src-1/);
    // Decay buckets surface as badges (active / fading / archived).
    expect(screen.getByText("active")).toBeInTheDocument();
    expect(screen.getByText("fading")).toBeInTheDocument();
  });

  it("shows an empty state when there are no memories", async () => {
    window.tessera.substrate.getMemories = vi.fn().mockResolvedValue([]);
    renderPage();
    await waitFor(() =>
      expect(screen.getByText("No memories yet")).toBeInTheDocument(),
    );
  });

  it("shows only the error + retry on fetch failure, not the empty state", async () => {
    window.tessera.substrate.getMemories = vi
      .fn()
      .mockRejectedValue(new Error("bridge unavailable"));
    renderPage();
    await waitFor(() =>
      expect(screen.getByRole("alert")).toHaveTextContent("bridge unavailable"),
    );
    expect(screen.getByText("Retry")).toBeInTheDocument();
    // The "No memories yet" prompt must NOT render alongside the error —
    // a failed fetch is not the same as an empty substrate.
    expect(screen.queryByText("No memories yet")).not.toBeInTheDocument();
  });

  it("filters by decay bucket", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("memory-list")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("memory-filter-active"));
    const list = screen.getByTestId("memory-list");
    expect(within(list).getByText("Atlas is the project codename")).toBeInTheDocument();
    expect(within(list).queryByText("Ship deadline is Q3")).not.toBeInTheDocument();
  });

  it("searches within memories", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("memory-list")).toBeInTheDocument(),
    );
    fireEvent.change(screen.getByLabelText("Search within memories"), {
      target: { value: "deadline" },
    });
    const list = screen.getByTestId("memory-list");
    expect(within(list).getByText("Ship deadline is Q3")).toBeInTheDocument();
    expect(within(list).queryByText("Atlas is the project codename")).not.toBeInTheDocument();
  });

  it("pins a memory and refreshes", async () => {
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("memory-list")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("memory-pin-m1"));
    await waitFor(() =>
      expect(window.tessera.substrate.pinMemory).toHaveBeenCalledWith("m1"),
    );
    // getMemories called once on mount + once after the pin refresh.
    await waitFor(() =>
      expect(window.tessera.substrate.getMemories).toHaveBeenCalledTimes(2),
    );
  });

  it("does not flash the loading state while reconciling after a pin", async () => {
    let resolveRefresh: (v: SubstrateMemoryInfo[]) => void = () => {};
    window.tessera.substrate.getMemories = vi
      .fn()
      .mockResolvedValueOnce(SAMPLE) // initial mount
      .mockImplementationOnce(
        () =>
          new Promise<SubstrateMemoryInfo[]>((res) => {
            resolveRefresh = res;
          }),
      );
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("memory-list")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("memory-pin-m1"));
    // The post-mutation refresh is in flight (deliberately unresolved).
    await waitFor(() =>
      expect(window.tessera.substrate.getMemories).toHaveBeenCalledTimes(2),
    );
    // A *silent* refresh must keep the list mounted — it must not tear the
    // page down to the "Loading memories…" placeholder on every mutation.
    expect(screen.queryByText("Loading memories...")).not.toBeInTheDocument();
    expect(screen.getByTestId("memory-list")).toBeInTheDocument();
    // Let the in-flight refresh settle so its state updates flush within act.
    await act(async () => {
      resolveRefresh(SAMPLE);
    });
  });

  it("forgets a memory after confirmation", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(true);
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("memory-list")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("memory-forget-m1"));
    await waitFor(() =>
      expect(window.tessera.substrate.forgetMemory).toHaveBeenCalledWith("m1"),
    );
    confirmSpy.mockRestore();
  });

  it("does not forget when confirmation is declined", async () => {
    const confirmSpy = vi.spyOn(window, "confirm").mockReturnValue(false);
    renderPage();
    await waitFor(() =>
      expect(screen.getByTestId("memory-list")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("memory-forget-m1"));
    expect(window.tessera.substrate.forgetMemory).not.toHaveBeenCalled();
    confirmSpy.mockRestore();
  });
});
