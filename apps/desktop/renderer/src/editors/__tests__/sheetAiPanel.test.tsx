/**
 * Integration coverage for the Sheet AI assistant + named-range panels:
 * the generate → validate → insert flow only offers Insert for a
 * parseable formula, and the named-range manager validates rows.
 */
import { act, fireEvent, render, screen } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NamedRangePanel } from "../components/NamedRangePanel";
import { SheetAiPanel } from "../components/SheetAiPanel";

type TokenCb = (chunk: { token: string; done: boolean; error?: string }) => void;

const originalModel = { ...window.tessera.model };

function installModel() {
  const cbs: TokenCb[] = [];
  window.tessera.model.generate = vi
    .fn()
    .mockResolvedValue(undefined) as unknown as typeof window.tessera.model.generate;
  window.tessera.model.onToken = vi.fn((cb: TokenCb) => {
    cbs.push(cb);
    return () => {
      const i = cbs.indexOf(cb);
      if (i >= 0) cbs.splice(i, 1);
    };
  }) as unknown as typeof window.tessera.model.onToken;
  return {
    emit: (chunk: { token: string; done: boolean; error?: string }) => {
      for (const cb of [...cbs]) cb(chunk);
    },
  };
}

afterEach(() => {
  window.tessera.model = { ...originalModel };
  vi.clearAllMocks();
});

describe("SheetAiPanel", () => {
  it("generates, validates, and inserts a formula", async () => {
    const { emit } = installModel();
    const onInsert = vi.fn();
    render(
      <SheetAiPanel
        columns={["Item", "Status", "Amount"]}
        rows={[["a", "paid", "10"]]}
        activeCellRef="D2"
        selectionRef="D2"
        onInsertFormula={onInsert}
        onClose={() => undefined}
      />,
    );

    fireEvent.change(screen.getByTestId("sheet-ai-request"), {
      target: { value: "sum amount where status is paid" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("sheet-ai-run"));
    });
    await act(async () => {
      emit({ token: '=SUMIF(B2:B100,"paid",C2:C100)', done: false });
      emit({ token: "", done: true });
    });

    const formula = await screen.findByTestId("sheet-ai-formula");
    expect(formula.textContent).toBe('=SUMIF(B2:B100,"paid",C2:C100)');

    fireEvent.click(screen.getByTestId("sheet-ai-insert"));
    expect(onInsert).toHaveBeenCalledWith('=SUMIF(B2:B100,"paid",C2:C100)');
  });

  it("does not offer Insert for an unparseable formula", async () => {
    const { emit } = installModel();
    render(
      <SheetAiPanel
        columns={["A"]}
        rows={[["1"]]}
        activeCellRef="B1"
        onInsertFormula={vi.fn()}
        onClose={() => undefined}
      />,
    );
    fireEvent.change(screen.getByTestId("sheet-ai-request"), {
      target: { value: "broken" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("sheet-ai-run"));
    });
    await act(async () => {
      emit({ token: "=SUM(A1:", done: false });
      emit({ token: "", done: true });
    });
    expect(screen.queryByTestId("sheet-ai-insert")).toBeNull();
    expect(screen.getByRole("alert").textContent).toMatch(/#ERR!|did not return/);
  });
});

describe("NamedRangePanel", () => {
  it("adds a valid named range and rejects an invalid one", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <NamedRangePanel ranges={[]} onChange={onChange} onClose={() => undefined} />,
    );

    // A cell-shaped name is rejected: the Add button stays disabled.
    fireEvent.change(screen.getByLabelText("New named-range name"), {
      target: { value: "A1" },
    });
    fireEvent.change(screen.getByLabelText("New named-range reference"), {
      target: { value: "B2:B10" },
    });
    expect(screen.getByTestId("sheet-nr-add")).toBeDisabled();

    // A valid name enables Add and emits the new range.
    fireEvent.change(screen.getByLabelText("New named-range name"), {
      target: { value: "Revenue" },
    });
    expect(screen.getByTestId("sheet-nr-add")).not.toBeDisabled();
    fireEvent.click(screen.getByTestId("sheet-nr-add"));
    expect(onChange).toHaveBeenCalledWith([
      { name: "Revenue", range: "B2:B10" },
    ]);

    rerender(
      <NamedRangePanel
        ranges={[{ name: "Revenue", range: "B2:B10" }]}
        onChange={onChange}
        onClose={() => undefined}
      />,
    );
    expect(screen.getByTestId("sheet-nr-row-0")).toBeTruthy();
  });

  it("flags a duplicate name across rows (case-insensitive)", () => {
    // Two rows colliding on name (one lower-cased) — the panel must
    // surface a duplicate error rather than silently last-wins'ing it.
    render(
      <NamedRangePanel
        ranges={[
          { name: "Revenue", range: "A1:A3" },
          { name: "revenue", range: "B1:B3" },
        ]}
        onChange={() => undefined}
        onClose={() => undefined}
      />,
    );

    expect(screen.getAllByText(/Duplicate name/i).length).toBeGreaterThan(0);
  });
});
