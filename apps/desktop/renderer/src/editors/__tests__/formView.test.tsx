/**
 * Integration tests for the Base **form** view.
 *
 * Mounts the real `BaseEditor`, switches to the Form tab (proving the
 * view is wired into the switcher/registry), fills the form, submits,
 * and asserts a new record with the typed values lands in the saved
 * JSON. Also checks the pristine-form guard disables submit.
 */
import { describe, it, expect, vi } from "vitest";
import {
  render,
  screen,
  fireEvent,
  within,
  act,
} from "@testing-library/react";
import BaseEditor from "../BaseEditor";
import type { BaseRecord } from "../baseEditorTypes";

function flushSave() {
  return act(async () => {
    vi.runAllTimers();
    await Promise.resolve();
  });
}

function renderEditor(content: object) {
  const onSave = vi.fn();
  const utils = render(
    <BaseEditor
      content={JSON.stringify(content)}
      onSave={onSave}
      autoSaveMs={5}
    />,
  );
  return { onSave, ...utils };
}

function lastRecords(onSave: ReturnType<typeof vi.fn>): BaseRecord[] {
  const call = onSave.mock.calls.at(-1);
  if (!call) throw new Error("onSave was never called");
  return (JSON.parse(call[0] as string) as { records: BaseRecord[] }).records;
}

const CONTENT = {
  fields: [
    { name: "Title", type: "text" },
    { name: "Count", type: "number" },
    { name: "Done", type: "checkbox" },
  ],
  records: [] as BaseRecord[],
};

describe("FormView (via BaseEditor)", () => {
  it("appears in the view switcher and renders a fillable form", () => {
    renderEditor(CONTENT);
    fireEvent.click(screen.getByRole("tab", { name: "Form" }));
    const form = screen.getByTestId("base-form-view");
    expect(within(form).getByLabelText("Title")).toBeTruthy();
    expect(within(form).getByLabelText("Count")).toBeTruthy();
    expect(within(form).getByLabelText("Done")).toBeTruthy();
  });

  it("disables submit on a pristine form", () => {
    renderEditor(CONTENT);
    fireEvent.click(screen.getByRole("tab", { name: "Form" }));
    const submit = screen.getByTestId("base-form-submit") as HTMLButtonElement;
    expect(submit.disabled).toBe(true);
  });

  it("creates a typed record on submit and resets the form", async () => {
    vi.useFakeTimers();
    try {
      const { onSave } = renderEditor(CONTENT);
      fireEvent.click(screen.getByRole("tab", { name: "Form" }));

      fireEvent.change(screen.getByLabelText("Title"), {
        target: { value: "First task" },
      });
      fireEvent.change(screen.getByLabelText("Count"), {
        target: { value: "3" },
      });
      fireEvent.click(screen.getByLabelText("Done"));

      fireEvent.click(screen.getByTestId("base-form-submit"));
      await flushSave();

      const records = lastRecords(onSave);
      expect(records).toHaveLength(1);
      expect(records[0]).toMatchObject({
        Title: "First task",
        Count: 3,
        Done: true,
      });

      // Form reset: the title input is empty and submit is disabled again.
      const title = screen.getByLabelText("Title") as HTMLInputElement;
      expect(title.value).toBe("");
      const submit = screen.getByTestId(
        "base-form-submit",
      ) as HTMLButtonElement;
      expect(submit.disabled).toBe(true);
      // Confirmation status is shown.
      expect(screen.getByTestId("base-form-status").textContent).toContain(
        "1 record",
      );
    } finally {
      vi.useRealTimers();
    }
  });
});
