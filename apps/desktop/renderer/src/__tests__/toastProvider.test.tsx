/**
 * Phase 15 Task 21 — coverage for the toast notification system.
 *
 * Asserts the behaviour matrix the task spec requires:
 *  - max 3 visible toasts (excess queues + promotes on dismiss)
 *  - success / info auto-dismiss after 5s
 *  - error toasts PERSIST until explicit dismiss
 *  - hover/focus pauses the auto-dismiss timer; leave/blur resumes
 *  - Escape on a focused toast dismisses that toast
 *  - explicit dismiss button removes the toast
 *
 * The provider is mounted inside a TestConsumer component that
 * surfaces a button per `addToast` call so we can drive the queue
 * deterministically via `fireEvent.click` instead of awaiting a
 * hand-rolled side-effect from another component.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { render, screen, fireEvent, within, act } from "@testing-library/react";
import { ToastProvider } from "../components/Toast";
import { useToast, type ToastType } from "../components/toastContext";

/**
 * Test harness: renders one button per (label, type) pair which, when
 * clicked, fires `addToast(label, type)`. Tests drive the provider by
 * clicking these buttons.
 */
function TestConsumer({
  toasts,
}: {
  toasts: ReadonlyArray<{ label: string; type?: ToastType }>;
}) {
  const { addToast } = useToast();
  return (
    <div>
      {toasts.map((t) => (
        <button
          key={t.label}
          type="button"
          data-testid={`fire-${t.label}`}
          onClick={() => addToast(t.label, t.type ?? "info")}
        >
          fire {t.label}
        </button>
      ))}
    </div>
  );
}

function fire(label: string) {
  fireEvent.click(screen.getByTestId(`fire-${label}`));
}

function visibleToastTexts(): string[] {
  const region = screen.queryByRole("region", { name: "Notifications" });
  if (!region) return [];
  return Array.from(region.querySelectorAll(".toast-message")).map(
    (el) => el.textContent ?? "",
  );
}

describe("ToastProvider (Phase 15 Task 21)", () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("caps the visible stack at 3 and queues additional toasts FIFO", () => {
    const labels = ["one", "two", "three", "four", "five"];
    render(
      <ToastProvider>
        <TestConsumer toasts={labels.map((label) => ({ label }))} />
      </ToastProvider>,
    );
    labels.forEach(fire);
    expect(visibleToastTexts()).toEqual(["one", "two", "three"]);
    // Dismiss "one" — the queue head "four" should take its place.
    const region = screen.getByRole("region", { name: "Notifications" });
    const dismissButtons = within(region).getAllByLabelText(
      "Dismiss notification",
    );
    fireEvent.click(dismissButtons[0]);
    expect(visibleToastTexts()).toEqual(["two", "three", "four"]);
    // Dismiss "two" — "five" promotes.
    const after = within(region).getAllByLabelText("Dismiss notification");
    fireEvent.click(after[0]);
    expect(visibleToastTexts()).toEqual(["three", "four", "five"]);
  });

  it("auto-dismisses info / success after 5 seconds", () => {
    render(
      <ToastProvider>
        <TestConsumer toasts={[{ label: "hello" }]} />
      </ToastProvider>,
    );
    fire("hello");
    expect(visibleToastTexts()).toEqual(["hello"]);
    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(visibleToastTexts()).toEqual(["hello"]);
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(visibleToastTexts()).toEqual([]);
  });

  it("keeps error toasts visible past the info auto-dismiss window", () => {
    render(
      <ToastProvider>
        <TestConsumer toasts={[{ label: "boom", type: "error" }]} />
      </ToastProvider>,
    );
    fire("boom");
    act(() => {
      vi.advanceTimersByTime(60_000);
    });
    expect(visibleToastTexts()).toEqual(["boom"]);
  });

  it("dismisses a toast on Escape when it is focused", () => {
    render(
      <ToastProvider>
        <TestConsumer toasts={[{ label: "escapable" }]} />
      </ToastProvider>,
    );
    fire("escapable");
    const region = screen.getByRole("region", { name: "Notifications" });
    const toast = within(region).getByText("escapable").closest(".toast");
    if (!(toast instanceof HTMLElement)) {
      throw new Error("expected toast container element");
    }
    toast.focus();
    fireEvent.keyDown(toast, { key: "Escape" });
    expect(visibleToastTexts()).toEqual([]);
  });

  it("pauses auto-dismiss on hover and resumes on mouseleave", () => {
    render(
      <ToastProvider>
        <TestConsumer toasts={[{ label: "linger" }]} />
      </ToastProvider>,
    );
    fire("linger");
    const region = screen.getByRole("region", { name: "Notifications" });
    const toast = within(region).getByText("linger").closest(".toast");
    if (!(toast instanceof HTMLElement)) {
      throw new Error("expected toast container element");
    }
    // Advance partway, then hover so the timer is cleared.
    act(() => {
      vi.advanceTimersByTime(3000);
    });
    fireEvent.mouseEnter(toast);
    act(() => {
      // Past the original 5s window — toast should still be visible
      // because the timer was cancelled on hover.
      vi.advanceTimersByTime(10_000);
    });
    expect(visibleToastTexts()).toEqual(["linger"]);
    // Mouseleave restarts the full 5s window.
    fireEvent.mouseLeave(toast);
    act(() => {
      vi.advanceTimersByTime(4999);
    });
    expect(visibleToastTexts()).toEqual(["linger"]);
    act(() => {
      vi.advanceTimersByTime(2);
    });
    expect(visibleToastTexts()).toEqual([]);
  });

  it("removes a toast when the dismiss button is clicked", () => {
    render(
      <ToastProvider>
        <TestConsumer toasts={[{ label: "tap" }]} />
      </ToastProvider>,
    );
    fire("tap");
    const region = screen.getByRole("region", { name: "Notifications" });
    fireEvent.click(within(region).getByLabelText("Dismiss notification"));
    expect(visibleToastTexts()).toEqual([]);
  });

  it("uses role=alert for errors and role=status for info", () => {
    render(
      <ToastProvider>
        <TestConsumer
          toasts={[
            { label: "info-one" },
            { label: "err-one", type: "error" },
          ]}
        />
      </ToastProvider>,
    );
    fire("info-one");
    fire("err-one");
    const region = screen.getByRole("region", { name: "Notifications" });
    expect(within(region).getByRole("alert")).toHaveTextContent("err-one");
    expect(within(region).getByRole("status")).toHaveTextContent("info-one");
  });
});
