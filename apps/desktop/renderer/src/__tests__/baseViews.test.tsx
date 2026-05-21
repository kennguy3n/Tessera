/**
 * Tests for the four non-grid Base views: Kanban, Calendar, Timeline,
 * Gallery. We exercise BaseEditor at the top so we cover the view
 * switcher AND each view's interaction with the canonical record list
 * end-to-end.
 *
 * Each view is responsible for:
 *  - Reading records from the same `BaseContent` model the grid uses.
 *  - Routing user actions (drag a kanban card, click a calendar day,
 *    delete a gallery card) back through `onUpdateCell` /
 *    `onAddRecordWith` / `onRemoveRecord`, which we assert on by
 *    inspecting the JSON that `onSave` ultimately receives after the
 *    debounce timer.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { render, screen, fireEvent, act } from "@testing-library/react";
import BaseEditor from "../editors/BaseEditor";

function renderEditor(content: object, onSave = vi.fn()) {
  const json = JSON.stringify(content);
  return {
    onSave,
    ...render(
      <BaseEditor content={json} onSave={onSave} autoSaveMs={10} />,
    ),
  };
}

function flushSave() {
  // BaseEditor uses setTimeout to debounce writes — advance fake
  // timers, then yield a microtask so the resulting state propagates.
  return act(async () => {
    vi.runAllTimers();
    await Promise.resolve();
  });
}

const KANBAN_BASE = {
  fields: [
    { name: "Title", type: "text" },
    { name: "Status", type: "select", options: ["Todo", "Doing", "Done"] },
  ],
  records: [
    { Title: "Card A", Status: "Todo" },
    { Title: "Card B", Status: "Doing" },
    // "Legacy" — option no longer exists, should fall through to Other
    { Title: "Card C", Status: "Archived" },
  ],
};

const CALENDAR_BASE = {
  fields: [
    { name: "Title", type: "text" },
    { name: "When", type: "date" },
  ],
  records: [
    { Title: "Event 1", When: "2026-05-10" },
    { Title: "Event 2", When: "2026-05-10" },
    { Title: "Event 3", When: "2026-05-11" },
  ],
};

const TIMELINE_BASE = {
  fields: [
    { name: "Title", type: "text" },
    { name: "Start", type: "date" },
    { name: "End", type: "date" },
  ],
  records: [
    { Title: "Task 1", Start: "2026-05-01", End: "2026-05-10" },
    { Title: "Task 2", Start: "2026-05-15", End: "2026-05-20" },
    // Missing end — should land in the "Unscheduled" bucket.
    { Title: "Task 3", Start: "2026-05-15", End: "" },
    // End before start — also unscheduled with the explanatory reason.
    { Title: "Task 4", Start: "2026-05-20", End: "2026-05-15" },
  ],
};

const GALLERY_BASE = {
  fields: [
    { name: "Title", type: "text" },
    { name: "Cover", type: "url" },
    { name: "Owner", type: "text" },
  ],
  records: [
    { Title: "Item One", Cover: "https://example.com/a.png", Owner: "Alice" },
    { Title: "Item Two", Cover: "", Owner: "Bob" },
  ],
};

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
  vi.restoreAllMocks();
});

describe("BaseEditor view switcher", () => {
  it("renders Grid by default and switches to each view by clicking the tab", () => {
    renderEditor(KANBAN_BASE);
    // Grid view shows the column-header buttons (sortable field names).
    // We assert per-tab content by switching and checking.
    expect(screen.getAllByRole("tab")).toHaveLength(5);
    expect(screen.getByRole("tab", { name: "Grid" })).toHaveAttribute(
      "aria-selected",
      "true",
    );

    fireEvent.click(screen.getByRole("tab", { name: "Kanban" }));
    expect(screen.getByRole("tab", { name: "Kanban" })).toHaveAttribute(
      "aria-selected",
      "true",
    );
    // Kanban renders the configured columns by default.
    expect(screen.getByText(/Todo \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Doing \(1\)/)).toBeInTheDocument();
    expect(screen.getByText(/Done \(0\)/)).toBeInTheDocument();
  });
});

describe("KanbanView", () => {
  it("buckets records into columns by the select-field value and an Other catch-all", () => {
    renderEditor(KANBAN_BASE);
    fireEvent.click(screen.getByRole("tab", { name: "Kanban" }));

    expect(screen.getByText("Card A")).toBeInTheDocument();
    expect(screen.getByText("Card B")).toBeInTheDocument();
    expect(screen.getByText("Card C")).toBeInTheDocument();
    // "Archived" isn't a column option — Card C lands in Other.
    expect(screen.getByText(/Other \(1\)/)).toBeInTheDocument();
  });

  it("dropping a card on a different column updates that card's status field", async () => {
    const { onSave } = renderEditor(KANBAN_BASE);
    fireEvent.click(screen.getByRole("tab", { name: "Kanban" }));

    const cardA = screen.getByText("Card A").closest('[draggable="true"]')!;
    // Find the "Done" column container — it's the closest scrollable
    // div in the kanban that contains the header text.
    const doneHeader = screen.getByText(/Done \(0\)/);
    const doneColumn = doneHeader.closest("div")!.parentElement!;

    fireEvent.dragStart(cardA, {
      dataTransfer: {
        effectAllowed: "",
        setData: vi.fn(),
        getData: vi.fn().mockReturnValue("0"),
      },
    });
    fireEvent.dragOver(doneColumn, {
      dataTransfer: { dropEffect: "" },
    });
    fireEvent.drop(doneColumn, {
      dataTransfer: { getData: vi.fn().mockReturnValue("0") },
    });

    await flushSave();
    expect(onSave).toHaveBeenCalled();
    const lastCall = onSave.mock.calls[onSave.mock.calls.length - 1][0];
    const saved = JSON.parse(lastCall);
    const cardARecord = saved.records.find(
      (r: Record<string, unknown>) => r.Title === "Card A",
    );
    expect(cardARecord.Status).toBe("Done");
  });

  it("dropping a legacy-bucketed card on the Other column preserves its original value", async () => {
    // Regression for Devin Review BUG finding
    // BUG_pr-review-job-c6936a0b5b8e426798d47bfdc62111c0_0001:
    // Card C carries `Status: "Archived"`, a value no longer present
    // in the field's `options`. The Kanban view buckets it into the
    // "Other" catch-all so it stays visible. The bug was that re-
    // dropping Card C onto the same Other column would silently
    // rewrite its Status to "" — destroying the legacy value the
    // user could see on the card — because `String("Archived") !== ""`
    // bypassed the same-value guard. The fix is to treat the Other
    // column as a display-only target: drops onto it are no-ops.
    const { onSave } = renderEditor(KANBAN_BASE);
    fireEvent.click(screen.getByRole("tab", { name: "Kanban" }));

    const cardC = screen.getByText("Card C").closest('[draggable="true"]')!;
    const otherHeader = screen.getByText(/Other \(1\)/);
    const otherColumn = otherHeader.closest("div")!.parentElement!;

    fireEvent.dragStart(cardC, {
      dataTransfer: {
        effectAllowed: "",
        setData: vi.fn(),
        getData: vi.fn().mockReturnValue("2"),
      },
    });
    fireEvent.dragOver(otherColumn, {
      dataTransfer: { dropEffect: "" },
    });
    fireEvent.drop(otherColumn, {
      dataTransfer: { getData: vi.fn().mockReturnValue("2") },
    });

    await flushSave();

    // Either no save fires (the cell didn't change) OR the saved
    // payload still carries the legacy "Archived" value — never "".
    if (onSave.mock.calls.length > 0) {
      const last = JSON.parse(
        onSave.mock.calls[onSave.mock.calls.length - 1][0],
      );
      const cardCRecord = last.records.find(
        (r: Record<string, unknown>) => r.Title === "Card C",
      );
      expect(cardCRecord.Status).toBe("Archived");
    }
    // Card C must still appear in the Other column with the original
    // value intact, not silently move to a different bucket.
    expect(screen.getByText("Card C")).toBeInTheDocument();
    expect(screen.getByText(/Other \(1\)/)).toBeInTheDocument();
  });

  it("clicking the '+' button on a column header creates a record pre-bucketed there", async () => {
    const { onSave } = renderEditor(KANBAN_BASE);
    fireEvent.click(screen.getByRole("tab", { name: "Kanban" }));

    // Each non-"Other" column has a "+" button next to its header.
    const doneHeader = screen.getByText(/Done \(0\)/);
    const plus = doneHeader.parentElement!.querySelector("button")!;
    fireEvent.click(plus);

    await flushSave();
    const saved = JSON.parse(onSave.mock.calls.at(-1)![0]);
    expect(saved.records).toHaveLength(4);
    const created = saved.records[saved.records.length - 1];
    expect(created.Status).toBe("Done");
  });
});

describe("CalendarView", () => {
  it("renders chips for records on the configured date field", () => {
    renderEditor(CALENDAR_BASE);
    fireEvent.click(screen.getByRole("tab", { name: "Calendar" }));

    // Navigate the anchor to May 2026 — the toolbar starts on
    // "today" (real now), so we step until the header shows our
    // event month. The dataset is small and bounded so a finite
    // loop is fine.
    let header = screen.getByText(/^[A-Z][a-z]+ \d{4}$/);
    let attempts = 0;
    while (!header.textContent?.includes("May 2026") && attempts < 24) {
      const prev = screen.getByRole("button", { name: "←" });
      const next = screen.getByRole("button", { name: "→" });
      // Decide direction by comparing the year prefix once.
      const now = new Date();
      const target = new Date(2026, 4, 1);
      if (now < target) {
        fireEvent.click(next);
      } else {
        fireEvent.click(prev);
      }
      header = screen.getByText(/^[A-Z][a-z]+ \d{4}$/);
      attempts += 1;
    }
    // Both events on the 10th show up — "+1 more" wouldn't apply
    // since the day has only 2 records (chip cap is 3).
    expect(screen.getAllByText("Event 1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Event 2").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Event 3").length).toBeGreaterThan(0);
  });

  it("clicking an empty day creates a record pre-populated with that day", async () => {
    const { onSave } = renderEditor({
      fields: [{ name: "When", type: "date" }],
      records: [],
    });
    fireEvent.click(screen.getByRole("tab", { name: "Calendar" }));

    // The first day cell in any month grid is some date (could be
    // last-month padding). Just click the first calendar cell —
    // we only care that a record is created with SOME YYYY-MM-DD
    // value in the right field.
    const days = screen
      .getAllByRole("button")
      .filter((b) => /^Click to add a record on/.test(b.getAttribute("title") ?? ""));
    expect(days.length).toBeGreaterThan(0);
    fireEvent.click(days[0]);

    await flushSave();
    const saved = JSON.parse(onSave.mock.calls.at(-1)![0]);
    expect(saved.records).toHaveLength(1);
    expect(typeof saved.records[0].When).toBe("string");
    expect(saved.records[0].When).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });
});

describe("TimelineView", () => {
  it("schedules valid records and lists invalid ones as unscheduled with reasons", () => {
    renderEditor(TIMELINE_BASE);
    fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));

    // Task 1 and Task 2 should appear as bar labels.
    expect(screen.getAllByText("Task 1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("Task 2").length).toBeGreaterThan(0);

    // Unscheduled section lists Task 3 (missing End) and Task 4
    // (End < Start) with their reason text.
    expect(screen.getByText(/Unscheduled \(2\)/)).toBeInTheDocument();
    expect(screen.getByText(/missing End/)).toBeInTheDocument();
    expect(screen.getByText(/End is before Start/)).toBeInTheDocument();
  });

  it("shows a guided empty state when there's only one date field", () => {
    renderEditor({
      fields: [
        { name: "Title", type: "text" },
        { name: "Only", type: "date" },
      ],
      records: [],
    });
    fireEvent.click(screen.getByRole("tab", { name: "Timeline" }));
    expect(
      screen.getByText(/Timeline needs two date fields/),
    ).toBeInTheDocument();
  });
});

describe("GalleryView", () => {
  it("renders one card per record with a cover image when a URL field is set", () => {
    renderEditor(GALLERY_BASE);
    fireEvent.click(screen.getByRole("tab", { name: "Gallery" }));

    expect(screen.getByText("Item One")).toBeInTheDocument();
    expect(screen.getByText("Item Two")).toBeInTheDocument();
    // The first record has a URL cover — an <img> must be rendered.
    const img = document.querySelector("img");
    expect(img).toBeTruthy();
    expect(img!.getAttribute("src")).toBe("https://example.com/a.png");
  });

  it("deleting a card removes the underlying record", async () => {
    const { onSave } = renderEditor(GALLERY_BASE);
    fireEvent.click(screen.getByRole("tab", { name: "Gallery" }));

    const deleteButtons = screen
      .getAllByRole("button", { name: "Delete" });
    fireEvent.click(deleteButtons[0]);

    await flushSave();
    const saved = JSON.parse(onSave.mock.calls.at(-1)![0]);
    expect(saved.records).toHaveLength(1);
    expect(saved.records[0].Title).toBe("Item Two");
  });
});
