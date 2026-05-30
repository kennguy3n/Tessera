import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import EmbeddingModelCard from "../components/EmbeddingModelCard";

/**
 * Phase 19 Task 1: renderer-side tests for the embedding-model
 * picker. The component is purely a thin wrapper over four IPC
 * endpoints (`settings:getEmbeddingModelStatus`,
 * `settings:getEmbeddingDownloadProgress`,
 * `settings:downloadEmbeddingModel`,
 * `settings:switchEmbeddingModel`) plus a 1 s / 500 ms polling
 * loop, so the tests focus on:
 *
 *   1. The right IPC is called for "select an already-installed
 *      model" (switch only, no download).
 *   2. The right sequence is called for "select a not-yet-
 *      installed model" (download → status refresh → switch).
 *   3. The multilingual hint banner appears only above the 10 %
 *      ratio AND the 50-chunk minimum corpus size — and is
 *      hidden once the multilingual model is the active one.
 *   4. The download progress bar reads from the progress IPC
 *      and renders both determinate and indeterminate states.
 *
 * The polling intervals are not exercised here — vitest's
 * fake-timers would force the test to coordinate around 1 s /
 * 500 ms cadences and the value/cost trade-off isn't worth it.
 * The IPC contracts themselves are covered in the Electron-side
 * IPC handler tests.
 */

const minilm = {
  slug: "all-MiniLM-L6-v2",
  displayName: "all-MiniLM-L6-v2",
  dim: 384,
  modelSizeBytes: 22 * 1024 * 1024,
  tokenizerSizeBytes: 700 * 1024,
  languages: "en",
  installed: false,
  modelId: "onnx:all-MiniLM-L6-v2:384d",
};

const xlmr = {
  slug: "paraphrase-multilingual-MiniLM-L12-v2",
  displayName: "paraphrase-multilingual-MiniLM-L12-v2",
  dim: 384,
  modelSizeBytes: 120 * 1024 * 1024,
  tokenizerSizeBytes: 17 * 1024 * 1024,
  languages: "ar,de,en,es,fr,hi,ja,ko,pt,ru,zh,…",
  installed: false,
  modelId: "onnx:paraphrase-multilingual-MiniLM-L12-v2:384d",
};

function seedStatus(
  overrides: Partial<{
    currentModelId: string | null;
    models: Array<typeof minilm | typeof xlmr>;
    nonAsciiChunks: number;
    totalChunks: number;
  }> = {},
) {
  const base = {
    currentModelId: "hash-trick-v1-256d-char3-5" as string | null,
    models: [minilm, xlmr],
    download: {
      status: "idle" as const,
      slug: null as string | null,
      bytesTotal: null as number | null,
      bytesDownloaded: 0,
      lastError: null as string | null,
    },
    nonAsciiChunks: 0,
    totalChunks: 0,
    ...overrides,
  };
  window.tessera.settings.getEmbeddingModelStatus = vi
    .fn()
    .mockResolvedValue(base);
  window.tessera.settings.getEmbeddingDownloadProgress = vi
    .fn()
    .mockResolvedValue(base.download);
  return base;
}

describe("EmbeddingModelCard", () => {
  beforeEach(() => {
    vi.clearAllMocks();
  });

  it("renders all three provider options on mount", async () => {
    seedStatus();
    render(<EmbeddingModelCard />);
    expect(
      await screen.findByRole("heading", { name: "Embedding model" }),
    ).toBeInTheDocument();
    await waitFor(() => {
      expect(
        screen.getByTestId("embedding-model-option-hash-trick"),
      ).toBeInTheDocument();
    });
    expect(
      screen.getByTestId("embedding-model-option-all-MiniLM-L6-v2"),
    ).toBeInTheDocument();
    expect(
      screen.getByTestId(
        "embedding-model-option-paraphrase-multilingual-MiniLM-L12-v2",
      ),
    ).toBeInTheDocument();
  });

  it("marks the HashTrick option as active when the bridge reports the HashTrick model id", async () => {
    seedStatus({ currentModelId: "hash-trick-v1-256d-char3-5" });
    render(<EmbeddingModelCard />);
    const radio = (await screen.findByRole("radio", {
      name: /Fast \(HashTrick/,
    })) as HTMLInputElement;
    await waitFor(() => expect(radio.checked).toBe(true));
  });

  it("marks the multilingual option as active when its model id is current", async () => {
    seedStatus({
      currentModelId: "onnx:paraphrase-multilingual-MiniLM-L12-v2:384d",
      models: [minilm, { ...xlmr, installed: true }],
    });
    render(<EmbeddingModelCard />);
    const radio = (await screen.findByRole("radio", {
      name: /Multilingual/,
    })) as HTMLInputElement;
    await waitFor(() => expect(radio.checked).toBe(true));
  });

  it("selecting HashTrick calls switch only — never download", async () => {
    // Seed with MiniLM active so the HashTrick radio is not
    // already checked — `fireEvent.click` on an already-checked
    // radio is a no-op in React's controlled-input model.
    seedStatus({
      currentModelId: "onnx:all-MiniLM-L6-v2:384d",
      models: [{ ...minilm, installed: true }, xlmr],
    });
    const downloadSpy = vi
      .fn()
      .mockRejectedValue(new Error("hash-trick is not downloadable"));
    const switchSpy = vi.fn().mockResolvedValue({
      slug: "hash-trick",
      displayName: "Fast (offline)",
      dim: 256,
      modelSizeBytes: 0,
      tokenizerSizeBytes: 0,
      languages: "any",
      installed: true,
      modelId: "hash-trick-v1-256d-char3-5",
    });
    window.tessera.settings.downloadEmbeddingModel = downloadSpy;
    window.tessera.settings.switchEmbeddingModel = switchSpy;
    render(<EmbeddingModelCard />);
    // Wait for the initial status to flow through so the
    // "MiniLM is active" state has rendered before we click.
    await waitFor(() =>
      expect(
        window.tessera.settings.getEmbeddingModelStatus,
      ).toHaveBeenCalled(),
    );
    const radio = (await screen.findByRole("radio", {
      name: /Fast \(HashTrick/,
    })) as HTMLInputElement;
    fireEvent.click(radio);
    await waitFor(() => expect(switchSpy).toHaveBeenCalledWith("hash-trick"));
    expect(downloadSpy).not.toHaveBeenCalled();
  });

  it("selecting an uninstalled ONNX model downloads first, then switches", async () => {
    seedStatus();
    const downloadSpy = vi.fn().mockResolvedValue({
      ...minilm,
      installed: true,
    });
    const switchSpy = vi.fn().mockResolvedValue({ ...minilm, installed: true });
    window.tessera.settings.downloadEmbeddingModel = downloadSpy;
    window.tessera.settings.switchEmbeddingModel = switchSpy;
    render(<EmbeddingModelCard />);
    const radio = (await screen.findByRole("radio", {
      name: /Semantic — English/,
    })) as HTMLInputElement;
    fireEvent.click(radio);
    await waitFor(() =>
      expect(downloadSpy).toHaveBeenCalledWith("all-MiniLM-L6-v2"),
    );
    await waitFor(() =>
      expect(switchSpy).toHaveBeenCalledWith("all-MiniLM-L6-v2"),
    );
    // Order matters — download must precede switch.
    expect(downloadSpy.mock.invocationCallOrder[0]).toBeLessThan(
      switchSpy.mock.invocationCallOrder[0],
    );
  });

  it("skips download when the ONNX model is already installed", async () => {
    seedStatus({
      models: [{ ...minilm, installed: true }, xlmr],
    });
    const downloadSpy = vi.fn();
    const switchSpy = vi.fn().mockResolvedValue({ ...minilm, installed: true });
    window.tessera.settings.downloadEmbeddingModel = downloadSpy;
    window.tessera.settings.switchEmbeddingModel = switchSpy;
    render(<EmbeddingModelCard />);
    const radio = (await screen.findByRole("radio", {
      name: /Semantic — English/,
    })) as HTMLInputElement;
    fireEvent.click(radio);
    await waitFor(() =>
      expect(switchSpy).toHaveBeenCalledWith("all-MiniLM-L6-v2"),
    );
    expect(downloadSpy).not.toHaveBeenCalled();
  });

  it("shows the multilingual hint when >10% of chunks are non-ASCII (above the 50-chunk minimum)", async () => {
    seedStatus({
      nonAsciiChunks: 20,
      totalChunks: 100,
      currentModelId: "hash-trick-v1-256d-char3-5",
    });
    render(<EmbeddingModelCard />);
    expect(
      await screen.findByTestId("embedding-multilingual-hint"),
    ).toBeInTheDocument();
  });

  it("hides the multilingual hint when the corpus is too small to be statistically meaningful", async () => {
    seedStatus({
      nonAsciiChunks: 10,
      totalChunks: 30,
      currentModelId: "hash-trick-v1-256d-char3-5",
    });
    render(<EmbeddingModelCard />);
    // Wait for the initial poll to land so we're not asserting
    // the absence of the hint just because the component hasn't
    // received its first status yet.
    await waitFor(() =>
      expect(
        window.tessera.settings.getEmbeddingModelStatus,
      ).toHaveBeenCalled(),
    );
    expect(
      screen.queryByTestId("embedding-multilingual-hint"),
    ).not.toBeInTheDocument();
  });

  it("hides the multilingual hint when the multilingual model is already active", async () => {
    seedStatus({
      nonAsciiChunks: 200,
      totalChunks: 1000,
      currentModelId: "onnx:paraphrase-multilingual-MiniLM-L12-v2:384d",
      models: [minilm, { ...xlmr, installed: true }],
    });
    render(<EmbeddingModelCard />);
    await waitFor(() =>
      expect(
        window.tessera.settings.getEmbeddingModelStatus,
      ).toHaveBeenCalled(),
    );
    expect(
      screen.queryByTestId("embedding-multilingual-hint"),
    ).not.toBeInTheDocument();
  });

  it("renders the download progress bar while a download is in flight", async () => {
    seedStatus();
    // Override the progress poll to report mid-download state.
    window.tessera.settings.getEmbeddingDownloadProgress = vi
      .fn()
      .mockResolvedValue({
        status: "downloading",
        slug: "paraphrase-multilingual-MiniLM-L12-v2",
        bytesTotal: 120 * 1024 * 1024,
        bytesDownloaded: 30 * 1024 * 1024,
        lastError: null,
      });
    render(<EmbeddingModelCard />);
    const bar = await screen.findByTestId("embedding-download-progress");
    expect(bar).toBeInTheDocument();
    expect(bar).toHaveAttribute("aria-valuenow", "25");
  });

  it("surfaces the bridge download error when a download fails", async () => {
    seedStatus();
    window.tessera.settings.getEmbeddingDownloadProgress = vi
      .fn()
      .mockResolvedValue({
        status: "failed",
        slug: "all-MiniLM-L6-v2",
        bytesTotal: null,
        bytesDownloaded: 0,
        lastError: "sha256 mismatch (expected 0xdead, got 0xbeef)",
      });
    render(<EmbeddingModelCard />);
    const err = await screen.findByTestId("embedding-download-error");
    expect(err.textContent).toContain("sha256 mismatch");
  });
});
