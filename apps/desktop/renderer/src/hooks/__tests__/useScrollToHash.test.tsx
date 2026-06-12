/**
 * `useScrollToHash` must reliably scroll cross-page deep links into
 * view even when the target anchor renders only after an async load.
 * The `ready` gate (callers pass `!loading`) lets the effect retry once
 * the content — and thus the anchor — is present. De-duplication is
 * keyed on the navigation (`location.key`): a background refresh
 * (ready toggle, same navigation) doesn't yank the user back, but an
 * intentional re-navigation to the same deep link scrolls again.
 * Devin Review PR #146.
 */

import { act } from "react";
import {
  renderHook,
  render,
  screen,
  fireEvent,
  cleanup,
} from "@testing-library/react";
import { MemoryRouter, useNavigate } from "react-router-dom";
import {
  afterEach,
  beforeEach,
  describe,
  expect,
  it,
  vi,
  type MockInstance,
} from "vitest";
import { useScrollToHash } from "../useScrollToHash";

function wrapper(hash: string) {
  return function Wrapper({ children }: { children: React.ReactNode }) {
    return (
      <MemoryRouter initialEntries={[`/sources${hash}`]}>
        {children}
      </MemoryRouter>
    );
  };
}

function Harness() {
  useScrollToHash(true);
  const navigate = useNavigate();
  return (
    <button type="button" onClick={() => navigate("/sources#connectors")}>
      re-navigate
    </button>
  );
}

function addAnchor(id: string): HTMLDivElement {
  const el = document.createElement("div");
  el.id = id;
  document.body.appendChild(el);
  return el;
}

let scrollSpy: MockInstance;

beforeEach(() => {
  vi.useFakeTimers();
  scrollSpy = vi
    .spyOn(HTMLElement.prototype, "scrollIntoView")
    .mockImplementation(() => {});
});

afterEach(() => {
  vi.runOnlyPendingTimers();
  vi.useRealTimers();
  scrollSpy.mockRestore();
  document.body.innerHTML = "";
  cleanup();
});

describe("useScrollToHash", () => {
  it("scrolls to the anchor when ready and the element exists", () => {
    addAnchor("connectors");
    renderHook(() => useScrollToHash(true), {
      wrapper: wrapper("#connectors"),
    });
    act(() => {
      vi.runAllTimers();
    });
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });

  it("does not scroll while not ready, then scrolls once ready flips true", () => {
    // The anchor only exists once loading completes.
    const { rerender } = renderHook(
      ({ ready }: { ready: boolean }) => useScrollToHash(ready),
      { wrapper: wrapper("#connectors"), initialProps: { ready: false } },
    );
    act(() => {
      vi.runAllTimers();
    });
    expect(scrollSpy).not.toHaveBeenCalled();

    addAnchor("connectors");
    rerender({ ready: true });
    act(() => {
      vi.runAllTimers();
    });
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });

  it("scrolls once per navigation across later ready toggles (no yank-back on refresh)", () => {
    addAnchor("connectors");
    const { rerender } = renderHook(
      ({ ready }: { ready: boolean }) => useScrollToHash(ready),
      { wrapper: wrapper("#connectors"), initialProps: { ready: true } },
    );
    act(() => {
      vi.runAllTimers();
    });
    expect(scrollSpy).toHaveBeenCalledTimes(1);

    // A background refresh toggles loading off and on again — same
    // navigation (`location.key` unchanged), so no second scroll.
    rerender({ ready: false });
    rerender({ ready: true });
    act(() => {
      vi.runAllTimers();
    });
    expect(scrollSpy).toHaveBeenCalledTimes(1);
  });

  it("scrolls again when the same deep link is intentionally re-invoked", () => {
    addAnchor("connectors");
    render(
      <MemoryRouter initialEntries={["/sources#connectors"]}>
        <Harness />
      </MemoryRouter>,
    );
    act(() => {
      vi.runAllTimers();
    });
    expect(scrollSpy).toHaveBeenCalledTimes(1);

    // Re-selecting the same deep link is a fresh navigation (new
    // `location.key`), so the user is taken back to the section.
    act(() => {
      fireEvent.click(screen.getByText("re-navigate"));
    });
    act(() => {
      vi.runAllTimers();
    });
    expect(scrollSpy).toHaveBeenCalledTimes(2);
  });

  it("is a no-op when there is no hash", () => {
    addAnchor("connectors");
    renderHook(() => useScrollToHash(true), { wrapper: wrapper("") });
    act(() => {
      vi.runAllTimers();
    });
    expect(scrollSpy).not.toHaveBeenCalled();
  });
});
