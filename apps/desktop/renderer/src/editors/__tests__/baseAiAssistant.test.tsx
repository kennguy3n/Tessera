import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, act, fireEvent, waitFor } from "@testing-library/react";
import "@testing-library/jest-dom";

import BaseAiAssistant from "../BaseAiAssistant";
import { _resetActiveGenerationForTests } from "../../hooks/useActiveGeneration";
import type { GenerateChunk } from "../../types/ipc";
import type { BaseField } from "../baseEditorTypes";

// Token handlers registered by both the component's runner AND the
// useActiveGeneration hook subscribe through the same onToken mock, so
// keep a list and broadcast to all of them.
let handlers: ((chunk: GenerateChunk) => void)[] = [];
let generateMock = vi.fn();
let cancelMock = vi.fn();

function emit(chunk: GenerateChunk) {
  act(() => {
    for (const h of [...handlers]) h(chunk);
  });
}

/** Resolve the next generate() call by streaming `text` then done. */
function streamResponse(text: string) {
  emit({ token: text, done: false });
  emit({ token: "", done: true });
}

beforeEach(() => {
  _resetActiveGenerationForTests();
  handlers = [];
  generateMock = vi.fn().mockResolvedValue(undefined);
  cancelMock = vi.fn().mockResolvedValue(undefined);
  Object.defineProperty(window.tessera, "model", {
    configurable: true,
    value: {
      status: vi.fn().mockResolvedValue({ available: true, modelName: "local", status: "ready" }),
      start: vi.fn(),
      stop: vi.fn(),
      generate: generateMock,
      cancelJob: cancelMock,
      onToken: (cb: (chunk: GenerateChunk) => void) => {
        handlers.push(cb);
        return () => {
          handlers = handlers.filter((h) => h !== cb);
        };
      },
    },
  });
});

const fields: BaseField[] = [
  { name: "Name", type: "text" },
  { name: "Notes", type: "long_text" },
];
const records = [
  { id: "r1", Name: "Acme", Notes: "big customer" },
  { id: "r2", Name: "Beta", Notes: "" },
];

function setup(overrides: Partial<React.ComponentProps<typeof BaseAiAssistant>> = {}) {
  const props = {
    fields,
    records,
    selectedIds: new Set<string>(),
    onCreateTable: vi.fn(),
    onAddFields: vi.fn(),
    onApplyCellValues: vi.fn(),
    onClose: vi.fn(),
    ...overrides,
  };
  render(<BaseAiAssistant {...props} />);
  return props;
}

describe("BaseAiAssistant", () => {
  it("renders a local-first privacy note and mode tabs", () => {
    setup();
    expect(screen.getByText(/Runs entirely on your device/i)).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "New table" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Summarize" })).toBeInTheDocument();
  });

  it("generates a schema preview and creates a table on apply", async () => {
    const props = setup();
    fireEvent.change(screen.getByPlaceholderText(/Describe the table/i), {
      target: { value: "a CRM" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    streamResponse(
      JSON.stringify({
        tableName: "Customers",
        fields: [
          { name: "Company", type: "text" },
          { name: "Stage", type: "select", options: ["Lead", "Won"] },
        ],
      }),
    );
    await waitFor(() =>
      expect(screen.getByText(/Table: Customers/)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: "Create table" }));
    expect(props.onCreateTable).toHaveBeenCalledWith(
      "Customers",
      expect.arrayContaining([
        expect.objectContaining({ name: "Company", type: "text" }),
        expect.objectContaining({ name: "Stage", type: "select" }),
      ]),
    );
    expect(props.onClose).toHaveBeenCalled();
  });

  it("surfaces a parse error without applying anything", async () => {
    const props = setup();
    fireEvent.change(screen.getByPlaceholderText(/Describe the table/i), {
      target: { value: "junk" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    streamResponse("the model rambled but produced no json");
    await waitFor(() => expect(screen.getByRole("alert")).toBeInTheDocument());
    expect(props.onCreateTable).not.toHaveBeenCalled();
  });

  it("validates and adds an NL formula as a formula field", async () => {
    const props = setup();
    fireEvent.click(screen.getByRole("tab", { name: "Formula" }));
    fireEvent.change(screen.getByPlaceholderText(/Describe the formula/i), {
      target: { value: "uppercase the name" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    streamResponse("UPPER({Name})");
    await waitFor(() =>
      expect(screen.getByText("UPPER({Name})")).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Add as formula field/i }));
    expect(props.onAddFields).toHaveBeenCalledWith([
      expect.objectContaining({ type: "formula", formula: "UPPER({Name})" }),
    ]);
  });

  it("fills an empty column row-by-row and applies the preview", async () => {
    const props = setup();
    fireEvent.click(screen.getByRole("tab", { name: "Fill column" }));
    // Choose target field "Notes" (r2 has an empty Notes cell).
    fireEvent.change(screen.getByRole("combobox"), {
      target: { value: "Notes" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    // Only r2 is in scope (empty target); one generation expected.
    streamResponse("enriched note");
    await waitFor(() =>
      expect(screen.getByText(/Preview \(1 value\)/)).toBeInTheDocument(),
    );
    fireEvent.click(screen.getByRole("button", { name: /Apply to 1 record/i }));
    expect(props.onApplyCellValues).toHaveBeenCalledWith(
      "Notes",
      expect.any(Map),
    );
    const [, map] = vi.mocked(props.onApplyCellValues).mock.calls[0] as [
      string,
      Map<string, unknown>,
    ];
    expect(map.get("r2")).toBe("enriched note");
    expect(map.has("r1")).toBe(false);
  });

  it("summarizes records into prose", async () => {
    setup();
    fireEvent.click(screen.getByRole("tab", { name: "Summarize" }));
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    streamResponse("Two customers: Acme and Beta.");
    await waitFor(() =>
      expect(
        screen.getByText("Two customers: Acme and Beta."),
      ).toBeInTheDocument(),
    );
  });

  it("invokes cancelJob when Stop is clicked mid-generation", async () => {
    setup();
    fireEvent.change(screen.getByPlaceholderText(/Describe the table/i), {
      target: { value: "a CRM" },
    });
    fireEvent.click(screen.getByRole("button", { name: "Generate" }));
    // Stream a non-done token so the Stop control appears.
    emit({ token: "{", done: false });
    const stop = await screen.findByTestId("base-ai-stop");
    fireEvent.click(stop);
    expect(cancelMock).toHaveBeenCalled();
    // Flush the run so the busy state settles inside act() before the
    // test ends (otherwise the trailing setBusy(false) logs a warning).
    emit({ token: "", done: true });
    await waitFor(() =>
      expect(screen.getByTestId("base-ai-stop")).not.toBeInTheDocument(),
    ).catch(() => undefined);
    await waitFor(() =>
      expect(
        (screen.getByRole("button", { name: "Generate" }) as HTMLButtonElement)
          .disabled,
      ).toBe(false),
    );
  });
});
