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
