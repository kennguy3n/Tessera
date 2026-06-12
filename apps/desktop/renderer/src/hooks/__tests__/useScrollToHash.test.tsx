/**
 * `useScrollToHash` must reliably scroll cross-page deep links into
 * view even when the target anchor renders only after an async load.
 * The `ready` gate (callers pass `!loading`) lets the effect retry once
 * the content — and thus the anchor — is present, and each hash is
 * honoured at most once so a later refresh doesn't yank the user back.
 * Devin Review PR #146.
 */

import { act } from "react";
import { renderHook, cleanup } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
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

  it("scrolls a given hash at most once across later ready toggles", () => {
    addAnchor("connectors");
    const { rerender } = renderHook(
      ({ ready }: { ready: boolean }) => useScrollToHash(ready),
      { wrapper: wrapper("#connectors"), initialProps: { ready: true } },
    );
    act(() => {
      vi.runAllTimers();
    });
    expect(scrollSpy).toHaveBeenCalledTimes(1);

    // A background refresh toggles loading off and on again.
    rerender({ ready: false });
    rerender({ ready: true });
    act(() => {
      vi.runAllTimers();
    });
    expect(scrollSpy).toHaveBeenCalledTimes(1);
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
