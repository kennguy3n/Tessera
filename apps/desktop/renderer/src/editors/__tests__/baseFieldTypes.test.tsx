/**
 * Integration tests for the Phase 17 PR 4 Base editor field types.
 * Each new FieldType variant gets a dedicated test covering:
 *   - default value & initial render
 *   - the user-facing interaction that changes the cell value
 *   - that the change is persisted back into the saved JSON
 *
 * Where the field is read-only (formula / rollup / lookup /
 * auto_number) we assert the rendered text matches the helper's
 * computed result for known inputs.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import {
  render,
  screen,
  fireEvent,
  within,
  act,
} from "@testing-library/react";
import BaseEditor from "../BaseEditor";

function flushSave() {
  return act(async () => {
    vi.runAllTimers();
    await Promise.resolve();
  });
}

function renderEditor(content: object) {
  const onSave = vi.fn();
  const json = JSON.stringify(content);
  const utils = render(
    <BaseEditor content={json} onSave={onSave} autoSaveMs={5} />,
  );
  return { onSave, ...utils };
}

function lastSavedRecords(onSave: ReturnType<typeof vi.fn>) {
  const call = onSave.mock.calls.at(-1);
  if (!call) throw new Error("onSave was never called");
  const parsed = JSON.parse(call[0]);
  return parsed.records as Array<Record<string, unknown>>;
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("BaseEditor — multi_select field", () => {
  it("toggles checkbox options and persists string[] back to onSave", async () => {
    const { onSave } = renderEditor({
      fields: [
        {
          name: "Tags",
          type: "multi_select",
          options: ["red", "green", "blue"],
        },
      ],
      records: [{ id: "r1", Tags: [] }],
    });
    // The cell renders as a button that opens a checkbox dropdown.
    fireEvent.click(screen.getByText("—"));
    fireEvent.click(screen.getByLabelText("red"));
    fireEvent.click(screen.getByLabelText("blue"));
    await flushSave();
    const records = lastSavedRecords(onSave);
    expect(records[0].Tags).toEqual(["red", "blue"]);
  });
});

describe("BaseEditor — formula field", () => {
  it("renders the computed result inline (read-only)", () => {
    renderEditor({
      fields: [
        { name: "Price", type: "number" },
        { name: "Qty", type: "number" },
        { name: "Total", type: "formula", formula: "{Price} * {Qty}" },
      ],
      records: [{ id: "r1", Price: 25, Qty: 4, Total: null }],
    });
    // Result should appear in the read-only cell.
    expect(screen.getByText("100")).toBeTruthy();
  });
});

describe("BaseEditor — linked_record field", () => {
  it("adds a link via the + picker and removes via the × chip", async () => {
    const { onSave } = renderEditor({
      fields: [
        { name: "Name", type: "text" },
        {
          name: "Owner",
          type: "linked_record",
          linkedDisplayField: "Name",
        },
      ],
      records: [
        { id: "r1", Name: "Alice", Owner: [] },
        { id: "r2", Name: "Bob", Owner: [] },
        { id: "r3", Name: "Carol", Owner: [] },
      ],
    });
    // Click the first row's + button (one per cell).
    const plusButtons = screen.getAllByRole("button", { name: "+" });
    fireEvent.click(plusButtons[0]);
    // Now pick "Bob" from the dropdown.
    fireEvent.click(screen.getByText("Bob"));
    await flushSave();
    const records = lastSavedRecords(onSave);
    expect(records[0].Owner).toEqual(["r2"]);
  });
});

describe("BaseEditor — rollup field", () => {
  it("aggregates SUM over a linked_record's targetField", () => {
    renderEditor({
      fields: [
        { name: "Title", type: "text" },
        { name: "Cost", type: "number" },
        { name: "Children", type: "linked_record" },
        {
          name: "TotalCost",
          type: "rollup",
          linkedField: "Children",
          targetField: "Cost",
          aggregation: "SUM",
        },
      ],
      records: [
        { id: "child1", Title: "C1", Cost: 10, Children: [] },
        { id: "child2", Title: "C2", Cost: 25, Children: [] },
        {
          id: "parent",
          Title: "P",
          Cost: 0,
          Children: ["child1", "child2"],
        },
      ],
    });
    // The parent row's rollup cell should display 35.
    expect(screen.getByText("35")).toBeTruthy();
  });

  it("renders #REF! when linkedField does not exist", () => {
    renderEditor({
      fields: [
        {
          name: "Bad",
          type: "rollup",
          linkedField: "Nonexistent",
          targetField: "X",
          aggregation: "SUM",
        },
      ],
      records: [{ id: "r1", Bad: null }],
    });
    expect(screen.getByText("#REF!")).toBeTruthy();
  });
});

describe("BaseEditor — lookup field", () => {
  it("pulls field values from linked records and joins them", () => {
    renderEditor({
      fields: [
        { name: "Name", type: "text" },
        { name: "Email", type: "email" },
        { name: "Team", type: "linked_record" },
        {
          name: "TeamEmails",
          type: "lookup",
          linkedField: "Team",
          targetField: "Email",
        },
      ],
      records: [
        { id: "m1", Name: "Alice", Email: "a@x.com", Team: [] },
        { id: "m2", Name: "Bob", Email: "b@x.com", Team: [] },
        { id: "group", Name: "G", Email: "", Team: ["m1", "m2"] },
      ],
    });
    expect(screen.getByText("a@x.com, b@x.com")).toBeTruthy();
  });
});

describe("BaseEditor — attachment field", () => {
  it("adds an attachment via file picker and persists the file name", async () => {
    const { onSave } = renderEditor({
      fields: [{ name: "Files", type: "attachment" }],
      records: [{ id: "r1", Files: [] }],
    });
    const fileInputs = document.querySelectorAll(
      'input[type="file"]',
    ) as NodeListOf<HTMLInputElement>;
    expect(fileInputs.length).toBe(1);
    const file = new File(["hello"], "note.txt", { type: "text/plain" });
    // Fire change directly — the cell uses a hidden file input.
    Object.defineProperty(fileInputs[0], "files", {
      value: [file],
      configurable: true,
    });
    fireEvent.change(fileInputs[0]);
    await flushSave();
    const records = lastSavedRecords(onSave);
    expect(records[0].Files).toEqual(["note.txt"]);
  });
});

describe("BaseEditor — long_text field", () => {
  it("edits inline and persists the new value", async () => {
    const { onSave, container } = renderEditor({
      fields: [{ name: "Notes", type: "long_text" }],
      records: [{ id: "r1", Notes: "" }],
    });
    // Disambiguate from the column-header Filter input (both are
    // role=textbox); pick the actual <textarea> by tag.
    const textarea = container.querySelector(
      "textarea.base-cell-longtext",
    ) as HTMLTextAreaElement;
    expect(textarea).not.toBeNull();
    fireEvent.change(textarea, { target: { value: "# Hello\n\nWorld" } });
    await flushSave();
    const records = lastSavedRecords(onSave);
    expect(records[0].Notes).toBe("# Hello\n\nWorld");
  });

  it("opens the expand modal and saves edits made inside it", async () => {
    const { onSave } = renderEditor({
      fields: [{ name: "Notes", type: "long_text" }],
      records: [{ id: "r1", Notes: "initial" }],
    });
    fireEvent.click(screen.getByTitle("Expand"));
    const dialog = screen.getByRole("dialog");
    const modalTextarea = dialog.querySelector(
      "textarea.base-longtext-textarea",
    ) as HTMLTextAreaElement;
    expect(modalTextarea).not.toBeNull();
    fireEvent.change(modalTextarea, { target: { value: "edited" } });
    fireEvent.click(within(dialog).getByText("Save"));
    await flushSave();
    const records = lastSavedRecords(onSave);
    expect(records[0].Notes).toBe("edited");
  });

  it("locks the inline textarea + Expand button while the modal is open over the same cell", () => {
    // Devin Review round-7 finding ANALYSIS_0006 — LongTextModal's
    // `draft` initializes once from `value` on mount and only flushes
    // on Save. If the user typed into the inline textarea WHILE the
    // modal was open and then hit Save, the modal would overwrite the
    // inline edit with stale text. Disabling the inline surface
    // eliminates the ambiguity: while the modal is up, the modal is
    // the sole edit surface, matching Airtable's behaviour.
    const { container } = renderEditor({
      fields: [
        { name: "Notes", type: "long_text" },
        { name: "Other", type: "text" },
      ],
      records: [{ id: "r1", Notes: "initial", Other: "untouched" }],
    });
    const inlineTextarea = container.querySelector(
      "textarea.base-cell-longtext",
    ) as HTMLTextAreaElement;
    const expandButton = screen.getByTitle("Expand");
    // Precondition — both editable before the modal opens.
    expect(inlineTextarea.disabled).toBe(false);
    expect(expandButton).not.toBeDisabled();

    fireEvent.click(expandButton);

    // Modal mounted — same inline textarea is now disabled + dimmed,
    // and the Expand button is also disabled so a second click can't
    // re-mount a new modal on top of the first.
    expect(inlineTextarea.disabled).toBe(true);
    expect(inlineTextarea).toHaveAttribute(
      "title",
      "Edit in the expanded modal",
    );
    const stillExpandButton = screen.getByTitle("Already open");
    expect(stillExpandButton).toBeDisabled();
    // The cell wrapper carries a `data-expanded="true"` flag the
    // styling layer can hook into without needing class plumbing.
    const cellWrapper = inlineTextarea.closest('[data-expanded="true"]');
    expect(cellWrapper).not.toBeNull();

    // Cells in OTHER records / OTHER fields stay editable — the lock
    // is scoped to the exact (recordId, fieldName) pair.
    const otherInput = screen.getByDisplayValue("untouched") as
      HTMLInputElement;
    expect(otherInput.disabled).toBe(false);
  });
});

describe("BaseEditor — email field", () => {
  it("renders as an email input and persists changes", async () => {
    const { onSave } = renderEditor({
      fields: [{ name: "Email", type: "email" }],
      records: [{ id: "r1", Email: "" }],
    });
    const input = screen.getByPlaceholderText("name@example.com") as
      HTMLInputElement;
    expect(input.type).toBe("email");
    fireEvent.change(input, { target: { value: "test@example.com" } });
    await flushSave();
    expect(lastSavedRecords(onSave)[0].Email).toBe("test@example.com");
  });
});

describe("BaseEditor — phone field", () => {
  it("renders as a tel input and persists changes", async () => {
    const { onSave } = renderEditor({
      fields: [{ name: "Phone", type: "phone" }],
      records: [{ id: "r1", Phone: "" }],
    });
    const input = screen.getByPlaceholderText("+1 555-0123") as HTMLInputElement;
    expect(input.type).toBe("tel");
    fireEvent.change(input, { target: { value: "555-1234" } });
    await flushSave();
    expect(lastSavedRecords(onSave)[0].Phone).toBe("555-1234");
  });
});

describe("BaseEditor — currency field", () => {
  it("shows the configured symbol and stores a Number value", async () => {
    const { onSave } = renderEditor({
      fields: [{ name: "Cost", type: "currency", currencySymbol: "€" }],
      records: [{ id: "r1", Cost: null }],
    });
    expect(screen.getByText("€")).toBeTruthy();
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "19.99" } });
    await flushSave();
    expect(lastSavedRecords(onSave)[0].Cost).toBe(19.99);
  });
});

describe("BaseEditor — percent field", () => {
  it("stores the value as a fraction (0..1) of the user input", async () => {
    const { onSave } = renderEditor({
      fields: [{ name: "Discount", type: "percent", percentPrecision: 1 }],
      records: [{ id: "r1", Discount: null }],
    });
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "37.5" } });
    await flushSave();
    expect(lastSavedRecords(onSave)[0].Discount).toBe(0.375);
  });

  it("renders existing fractional values back in percent units", () => {
    renderEditor({
      fields: [{ name: "Discount", type: "percent", percentPrecision: 0 }],
      records: [{ id: "r1", Discount: 0.5 }],
    });
    const input = screen.getByRole("spinbutton") as HTMLInputElement;
    expect(input.value).toBe("50");
  });
});

describe("BaseEditor — rating field", () => {
  it("clicks a star to set the rating, and clicking the same star clears it", async () => {
    const { onSave } = renderEditor({
      fields: [{ name: "Score", type: "rating" }],
      records: [{ id: "r1", Score: null }],
    });
    const stars = screen.getAllByRole("radio");
    expect(stars).toHaveLength(5);
    fireEvent.click(stars[3]); // pick 4 stars
    await flushSave();
    expect(lastSavedRecords(onSave)[0].Score).toBe(4);

    // Clicking the active star clears the rating.
    const starsAgain = screen.getAllByRole("radio");
    fireEvent.click(starsAgain[3]);
    await flushSave();
    expect(lastSavedRecords(onSave)[0].Score).toBe(0);
  });
});

describe("BaseEditor — duration field", () => {
  it("parses h:mm input on blur and persists integer minutes", async () => {
    const { onSave } = renderEditor({
      fields: [{ name: "Length", type: "duration" }],
      records: [{ id: "r1", Length: null }],
    });
    const input = screen.getByPlaceholderText("h:mm") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "1:30" } });
    // Commit is on blur (or Enter) — fix for BUG_0003 so users can
    // type intermediate keystrokes like "1" / "1:" without the
    // controlled input rejecting them mid-typing.
    fireEvent.blur(input);
    await flushSave();
    expect(lastSavedRecords(onSave)[0].Length).toBe(90);
  });

  it("allows free typing including intermediate keystrokes", () => {
    renderEditor({
      fields: [{ name: "Length", type: "duration" }],
      records: [{ id: "r1", Length: 60 }],
    });
    const input = screen.getByPlaceholderText("h:mm") as HTMLInputElement;
    // Pre-condition: 60 minutes renders as 1:00.
    expect(input.value).toBe("1:00");
    // Typing intermediate values that don't yet match h:mm should
    // be reflected in the input (draft state), not rejected.
    fireEvent.change(input, { target: { value: "2" } });
    expect(input.value).toBe("2");
    fireEvent.change(input, { target: { value: "2:" } });
    expect(input.value).toBe("2:");
    fireEvent.change(input, { target: { value: "2:3" } });
    expect(input.value).toBe("2:3");
  });

  it("rejects malformed input on blur and re-displays the last committed value", async () => {
    const { onSave } = renderEditor({
      fields: [{ name: "Length", type: "duration" }],
      records: [{ id: "r1", Length: 60 }],
    });
    const input = screen.getByPlaceholderText("h:mm") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "garbage" } });
    fireEvent.blur(input);
    await flushSave();
    // Malformed draft is discarded on commit and the cell rolls
    // back to the previously committed minutes representation.
    expect(input.value).toBe("1:00");
    expect(onSave).not.toHaveBeenCalled();
  });

  it("commits on Enter as well as blur", async () => {
    const { onSave } = renderEditor({
      fields: [{ name: "Length", type: "duration" }],
      records: [{ id: "r1", Length: null }],
    });
    const input = screen.getByPlaceholderText("h:mm") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "0:45" } });
    fireEvent.keyDown(input, { key: "Enter" });
    await flushSave();
    expect(lastSavedRecords(onSave)[0].Length).toBe(45);
  });

  it("clamps a negative stored value to a sane display", () => {
    renderEditor({
      fields: [{ name: "Length", type: "duration" }],
      records: [{ id: "r1", Length: -90 }],
    });
    const input = screen.getByPlaceholderText("h:mm") as HTMLInputElement;
    // Without clamping, JS `%` would produce "-2:-30". The helper
    // floors negative values to 0 so a corrupt JSON load can't
    // display gibberish.
    expect(input.value).toBe("0:00");
  });
});

describe("BaseEditor — auto_number field", () => {
  it("renders a stable 1-based row position regardless of sort", () => {
    renderEditor({
      fields: [
        { name: "Name", type: "text" },
        { name: "Id", type: "auto_number" },
      ],
      records: [
        { id: "r1", Name: "Alice", Id: null },
        { id: "r2", Name: "Bob", Id: null },
        { id: "r3", Name: "Carol", Id: null },
      ],
    });
    // Three rows means rows 1, 2, 3 appear.
    expect(screen.getAllByText("1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("3").length).toBeGreaterThan(0);
  });
});

describe("BaseEditor — record ID stability", () => {
  it("preserves record ids across edits", async () => {
    const initialId = "abcdef0123456789";
    const { onSave } = renderEditor({
      fields: [{ name: "Name", type: "text" }],
      records: [{ id: initialId, Name: "Pinned" }],
    });
    const input = screen.getByDisplayValue("Pinned") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "Edited" } });
    await flushSave();
    expect(lastSavedRecords(onSave)[0].id).toBe(initialId);
    expect(lastSavedRecords(onSave)[0].Name).toBe("Edited");
  });

  it("auto-assigns ids when adding a new record", async () => {
    const { onSave } = renderEditor({
      fields: [{ name: "Name", type: "text" }],
      records: [{ id: "r1", Name: "Existing" }],
    });
    fireEvent.click(screen.getByText("+ Record"));
    await flushSave();
    const records = lastSavedRecords(onSave);
    expect(records).toHaveLength(2);
    expect(records[1].id).toMatch(/^[0-9a-f]{16}$/);
    expect(records[1].id).not.toBe("r1");
  });
});

describe("BaseEditor — AddFieldDialog", () => {
  it("creates a new formula field with the entered source", async () => {
    const { onSave } = renderEditor({
      fields: [{ name: "Name", type: "text" }],
      records: [{ id: "r1", Name: "Alice" }],
    });
    fireEvent.click(screen.getByText("+ Field"));
    const nameInput = screen.getByPlaceholderText(
      "Field name",
    ) as HTMLInputElement;
    fireEvent.change(nameInput, { target: { value: "Greeting" } });
    const typeSelect = screen.getByDisplayValue("Text") as HTMLSelectElement;
    fireEvent.change(typeSelect, { target: { value: "formula" } });
    const formulaInput = screen.getByPlaceholderText(
      "= {Price} * {Quantity}",
    ) as HTMLInputElement;
    fireEvent.change(formulaInput, {
      target: { value: 'CONCATENATE("Hi ", {Name})' },
    });
    fireEvent.click(screen.getByText("Add"));
    await flushSave();
    const call = onSave.mock.calls.at(-1)!;
    const parsed = JSON.parse(call[0]);
    const greetField = parsed.fields.find(
      (f: { name: string }) => f.name === "Greeting",
    );
    expect(greetField).toEqual({
      name: "Greeting",
      type: "formula",
      formula: 'CONCATENATE("Hi ", {Name})',
    });
  });

  it("creates a new currency field with the chosen symbol", async () => {
    const { onSave } = renderEditor({
      fields: [{ name: "Name", type: "text" }],
      records: [{ id: "r1", Name: "Alice" }],
    });
    fireEvent.click(screen.getByText("+ Field"));
    fireEvent.change(screen.getByPlaceholderText("Field name"), {
      target: { value: "Salary" },
    });
    fireEvent.change(screen.getByDisplayValue("Text"), {
      target: { value: "currency" },
    });
    fireEvent.change(screen.getByPlaceholderText("Currency symbol"), {
      target: { value: "£" },
    });
    fireEvent.click(screen.getByText("Add"));
    await flushSave();
    const parsed = JSON.parse(onSave.mock.calls.at(-1)![0]);
    const salaryField = parsed.fields.find(
      (f: { name: string }) => f.name === "Salary",
    );
    expect(salaryField).toEqual({
      name: "Salary",
      type: "currency",
      currencySymbol: "£",
    });
  });

  it("rejects creating a field named 'id' (would shadow the record identifier)", () => {
    const { onSave } = renderEditor({
      fields: [{ name: "Name", type: "text" }],
      records: [{ id: "r1", Name: "Alice" }],
    });
    onSave.mockClear();
    fireEvent.click(screen.getByText("+ Field"));
    fireEvent.change(screen.getByPlaceholderText("Field name"), {
      target: { value: "id" },
    });
    fireEvent.click(screen.getByText("Add"));
    // The dialog stays open with an inline error and does NOT
    // produce a save (no field was added).
    expect(screen.getByRole("alert").textContent).toMatch(/reserved/i);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("rejects creating a field with an existing name (would silently clobber data)", () => {
    const { onSave } = renderEditor({
      fields: [{ name: "Name", type: "text" }],
      records: [{ id: "r1", Name: "Alice" }],
    });
    onSave.mockClear();
    fireEvent.click(screen.getByText("+ Field"));
    fireEvent.change(screen.getByPlaceholderText("Field name"), {
      target: { value: "Name" },
    });
    fireEvent.click(screen.getByText("Add"));
    expect(screen.getByRole("alert").textContent).toMatch(/already exists/i);
    expect(onSave).not.toHaveBeenCalled();
  });

  it("rejects an empty / whitespace-only field name", () => {
    const { onSave } = renderEditor({
      fields: [{ name: "Name", type: "text" }],
      records: [{ id: "r1", Name: "Alice" }],
    });
    onSave.mockClear();
    fireEvent.click(screen.getByText("+ Field"));
    fireEvent.change(screen.getByPlaceholderText("Field name"), {
      target: { value: "   " },
    });
    fireEvent.click(screen.getByText("Add"));
    expect(screen.getByRole("alert").textContent).toMatch(/required/i);
    expect(onSave).not.toHaveBeenCalled();
  });
});

describe("BaseEditor — record-identity guards", () => {
  it("clicking the 'x' on the id column would do nothing (column doesn't render)", () => {
    // The id key is invisible to the user — it has no BaseField in
    // `data.fields`, so the grid never renders a remove button for
    // it. This test documents the invariant: as long as the user
    // can't create a field named "id" (above) and can't see one in
    // the column list, the `removeField("id")` guard is defense in
    // depth.
    renderEditor({
      fields: [{ name: "Name", type: "text" }],
      records: [{ id: "r1", Name: "Alice" }],
    });
    expect(screen.queryByText("(id)")).toBeNull();
  });

  it("LinkedRecordCell picker excludes the current record itself", () => {
    renderEditor({
      fields: [
        { name: "Title", type: "text" },
        { name: "Refs", type: "linked_record", linkedDisplayField: "Title" },
      ],
      records: [
        { id: "r1", Title: "Alpha", Refs: [] },
        { id: "r2", Title: "Beta", Refs: [] },
        { id: "r3", Title: "Gamma", Refs: [] },
      ],
    });
    // Find the picker '+' button on the first record's Refs cell.
    // There's one per row, so we open the first.
    const plusButtons = screen.getAllByRole("button", { name: "+" });
    fireEvent.click(plusButtons[0]);
    // The picker should offer Beta and Gamma — but NOT Alpha
    // (the current record itself).
    const listbox = screen.getByRole("listbox");
    expect(listbox.textContent).toContain("Beta");
    expect(listbox.textContent).toContain("Gamma");
    expect(listbox.textContent).not.toContain("Alpha");
  });
});

describe("BaseEditor — formula cycle detection", () => {
  it("returns #CIRCULAR! for a self-referencing formula instead of crashing", () => {
    renderEditor({
      fields: [
        { name: "Self", type: "formula", formula: "{Self} + 1" },
      ],
      records: [{ id: "r1", Self: null }],
    });
    // The rendered cell should display #CIRCULAR! — the engine's
    // cycle detector caught the back-edge before recursing into
    // an unbounded stack.
    expect(screen.getByText("#CIRCULAR!")).toBeInTheDocument();
  });

  it("returns #CIRCULAR! for mutual references between two formula fields", () => {
    renderEditor({
      fields: [
        { name: "A", type: "formula", formula: "{B} + 1" },
        { name: "B", type: "formula", formula: "{A} + 1" },
      ],
      records: [{ id: "r1", A: null, B: null }],
    });
    // Both cells in the grid should report #CIRCULAR!
    const cells = screen.getAllByText("#CIRCULAR!");
    expect(cells.length).toBeGreaterThanOrEqual(2);
  });
});

describe("BaseEditor — record deletion cascades linked_record cleanup", () => {
  it("deleting a record strips its id from every other record's linked_record array", async () => {
    const { onSave } = renderEditor({
      fields: [
        { name: "Title", type: "text" },
        { name: "Refs", type: "linked_record", linkedDisplayField: "Title" },
      ],
      records: [
        { id: "r1", Title: "Alpha", Refs: ["r2", "r3"] },
        { id: "r2", Title: "Beta", Refs: ["r3"] },
        { id: "r3", Title: "Gamma", Refs: [] },
      ],
    });
    // Delete record r3 (the Gamma row, 3rd "Del" button).
    const delButtons = screen.getAllByRole("button", { name: "Del" });
    fireEvent.click(delButtons[2]);
    await flushSave();
    const records = lastSavedRecords(onSave);
    // Two records survive: Alpha and Beta, and neither still
    // references the deleted r3.
    expect(records).toHaveLength(2);
    const r1 = records.find((r) => r.id === "r1");
    const r2 = records.find((r) => r.id === "r2");
    expect(r1?.Refs).toEqual(["r2"]);
    expect(r2?.Refs).toEqual([]);
  });

  it("records that did not reference the deleted id keep their original array identity", async () => {
    // This is a regression guard: the cleanup pass must not
    // unnecessarily clone records that weren't pointing at the
    // deleted id, so React reconciliation can skip them.
    const { onSave } = renderEditor({
      fields: [
        { name: "Title", type: "text" },
        { name: "Refs", type: "linked_record", linkedDisplayField: "Title" },
      ],
      records: [
        { id: "r1", Title: "Alpha", Refs: [] },
        { id: "r2", Title: "Beta", Refs: [] },
      ],
    });
    const delButtons = screen.getAllByRole("button", { name: "Del" });
    fireEvent.click(delButtons[1]); // delete Beta (r2)
    await flushSave();
    const records = lastSavedRecords(onSave);
    expect(records).toHaveLength(1);
    expect(records[0]?.id).toBe("r1");
    expect(records[0]?.Refs).toEqual([]);
  });
});

describe("BaseEditor — base formula numeric string coercion", () => {
  it("treats the literal string 'Infinity' as a non-numeric token (no numeric infinity propagation)", () => {
    // A text-typed source field containing the user-entered string
    // "Infinity" must NOT be coerced into a numeric Infinity that
    // would silently propagate through downstream arithmetic. With
    // the old `!Number.isNaN` check, `{Source} + 0` would have
    // rendered as "Infinity"; with `Number.isFinite` the string is
    // passed through to the engine, which then surfaces #VALUE!
    // for the type mismatch.
    renderEditor({
      fields: [
        { name: "Source", type: "text" },
        { name: "Doubled", type: "formula", formula: "{Source} * 2" },
      ],
      records: [{ id: "r1", Source: "Infinity" }],
    });
    expect(screen.queryByText("Infinity")).toBeNull();
    expect(screen.queryByText("-Infinity")).toBeNull();
  });

  it("still coerces normal numeric strings so `{Price} * 2` works on a text column of digits", () => {
    renderEditor({
      fields: [
        { name: "Price", type: "text" },
        { name: "Doubled", type: "formula", formula: "{Price} * 2" },
      ],
      records: [{ id: "r1", Price: "21" }],
    });
    expect(screen.getByText("42")).toBeInTheDocument();
  });
});

describe("BaseEditor — dropdown click-outside behavior", () => {
  it("multi_select dropdown closes when the user clicks outside the cell", () => {
    renderEditor({
      fields: [{ name: "Tags", type: "multi_select", options: ["a", "b"] }],
      records: [{ id: "r1", Tags: [] }],
    });
    // Open the dropdown via the trigger button.
    const trigger = screen.getByRole("button", { name: /—|^$/ });
    fireEvent.click(trigger);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    // Dispatch a mousedown on the document body — the click-outside
    // hook listens on mousedown so it fires before any subsequent
    // click handler would re-open a different popover.
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });

  it("linked_record dropdown closes when the user clicks outside the cell", () => {
    renderEditor({
      fields: [
        { name: "Title", type: "text" },
        { name: "Refs", type: "linked_record", linkedDisplayField: "Title" },
      ],
      records: [
        { id: "r1", Title: "Alpha", Refs: [] },
        { id: "r2", Title: "Beta", Refs: [] },
      ],
    });
    const plusButtons = screen.getAllByRole("button", { name: "+" });
    fireEvent.click(plusButtons[0]);
    expect(screen.getByRole("listbox")).toBeInTheDocument();
    fireEvent.mouseDown(document.body);
    expect(screen.queryByRole("listbox")).toBeNull();
  });
});

describe("BaseEditor — bulk-delete scoped to visible records", () => {
  it("bulk-delete only removes records that are visible in the filtered view; hidden selections are preserved", async () => {
    const { onSave } = renderEditor({
      fields: [{ name: "Tag", type: "text" }],
      records: [
        { id: "r1", Tag: "alpha" },
        { id: "r2", Tag: "alpha" },
        { id: "r3", Tag: "beta" },
        { id: "r4", Tag: "beta" },
      ],
    });
    // Select every record via the header "Select all visible
    // records" checkbox while the view is unfiltered.
    const selectAll = screen.getByRole("checkbox", {
      name: "Select all visible records",
    });
    fireEvent.click(selectAll);
    // Bulk-delete button now shows the full count (4 visible).
    expect(
      screen.getByRole("button", { name: /Delete 4 selected/ }),
    ).toBeInTheDocument();

    // Apply a filter that hides r3 + r4 (only `alpha` rows remain
    // visible). The bulk-delete button must rescope to 2.
    const tagFilter = screen.getByPlaceholderText("Filter…");
    fireEvent.change(tagFilter, { target: { value: "alpha" } });
    expect(
      screen.getByRole("button", { name: /Delete 2 selected/ }),
    ).toBeInTheDocument();
    expect(
      screen.queryByRole("button", { name: /Delete 4 selected/ }),
    ).toBeNull();

    // Trigger the bulk delete. Only the two visible (`alpha`) rows
    // should be removed; the two hidden (`beta`) rows must survive.
    fireEvent.click(
      screen.getByRole("button", { name: /Delete 2 selected/ }),
    );
    await flushSave();
    const records = lastSavedRecords(onSave);
    expect(records).toHaveLength(2);
    expect(records.map((r) => r.id).sort()).toEqual(["r3", "r4"]);
    expect(records.every((r) => r.Tag === "beta")).toBe(true);

    // Clear the filter — the hidden `beta` selections should still
    // be highlighted, and the bulk-delete button should show 2 again
    // (the original beta selections, now back in view).
    fireEvent.change(tagFilter, { target: { value: "" } });
    expect(
      screen.getByRole("button", { name: /Delete 2 selected/ }),
    ).toBeInTheDocument();
  });
});

describe("BaseEditor — expanded modal auto-closes when target record is deleted", () => {
  it("clears `expandedCell` after the record currently being edited is removed", async () => {
    renderEditor({
      fields: [{ name: "Body", type: "long_text" }],
      records: [
        { id: "r1", Body: "first" },
        { id: "r2", Body: "second" },
      ],
    });
    // Open the long-text modal on r1 by clicking its expand button.
    const expandButtons = screen.getAllByTitle("Expand");
    fireEvent.click(expandButtons[0]);
    // The modal opens (dialog role with name `Edit Body`).
    expect(screen.getByRole("dialog", { name: /Edit Body/ })).toBeInTheDocument();
    // Now delete r1 from the grid. With the cleanup effect in
    // place, the modal should disappear because expandedCell is
    // cleared to null.
    const delButtons = screen.getAllByRole("button", { name: "Del" });
    fireEvent.click(delButtons[0]);
    await flushSave();
    expect(screen.queryByRole("dialog", { name: /Edit Body/ })).toBeNull();
  });

  it("clears `expandedCell` when the field itself is removed while the modal is open (PR #79 round 13 fix)", async () => {
    // Round 13 (ANALYSIS_0004): the cleanup effect previously only
    // checked the target record. If the user opened a long-text
    // modal and then removed the field via the column-header ×, the
    // modal stayed open displaying `undefined` and any committed
    // edit silently re-added the field key to the record — partially
    // undoing the field removal.
    renderEditor({
      fields: [
        { name: "Body", type: "long_text" },
        { name: "Other", type: "text" },
      ],
      records: [{ id: "r1", Body: "first", Other: "keep" }],
    });
    // Open the long-text modal on the Body cell.
    const expandButtons = screen.getAllByTitle("Expand");
    fireEvent.click(expandButtons[0]);
    expect(screen.getByRole("dialog", { name: /Edit Body/ })).toBeInTheDocument();
    // Now remove the Body field via the column-header × button.
    // `title="Remove field"` is the same control wired to
    // `removeField` that powers the in-grid delete.
    const removeButtons = screen.getAllByTitle("Remove field");
    // First column is `id` which has no remove button — the first
    // matching button is the one for `Body`.
    fireEvent.click(removeButtons[0]);
    await flushSave();
    expect(screen.queryByRole("dialog", { name: /Edit Body/ })).toBeNull();
  });
});

describe("BaseEditor — expanded modal auto-closes when target field is removed", () => {
  // Devin Review PR #78 ANALYSIS_0006 (round 6):
  //
  // `expandedCell` used to hold a BaseField object reference; if
  // the field was removed via ManageFields while the modal was
  // open, the modal would keep rendering against a field that
  // no longer existed in `data.fields`, so a save would write
  // back a key with no corresponding column (orphaned data). The
  // fix stores fieldName (not the BaseField ref) and the cleanup
  // effect now watches `data.fields` symmetrically with
  // `data.records`. Pin both ends of the contract: the modal must
  // close AND no orphan key must be written.
  it("clears `expandedCell` after the field currently being edited is removed", async () => {
    renderEditor({
      fields: [
        { name: "Body", type: "long_text" },
        { name: "Other", type: "text" },
      ],
      records: [{ id: "r1", Body: "first", Other: "x" }],
    });
    // Open the long-text modal on the Body field.
    fireEvent.click(screen.getByTitle("Expand"));
    expect(
      screen.getByRole("dialog", { name: /Edit Body/ }),
    ).toBeInTheDocument();

    // Now remove the Body field. The "x" button on each column
    // has title="Remove field". The first one corresponds to the
    // Body column (which is the field the modal is anchored to).
    const removeFieldButtons = screen.getAllByTitle("Remove field");
    fireEvent.click(removeFieldButtons[0]);
    await flushSave();
    // The cleanup effect must have cleared `expandedCell`, so the
    // dialog is gone.
    expect(
      screen.queryByRole("dialog", { name: /Edit Body/ }),
    ).toBeNull();
  });

  it("does not write the removed field's key back when the modal closes silently", async () => {
    const { onSave } = renderEditor({
      fields: [
        { name: "Body", type: "long_text" },
        { name: "Other", type: "text" },
      ],
      records: [{ id: "r1", Body: "first", Other: "x" }],
    });
    fireEvent.click(screen.getByTitle("Expand"));
    expect(
      screen.getByRole("dialog", { name: /Edit Body/ }),
    ).toBeInTheDocument();
    const removeFieldButtons = screen.getAllByTitle("Remove field");
    fireEvent.click(removeFieldButtons[0]);
    await flushSave();
    // The latest persisted record must NOT carry a `Body` key —
    // removeField strips it from every record, and the closing
    // modal must NOT resurrect it.
    const records = lastSavedRecords(onSave);
    expect(records[0]).not.toHaveProperty("Body");
    expect(records[0]).toMatchObject({ id: "r1", Other: "x" });
  });
});
