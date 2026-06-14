/**
 * Integration coverage for the Sheet AI assistant + named-range panels:
 * the generate → validate → insert flow only offers Insert for a
 * parseable formula, and the named-range manager validates rows.
 */
import {
  act,
  fireEvent,
  render,
  screen,
  waitFor,
} from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";

import { NamedRangePanel } from "../components/NamedRangePanel";
import { SheetAiPanel } from "../components/SheetAiPanel";
import { _resetActiveGenerationForTests } from "../../hooks/useActiveGeneration";

type TokenCb = (chunk: {
  token: string;
  done: boolean;
  error?: string;
}) => void;

const originalModel = { ...window.tessera.model };

function installModel() {
  const cbs: TokenCb[] = [];
  window.tessera.model.generate = vi
    .fn()
    .mockResolvedValue(
      undefined,
    ) as unknown as typeof window.tessera.model.generate;
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
    expect(screen.getByRole("alert").textContent).toMatch(
      /#ERR!|did not return/,
    );
  });

  it("runs the formula skill and inserts the validated final formula", async () => {
    _resetActiveGenerationForTests();
    const { emit } = installModel();
    const generate = window.tessera.model.generate as unknown as ReturnType<
      typeof vi.fn
    >;
    const onInsert = vi.fn();
    const onClose = vi.fn();
    render(
      <SheetAiPanel
        columns={["Item", "Status", "Amount"]}
        rows={[["a", "paid", "10"]]}
        activeCellRef="D2"
        selectionRef="D2"
        onInsertFormula={onInsert}
        onClose={onClose}
      />,
    );

    fireEvent.click(screen.getByTestId("sheet-ai-mode-skills"));
    fireEvent.change(screen.getByLabelText(/What should the formula do/i), {
      target: { value: "sum amount where status is paid" },
    });
    fireEvent.click(screen.getByTestId("skill-run"));

    // propose → self-check → repair: drive each of the skill's three steps.
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await act(async () => emit({ token: "=SUM(", done: false }));
    await act(async () => emit({ token: "", done: true }));
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    await act(async () => emit({ token: "needs a range", done: false }));
    await act(async () => emit({ token: "", done: true }));
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(3));
    await act(async () =>
      emit({ token: '=SUMIF(B2:B100,"paid",C2:C100)', done: false }),
    );
    await act(async () => emit({ token: "", done: true }));

    fireEvent.click(await screen.findByTestId("skill-apply"));
    expect(onInsert).toHaveBeenCalledWith('=SUMIF(B2:B100,"paid",C2:C100)');
    expect(onClose).toHaveBeenCalled();
  });

  it("surfaces a skill error when the final formula is unparseable", async () => {
    _resetActiveGenerationForTests();
    const { emit } = installModel();
    const generate = window.tessera.model.generate as unknown as ReturnType<
      typeof vi.fn
    >;
    const onInsert = vi.fn();
    render(
      <SheetAiPanel
        columns={["A"]}
        rows={[["1"]]}
        activeCellRef="B1"
        onInsertFormula={onInsert}
        onClose={() => undefined}
      />,
    );

    fireEvent.click(screen.getByTestId("sheet-ai-mode-skills"));
    fireEvent.change(screen.getByLabelText(/What should the formula do/i), {
      target: { value: "broken" },
    });
    fireEvent.click(screen.getByTestId("skill-run"));

    await waitFor(() => expect(generate).toHaveBeenCalledTimes(1));
    await act(async () => emit({ token: "=SUM(A1:", done: false }));
    await act(async () => emit({ token: "", done: true }));
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(2));
    await act(async () => emit({ token: "unbalanced parens", done: false }));
    await act(async () => emit({ token: "", done: true }));
    await waitFor(() => expect(generate).toHaveBeenCalledTimes(3));
    await act(async () => emit({ token: "=SUM(A1:", done: false }));
    await act(async () => emit({ token: "", done: true }));

    fireEvent.click(await screen.findByTestId("skill-apply"));
    expect(onInsert).not.toHaveBeenCalled();
    expect(screen.getByTestId("sheet-ai-skill-error")).toBeInTheDocument();
  });

  it("disables the mode-switch buttons while a quick generation streams", async () => {
    _resetActiveGenerationForTests();
    const { emit } = installModel();
    render(
      <SheetAiPanel
        columns={["Item", "Status", "Amount"]}
        rows={[["a", "paid", "10"]]}
        activeCellRef="D2"
        selectionRef="D2"
        onInsertFormula={vi.fn()}
        onClose={() => undefined}
      />,
    );

    fireEvent.change(screen.getByTestId("sheet-ai-request"), {
      target: { value: "sum amount where status is paid" },
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("sheet-ai-run"));
    });
    // A token WITHOUT a terminating `done` keeps the stream open.
    await act(async () => emit({ token: "=SUM(", done: false }));

    expect(screen.getByTestId("sheet-ai-mode-quick")).toBeDisabled();
    expect(screen.getByTestId("sheet-ai-mode-skills")).toBeDisabled();

    // Settle so the unmount-cancel doesn't act on a live run.
    await act(async () => emit({ token: "", done: true }));
  });

  it("clears a stale quick result when toggling modes", async () => {
    _resetActiveGenerationForTests();
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

    // A completed quick run leaves a streamed output + an invalid-formula
    // alert on screen.
    expect(screen.getByTestId("sheet-ai-output")).toBeInTheDocument();
    expect(screen.queryAllByRole("alert").length).toBeGreaterThan(0);

    // Toggling to skills and back clears the stale quick result.
    await act(async () => {
      fireEvent.click(screen.getByTestId("sheet-ai-mode-skills"));
    });
    await act(async () => {
      fireEvent.click(screen.getByTestId("sheet-ai-mode-quick"));
    });

    expect(screen.queryByTestId("sheet-ai-output")).toBeNull();
    expect(screen.queryAllByRole("alert")).toHaveLength(0);
  });
});

describe("NamedRangePanel", () => {
  it("adds a valid named range and rejects an invalid one", () => {
    const onChange = vi.fn();
    const { rerender } = render(
      <NamedRangePanel
        ranges={[]}
        onChange={onChange}
        onClose={() => undefined}
      />,
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
