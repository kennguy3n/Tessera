/**
 * ModelDownloadBanner tests (Session 5, Step 2 + Step 6).
 *
 * The banner is now a pure OBSERVER — the first-launch auto-download is
 * triggered in the main process (`autoModelDownload.ts`), so the banner
 * never initiates a download on mount. These tests therefore drive the
 * banner entirely through the `runtime:downloadProgress` /
 * `runtime:downloadError` IPC events it subscribes to.
 *
 * Coverage:
 *   1. Renders nothing until a download event arrives (no auto-start).
 *   2. A progress event shows the downloading state + percentage.
 *   3. The size estimate is shown before the first byte (percent 0).
 *   4. A `percent >= 100` event surfaces the "AI ready" state.
 *   5. A `runtime:downloadError` event surfaces the failure state, and
 *      Retry calls `runtime.downloadRecommended("text")`.
 *   6. Skip dismisses the banner AND persists `autoDownloadModel:false`.
 *   7. The success state auto-dismisses after the timeout.
 *   8. `formatModelSize` formatting (unit).
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import type {
  ModelDownloadProgress,
  ModelDownloadError,
} from "../../../shared/types";
import ModelDownloadBanner from "../components/ModelDownloadBanner";
import { formatModelSize } from "../utils/formatModelSize";

const updateMock = vi.fn().mockResolvedValue(undefined);
vi.mock("../hooks/useSettings", () => ({
  useUpdateSetting: () => ({ update: updateMock, loading: false, error: null }),
}));

const recommended = {
  id: "text-model-v1",
  name: "Text Model",
  capability: "text",
  downloadSizeMb: 450,
};

function progress(percent: number): ModelDownloadProgress {
  return {
    modelId: "text-model-v1",
    capability: "text",
    format: "gguf",
    filename: "model.gguf",
    downloadedMb: (percent / 100) * 450,
    totalMb: 450,
    percent,
  } as ModelDownloadProgress;
}

describe("ModelDownloadBanner", () => {
  beforeEach(() => {
    updateMock.mockClear();
    window.tessera.runtime.recommendModel = vi
      .fn()
      .mockResolvedValue(recommended);
    window.tessera.runtime.downloadRecommended = vi
      .fn()
      .mockReturnValue(new Promise(() => {}));
    window.tessera.runtime.cancelDownload = vi.fn().mockResolvedValue(true);
    window.tessera.runtime.onDownloadProgress = vi
      .fn()
      .mockReturnValue(() => undefined);
    window.tessera.runtime.onDownloadError = vi
      .fn()
      .mockReturnValue(() => undefined);
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("renders nothing until a download event arrives", async () => {
    render(<ModelDownloadBanner />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      screen.queryByTestId("model-download-banner"),
    ).not.toBeInTheDocument();
    // It must NOT initiate a download itself.
    expect(window.tessera.runtime.downloadRecommended).not.toHaveBeenCalled();
  });

  it("shows the downloading state + percentage from a progress event", async () => {
    let emit: ((p: ModelDownloadProgress) => void) | null = null;
    window.tessera.runtime.onDownloadProgress = vi.fn((cb) => {
      emit = cb;
      return () => undefined;
    });

    render(<ModelDownloadBanner />);
    await waitFor(() => expect(emit).not.toBeNull());
    act(() => emit!(progress(42)));

    expect(screen.getByTestId("model-download-banner")).toHaveTextContent(
      "42%",
    );
  });

  it("shows the size estimate before the first byte (percent 0)", async () => {
    let emit: ((p: ModelDownloadProgress) => void) | null = null;
    window.tessera.runtime.onDownloadProgress = vi.fn((cb) => {
      emit = cb;
      return () => undefined;
    });

    render(<ModelDownloadBanner />);
    // Wait for the size probe to resolve so the estimate is populated.
    await waitFor(() =>
      expect(window.tessera.runtime.recommendModel).toHaveBeenCalled(),
    );
    await act(async () => {
      await Promise.resolve();
    });
    act(() => emit!(progress(0)));

    expect(screen.getByTestId("model-download-banner")).toHaveTextContent(
      /Downloading AI model \(~450 MB\)/,
    );
  });

  it("surfaces the ready state on a completion (>=100) event", async () => {
    let emit: ((p: ModelDownloadProgress) => void) | null = null;
    window.tessera.runtime.onDownloadProgress = vi.fn((cb) => {
      emit = cb;
      return () => undefined;
    });

    render(<ModelDownloadBanner />);
    await waitFor(() => expect(emit).not.toBeNull());
    act(() => emit!(progress(100)));

    expect(screen.getByTestId("model-download-banner")).toHaveTextContent(
      "AI ready",
    );
  });

  it("surfaces failure from a downloadError event and Retry re-installs", async () => {
    let emitErr: ((e: ModelDownloadError) => void) | null = null;
    window.tessera.runtime.onDownloadError = vi.fn((cb) => {
      emitErr = cb;
      return () => undefined;
    });

    render(<ModelDownloadBanner />);
    await waitFor(() => expect(emitErr).not.toBeNull());
    act(() =>
      emitErr!({
        capability: "text",
        modelId: "text-model-v1",
        message: "network",
      }),
    );

    expect(screen.getByTestId("model-download-banner")).toHaveTextContent(
      /failed/i,
    );

    fireEvent.click(screen.getByTestId("model-download-banner-retry"));
    await waitFor(() => {
      expect(window.tessera.runtime.downloadRecommended).toHaveBeenCalledWith(
        "text",
      );
    });
  });

  it("Skip cancels the in-flight download, dismisses, and persists autoDownloadModel:false", async () => {
    let emit: ((p: ModelDownloadProgress) => void) | null = null;
    window.tessera.runtime.onDownloadProgress = vi.fn((cb) => {
      emit = cb;
      return () => undefined;
    });

    render(<ModelDownloadBanner />);
    await waitFor(() => expect(emit).not.toBeNull());
    act(() => emit!(progress(20)));
    expect(screen.getByTestId("model-download-banner")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("model-download-banner-skip"));

    expect(
      screen.queryByTestId("model-download-banner"),
    ).not.toBeInTheDocument();
    // True cancellation: the in-flight transfer is aborted (text slot)…
    expect(window.tessera.runtime.cancelDownload).toHaveBeenCalledWith("text");
    // …and the opt-out is persisted so next launch does not auto-start.
    expect(updateMock).toHaveBeenCalledWith({ autoDownloadModel: false });
  });

  it("Skip still dismisses + opts out when cancellation rejects (already complete)", async () => {
    window.tessera.runtime.cancelDownload = vi
      .fn()
      .mockRejectedValue(new Error("nothing in flight"));
    let emit: ((p: ModelDownloadProgress) => void) | null = null;
    window.tessera.runtime.onDownloadProgress = vi.fn((cb) => {
      emit = cb;
      return () => undefined;
    });

    render(<ModelDownloadBanner />);
    await waitFor(() => expect(emit).not.toBeNull());
    act(() => emit!(progress(20)));

    fireEvent.click(screen.getByTestId("model-download-banner-skip"));

    // A rejected cancellation (download already finished) must not block
    // the dismissal or the durable opt-out.
    await waitFor(() =>
      expect(
        screen.queryByTestId("model-download-banner"),
      ).not.toBeInTheDocument(),
    );
    expect(updateMock).toHaveBeenCalledWith({ autoDownloadModel: false });
  });

  it("treats a Retry that Skip cancels as a cancellation, not a failure", async () => {
    // Retry owns a promise that we reject to simulate the cancellation
    // tearing down the in-flight transfer.
    let rejectRetry: (e: unknown) => void = () => {};
    window.tessera.runtime.downloadRecommended = vi.fn(
      () =>
        new Promise((_resolve, reject) => {
          rejectRetry = reject;
        }),
    );
    let emitErr: ((e: ModelDownloadError) => void) | null = null;
    window.tessera.runtime.onDownloadError = vi.fn((cb) => {
      emitErr = cb;
      return () => undefined;
    });

    render(<ModelDownloadBanner />);
    await waitFor(() => expect(emitErr).not.toBeNull());
    // Surface a failure so the Retry affordance is available, then Retry.
    act(() =>
      emitErr!({
        capability: "text",
        modelId: "text-model-v1",
        message: "network",
      }),
    );
    fireEvent.click(screen.getByTestId("model-download-banner-retry"));
    // Skip while the Retry is in flight: it cancels the download…
    fireEvent.click(screen.getByTestId("model-download-banner-skip"));
    expect(window.tessera.runtime.cancelDownload).toHaveBeenCalledWith("text");

    // …and the resulting rejection is classified as a deliberate cancel,
    // so it is swallowed cleanly: the banner stays dismissed and never
    // flips back to a "failed" UI.
    await act(async () => {
      rejectRetry(new Error("Download cancelled by user"));
      await Promise.resolve();
    });
    expect(
      screen.queryByTestId("model-download-banner"),
    ).not.toBeInTheDocument();
    expect(updateMock).toHaveBeenCalledWith({ autoDownloadModel: false });
  });

  it("auto-dismisses the ready state after the timeout", async () => {
    vi.useFakeTimers();
    let emit: ((p: ModelDownloadProgress) => void) | null = null;
    window.tessera.runtime.onDownloadProgress = vi.fn((cb) => {
      emit = cb;
      return () => undefined;
    });

    render(<ModelDownloadBanner />);
    // `render` already flushed effects (so `emit` is wired); flush the
    // size-probe microtask too. We avoid `waitFor` here because it polls
    // on faked timers and would never resolve.
    await act(async () => {
      await Promise.resolve();
    });
    act(() => emit!(progress(100)));
    expect(screen.getByTestId("model-download-banner")).toHaveTextContent(
      "AI ready",
    );

    act(() => {
      vi.advanceTimersByTime(5000);
    });
    expect(
      screen.queryByTestId("model-download-banner"),
    ).not.toBeInTheDocument();
  });
});

describe("formatModelSize", () => {
  it("formats MB and GB and degrades on bad input", () => {
    expect(formatModelSize(450)).toBe(" (~450 MB)");
    expect(formatModelSize(2048)).toBe(" (~2.0 GB)");
    expect(formatModelSize(null)).toBe("");
    expect(formatModelSize(0)).toBe("");
    expect(formatModelSize(Number.NaN)).toBe("");
    expect(formatModelSize(-10)).toBe("");
  });
});
