import { describe, it, expect, vi } from "vitest";
import { render, screen, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import Sidebar from "../components/Sidebar";
import Button from "../components/Button";
import Card from "../components/Card";
import PageHeader from "../components/PageHeader";
import StatusBadge from "../components/StatusBadge";
import EmptyState from "../components/EmptyState";
import SearchInput from "../components/SearchInput";
import Modal from "../components/Modal";

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
