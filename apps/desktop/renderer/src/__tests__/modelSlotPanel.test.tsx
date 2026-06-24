/**
 * Tests for `ModelSlotPanel` — the per-capability install / recommend
 * / delete card used by Settings → Models for the vision and imagegen
 * slots.
 *
 * The component re-uses every pattern from `ModelRuntimeCard`'s
 * text-slot path (refresh-on-mount, 5s poll, busy-gated optimistic
 * updates, capability-scoped onDownloadProgress filtering), so these
 * tests focus on the BEHAVIOUR that's specific to the slot panel:
 *
 *   - It calls `listModels(capability)` / `recommendModel(capability)`
 *     / `getCurrentModel(capability)` with the capability prop
 *     (not the bare text overload).
 *   - It IGNORES `onDownloadProgress` events whose `capability` field
 *     doesn't match its own slot — otherwise a text-slot download
 *     would paint into a vision-slot progress bar.
 *   - It re-fetches `getCurrentModel(capability)` after both
 *     successful and failed downloads / deletes so `state.current`
 *     matches on-disk truth on every settled boundary.
 *   - It does NOT render Start / Stop buttons (vision and imagegen
 *     sidecars start lazily — see the component docstring).
 *
 * Where the test crafts a custom `api` it spreads from
 * `window.tessera` so any new IPC channel added to the bridge in
 * future work shows up here too (no need to thread it through every
 * test by hand).
 */
import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import ModelSlotPanel from "../components/ModelSlotPanel";
import type {
  InstalledModelRecord,
  ModelDownloadProgress,
  ResolvedModel,
} from "../types/ipc";

function makeResolved(
  partial: Partial<ResolvedModel> & { id: string; name: string },
): ResolvedModel {
  return {
    id: partial.id,
    name: partial.name,
    parameters: partial.parameters ?? "3B",
    capability: partial.capability ?? "vision",
    format: partial.format ?? "gguf",
    formatLabel: partial.formatLabel ?? "GGUF Q4_K_M",
    quantization: partial.quantization ?? "Q4_K_M",
    platform: partial.platform ?? "linux-x64",
    tier: partial.tier ?? "medium",
    computeBackends: partial.computeBackends ?? ["cpu"],
    downloadSizeMb: partial.downloadSizeMb ?? 1800,
    diskSizeMb: partial.diskSizeMb ?? 1800,
    requiredRamGb: partial.requiredRamGb ?? 8,
    contextLength: partial.contextLength ?? 4096,
    filename: partial.filename ?? "test.gguf",
    url: partial.url ?? "https://example.invalid/test.gguf",
    sha256: partial.sha256 ?? "0".repeat(64),
    mmprojFilename: partial.mmprojFilename,
    mmprojUrl: partial.mmprojUrl,
    mmprojSha256: partial.mmprojSha256,
    mmprojSizeMb: partial.mmprojSizeMb,
  };
}

function makeRecord(
  partial: Partial<InstalledModelRecord> & { modelId: string },
): InstalledModelRecord {
  return {
    modelId: partial.modelId,
    capability: partial.capability ?? "vision",
    format: partial.format ?? "gguf",
    filename: partial.filename ?? "test.gguf",
    path: partial.path ?? "/tmp/test.gguf",
    downloadSizeMb: partial.downloadSizeMb ?? 1800,
    diskSizeMb: partial.diskSizeMb ?? 1800,
    sha256: partial.sha256 ?? "0".repeat(64),
    downloadedAt: partial.downloadedAt ?? "2025-01-01T00:00:00Z",
    mmprojPath: partial.mmprojPath,
    mmprojSha256: partial.mmprojSha256,
    mmprojSizeMb: partial.mmprojSizeMb,
  };
}

describe("ModelSlotPanel — capability-scoped IPC", () => {
  it("calls listModels / recommendModel / getCurrentModel with the capability prop", async () => {
    const listMock = vi.fn().mockResolvedValue([]);
    const recommendMock = vi.fn().mockResolvedValue(null);
    const currentMock = vi.fn().mockResolvedValue(null);
    const api = {
      ...window.tessera,
      runtime: {
        ...window.tessera.runtime,
        listModels: listMock,
        recommendModel: recommendMock,
        getCurrentModel: currentMock,
      },
    } as Window["tessera"];

    render(
      <ModelSlotPanel
        capability="vision"
        title="Vision model"
        testIdPrefix="vision-slot"
        api={api}
      />,
    );

    await waitFor(() => {
      expect(listMock).toHaveBeenCalledWith("vision");
      expect(recommendMock).toHaveBeenCalledWith("vision");
      expect(currentMock).toHaveBeenCalledWith("vision");
    });
  });

  it("passes capability=imagegen to all runtime calls when used for the imagegen slot", async () => {
    const listMock = vi.fn().mockResolvedValue([]);
    const recommendMock = vi.fn().mockResolvedValue(null);
    const currentMock = vi.fn().mockResolvedValue(null);
    const api = {
      ...window.tessera,
      runtime: {
        ...window.tessera.runtime,
        listModels: listMock,
        recommendModel: recommendMock,
        getCurrentModel: currentMock,
      },
    } as Window["tessera"];

    render(
      <ModelSlotPanel
        capability="imagegen"
        title="Image-generation model"
        testIdPrefix="imagegen-slot"
        api={api}
      />,
    );

    await waitFor(() => {
      expect(listMock).toHaveBeenCalledWith("imagegen");
      expect(recommendMock).toHaveBeenCalledWith("imagegen");
      expect(currentMock).toHaveBeenCalledWith("imagegen");
    });
  });
});

describe("ModelSlotPanel — recommended / installed rendering", () => {
  it("renders the recommended model when getCurrentModel returns null", async () => {
    const rec = makeResolved({ id: "vis-1", name: "VisionModel-1" });
    const api = {
      ...window.tessera,
      runtime: {
        ...window.tessera.runtime,
        listModels: vi.fn().mockResolvedValue([rec]),
        recommendModel: vi.fn().mockResolvedValue(rec),
        getCurrentModel: vi.fn().mockResolvedValue(null),
      },
    } as Window["tessera"];

    render(
      <ModelSlotPanel
        capability="vision"
        title="Vision model"
        testIdPrefix="vision-slot"
        api={api}
      />,
    );

    await screen.findByTestId("vision-slot-recommended");
    expect(screen.getByTestId("vision-slot-download")).toBeInTheDocument();
    expect(screen.queryByTestId("vision-slot-current")).not.toBeInTheDocument();
    expect(screen.queryByTestId("vision-slot-delete")).not.toBeInTheDocument();
  });

  it("renders Installed + Delete when getCurrentModel returns a record", async () => {
    const cur = makeRecord({ modelId: "vis-1" });
    const api = {
      ...window.tessera,
      runtime: {
        ...window.tessera.runtime,
        listModels: vi.fn().mockResolvedValue([]),
        recommendModel: vi.fn().mockResolvedValue(null),
        getCurrentModel: vi.fn().mockResolvedValue(cur),
      },
    } as Window["tessera"];

    render(
      <ModelSlotPanel
        capability="vision"
        title="Vision model"
        testIdPrefix="vision-slot"
        api={api}
      />,
    );

    await screen.findByTestId("vision-slot-current");
    expect(screen.getByText(/vis-1/)).toBeInTheDocument();
    expect(screen.getByTestId("vision-slot-delete")).toBeInTheDocument();
  });

  it("renders the projector path when InstalledModelRecord has an mmprojPath", async () => {
    const cur = makeRecord({
      modelId: "vis-1",
      mmprojPath: "/tmp/mmproj.gguf",
    });
    const api = {
      ...window.tessera,
      runtime: {
        ...window.tessera.runtime,
        getCurrentModel: vi.fn().mockResolvedValue(cur),
      },
    } as Window["tessera"];

    render(
      <ModelSlotPanel
        capability="vision"
        title="Vision model"
        testIdPrefix="vision-slot"
        api={api}
      />,
    );

    await screen.findByTestId("vision-slot-mmproj");
    expect(screen.getByTestId("vision-slot-mmproj").textContent).toMatch(
      /mmproj\.gguf/,
    );
  });

  it("never renders Start / Stop buttons regardless of installed state", async () => {
    const cur = makeRecord({ modelId: "vis-1" });
    const api = {
      ...window.tessera,
      runtime: {
        ...window.tessera.runtime,
        getCurrentModel: vi.fn().mockResolvedValue(cur),
      },
    } as Window["tessera"];

    render(
      <ModelSlotPanel
        capability="vision"
        title="Vision model"
        testIdPrefix="vision-slot"
        api={api}
      />,
    );

    await screen.findByTestId("vision-slot-current");
    expect(
      screen.queryByRole("button", { name: /^Start$/ }),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /^Stop$/ }),
    ).not.toBeInTheDocument();
  });
});

describe("ModelSlotPanel — onDownloadProgress filtering by capability", () => {
  it("renders progress for an event whose capability matches the slot", async () => {
    let listener: ((p: ModelDownloadProgress) => void) | null = null;
    const rec = makeResolved({ id: "vis-1", name: "VisionModel-1" });
    const api = {
      ...window.tessera,
      runtime: {
        ...window.tessera.runtime,
        listModels: vi.fn().mockResolvedValue([rec]),
        recommendModel: vi.fn().mockResolvedValue(rec),
        getCurrentModel: vi.fn().mockResolvedValue(null),
        downloadModel: vi.fn(
          () =>
            // Hold the promise open so `busyModelId` stays set
            // and the progress bar gets a chance to render.
            new Promise<InstalledModelRecord>(() => {
              /* never resolves in this test */
            }),
        ),
        onDownloadProgress: vi.fn((cb) => {
          listener = cb;
          return () => {
            listener = null;
          };
        }),
      },
    } as Window["tessera"];

    render(
      <ModelSlotPanel
        capability="vision"
        title="Vision model"
        testIdPrefix="vision-slot"
        api={api}
      />,
    );

    const downloadBtn = await screen.findByTestId("vision-slot-download");
    fireEvent.click(downloadBtn);

    await waitFor(() => {
      expect(listener).not.toBeNull();
    });
    // Vision-capability event — should render.
    listener!({
      modelId: "vis-1",
      capability: "vision",
      format: "gguf",
      filename: "vis.gguf",
      downloadedMb: 100,
      totalMb: 1800,
      percent: 5.5,
    });
    await screen.findByTestId("vision-slot-progress");
    expect(screen.getByTestId("vision-slot-progress").textContent).toMatch(
      /vis\.gguf/,
    );
  });

  it("IGNORES progress events whose capability is different from the slot", async () => {
    let listener: ((p: ModelDownloadProgress) => void) | null = null;
    const rec = makeResolved({ id: "vis-1", name: "VisionModel-1" });
    const api = {
      ...window.tessera,
      runtime: {
        ...window.tessera.runtime,
        listModels: vi.fn().mockResolvedValue([rec]),
        recommendModel: vi.fn().mockResolvedValue(rec),
        getCurrentModel: vi.fn().mockResolvedValue(null),
        downloadModel: vi.fn(
          () =>
            new Promise<InstalledModelRecord>(() => {
              /* never resolves */
            }),
        ),
        onDownloadProgress: vi.fn((cb) => {
          listener = cb;
          return () => {
            listener = null;
          };
        }),
      },
    } as Window["tessera"];

    render(
      <ModelSlotPanel
        capability="vision"
        title="Vision model"
        testIdPrefix="vision-slot"
        api={api}
      />,
    );

    const downloadBtn = await screen.findByTestId("vision-slot-download");
    fireEvent.click(downloadBtn);

    await waitFor(() => {
      expect(listener).not.toBeNull();
    });
    // Text-capability event landing on the vision slot — MUST be ignored.
    listener!({
      modelId: "text-1",
      capability: "text",
      format: "gguf",
      filename: "text.gguf",
      downloadedMb: 200,
      totalMb: 4000,
      percent: 5,
    });
    // Imagegen-capability event landing on the vision slot — MUST be ignored.
    listener!({
      modelId: "imagegen-1",
      capability: "imagegen",
      format: "gguf",
      filename: "sd.gguf",
      downloadedMb: 300,
      totalMb: 6000,
      percent: 5,
    });
    // Give React a chance to schedule a render if the filter is broken.
    await new Promise((r) => setTimeout(r, 30));
    expect(
      screen.queryByTestId("vision-slot-progress"),
    ).not.toBeInTheDocument();
  });
});

describe("ModelSlotPanel — settled-boundary re-fetch of getCurrentModel", () => {
  it("re-fetches getCurrentModel after a successful download so the live record lands in state", async () => {
    const rec = makeResolved({ id: "vis-1", name: "VisionModel-1" });
    const installedFromDownload = makeRecord({ modelId: "vis-1" });
    const installedFromLive = makeRecord({
      modelId: "vis-1",
      // A different field so the test can distinguish which one
      // the UI ended up rendering. The component MUST prefer
      // `liveCurrent` over the synchronous downloadModel return.
      path: "/tmp/live-truth.gguf",
    });
    const getCurrentSeq = vi
      .fn<[unknown?], Promise<InstalledModelRecord | null>>()
      .mockResolvedValueOnce(null) // initial mount
      .mockResolvedValueOnce(installedFromLive); // post-download re-fetch
    const api = {
      ...window.tessera,
      runtime: {
        ...window.tessera.runtime,
        listModels: vi.fn().mockResolvedValue([rec]),
        recommendModel: vi.fn().mockResolvedValue(rec),
        getCurrentModel: getCurrentSeq,
        downloadModel: vi.fn().mockResolvedValue(installedFromDownload),
      },
    } as Window["tessera"];

    render(
      <ModelSlotPanel
        capability="vision"
        title="Vision model"
        testIdPrefix="vision-slot"
        api={api}
      />,
    );

    const downloadBtn = await screen.findByTestId("vision-slot-download");
    fireEvent.click(downloadBtn);

    await screen.findByTestId("vision-slot-current");
    expect(screen.getByText(/live-truth\.gguf/)).toBeInTheDocument();
    // getCurrentModel called twice: mount + post-download.
    expect(getCurrentSeq).toHaveBeenCalledTimes(2);
    expect(getCurrentSeq).toHaveBeenNthCalledWith(1, "vision");
    expect(getCurrentSeq).toHaveBeenNthCalledWith(2, "vision");
  });

  it("re-fetches getCurrentModel after a failed download so the renderer sees the post-eviction truth", async () => {
    const oldRec = makeRecord({
      modelId: "vis-old",
      path: "/tmp/old.gguf",
    });
    const rec = makeResolved({ id: "vis-new", name: "VisionModel-New" });
    // After the failed swap, the main process has evicted the old
    // record, so getCurrentModel resolves to `null`. The renderer
    // MUST surface that — not the stale pre-swap record.
    const getCurrentSeq = vi
      .fn<[unknown?], Promise<InstalledModelRecord | null>>()
      .mockResolvedValueOnce(oldRec) // initial mount
      .mockResolvedValueOnce(null); // post-failure re-fetch
    const api = {
      ...window.tessera,
      runtime: {
        ...window.tessera.runtime,
        listModels: vi.fn().mockResolvedValue([rec]),
        recommendModel: vi.fn().mockResolvedValue(rec),
        getCurrentModel: getCurrentSeq,
        downloadModel: vi
          .fn()
          .mockRejectedValue(new Error("checksum mismatch")),
      },
    } as Window["tessera"];

    render(
      <ModelSlotPanel
        capability="vision"
        title="Vision model"
        testIdPrefix="vision-slot"
        api={api}
      />,
    );

    // Initial render shows the old record.
    await screen.findByText(/old\.gguf/);

    // The download UI is hidden once `current` is populated, so we
    // click the swap button on the "all models" list instead.
    fireEvent.click(screen.getByTestId("vision-slot-toggle-all"));
    const swap = await screen.findByRole("button", { name: /Swap/i });
    fireEvent.click(swap);

    // The failure path should surface the error AND clear
    // `state.current` because the re-fetch returned null.
    await waitFor(() => {
      expect(screen.getByTestId("vision-slot-error").textContent).toMatch(
        /checksum mismatch/,
      );
    });
    expect(screen.queryByTestId("vision-slot-current")).not.toBeInTheDocument();
  });

  it("re-fetches getCurrentModel after a successful delete", async () => {
    const cur = makeRecord({ modelId: "vis-1" });
    const getCurrentSeq = vi
      .fn<[unknown?], Promise<InstalledModelRecord | null>>()
      .mockResolvedValueOnce(cur) // mount
      .mockResolvedValueOnce(null); // post-delete
    const deleteMock = vi.fn().mockResolvedValue(undefined);
    const api = {
      ...window.tessera,
      runtime: {
        ...window.tessera.runtime,
        getCurrentModel: getCurrentSeq,
        deleteModel: deleteMock,
      },
    } as Window["tessera"];

    render(
      <ModelSlotPanel
        capability="vision"
        title="Vision model"
        testIdPrefix="vision-slot"
        api={api}
      />,
    );

    const deleteBtn = await screen.findByTestId("vision-slot-delete");
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledWith("vision");
    });
    await waitFor(() => {
      expect(
        screen.queryByTestId("vision-slot-current"),
      ).not.toBeInTheDocument();
    });
  });
});

describe("ModelSlotPanel — render falls back gracefully without the bridge", () => {
  it("renders a placeholder Card if the bridge is unavailable", () => {
    // The component's `if (!tessera)` branch is defensive — in
    // production the preload guarantees `window.tessera` exists.
    // `setup.ts` installs `window.tessera` as `writable: true`
    // but non-configurable, so the property can't be deleted; we
    // assign `undefined` instead and restore the original
    // afterwards so other tests in the same file (and run) keep
    // their bridge.
    const orig = window.tessera;
    (window as { tessera?: Window["tessera"] }).tessera = undefined;
    try {
      render(
        <ModelSlotPanel
          capability="vision"
          title="Vision model"
          testIdPrefix="vision-slot"
        />,
      );
      expect(screen.getByText("Bridge unavailable.")).toBeInTheDocument();
    } finally {
      window.tessera = orig;
    }
  });
});
