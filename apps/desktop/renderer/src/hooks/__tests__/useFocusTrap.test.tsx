/**
 * Contract tests for the shared `useFocusTrap` hook. Modal's own
 * accessibility suite covers the Tab-cycling path through a real
 * component; these tests pin the two behaviours that are easy to
 * regress and not asserted there: focus is *restored* to the opener on
 * close, and an empty dialog keeps focus pinned to its container rather
 * than letting Tab walk into the inert background.
 */
import { useRef } from "react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { act, cleanup, fireEvent, render } from "@testing-library/react";
import { useFocusTrap } from "../useFocusTrap";

function Harness({
  isOpen,
  onClose,
  children,
}: {
  isOpen: boolean;
  onClose: () => void;
  children?: React.ReactNode;
}) {
  const ref = useRef<HTMLDivElement | null>(null);
  useFocusTrap(isOpen, ref, onClose);
  if (!isOpen) return null;
  return (
    <div ref={ref} role="dialog" tabIndex={-1} data-testid="trap">
      {children}
    </div>
  );
}

afterEach(cleanup);

describe("useFocusTrap", () => {
  it("restores focus to the previously focused element on close", () => {
    vi.useFakeTimers();
    try {
      const opener = document.createElement("button");
      document.body.appendChild(opener);
      opener.focus();
      expect(document.activeElement).toBe(opener);

      const { rerender } = render(
        <Harness isOpen={true} onClose={vi.fn()}>
          <button type="button">Inside</button>
        </Harness>,
      );
      act(() => {
        vi.runAllTimers();
      });
      // Focus moved into the dialog.
      expect(document.activeElement).not.toBe(opener);

      // Closing runs the effect cleanup, which restores focus.
      rerender(<Harness isOpen={false} onClose={vi.fn()} />);
      expect(document.activeElement).toBe(opener);
      document.body.removeChild(opener);
    } finally {
      vi.useRealTimers();
    }
  });

  it("pins focus to the container when the dialog has no focusable children", () => {
    vi.useFakeTimers();
    try {
      const { getByTestId } = render(
        <Harness isOpen={true} onClose={vi.fn()} />,
      );
      act(() => {
        vi.runAllTimers();
      });
      const container = getByTestId("trap");
      expect(document.activeElement).toBe(container);

      // Tab must not escape — preventDefault keeps focus on the container.
      const event = fireEvent.keyDown(document, { key: "Tab" });
      expect(event).toBe(false); // preventDefault was called
      expect(document.activeElement).toBe(container);
    } finally {
      vi.useRealTimers();
    }
  });

  it("invokes onClose when Escape is pressed", () => {
    const onClose = vi.fn();
    render(
      <Harness isOpen={true} onClose={onClose}>
        <button type="button">Inside</button>
      </Harness>,
    );
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it("is inert while closed (no listener, no focus change)", () => {
    const onClose = vi.fn();
    const opener = document.createElement("button");
    document.body.appendChild(opener);
    opener.focus();
    render(<Harness isOpen={false} onClose={onClose} />);
    fireEvent.keyDown(document, { key: "Escape" });
    expect(onClose).not.toHaveBeenCalled();
    expect(document.activeElement).toBe(opener);
    document.body.removeChild(opener);
  });
});
