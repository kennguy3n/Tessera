/**
 * ModelDownloadBanner tests.
 *
 * Coverage:
 *   1. Renders nothing on an already-onboarded install (no auto-start).
 *   2. Fresh install with auto-download enabled and no text model
 *      installed → triggers `runtime.downloadModel(recommended)` and
 *      shows the downloading state.
 *   3. Progress events update the visible percentage.
 *   4. A resolved download surfaces the "AI model ready" state.
 *   5. A rejected download surfaces the failure state + Retry, and
 *      Retry re-invokes the download.
 *   6. Skip dismisses the banner.
 *   7. Auto-download is suppressed when the preference is off.
 *
 * `useSettings` is mocked so each test controls the fresh-install
 * preconditions deterministically without driving the settings IPC.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  act,
  render,
  screen,
  fireEvent,
  waitFor,
} from "@testing-library/react";
import type { SettingsData, ModelDownloadProgress } from "../../../shared/types";
import ModelDownloadBanner from "../components/ModelDownloadBanner";

let bannerSettings: Partial<SettingsData> = {};
vi.mock("../hooks/useSettings", () => ({
  useSettings: () => ({
    settings: bannerSettings as SettingsData,
    loading: false,
    error: null,
    refresh: vi.fn(),
  }),
  __resetSettingsStoreForTests: vi.fn(),
}));

const recommended = {
  id: "text-model-v1",
  name: "Text Model",
  capability: "text",
};

function emitProgress(
  cb: (p: ModelDownloadProgress) => void,
  percent: number,
) {
  cb({
    modelId: "text-model-v1",
    capability: "text",
    format: "gguf",
    filename: "model.gguf",
    downloadedMb: percent,
    totalMb: 100,
    percent,
  } as ModelDownloadProgress);
}

describe("ModelDownloadBanner", () => {
  beforeEach(() => {
    bannerSettings = { onboardingCompleted: true, autoDownloadModel: true };
    window.tessera.runtime.recommendModel = vi
      .fn()
      .mockResolvedValue(recommended);
    window.tessera.runtime.getCurrentModel = vi.fn().mockResolvedValue(null);
    window.tessera.runtime.downloadModel = vi
      .fn()
      .mockReturnValue(new Promise(() => {}));
    window.tessera.runtime.onDownloadProgress = vi
      .fn()
      .mockReturnValue(() => undefined);
  });

  it("renders nothing for an already-onboarded install", async () => {
    render(<ModelDownloadBanner />);
    // Give the (suppressed) effects a tick to run.
    await act(async () => {
      await Promise.resolve();
    });
    expect(
      screen.queryByTestId("model-download-banner"),
    ).not.toBeInTheDocument();
    expect(window.tessera.runtime.downloadModel).not.toHaveBeenCalled();
  });

  it("auto-starts the recommended download on a fresh install", async () => {
    bannerSettings = { onboardingCompleted: false, autoDownloadModel: true };
    render(<ModelDownloadBanner />);
    await waitFor(() => {
      expect(window.tessera.runtime.downloadModel).toHaveBeenCalledWith(
        "text-model-v1",
      );
    });
    expect(
      screen.getByTestId("model-download-banner"),
    ).toHaveTextContent(/Setting up AI capabilities/);
  });

  it("does not auto-start when the preference is disabled", async () => {
    bannerSettings = { onboardingCompleted: false, autoDownloadModel: false };
    render(<ModelDownloadBanner />);
    await act(async () => {
      await Promise.resolve();
    });
    expect(window.tessera.runtime.downloadModel).not.toHaveBeenCalled();
    expect(
      screen.queryByTestId("model-download-banner"),
    ).not.toBeInTheDocument();
  });

  it("reflects download progress percentage", async () => {
    bannerSettings = { onboardingCompleted: false, autoDownloadModel: true };
    let emit: ((p: ModelDownloadProgress) => void) | null = null;
    window.tessera.runtime.onDownloadProgress = vi.fn((cb) => {
      emit = cb;
      return () => undefined;
    });

    render(<ModelDownloadBanner />);
    await waitFor(() => expect(emit).not.toBeNull());
    act(() => emitProgress(emit!, 42));

    expect(
      screen.getByTestId("model-download-banner"),
    ).toHaveTextContent("42%");
  });

  it("shows the ready state when the download resolves", async () => {
    bannerSettings = { onboardingCompleted: false, autoDownloadModel: true };
    window.tessera.runtime.downloadModel = vi.fn().mockResolvedValue({
      id: "text-model-v1",
    });

    render(<ModelDownloadBanner />);
    await waitFor(() => {
      expect(
        screen.getByTestId("model-download-banner"),
      ).toHaveTextContent("AI model ready");
    });
  });

  it("shows the failure state with a working Retry", async () => {
    bannerSettings = { onboardingCompleted: false, autoDownloadModel: true };
    window.tessera.runtime.downloadModel = vi
      .fn()
      .mockRejectedValueOnce(new Error("network"))
      .mockReturnValue(new Promise(() => {}));

    render(<ModelDownloadBanner />);
    await waitFor(() => {
      expect(
        screen.getByTestId("model-download-banner"),
      ).toHaveTextContent(/failed/i);
    });

    fireEvent.click(screen.getByTestId("model-download-banner-retry"));
    await waitFor(() => {
      expect(window.tessera.runtime.downloadModel).toHaveBeenCalledTimes(2);
    });
  });

  it("dismisses when Skip is clicked", async () => {
    bannerSettings = { onboardingCompleted: false, autoDownloadModel: true };
    render(<ModelDownloadBanner />);
    await waitFor(() =>
      expect(screen.getByTestId("model-download-banner")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByTestId("model-download-banner-skip"));
    expect(
      screen.queryByTestId("model-download-banner"),
    ).not.toBeInTheDocument();
  });
});
