import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Sidebar from "../components/Sidebar";
import WorkspaceProvider from "../workspace/WorkspaceProvider";
import { __resetSettingsStoreForTests } from "../hooks/useSettings";
import Button from "../components/Button";
import Card from "../components/Card";
import PageHeader from "../components/PageHeader";
import StatusBadge from "../components/StatusBadge";
import EmptyState from "../components/EmptyState";
import SearchInput from "../components/SearchInput";
import Modal from "../components/Modal";
import ModelRuntimeCard from "../components/ModelRuntimeCard";

describe("Sidebar", () => {
  beforeEach(() => {
    // Reset the shared settings store and any persisted "More tools"
    // choice so each case starts from a fresh-install state
    // (`simplifiedNav: true`, secondary section collapsed).
    localStorage.clear();
    __resetSettingsStoreForTests();
  });

  it("always renders the primary navigation links", () => {
    render(
      <MemoryRouter>
        <WorkspaceProvider>
          <Sidebar />
        </WorkspaceProvider>
      </MemoryRouter>,
    );
    expect(screen.getByText("Home")).toBeInTheDocument();
    expect(screen.getByText("Sources")).toBeInTheDocument();
    expect(screen.getByText("Create")).toBeInTheDocument();
    expect(screen.getByText("Settings")).toBeInTheDocument();
  });

  it("collapses secondary tools behind a 'More tools' toggle by default", () => {
    render(
      <MemoryRouter>
        <WorkspaceProvider>
          <Sidebar />
        </WorkspaceProvider>
      </MemoryRouter>,
    );
    const toggle = screen.getByRole("button", { name: /more tools/i });
    expect(toggle).toHaveAttribute("aria-expanded", "false");
    // Secondary destinations are hidden until the section is expanded.
    expect(screen.queryByText("Templates")).not.toBeInTheDocument();
    expect(screen.queryByText("Tasks")).not.toBeInTheDocument();
    expect(screen.queryByText("Automations")).not.toBeInTheDocument();
    expect(screen.queryByText("Vision")).not.toBeInTheDocument();
  });

  it("reveals secondary tools when 'More tools' is expanded", () => {
    render(
      <MemoryRouter>
        <WorkspaceProvider>
          <Sidebar />
        </WorkspaceProvider>
      </MemoryRouter>,
    );
    fireEvent.click(screen.getByRole("button", { name: /more tools/i }));
    expect(
      screen.getByRole("button", { name: /more tools/i }),
    ).toHaveAttribute("aria-expanded", "true");
    expect(screen.getByText("Templates")).toBeInTheDocument();
    expect(screen.getByText("Tasks")).toBeInTheDocument();
    expect(screen.getByText("Automations")).toBeInTheDocument();
    expect(screen.getByText("Vision")).toBeInTheDocument();
  });

  it("renders the Tessera brand", () => {
    render(
      <MemoryRouter>
        <WorkspaceProvider>
          <Sidebar />
        </WorkspaceProvider>
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

  it("calls onClose when clicking overlay backdrop", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal isOpen={true} onClose={onClose} title="Test">
        Body
      </Modal>,
    );
    // The backdrop is `.modal-overlay`; the dialog is now its inner
    // child with role="dialog", and a click inside the dialog itself
    // is intentionally stopped (we don't want clicks on form fields
    // to close the modal). Hit the outer overlay directly.
    const overlay = container.querySelector(".modal-overlay");
    expect(overlay).not.toBeNull();
    fireEvent.click(overlay!);
    expect(onClose).toHaveBeenCalledOnce();
  });

  it("does NOT call onClose when clicking inside the dialog", () => {
    const onClose = vi.fn();
    render(
      <Modal isOpen={true} onClose={onClose} title="Test">
        Body
      </Modal>,
    );
    fireEvent.click(screen.getByRole("dialog"));
    expect(onClose).not.toHaveBeenCalled();
  });

  it("respects closeOnOverlayClick=false", () => {
    const onClose = vi.fn();
    const { container } = render(
      <Modal
        isOpen={true}
        onClose={onClose}
        title="Test"
        closeOnOverlayClick={false}
      >
        Body
      </Modal>,
    );
    fireEvent.click(container.querySelector(".modal-overlay")!);
    expect(onClose).not.toHaveBeenCalled();
  });

  it("links role=dialog to title via aria-labelledby", () => {
    render(
      <Modal isOpen={true} onClose={vi.fn()} title="Confirm Delete">
        Body
      </Modal>,
    );
    const dialog = screen.getByRole("dialog");
    const labelId = dialog.getAttribute("aria-labelledby");
    expect(labelId).toBeTruthy();
    const heading = document.getElementById(labelId!);
    expect(heading?.textContent).toBe("Confirm Delete");
  });
});

describe("ModelRuntimeCard delete-from-non-running flow", () => {
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
          // Required `ResolvedModel.capability` field (shared/types.ts:541).
          // The text card only ever receives text-slot records via the
          // `capability="text"`-scoped IPC, so the test fixtures must
          // match that wire shape — a vision/imagegen record would
          // imply a cross-slot bug at the IPC boundary, not a valid
          // mock for this card.
          capability: "text",
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

describe("ModelRuntimeCard onDownloadProgress capability filter", () => {
  // Block F added sibling `ModelSlotPanel` cards for vision + imagegen
  // that can run concurrent downloads alongside the text-slot card.
  // The per-slot download lock in the main process is keyed by
  // `(userDataDir, capability)`, so a text download and a vision
  // download CAN be in flight at the same time once the global 5s
  // rate-limiter gap has elapsed. Without a capability filter on
  // `ModelRuntimeCard`'s `onDownloadProgress` subscriber, vision /
  // imagegen progress events would overwrite the text card's progress
  // bar with another slot's filename + percentage. This guards the
  // filter shipped alongside Block F.
  type ProgressEvent = {
    modelId: string;
    format: string;
    filename: string;
    downloadedMb: number;
    totalMb: number;
    percent: number;
    capability?: "text" | "vision" | "imagegen";
  };
  type Listener = (p: ProgressEvent) => void;

  function buildApi(opts: { withDownloadable?: boolean } = {}) {
    let listener: Listener | null = null;
    // Hold the downloadModel promise open so the renderer sits in
    // the `busyModelId` state and the progress gate `busyModelId &&
    // progress` evaluates against a live download. This lets the
    // test directly observe what the filter does with each event
    // category (vision / imagegen / legacy / text) — not just that
    // the listener was invoked, but that the gated render either
    // paints or doesn't paint the progress region in response.
    let resolveDownload: ((v: unknown) => void) | null = null;
    const downloadModel = vi.fn().mockImplementation(
      () =>
        new Promise((resolve) => {
          resolveDownload = resolve;
        }),
    );
    const recommended = opts.withDownloadable
      ? {
          id: "ternary-bonsai-1.7b-gguf",
          name: "Ternary-Bonsai 1.7B",
          parameters: "1.7B",
          // See note in the buildApi above — this matches
          // ResolvedModel.capability (required by shared/types.ts:541).
          capability: "text" as const,
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
        }
      : null;
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
        recommendModel: vi.fn().mockResolvedValue(recommended),
        listModels: vi.fn().mockResolvedValue([]),
        getCurrentModel: vi.fn().mockResolvedValue(null),
        deleteModel: vi.fn().mockResolvedValue(undefined),
        downloadModel,
        onDownloadProgress: vi.fn().mockImplementation((cb: Listener) => {
          listener = cb;
          return () => {
            listener = null;
          };
        }),
      },
    } as unknown as Window["tessera"];
    return {
      api,
      emit: (p: ProgressEvent) => listener?.(p),
      resolveDownload: () => resolveDownload?.({}),
    };
  }

  it("ignores vision-slot progress events (does not paint into the text card)", async () => {
    const { api, emit } = buildApi();
    render(<ModelRuntimeCard api={api} />);
    // Wait for the subscriber to attach (post-mount effect).
    await waitFor(() => {
      expect(
        (api.runtime.onDownloadProgress as unknown as { mock: { calls: unknown[] } })
          .mock.calls.length,
      ).toBeGreaterThan(0);
    });
    emit({
      modelId: "siglip-vision-base",
      format: "gguf",
      filename: "siglip-vision.gguf",
      downloadedMb: 120,
      totalMb: 300,
      percent: 40,
      capability: "vision",
    });
    // A vision-slot progress event must NOT cause the text card to
    // render its progress region.
    await Promise.resolve();
    expect(
      screen.queryByTestId("model-runtime-progress"),
    ).not.toBeInTheDocument();
  });

  it("ignores imagegen-slot progress events (does not paint into the text card)", async () => {
    const { api, emit } = buildApi();
    render(<ModelRuntimeCard api={api} />);
    await waitFor(() => {
      expect(
        (api.runtime.onDownloadProgress as unknown as { mock: { calls: unknown[] } })
          .mock.calls.length,
      ).toBeGreaterThan(0);
    });
    emit({
      modelId: "sd-turbo-q5",
      format: "gguf",
      filename: "sd-turbo.gguf",
      downloadedMb: 200,
      totalMb: 6000,
      percent: 3,
      capability: "imagegen",
    });
    await Promise.resolve();
    expect(
      screen.queryByTestId("model-runtime-progress"),
    ).not.toBeInTheDocument();
  });

  it("accepts legacy progress events with no capability field (backward compat)", async () => {
    // Strengthened test not just "filter
    // didn't throw" but "filter actually paints the legacy event
    // into the text card's progress bar after a Download click puts
    // the gate in the busyModelId state".
    //
    // A stale renderer running against a newer main process should
    // never be the path this filter sees — the main process tags
    // every outgoing event. But if for any reason the field is
    // missing, the filter must treat it as a text event so the
    // historical behaviour is preserved.
    const { api, emit } = buildApi({ withDownloadable: true });
    render(<ModelRuntimeCard api={api} />);
    // Click Download to enter the busy state so the progress region
    // is gated open. The downloadModel mock returns a pending
    // Promise, so the renderer sits in busyModelId=<modelId> for
    // the duration of the test.
    const downloadBtn = await screen.findByRole("button", {
      name: /^Download$/i,
    });
    fireEvent.click(downloadBtn);
    await waitFor(() => {
      expect(api.runtime.downloadModel).toHaveBeenCalledTimes(1);
    });
    // Now emit a legacy event (capability intentionally omitted).
    // The filter must accept it and the progress region must render.
    emit({
      modelId: "ternary-bonsai-1.7b-gguf",
      format: "gguf",
      filename: "ternary-bonsai-1.7b-q1_0_g128.gguf",
      downloadedMb: 80,
      totalMb: 450,
      percent: 17,
      // capability intentionally omitted
    });
    await waitFor(() => {
      expect(
        screen.queryByTestId("model-runtime-progress"),
      ).toBeInTheDocument();
    });
    // The painted progress reflects the legacy event's numbers,
    // proving the filter actually committed the event to state
    // (not just "didn't throw").
    expect(screen.getByTestId("model-runtime-progress")).toHaveTextContent(
      /17%/,
    );
  });

  it("accepts capability=text progress events (paints into the text card)", async () => {
    // Positive control alongside the legacy case: an explicit
    // `capability: "text"` event must paint, in the same gated
    // state the vision/imagegen drop tests above set up. This
    // closes the loop: the filter rejects non-text events AND
    // accepts text-or-missing events.
    const { api, emit } = buildApi({ withDownloadable: true });
    render(<ModelRuntimeCard api={api} />);
    const downloadBtn = await screen.findByRole("button", {
      name: /^Download$/i,
    });
    fireEvent.click(downloadBtn);
    await waitFor(() => {
      expect(api.runtime.downloadModel).toHaveBeenCalledTimes(1);
    });
    emit({
      modelId: "ternary-bonsai-1.7b-gguf",
      format: "gguf",
      filename: "ternary-bonsai-1.7b-q1_0_g128.gguf",
      downloadedMb: 90,
      totalMb: 450,
      percent: 20,
      capability: "text",
    });
    await waitFor(() => {
      expect(
        screen.queryByTestId("model-runtime-progress"),
      ).toBeInTheDocument();
    });
    expect(screen.getByTestId("model-runtime-progress")).toHaveTextContent(
      /20%/,
    );
  });
});

describe("ModelRuntimeCard listModels is text-scoped", () => {
  // Devin Review pass-N flagged that `refresh()` previously called
  // `tessera.runtime.listModels()` with no capability arg. Per the
  // RuntimeApi contract (apps/desktop/shared/types.ts:1050-1053)
  // that returns EVERY slot's candidates merged together — so vision
  // and imagegen models would leak into the text card's
  // "Show all available models" disclosure, with actionable
  // Download / Swap buttons. Clicking those from the text card
  // would route the download to the vision / imagegen slot (by
  // manifest capability) while the text card's state.current
  // updated with the cross-slot record — corrupting text-card UI
  // state until the next 5s poll. This test guards the
  // `listModels("text")` scoping fix.
  it("calls listModels with capability='text' on mount refresh", async () => {
    const listModelsMock = vi.fn().mockResolvedValue([]);
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
        recommendModel: vi.fn().mockResolvedValue(null),
        listModels: listModelsMock,
        getCurrentModel: vi.fn().mockResolvedValue(null),
        deleteModel: vi.fn().mockResolvedValue(undefined),
        onDownloadProgress: vi.fn().mockReturnValue(() => undefined),
      },
    } as unknown as Window["tessera"];
    render(<ModelRuntimeCard api={api} />);
    await waitFor(() => {
      expect(listModelsMock).toHaveBeenCalledTimes(1);
    });
    expect(listModelsMock).toHaveBeenCalledWith("text");
  });

  it("calls recommendModel and getCurrentModel with capability='text' on mount refresh", async () => {
    // Defense-in-depth: both overloads default to "text" on the
    // main-process side, but passing the cap explicitly at the
    // renderer boundary makes the scoping self-documenting and
    // catches any future server-side default flip.
    const recommendMock = vi.fn().mockResolvedValue(null);
    const getCurrentMock = vi.fn().mockResolvedValue(null);
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
        recommendModel: recommendMock,
        listModels: vi.fn().mockResolvedValue([]),
        getCurrentModel: getCurrentMock,
        deleteModel: vi.fn().mockResolvedValue(undefined),
        onDownloadProgress: vi.fn().mockReturnValue(() => undefined),
      },
    } as unknown as Window["tessera"];
    render(<ModelRuntimeCard api={api} />);
    await waitFor(() => {
      expect(recommendMock).toHaveBeenCalledWith("text");
      expect(getCurrentMock).toHaveBeenCalledWith("text");
    });
  });
});

describe("ModelRuntimeCard failed-swap re-fetches current model", () => {
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
          capability: "text",
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
            capability: "text",
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
          capability: "text",
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

    // Regression guard: every getCurrentModel call from this card must
    // pass the explicit "text" capability — including the catch-block
    // re-fetch after deleteModel throws. A previous pass left line 370
    // unscoped (relying on the IPC default), which would silently break
    // if the server-side default ever changes. The mount-time refresh
    // and 5s poll have their own regression tests above; this one
    // closes the gap on the delete catch path.
    for (const call of getCurrentModelMock.mock.calls) {
      expect(call[0]).toBe("text");
    }
    // deleteModel must also be explicitly text-scoped at the renderer
    // boundary, even though the IPC default is "text". Matches the
    // text-scoping invariant the card's header comment documents.
    expect(deleteMock).toHaveBeenCalledWith("text");

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

describe("ModelRuntimeCard handleDelete success path re-fetches current", () => {
  // `handleDelete`'s success path used to hardcode `current: null` after
  // a successful `deleteModel("text")`. The new contract: re-fetch
  // `getCurrentModel("text")` and adopt whatever the main process
  // reports — matches the same on-disk-truth invariant the error path,
  // both `performDownload` paths, and `ModelSlotPanel.handleDelete`
  // already maintain. The expected reading is `null` (we just
  // deleted), but reading from disk is the only way to guarantee it
  // and is robust against a concurrent install in another window.
  it("calls getCurrentModel('text') after deleteModel resolves and adopts the live value", async () => {
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

    // Initial mount → installedRecord. Post-delete re-fetch → null
    // (which is what we'd see after a normal delete settled cleanly
    // and `active-model-text.json` was cleared).
    const getCurrentModelMock = vi
      .fn()
      .mockResolvedValueOnce(installedRecord) // initial mount
      .mockResolvedValue(null); // post-success re-fetch + any poll ticks
    const statusMock = vi
      .fn()
      .mockResolvedValue({
        available: false,
        modelName: null,
        status: "stopped",
      });
    const deleteMock = vi.fn().mockResolvedValue(undefined);

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

    await screen.findByText(/ternary-bonsai-1.7b-gguf/i);

    const deleteBtn = screen.getByRole("button", { name: /Delete model/i });
    fireEvent.click(deleteBtn);

    await waitFor(() => {
      expect(deleteMock).toHaveBeenCalledTimes(1);
    });

    // getCurrentModel must have been called AT LEAST twice — once on
    // mount, once on the success path's live re-fetch. If the fix were
    // reverted (hardcoded `current: null`), only the mount call would
    // happen and this assertion would fail.
    await waitFor(() => {
      expect(getCurrentModelMock.mock.calls.length).toBeGreaterThanOrEqual(2);
    });
    // Every call must be explicitly text-scoped — locks the same
    // text-scoping invariant the catch-path regression guards above.
    for (const call of getCurrentModelMock.mock.calls) {
      expect(call[0]).toBe("text");
    }

    // The on-disk record is `null` (we just deleted) — the UI must
    // reflect that. If the renderer had ignored the re-fetch and
    // hardcoded `null` blindly, this would still pass; the
    // call-count + argument assertions above are what lock the new
    // contract.
    await waitFor(() => {
      expect(
        screen.queryByText(/ternary-bonsai-1.7b-gguf/i),
      ).not.toBeInTheDocument();
    });
  });

  it("adopts a non-null record if a concurrent install lands between deleteModel and the re-fetch", async () => {
    // Edge case: another renderer window or a background download
    // completes between our `deleteModel` call and the re-fetch, so
    // the on-disk truth is a DIFFERENT model record rather than
    // `null`. The renderer must adopt that record — hardcoding `null`
    // would lie to the user until the next 5s poll tick caught up.
    const beforeDelete = {
      modelId: "ternary-bonsai-1.7b-gguf",
      format: "gguf" as const,
      filename: "ternary-bonsai-1.7b-q1_0_g128.gguf",
      path: "/var/tmp/m1.gguf",
      downloadSizeMb: 450,
      diskSizeMb: 450,
      sha256: null,
      downloadedAt: new Date().toISOString(),
    };
    const concurrentInstall = {
      modelId: "ternary-bonsai-8b-gguf",
      format: "gguf" as const,
      filename: "ternary-bonsai-8b-q1_0_g128.gguf",
      path: "/var/tmp/m2.gguf",
      downloadSizeMb: 2000,
      diskSizeMb: 2000,
      sha256: null,
      downloadedAt: new Date().toISOString(),
    };
    const getCurrentModelMock = vi
      .fn()
      .mockResolvedValueOnce(beforeDelete) // initial mount
      .mockResolvedValue(concurrentInstall); // post-delete + polls

    const api = {
      ...window.tessera,
      model: {
        ...window.tessera.model,
        status: vi.fn().mockResolvedValue({
          available: false,
          modelName: null,
          status: "stopped",
        }),
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
        deleteModel: vi.fn().mockResolvedValue(undefined),
        onDownloadProgress: vi.fn().mockReturnValue(() => undefined),
      },
    } as unknown as Window["tessera"];

    render(<ModelRuntimeCard api={api} />);

    await screen.findByText(/ternary-bonsai-1.7b-gguf/i);

    const deleteBtn = screen.getByRole("button", { name: /Delete model/i });
    fireEvent.click(deleteBtn);

    // The renderer must adopt the concurrent install's record — NOT
    // the hardcoded null we used to write. If the fix were reverted,
    // the assertion that the 8B record appears would never resolve.
    await screen.findByText(/ternary-bonsai-8b-gguf/i);
    expect(
      screen.queryByText(/ternary-bonsai-1.7b-gguf/i),
    ).not.toBeInTheDocument();
  });
});
