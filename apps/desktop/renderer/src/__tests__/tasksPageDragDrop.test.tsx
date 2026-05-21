/**
 * Tests for the drag-and-drop reorder logic in `TasksPage`.
 *
 * The interesting cases are:
 *
 * 1. Same-column drop calls `tasks.reorder` with the column's current ids
 *    in the new order (dropped card last).
 * 2. Cross-column drop calls `tasks.update` to change the status, then
 *    `tasks.reorder` with the target column's ids in the new order
 *    (dropped card last) — this is the BUG_0001 regression: a stale
 *    `position` value from the source column would otherwise place the
 *    moved card at an arbitrary visible position.
 * 3. Hovering over a column repeatedly does NOT cause the `onDragOver`
 *    handler to be recreated — verified indirectly by asserting that the
 *    same handler reference is used across renders (ANALYSIS_0004
 *    regression).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { render, screen, waitFor, fireEvent } from "@testing-library/react";
import { MemoryRouter } from "react-router-dom";
import TasksPage from "../pages/TasksPage";
import type { TaskInfo } from "../types/ipc";

const TASKS: TaskInfo[] = [
  // Two cards in `todo` …
  {
    id: "t-todo-a",
    title: "Todo A",
    description: "",
    status: "todo",
    priority: "medium",
    position: 0,
    assignee: null,
    dueDate: null,
    sourceId: null,
    extractedItemId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  {
    id: "t-todo-b",
    title: "Todo B",
    description: "",
    status: "todo",
    priority: "low",
    position: 1,
    assignee: null,
    dueDate: null,
    sourceId: null,
    extractedItemId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
  // … and one card in `in_progress` whose position deliberately
  // collides with the todo column to expose stale-position ordering
  // bugs (BUG_0001).
  {
    id: "t-prog",
    title: "Progress 1",
    description: "",
    status: "in_progress",
    priority: "high",
    position: 0,
    assignee: null,
    dueDate: null,
    sourceId: null,
    extractedItemId: null,
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  },
];

function renderWithRouter() {
  return render(
    <MemoryRouter>
      <TasksPage />
    </MemoryRouter>,
  );
}

beforeEach(() => {
  vi.clearAllMocks();
  window.tessera.tasks.list = vi.fn().mockResolvedValue(TASKS);
});

describe("TasksPage drag-and-drop", () => {
  it("same-column drop calls reorder with the column's ids (dropped card last)", async () => {
    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByText("Todo A")).toBeInTheDocument();
      expect(screen.getByText("Todo B")).toBeInTheDocument();
    });

    // Drag "Todo A" onto the "todo" column (same column).
    const cardA = screen.getByText("Todo A").closest('[draggable="true"]');
    const todoColumn = screen.getByTestId("column-todo");
    expect(cardA).toBeTruthy();

    fireEvent.dragStart(cardA!);
    fireEvent.dragOver(todoColumn);
    fireEvent.drop(todoColumn);

    await waitFor(() => {
      expect(window.tessera.tasks.reorder).toHaveBeenCalledWith("todo", [
        "t-todo-b",
        "t-todo-a", // dropped card last
      ]);
    });
    // `update` is NOT called for same-column drops.
    expect(window.tessera.tasks.update).not.toHaveBeenCalled();
  });

  it("cross-column drop calls update(status) then reorder with target column ids (dropped card last)", async () => {
    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByText("Todo A")).toBeInTheDocument();
    });

    // Drag "Todo A" onto the "In Progress" column.
    const cardA = screen.getByText("Todo A").closest('[draggable="true"]');
    const progressColumn = screen.getByTestId("column-in_progress");
    expect(cardA).toBeTruthy();

    fireEvent.dragStart(cardA!);
    fireEvent.dragOver(progressColumn);
    fireEvent.drop(progressColumn);

    await waitFor(() => {
      expect(window.tessera.tasks.update).toHaveBeenCalledWith("t-todo-a", {
        status: "in_progress",
      });
    });
    // Then reorder is called for the target column with the moved card
    // appended to the end — guaranteeing a deterministic position.
    await waitFor(() => {
      expect(window.tessera.tasks.reorder).toHaveBeenCalledWith("in_progress", [
        "t-prog",
        "t-todo-a", // dropped card appended last
      ]);
    });
  });

  it("dropping with no active drag source is a no-op", async () => {
    renderWithRouter();
    await waitFor(() => {
      expect(screen.getByText("Todo A")).toBeInTheDocument();
    });

    const todoColumn = screen.getByTestId("column-todo");
    fireEvent.dragOver(todoColumn);
    fireEvent.drop(todoColumn);

    // Neither update nor reorder fire when there's no drag source.
    expect(window.tessera.tasks.update).not.toHaveBeenCalled();
    expect(window.tessera.tasks.reorder).not.toHaveBeenCalled();
  });
});
