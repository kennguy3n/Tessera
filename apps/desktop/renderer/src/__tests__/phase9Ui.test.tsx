import { describe, it, expect, vi, beforeEach } from "vitest";
import { act, fireEvent, render, screen, waitFor } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import { ToastProvider } from "../components/Toast";
import { useToast } from "../components/toastContext";
import ErrorBoundary from "../components/ErrorBoundary";
import Sidebar from "../components/Sidebar";
import { useKeyboardShortcuts } from "../hooks/useKeyboardShortcuts";
import { useIndexingProgress } from "../hooks/useIndexingProgress";

describe("ToastProvider", () => {
  function Probe({ messages }: { messages: Array<["info" | "error", string]> }) {
    const { addToast } = useToast();
    return (
      <button
        onClick={() => {
          messages.forEach(([type, msg]) => addToast(msg, type));
        }}
      >
        fire
      </button>
    );
  }

  it("stacks multiple toasts and supports manual dismiss", async () => {
    render(
      <ToastProvider>
        <Probe
          messages={[
            ["info", "Saved draft"],
            ["error", "Network down"],
          ]}
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("fire"));
    expect(screen.getByText("Saved draft")).toBeInTheDocument();
    expect(screen.getByText("Network down")).toBeInTheDocument();

    const dismissButtons = screen.getAllByRole("button", {
      name: "Dismiss notification",
    });
    expect(dismissButtons).toHaveLength(2);
    fireEvent.click(dismissButtons[0]);
    await waitFor(() => {
      expect(screen.queryByText("Saved draft")).not.toBeInTheDocument();
    });
    expect(screen.getByText("Network down")).toBeInTheDocument();
  });

  it("uses role=alert for error toasts and role=status for others", () => {
    render(
      <ToastProvider>
        <Probe
          messages={[
            ["error", "Boom"],
            ["info", "Hi"],
          ]}
        />
      </ToastProvider>,
    );
    fireEvent.click(screen.getByText("fire"));
    const alert = screen.getByRole("alert");
    expect(alert).toHaveTextContent("Boom");
    const statuses = screen.getAllByRole("status");
    // The provider's container is role=region, and the info toast
    // is role=status. There's only one status toast.
    expect(statuses.some((el) => el.textContent?.includes("Hi"))).toBe(true);
  });

  it("auto-dismisses after the configured timeout", async () => {
    vi.useFakeTimers();
    try {
      render(
        <ToastProvider>
          <Probe messages={[["info", "Ephemeral"]]} />
        </ToastProvider>,
      );
      fireEvent.click(screen.getByText("fire"));
      expect(screen.getByText("Ephemeral")).toBeInTheDocument();
      act(() => {
        vi.advanceTimersByTime(5000);
      });
      expect(screen.queryByText("Ephemeral")).not.toBeInTheDocument();
    } finally {
      vi.useRealTimers();
    }
  });
});

describe("ErrorBoundary", () => {
  function Boom(): never {
    throw new Error("kaboom");
  }

  it("renders the fallback when a child throws", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      render(
        <ErrorBoundary>
          <Boom />
        </ErrorBoundary>,
      );
      expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
      // The error message is rendered in the diagnostic <pre>.
      expect(screen.getByText(/kaboom/)).toBeInTheDocument();
      // Reload + Dismiss buttons are present along with a Report link.
      expect(screen.getByRole("button", { name: "Reload" })).toBeInTheDocument();
      expect(screen.getByRole("button", { name: "Dismiss" })).toBeInTheDocument();
      expect(screen.getByRole("link", { name: "Report" })).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it("forwards a crash report tagged with the boundary name", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    const reportCrash = vi.fn().mockResolvedValue(undefined);
    (
      window as unknown as { tessera: { diagnostics?: unknown } }
    ).tessera.diagnostics = { reportCrash };
    try {
      render(
        <ErrorBoundary name="DocumentEditor">
          <Boom />
        </ErrorBoundary>,
      );
      expect(reportCrash).toHaveBeenCalledTimes(1);
      const report = reportCrash.mock.calls[0][0] as {
        component: string;
        error: string;
        stack: string;
        timestamp: string;
      };
      expect(report.component).toBe("DocumentEditor");
      expect(report.error).toBe("kaboom");
      expect(typeof report.stack).toBe("string");
      expect(Number.isNaN(Date.parse(report.timestamp))).toBe(false);
    } finally {
      spy.mockRestore();
      delete (window as unknown as { tessera: { diagnostics?: unknown } })
        .tessera.diagnostics;
    }
  });

  // A child that throws on its first render only, so that after the
  // boundary resets (clears its error) the re-render succeeds — this is
  // what happens in practice when navigating to a different, healthy
  // resource.
  function ThrowOnce({ label }: { label: string }) {
    if (label === "crash") throw new Error("kaboom");
    return <div>safe: {label}</div>;
  }

  it("clears a caught error when resetKeys change (e.g. route/id change)", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { rerender } = render(
        <ErrorBoundary resetKeys={["/sources/a"]}>
          <ThrowOnce label="crash" />
        </ErrorBoundary>,
      );
      // Crashed on /sources/a.
      expect(screen.getByText("Something went wrong.")).toBeInTheDocument();

      // Navigate to /sources/b: resetKeys change, so the boundary clears
      // its error and renders the now-healthy child instead of the stale
      // crash screen.
      rerender(
        <ErrorBoundary resetKeys={["/sources/b"]}>
          <ThrowOnce label="ok" />
        </ErrorBoundary>,
      );
      expect(screen.queryByText("Something went wrong.")).not.toBeInTheDocument();
      expect(screen.getByText("safe: ok")).toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });

  it("keeps showing the crash screen when resetKeys are unchanged", () => {
    const spy = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      const { rerender } = render(
        <ErrorBoundary resetKeys={["/sources/a"]}>
          <ThrowOnce label="crash" />
        </ErrorBoundary>,
      );
      expect(screen.getByText("Something went wrong.")).toBeInTheDocument();

      // Unrelated re-render with the same resetKeys: the error must
      // persist (we don't silently retry the still-crashing subtree).
      rerender(
        <ErrorBoundary resetKeys={["/sources/a"]}>
          <ThrowOnce label="ok" />
        </ErrorBoundary>,
      );
      expect(screen.getByText("Something went wrong.")).toBeInTheDocument();
      expect(screen.queryByText("safe: ok")).not.toBeInTheDocument();
    } finally {
      spy.mockRestore();
    }
  });
});

describe("useKeyboardShortcuts", () => {
  function Harness() {
    useKeyboardShortcuts();
    return <div>shortcuts mounted</div>;
  }

  it("registers Ctrl/Cmd shortcuts on document and removes them on unmount", () => {
    const events: string[] = [];
    const navListener = (e: Event) =>
      events.push((e as CustomEvent).type);
    window.addEventListener("tessera:save", navListener);
    window.addEventListener("tessera:export", navListener);
    window.addEventListener("tessera:focus-search", navListener);

    const { unmount } = render(
      <MemoryRouter initialEntries={["/"]}>
        <Harness />
      </MemoryRouter>,
    );

    fireEvent.keyDown(document, { key: "s", ctrlKey: true });
    fireEvent.keyDown(document, { key: "e", ctrlKey: true });
    fireEvent.keyDown(document, { key: "f", ctrlKey: true });

    expect(events).toEqual([
      "tessera:save",
      "tessera:export",
      "tessera:focus-search",
    ]);

    unmount();
    events.length = 0;
    fireEvent.keyDown(document, { key: "s", ctrlKey: true });
    expect(events).toEqual([]);
    window.removeEventListener("tessera:save", navListener);
    window.removeEventListener("tessera:export", navListener);
    window.removeEventListener("tessera:focus-search", navListener);
  });

  it("dispatches tessera:escape when Escape is pressed outside a modifier", () => {
    const calls: string[] = [];
    const cb = () => calls.push("esc");
    window.addEventListener("tessera:escape", cb);
    render(
      <MemoryRouter>
        <Harness />
      </MemoryRouter>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(calls).toEqual(["esc"]);
    window.removeEventListener("tessera:escape", cb);
  });
});

describe("Sidebar shortcut hints", () => {
  it("annotates nav links with the matching Ctrl/Cmd shortcut", () => {
    render(
      <MemoryRouter>
        <Sidebar />
      </MemoryRouter>,
    );
    // Each item should expose aria-keyshortcuts; we don't pin the
    // exact label because it depends on navigator.platform under
    // jsdom (Linux runners report "Linux x86_64").
    const home = screen.getByRole("link", { name: /Home/ });
    expect(home.getAttribute("aria-keyshortcuts")).toMatch(/(Ctrl|⌘)\+1/);
    // Settings was at shortcut 7 before Block E inserted /vision at
    // position 7. The test pins the new layout: Vision at 7,
    // Settings at 8.
    const vision = screen.getByRole("link", { name: /Vision/ });
    expect(vision.getAttribute("aria-keyshortcuts")).toMatch(/(Ctrl|⌘)\+7/);
    const settings = screen.getByRole("link", { name: /Settings/ });
    expect(settings.getAttribute("aria-keyshortcuts")).toMatch(/(Ctrl|⌘)\+8/);
  });
});

describe("useIndexingProgress", () => {
  beforeEach(() => {
    window.tessera.sources.getIndexingProgress = vi
      .fn()
      .mockResolvedValueOnce({
        status: "running",
        scanned: 3,
        indexed: 1,
        unchanged: 0,
        skipped: 0,
        errors: 0,
        totalFiles: 10,
        currentPath: "/foo/a.md",
        lastError: null,
      })
      .mockResolvedValueOnce({
        status: "done",
        scanned: 10,
        indexed: 7,
        unchanged: 2,
        skipped: 1,
        errors: 0,
        totalFiles: 10,
        currentPath: null,
        lastError: null,
      });
  });

  it("polls until a terminal status is reached and then stops", async () => {
    function Probe() {
      const snap = useIndexingProgress("src-1", true, 5);
      return (
        <div data-testid="snap">
          {snap ? `${snap.status}:${snap.indexed}` : "pending"}
        </div>
      );
    }
    render(<Probe />);
    await waitFor(() => {
      expect(screen.getByTestId("snap").textContent).toBe("running:1");
    });
    await waitFor(() => {
      expect(screen.getByTestId("snap").textContent).toBe("done:7");
    });
    const callCountAtTerminal = (
      window.tessera.sources.getIndexingProgress as ReturnType<typeof vi.fn>
    ).mock.calls.length;
    await new Promise((r) => setTimeout(r, 30));
    expect(
      (window.tessera.sources.getIndexingProgress as ReturnType<typeof vi.fn>)
        .mock.calls.length,
    ).toBe(callCountAtTerminal);
  });
});
