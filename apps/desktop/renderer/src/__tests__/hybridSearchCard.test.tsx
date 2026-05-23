import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import HybridSearchCard from "../components/HybridSearchCard";

const DAY = 24 * 60 * 60;

function seedConfig(overrides: Partial<{
  bm25Weight: number;
  vectorWeight: number;
  rrfK: number;
  recencyDecayEnabled: boolean;
  recencyHalflifeSecs: number | null;
  candidatePoolSize: number;
}> = {}) {
  const base = {
    bm25Weight: 1.0,
    vectorWeight: 1.0,
    rrfK: 60.0,
    recencyDecayEnabled: true,
    recencyHalflifeSecs: 30 * DAY,
    candidatePoolSize: 0,
    ...overrides,
  };
  window.tessera.sources.getHybridSearchConfig = vi
    .fn()
    .mockResolvedValue(base);
  window.tessera.sources.updateHybridSearchConfig = vi
    .fn()
    .mockImplementation(async (patch) => ({
      ...base,
      ...(patch.vectorWeight !== undefined && {
        vectorWeight: patch.vectorWeight,
      }),
      ...(patch.recencyDecayEnabled !== undefined && {
        recencyDecayEnabled: patch.recencyDecayEnabled,
      }),
      ...(patch.recencyHalflifeSecs !== undefined && {
        recencyHalflifeSecs: patch.recencyHalflifeSecs,
      }),
      ...(patch.recencyDecayEnabled === false && {
        recencyHalflifeSecs: null,
      }),
    }));
  return base;
}

describe("HybridSearchCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders the Search heading and reads the live config on mount", async () => {
    seedConfig();
    render(<HybridSearchCard />);
    expect(
      await screen.findByRole("heading", { name: "Search" }),
    ).toBeInTheDocument();
    expect(window.tessera.sources.getHybridSearchConfig).toHaveBeenCalledTimes(
      1,
    );
    // Slider shows the 30-day default once the config loads.
    await waitFor(() => {
      expect(screen.getByText(/30 days/i)).toBeInTheDocument();
    });
  });

  it("starts with hybrid mode ON when vectorWeight > 0", async () => {
    seedConfig({ vectorWeight: 1.0 });
    render(<HybridSearchCard />);
    const toggle = (await screen.findByTestId(
      "hybrid-mode-toggle",
    )) as HTMLInputElement;
    expect(toggle.checked).toBe(true);
  });

  it("starts with hybrid mode OFF when vectorWeight == 0", async () => {
    seedConfig({ vectorWeight: 0 });
    render(<HybridSearchCard />);
    const toggle = (await screen.findByTestId(
      "hybrid-mode-toggle",
    )) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it("dragging the slider updates the day label without firing an IPC call", async () => {
    seedConfig();
    render(<HybridSearchCard />);
    const slider = (await screen.findByTestId(
      "hybrid-halflife-slider",
    )) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "7" } });
    expect(screen.getByText(/7 days/i)).toBeInTheDocument();
    expect(
      window.tessera.sources.updateHybridSearchConfig,
    ).not.toHaveBeenCalled();
  });

  it("clicking Save sends a patch to the bridge with the slider value in seconds", async () => {
    seedConfig();
    render(<HybridSearchCard />);
    const slider = (await screen.findByTestId(
      "hybrid-halflife-slider",
    )) as HTMLInputElement;
    fireEvent.change(slider, { target: { value: "14" } });
    const saveButton = screen.getByTestId("hybrid-save");
    fireEvent.click(saveButton);
    await waitFor(() => {
      expect(
        window.tessera.sources.updateHybridSearchConfig,
      ).toHaveBeenCalledWith(
        expect.objectContaining({
          recencyHalflifeSecs: 14 * DAY,
          recencyDecayEnabled: true,
          vectorWeight: 1.0,
        }),
      );
    });
  });

  it("toggling hybrid mode off then saving sends vectorWeight=0", async () => {
    seedConfig();
    render(<HybridSearchCard />);
    const toggle = await screen.findByTestId("hybrid-mode-toggle");
    fireEvent.click(toggle);
    fireEvent.click(screen.getByTestId("hybrid-save"));
    await waitFor(() => {
      expect(
        window.tessera.sources.updateHybridSearchConfig,
      ).toHaveBeenCalledWith(
        expect.objectContaining({ vectorWeight: 0 }),
      );
    });
  });

  it("toggling decay off disables the slider and skips recencyHalflifeSecs in the patch", async () => {
    seedConfig();
    render(<HybridSearchCard />);
    const decayToggle = await screen.findByTestId("hybrid-decay-toggle");
    fireEvent.click(decayToggle);
    expect(
      (screen.getByTestId("hybrid-halflife-slider") as HTMLInputElement)
        .disabled,
    ).toBe(true);
    fireEvent.click(screen.getByTestId("hybrid-save"));
    await waitFor(() => {
      const mockFn = vi.mocked(
        window.tessera.sources.updateHybridSearchConfig,
      );
      const lastCall = mockFn.mock.calls.at(-1);
      expect(lastCall).toBeDefined();
      const patch = lastCall![0] as {
        recencyDecayEnabled: boolean;
        recencyHalflifeSecs?: number;
      };
      expect(patch.recencyDecayEnabled).toBe(false);
      // Halflife omitted entirely so the bridge keeps its current
      // value; sending `undefined` would round-trip to `null` and
      // override.
      expect(patch.recencyHalflifeSecs).toBeUndefined();
    });
  });

  it("renders an error banner if the bridge call rejects on save", async () => {
    seedConfig();
    window.tessera.sources.updateHybridSearchConfig = vi
      .fn()
      .mockRejectedValue(new Error("rate-limited"));
    render(<HybridSearchCard />);
    await screen.findByTestId("hybrid-save");
    fireEvent.click(screen.getByTestId("hybrid-save"));
    await waitFor(() => {
      expect(screen.getByTestId("hybrid-error")).toHaveTextContent(
        "rate-limited",
      );
    });
  });

  it("seeds the slider with a sensible day count when the bridge returns null halflife (decay disabled)", async () => {
    seedConfig({ recencyDecayEnabled: false, recencyHalflifeSecs: null });
    render(<HybridSearchCard />);
    // The slider should show the documented 30-day default so the
    // control isn't blank when the user toggles decay back on.
    await waitFor(() => {
      expect(screen.getByText(/30 days/i)).toBeInTheDocument();
    });
    const toggle = (await screen.findByTestId(
      "hybrid-decay-toggle",
    )) as HTMLInputElement;
    expect(toggle.checked).toBe(false);
  });

  it("shows a friendly error banner if the initial config read rejects, but still renders the form with defaults", async () => {
    window.tessera.sources.getHybridSearchConfig = vi
      .fn()
      .mockRejectedValue(new Error("bridge offline"));
    render(<HybridSearchCard />);
    await waitFor(() => {
      expect(screen.getByTestId("hybrid-error")).toHaveTextContent(
        "bridge offline",
      );
    });
    expect(screen.getByTestId("hybrid-mode-toggle")).toBeInTheDocument();
    expect(screen.getByText(/30 days/i)).toBeInTheDocument();
  });
});
