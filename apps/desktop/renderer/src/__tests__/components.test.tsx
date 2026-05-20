import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Sidebar from "../components/Sidebar";
import Button from "../components/Button";
import Card from "../components/Card";
import PageHeader from "../components/PageHeader";
import StatusBadge from "../components/StatusBadge";
import EmptyState from "../components/EmptyState";
import SearchInput from "../components/SearchInput";
import Modal from "../components/Modal";
import ModelRuntimeCard from "../components/ModelRuntimeCard";

describe("Sidebar", () => {
  it("renders all navigation links", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByText("Sources")).toBeInTheDocument();
    expect(screen.getByText("Create")).toBeInTheDocument();
    expect(screen.getByText("Templates")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("renders the Tessera brand", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    expect(screen.getByText("Tessera")).toBeInTheDocument();
    expect(screen.getByText("T")).toBeInTheDocument();
  });
});

describe("Button", () => {
  it("renders primary button by default", () => {
    render(<Button>Click me</Button>);
    const btn = screen.getByRole("button", { name: "Click me" });
    expect(btn).toHaveClass("btn-primary");
  });

  it("renders secondary variant", () => {
    render(<Button variant="secondary">Cancel</Button>);
    const btn = screen.getByRole("button", { name: "Cancel" });
    expect(btn).toHaveClass("btn-secondary");
  });

  it("renders danger variant", () => {
    render(<Button variant="danger">Delete</Button>);
    const btn = screen.getByRole("button", { name: "Delete" });
    expect(btn).toHaveClass("btn-danger");
  });

  it("fires onClick when clicked", () => {
    const handler = vi.fn();
    render(<Button onClick={handler}>Click</Button>);
    fireEvent.click(screen.getByRole("button", { name: "Click" }));
    expect(handler).toHaveBeenCalledOnce();
  });

  it("can be disabled", () => {
    render(<Button disabled>Disabled</Button>);
    expect(screen.getByRole("button", { name: "Disabled" })).toBeDisabled();
  });
});

describe("Card", () => {
  it("renders children", () => {
    render(<Card>Card content</Card>);
    expect(screen.getByText("Card content")).toBeInTheDocument();
  });

  it("is clickable when onClick provided", () => {
    const handler = vi.fn();
    render(<Card onClick={handler}>Clickable card</Card>);
    const card = screen.getByRole("button");
    fireEvent.click(card);
    expect(handler).toHaveBeenCalledOnce();
  });

  it("handles keyboard activation", () => {
    const handler = vi.fn();
    render(<Card onClick={handler}>Keyboard card</Card>);
    const card = screen.getByRole("button");
    fireEvent.keyDown(card, { key: "Enter" });
    expect(handler).toHaveBeenCalledOnce();
  });
});

describe("PageHeader", () => {
  it("renders title", () => {
    render(<PageHeader title="Page Title" />);
    expect(screen.getByText("Page Title")).toBeInTheDocument();
  });

  it("renders description when provided", () => {
    render(<PageHeader title="Title" description="Subtitle text" />);
    expect(screen.getByText("Subtitle text")).toBeInTheDocument();
  });

  it("renders actions when provided", () => {
    render(
      <PageHeader title="Title" actions={<button>Action</button>} />,
    );
    expect(screen.getByRole("button", { name: "Action" })).toBeInTheDocument();
  });
});

describe("StatusBadge", () => {
  it("renders status text", () => {
    render(<StatusBadge status="connected" />);
    expect(screen.getByText("connected")).toBeInTheDocument();
  });

  it("applies correct variant class", () => {
    const { container } = render(<StatusBadge status="error" />);
    expect(container.querySelector(".badge-error")).toBeInTheDocument();
  });

  it("uses custom variant when provided", () => {
    const { container } = render(
      <StatusBadge status="custom" variant="warning" />,
    );
    expect(container.querySelector(".badge-warning")).toBeInTheDocument();
  });
});

describe("EmptyState", () => {
  it("renders title and message", () => {
    render(<EmptyState title="No Data" message="Nothing here yet" />);
    expect(screen.getByText("No Data")).toBeInTheDocument();
    expect(screen.getByText("Nothing here yet")).toBeInTheDocument();
  });

  it("renders icon when provided", () => {
    render(<EmptyState icon="!" title="Empty" message="msg" />);
    expect(screen.getByText("!")).toBeInTheDocument();
  });

  it("renders action when provided", () => {
    render(
      <EmptyState
        title="Empty"
        message="msg"
        action={<button>Add</button>}
      />,
    );
    expect(screen.getByRole("button", { name: "Add" })).toBeInTheDocument();
  });
});

describe("SearchInput", () => {
  it("renders a search input", () => {
    render(<SearchInput placeholder="Search..." />);
    expect(screen.getByPlaceholderText("Search...")).toBeInTheDocument();
  });

  it("calls onSearch when typing", () => {
    const handler = vi.fn();
    render(<SearchInput onSearch={handler} />);
    const input = screen.getByRole("searchbox");
    fireEvent.change(input, { target: { value: "test" } });
    expect(handler).toHaveBeenCalledWith("test");
  });
});

describe("Modal", () => {
  it("renders nothing when closed", () => {
    render(
      <Modal isOpen={false} onClose={vi.fn()} title="Test">
        Content
      </Modal>,
    );
    expect(screen.queryByText("Test")).not.toBeInTheDocument();
  });

  it("renders content when open", () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} title="Test Modal">
        Modal body
      </Modal>,
    );
    expect(screen.getByText("Test Modal")).toBeInTheDocument();
    expect(screen.getByText("Modal body")).toBeInTheDocument();
  });

  it("calls onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={onClose} title="Test">
        Body
      </Modal>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("calls onClose when clicking overlay", () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={onClose} title="Test">
        Body
      </Modal>,
    );
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).toHaveBeenCalledOnce();
  });
});

describe("ModelRuntimeCard delete-from-non-running flow", () => {
  // Regression for Devin Review finding 3271137928: handleDelete used to
  // only refresh `model.status()` on the branch where the runtime was
  // running before delete. If the user clicked Delete while the runtime
  // was in any other state ("stopped", "error", a stale "running" whose
  // process crashed externally) we would clear `state.current` but leave
  // a stale status badge next to the now-empty "no model" panel. The fix
  // is to unconditionally re-pull `model.status()` after a successful
  // `runtime.deleteModel()` so the UI matches main-process truth.
  function buildApi(initial: {
    status: { available: boolean; modelName: string | null; status: string };
  }) {
    const statusMock = vi
      .fn()
      .mockResolvedValueOnce(initial.status)
      .mockResolvedValue({
        available: false,
        modelName: null,
        status: "stopped",
      });
    const deleteMock = vi.fn().mockResolvedValue(undefined);
    const stopMock = vi.fn().mockResolvedValue(undefined);
    const api = {
      ...window.tessera,
      model: { ...window.tessera.model, status: statusMock, stop: stopMock },
      runtime: {
        ...window.tessera.runtime,
        detectPlatform: vi.fn().mockResolvedValue({
          platform: "linux-x64",
          platformLabel: "Linux x64",
          totalRamGb: 16,
          tier: "high",
          tierLabel: "High (8+ GB RAM)",
          computeBackends: ["cpu"],
          preferredFormat: "gguf",
        }),
        recommendModel: vi.fn().mockResolvedValue(null),
        listModels: vi.fn().mockResolvedValue([]),
        getCurrentModel: vi.fn().mockResolvedValue({
          modelId: "ternary-bonsai-1.7b-gguf",
          format: "gguf",
          filename: "ternary-bonsai-1.7b-q1_0_g128.gguf",
          path: "/var/tmp/m.gguf",
          downloadSizeMb: 450,
          diskSizeMb: 450,
          sha256: null,
          downloadedAt: new Date().toISOString(),
        }),
        deleteModel: deleteMock,
        onDownloadProgress: vi.fn().mockReturnValue(() => undefined),
      },
    } as unknown as Window["tessera"];
    return { api, statusMock, deleteMock, stopMock };
  }

  it("refreshes status even when the runtime was not running before delete", async () => {
    const { api, statusMock, deleteMock, stopMock } = buildApi({
      status: { available: false, modelName: null, status: "stopped" },
    });

    render(<ModelRuntimeCard api={api} />);

    const deleteBtn = await screen.findByRole("button", { name: /Delete model/i });
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledTimes(1);
    });
    // stop() must NOT be called when the runtime was not running.
    expect(stopMock).not.toHaveBeenCalled();
    // status() is called at least twice: once on mount + once after
    // delete. The second call is the bug fix \u2014 before the fix it was
    // skipped on the non-running branch.
    await waitFor(() => {
      expect(statusMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
  });

  it("still refreshes status when the runtime WAS running before delete (regression guard for the running branch)", async () => {
    const { api, statusMock, deleteMock, stopMock } = buildApi({
      status: { available: true, modelName: "Bonsai 1.7B", status: "running" },
    });

    render(<ModelRuntimeCard api={api} />);

    // Wait for the "Stop" button to render so we know the running-status
    // mount path completed.
    await screen.findByRole("button", { name: /Stop/i });
    const deleteBtn = screen.getByRole("button", { name: /Delete model/i });
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(stopMock).toHaveBeenCalledTimes(1);
      expect(deleteMock).toHaveBeenCalledTimes(1);
    });
    // Mount status() + post-stop status() + post-delete status() = at
    // least 3 calls.
    await waitFor(() => {
      expect(statusMock.mock.calls.length).toBeGreaterThanOrEqual(3);
    });
  });
});

describe("ModelRuntimeCard download-progress lifecycle", () => {
  // Regression for Devin Review BUG finding 8f14f796:
  // `performDownload` used to leave `state.progress` populated after a
  // failed download because the catch block only cleared `busyModelId`
  // and `error`. The subscriber `onDownloadProgress` keeps writing
  // snapshots until the moment the main process throws, so without
  // explicit cleanup the renderer showed BOTH the error banner AND a
  // frozen "42 / 1000 MB (4%)" progress bar. The fix has two parts:
  // (a) catch-path now sets `progress: null`; (b) the progress bar
  // render is gated on `state.busyModelId && state.progress` so even a
  // future code path that forgets the explicit null cannot leak a
  // stale snapshot. Both invariants are guarded here.

  function buildDownloadApi(opts: {
    downloadOutcome: "ok" | "fail";
    progressBeforeOutcome: { downloadedMb: number; totalMb: number; percent: number };
  }) {
    type Listener = (p: {
      modelId: string;
      format: string;
      filename: string;
      downloadedMb: number;
      totalMb: number;
      percent: number;
    }) => void;
    let listener: Listener | null = null;
    const downloadMock = vi.fn().mockImplementation(async (modelId: string) => {
      // Simulate the main process emitting progress before terminating.
      listener?.({
        modelId,
        format: "gguf",
        filename: "ternary-bonsai-1.7b-q1_0_g128.gguf",
        ...opts.progressBeforeOutcome,
      });
      // Let React flush the listener-driven state update before we
      // terminate. `Promise.resolve()` is sufficient because the
      // listener path is synchronous setState.
      await Promise.resolve();
      if (opts.downloadOutcome === "fail") {
        throw new Error("simulated download failure");
      }
      return {
        modelId,
        format: "gguf",
        filename: "ternary-bonsai-1.7b-q1_0_g128.gguf",
        path: "/var/tmp/m.gguf",
        downloadSizeMb: 450,
        diskSizeMb: 450,
        sha256: null,
        downloadedAt: new Date().toISOString(),
      };
    });
    const api = {
      ...window.tessera,
      model: {
        ...window.tessera.model,
        status: vi.fn().mockResolvedValue({
          available: false,
          modelName: null,
          status: "stopped",
        }),
      },
      runtime: {
        ...window.tessera.runtime,
        detectPlatform: vi.fn().mockResolvedValue({
          platform: "linux-x64",
          platformLabel: "Linux x64",
          totalRamGb: 16,
          tier: "high",
          tierLabel: "High (8+ GB RAM)",
          computeBackends: ["cpu"],
          preferredFormat: "gguf",
        }),
        recommendModel: vi.fn().mockResolvedValue({
          id: "ternary-bonsai-1.7b-gguf",
          name: "Ternary-Bonsai 1.7B",
          parameters: "1.7B",
          format: "gguf",
          formatLabel: "GGUF Q1_0_g128",
          quantization: "Q1_0_g128",
          platform: "linux-x64",
          tier: "low",
          computeBackends: ["cpu"],
          downloadSizeMb: 450,
          diskSizeMb: 450,
          requiredRamGb: 2,
          contextLength: 2048,
          filename: "ternary-bonsai-1.7b-q1_0_g128.gguf",
          url: "https://example.com/m.gguf",
          sha256: null,
        }),
        listModels: vi.fn().mockResolvedValue([]),
        getCurrentModel: vi.fn().mockResolvedValue(null),
        deleteModel: vi.fn().mockResolvedValue(undefined),
        downloadModel: downloadMock,
        onDownloadProgress: vi.fn().mockImplementation((cb: Listener) => {
          listener = cb;
          return () => {
            listener = null;
          };
        }),
      },
    } as unknown as Window["tessera"];
    return { api, downloadMock };
  }

  it("clears the progress bar after a failed download (no frozen snapshot beside the error)", async () => {
    const { api, downloadMock } = buildDownloadApi({
      downloadOutcome: "fail",
      progressBeforeOutcome: { downloadedMb: 200, totalMb: 450, percent: 44 },
    });

    render(<ModelRuntimeCard api={api} />);

    const downloadBtn = await screen.findByRole("button", {
      name: /^Download$/i,
    });
    fireEvent.click(downloadBtn);

    await waitFor(() => {
      expect(downloadMock).toHaveBeenCalledTimes(1);
    });
    // Error banner is shown\u2026
    await screen.findByText(/simulated download failure/i);
    // \u2026and the progress region is NOT rendered. The gate is
    // `busyModelId && progress`; both must be falsy for the bar to be
    // hidden after the catch block runs.
    expect(
      screen.queryByTestId("model-runtime-progress"),
    ).not.toBeInTheDocument();
  });

  it("clears the progress bar after a successful download (positive control)", async () => {
    const { api, downloadMock } = buildDownloadApi({
      downloadOutcome: "ok",
      progressBeforeOutcome: { downloadedMb: 450, totalMb: 450, percent: 100 },
    });

    render(<ModelRuntimeCard api={api} />);

    const downloadBtn = await screen.findByRole("button", {
      name: /^Download$/i,
    });
    fireEvent.click(downloadBtn);

    await waitFor(() => {
      expect(downloadMock).toHaveBeenCalledTimes(1);
    });
    // Progress region must not linger once the download settled.
    await waitFor(() => {
      expect(
        screen.queryByTestId("model-runtime-progress"),
      ).not.toBeInTheDocument();
    });
  });
});

describe("ModelRuntimeCard failed-swap re-fetches current model", () => {
  // Regression for Devin Review BUG finding 3271328763:
  // `performDownload` on the swap path used to leave `state.current`
  // holding the pre-swap record after a failed download. The main
  // process's `downloadModelLocked` evicts the previously-installed
  // model and clears `active-model.json` BEFORE issuing the network
  // fetch, so a download failure leaves the on-disk truth as
  // "no model installed" while the renderer continued to show the old
  // model card with Start/Delete buttons pointing at a file that no
  // longer exists. The fix re-fetches `getCurrentModel()` in the catch
  // block; this test enforces that.

  it("clears state.current when the swap deletes the old model and the new download then fails", async () => {
    const initialRecord = {
      modelId: "ternary-bonsai-1.7b-gguf",
      format: "gguf" as const,
      filename: "ternary-bonsai-1.7b-q1_0_g128.gguf",
      path: "/var/tmp/m1.gguf",
      downloadSizeMb: 450,
      diskSizeMb: 450,
      sha256: null,
      downloadedAt: new Date(0).toISOString(),
    };

    // Mirror the main-process swap path: on initial mount, the old
    // record is reported. On the post-failure re-fetch (after the
    // catch block runs), the on-disk truth is now `null` because
    // `downloadModelLocked` already evicted the old model.
    const getCurrentModelMock = vi
      .fn()
      .mockResolvedValueOnce(initialRecord) // initial refresh()
      .mockResolvedValue(null); // post-failure re-fetch + polls

    const downloadMock = vi
      .fn()
      .mockImplementation(async () => {
        await Promise.resolve();
        throw new Error("simulated swap failure");
      });

    const api = {
      ...window.tessera,
      model: {
        ...window.tessera.model,
        status: vi.fn().mockResolvedValue({
          available: false,
          modelName: null,
          status: "stopped",
        }),
      },
      runtime: {
        ...window.tessera.runtime,
        detectPlatform: vi.fn().mockResolvedValue({
          platform: "linux-x64",
          platformLabel: "Linux x64",
          totalRamGb: 16,
          tier: "high",
          tierLabel: "High (8+ GB RAM)",
          computeBackends: ["cpu"],
          preferredFormat: "gguf",
        }),
        recommendModel: vi.fn().mockResolvedValue({
          id: "ternary-bonsai-8b-gguf",
          name: "Ternary-Bonsai 8B",
          parameters: "8B",
          format: "gguf",
          formatLabel: "GGUF Q1_0_g128",
          quantization: "Q1_0_g128",
          platform: "linux-x64",
          tier: "high",
          computeBackends: ["cpu"],
          downloadSizeMb: 2000,
          diskSizeMb: 2000,
          requiredRamGb: 8,
          contextLength: 8192,
          filename: "ternary-bonsai-8b-q1_0_g128.gguf",
          url: "https://example.com/8b.gguf",
          sha256: null,
        }),
        listModels: vi.fn().mockResolvedValue([
          {
            id: "ternary-bonsai-8b-gguf",
            name: "Ternary-Bonsai 8B",
            parameters: "8B",
            format: "gguf",
            formatLabel: "GGUF Q1_0_g128",
            quantization: "Q1_0_g128",
            platform: "linux-x64",
            tier: "high",
            computeBackends: ["cpu"],
            downloadSizeMb: 2000,
            diskSizeMb: 2000,
            requiredRamGb: 8,
            contextLength: 8192,
            filename: "ternary-bonsai-8b-q1_0_g128.gguf",
            url: "https://example.com/8b.gguf",
            sha256: null,
          },
        ]),
        getCurrentModel: getCurrentModelMock,
        deleteModel: vi.fn().mockResolvedValue(undefined),
        downloadModel: downloadMock,
        onDownloadProgress: vi.fn().mockReturnValue(() => undefined),
      },
    } as unknown as Window["tessera"];

    render(<ModelRuntimeCard api={api} />);

    // Wait for initial paint: the old model record (1.7B-gguf) should
    // be shown as installed. The card renders `state.current.modelId`
    // inside the `model-runtime-current` region.
    const installed = await screen.findByTestId("model-runtime-current");
    expect(installed.textContent ?? "").toMatch(/ternary-bonsai-1\.7b-gguf/i);

    // The Swap button only renders inside the "Show all available
    // models" expansion (rows other than the currently-installed one).
    // Expand the panel, then click Swap on the 8B row.
    const showAll = await screen.findByRole("button", {
      name: /Show all available models/i,
    });
    fireEvent.click(showAll);
    const swapBtn = await screen.findByRole("button", { name: /^Swap$/ });
    fireEvent.click(swapBtn);

    await waitFor(() => {
      expect(downloadMock).toHaveBeenCalledTimes(1);
    });

    // After the catch path runs, the renderer must re-fetch the live
    // current model and reflect that nothing is installed. Without the
    // fix, the old `ternary-bonsai-1.7b-gguf` copy would still appear
    // and the Start/Delete buttons would point at the now-deleted file.
    await waitFor(() => {
      expect(
        screen.queryByTestId("model-runtime-current"),
      ).not.toBeInTheDocument();
    });
    await screen.findByText(/simulated swap failure/i);

    // The re-fetch happened: getCurrentModel was called more times
    // than just the initial render (initial refresh + post-failure
    // re-fetch is the floor; the lightweight 5s poll may add more).
    expect(getCurrentModelMock.mock.calls.length).toBeGreaterThanOrEqual(2);
  });
});

describe("ModelRuntimeCard 5s poll respects busyModelId gate", () => {
  // Regression for Devin Review INFO finding 3271382737:
  // The 5-second status/getCurrentModel poll could overwrite optimistic
  // state set by `performDownload`/`handleDelete` if a poll tick landed
  // in the window where the renderer had already nulled `current` but
  // the main process hadn't yet evicted the file from disk. The fix
  // makes the poll's setState a functional update that skips when
  // `s.busyModelId !== null`. This test pumps a poll tick while a
  // download is in flight and asserts the poll's setState DID NOT
  // clobber the busy state.

  it("does not overwrite state when a download is in flight (busyModelId !== null)", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    // Resolve the poll's `getCurrentModel` to a sentinel value that
    // would visibly differ from the busy in-flight state, so that if
    // the gate failed we'd see the sentinel appear.
    const pollGetCurrent = vi.fn().mockResolvedValue({
      modelId: "ghost-record-from-poll",
      format: "gguf" as const,
      filename: "ghost.gguf",
      path: "/var/tmp/ghost.gguf",
      downloadSizeMb: 1,
      diskSizeMb: 1,
      sha256: null,
      downloadedAt: new Date(0).toISOString(),
    });
    const pollStatus = vi.fn().mockResolvedValue({
      available: true,
      modelName: "ghost-status-from-poll",
      status: "running",
    });

    // The download mock returns a promise that never resolves while
    // the test is running — so the card stays "busy" indefinitely
    // and we can pump as many poll ticks as we want against it.
    let resolveDownload: () => void = () => undefined;
    const downloadMock = vi.fn().mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveDownload = () => res();
        }),
    );

    const api = {
      ...window.tessera,
      model: {
        ...window.tessera.model,
        status: pollStatus,
      },
      runtime: {
        ...window.tessera.runtime,
        detectPlatform: vi.fn().mockResolvedValue({
          platform: "linux-x64",
          platformLabel: "Linux x64",
          totalRamGb: 16,
          tier: "high",
          tierLabel: "High (8+ GB RAM)",
          computeBackends: ["cpu"],
          preferredFormat: "gguf",
        }),
        recommendModel: vi.fn().mockResolvedValue({
          id: "ternary-bonsai-8b-gguf",
          name: "Ternary-Bonsai 8B",
          parameters: "8B",
          format: "gguf",
          formatLabel: "GGUF Q1_0_g128",
          quantization: "Q1_0_g128",
          platform: "linux-x64",
          tier: "high",
          computeBackends: ["cpu"],
          downloadSizeMb: 2000,
          diskSizeMb: 2000,
          requiredRamGb: 8,
          contextLength: 8192,
          filename: "ternary-bonsai-8b-q1_0_g128.gguf",
          url: "https://example.com/8b.gguf",
          sha256: null,
        }),
        listModels: vi.fn().mockResolvedValue([]),
        getCurrentModel: vi
          .fn()
          // initial mount: nothing installed yet
          .mockResolvedValueOnce(null)
          // every subsequent poll call returns the ghost value
          .mockImplementation(() => pollGetCurrent()),
        deleteModel: vi.fn().mockResolvedValue(undefined),
        downloadModel: downloadMock,
        onDownloadProgress: vi.fn().mockReturnValue(() => undefined),
      },
    } as unknown as Window["tessera"];

    render(<ModelRuntimeCard api={api} />);

    // Wait for the initial mount paint.
    const dlBtn = await screen.findByRole("button", { name: /Download/i });
    fireEvent.click(dlBtn);

    // Now we are mid-download. busyModelId is non-null; the download
    // promise never resolves, so the card stays in "busy" state.
    await waitFor(() => {
      expect(downloadMock).toHaveBeenCalled();
    });

    // Pump fake-timer poll ticks. If the gate fails, the poll would
    // call setState({ status: pollStatus, current: pollGetCurrent })
    // and the "ghost-record-from-poll" text would appear.
    await vi.advanceTimersByTimeAsync(5500);
    await vi.advanceTimersByTimeAsync(5500);
    await vi.advanceTimersByTimeAsync(5500);

    // Both poll-side mocks may have been called (the fetch fires),
    // but their setState callback must have skipped writing the ghost
    // state because busyModelId is non-null.
    expect(
      screen.queryByText(/ghost-record-from-poll/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/ghost-status-from-poll/i),
    ).not.toBeInTheDocument();

    // Clean up: release the never-resolving download so the catch
    // block in performDownload doesn't leak across tests.
    resolveDownload();
    vi.useRealTimers();
  });

  // Regression for Devin Review BUG finding 3271435390:
  // `handleDelete` previously never set `busyModelId`, so the 5s poll's
  // `busyModelId !== null` gate had no effect during delete. A poll
  // tick landing between the main-process unlink and the renderer's
  // final `setState({ current: null })` would re-fetch the
  // still-on-disk record and "resurrect" the deleted model in the UI
  // for up to 5s. The fix sets `busyModelId` to the model id at the
  // top of `handleDelete` and clears it in both the success and error
  // setState calls. This test pumps a poll tick while delete is in
  // flight and asserts the ghost record never appears.
  it("delete: poll does not overwrite state while delete is in flight", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    const pollGetCurrent = vi.fn().mockResolvedValue({
      modelId: "ghost-delete-record",
      format: "gguf" as const,
      filename: "ghost-delete.gguf",
      path: "/var/tmp/ghost-delete.gguf",
      downloadSizeMb: 1,
      diskSizeMb: 1,
      sha256: null,
      downloadedAt: new Date(0).toISOString(),
    });
    const pollStatus = vi.fn().mockResolvedValue({
      available: true,
      modelName: "ghost-delete-status",
      status: "running",
    });

    // `deleteModel` returns a never-resolving promise so the card
    // stays in the busy-delete state for the duration of the test.
    let resolveDelete: () => void = () => undefined;
    const deleteMock = vi.fn().mockImplementation(
      () =>
        new Promise<void>((res) => {
          resolveDelete = () => res();
        }),
    );

    const initialCurrent = {
      modelId: "ternary-bonsai-1.7b-gguf",
      format: "gguf" as const,
      filename: "ternary-bonsai-1.7b-q1_0_g128.gguf",
      path: "/var/tmp/m.gguf",
      downloadSizeMb: 450,
      diskSizeMb: 450,
      sha256: null,
      downloadedAt: new Date().toISOString(),
    };

    const api = {
      ...window.tessera,
      model: {
        ...window.tessera.model,
        status: pollStatus,
        stop: vi.fn().mockResolvedValue(undefined),
      },
      runtime: {
        ...window.tessera.runtime,
        detectPlatform: vi.fn().mockResolvedValue({
          platform: "linux-x64",
          platformLabel: "Linux x64",
          totalRamGb: 16,
          tier: "high",
          tierLabel: "High (8+ GB RAM)",
          computeBackends: ["cpu"],
          preferredFormat: "gguf",
        }),
        recommendModel: vi.fn().mockResolvedValue(null),
        listModels: vi.fn().mockResolvedValue([]),
        getCurrentModel: vi
          .fn()
          // initial mount: real installed model so the Delete button
          // renders
          .mockResolvedValueOnce(initialCurrent)
          // every subsequent (poll) call returns the ghost value
          .mockImplementation(() => pollGetCurrent()),
        deleteModel: deleteMock,
        onDownloadProgress: vi.fn().mockReturnValue(() => undefined),
      },
    } as unknown as Window["tessera"];

    render(<ModelRuntimeCard api={api} />);

    const deleteBtn = await screen.findByRole("button", { name: /Delete model/i });
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalled();
    });

    // Pump fake-timer poll ticks. If the gate fails the poll would
    // call setState({ current: pollGetCurrent }) and the ghost record
    // would replace the installed model in the UI.
    await vi.advanceTimersByTimeAsync(5500);
    await vi.advanceTimersByTimeAsync(5500);

    expect(
      screen.queryByText(/ghost-delete-record/i),
    ).not.toBeInTheDocument();
    expect(
      screen.queryByText(/ghost-delete-status/i),
    ).not.toBeInTheDocument();

    // Clean up: release the never-resolving delete.
    resolveDelete();
    vi.useRealTimers();
  });
});

describe("ModelRuntimeCard handleDelete error path re-fetches state", () => {
  // Regression for Devin Review ANALYSIS finding 3271435467:
  // `handleDelete`'s catch block used to only set `state.error` without
  // re-fetching `current` or `status`. In an asymmetric failure (e.g.
  // `deleteCurrentModel` unlinks the file but throws before clearing
  // `active-model.json`) the renderer would hold a stale `state.current`
  // pointing at a non-existent file, and Start/Delete buttons would
  // target a phantom model. The fix mirrors `performDownload`'s
  // recovery: re-fetch live `getCurrentModel()` + `model.status()` and
  // write them into state alongside the error.
  it("re-fetches getCurrentModel + model.status when deleteModel throws", async () => {
    const installedRecord = {
      modelId: "ternary-bonsai-1.7b-gguf",
      format: "gguf" as const,
      filename: "ternary-bonsai-1.7b-q1_0_g128.gguf",
      path: "/var/tmp/m.gguf",
      downloadSizeMb: 450,
      diskSizeMb: 450,
      sha256: null,
      downloadedAt: new Date().toISOString(),
    };

    // After deleteModel throws, getCurrentModel returns null
    // (representing the partial-failure state where the file was
    // unlinked but `active-model.json` had a stale entry that the
    // main process has since cleared). The renderer must adopt this
    // truth, NOT keep the pre-delete `installedRecord` in state.
    const getCurrentModelMock = vi
      .fn()
      .mockResolvedValueOnce(installedRecord) // initial mount
      .mockResolvedValue(null); // post-failure re-fetch
    const statusMock = vi
      .fn()
      .mockResolvedValueOnce({
        available: false,
        modelName: null,
        status: "stopped",
      }) // initial mount
      .mockResolvedValue({
        available: false,
        modelName: null,
        status: "stopped",
      });
    const deleteMock = vi.fn().mockRejectedValue(new Error("EBUSY"));

    const api = {
      ...window.tessera,
      model: {
        ...window.tessera.model,
        status: statusMock,
        stop: vi.fn().mockResolvedValue(undefined),
      },
      runtime: {
        ...window.tessera.runtime,
        detectPlatform: vi.fn().mockResolvedValue({
          platform: "linux-x64",
          platformLabel: "Linux x64",
          totalRamGb: 16,
          tier: "high",
          tierLabel: "High (8+ GB RAM)",
          computeBackends: ["cpu"],
          preferredFormat: "gguf",
        }),
        recommendModel: vi.fn().mockResolvedValue(null),
        listModels: vi.fn().mockResolvedValue([]),
        getCurrentModel: getCurrentModelMock,
        deleteModel: deleteMock,
        onDownloadProgress: vi.fn().mockReturnValue(() => undefined),
      },
    } as unknown as Window["tessera"];

    render(<ModelRuntimeCard api={api} />);

    // Wait for the installed record to render.
    await screen.findByText(/ternary-bonsai-1.7b-gguf/i);

    const deleteBtn = screen.getByRole("button", { name: /Delete model/i });
    fireEvent.click(deleteBtn);

    // Wait for the error banner to appear (confirms catch ran).
    await screen.findByText(/EBUSY/);

    // getCurrentModel must have been re-called on the error path
    // (mount + post-failure re-fetch + possibly poll ticks).
    await waitFor(() => {
      expect(getCurrentModelMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    // status must also have been re-called on the error path.
    await waitFor(() => {
      expect(statusMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });

    // After the re-fetch landed null, the installed-record text must
    // be gone — the UI now matches on-disk truth. If the fix were
    // missing, this assertion would fail because `state.current`
    // would still hold the pre-delete record.
    await waitFor(() => {
      expect(
        screen.queryByText(/ternary-bonsai-1.7b-gguf/i),
      ).not.toBeInTheDocument();
    });
  });
});
