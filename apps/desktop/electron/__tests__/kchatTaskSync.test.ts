/**
 * Unit tests for bidirectional task-sync mapping (Session 8 Task 6):
 * `formatTaskForKchat` (Tessera → KChat) and `detectTaskFromMessage`
 * (KChat → Tessera), including the loop-prevention contract.
 */
import { describe, it, expect } from "vitest";
import {
  formatTaskForKchat,
  detectTaskFromMessage,
  TESSERA_TASK_FOOTER,
} from "../kchat/kchatTaskSync";

describe("formatTaskForKchat", () => {
  it("renders title, status, priority and the Tessera footer", () => {
    const msg = formatTaskForKchat({
      id: "t1",
      title: "Ship the release",
      status: "in_progress",
      priority: "high",
    });
    expect(msg).toContain("**[Task] Ship the release**");
    expect(msg).toContain("Status: in_progress");
    expect(msg).toContain("Priority: high");
    expect(msg).toContain(TESSERA_TASK_FOOTER);
    expect(msg).toContain("(task t1)");
  });

  it("defaults missing/invalid status & priority to todo/medium", () => {
    const msg = formatTaskForKchat({
      id: "t2",
      title: "x",
      status: "nonsense",
      priority: undefined,
    });
    expect(msg).toContain("Status: todo");
    expect(msg).toContain("Priority: medium");
  });

  it("includes due date and assignee when present", () => {
    const msg = formatTaskForKchat({
      id: "t3",
      title: "Plan offsite",
      dueDate: "2026-07-01",
      assignee: "alice",
    });
    expect(msg).toContain("Due: 2026-07-01");
    expect(msg).toContain("Assignee: alice");
  });

  it("appends the description body when provided", () => {
    const msg = formatTaskForKchat({
      id: "t4",
      title: "Write docs",
      description: "Cover the new API surface.",
    });
    expect(msg).toContain("Cover the new API surface.");
  });

  it("falls back to a placeholder for an empty title", () => {
    expect(formatTaskForKchat({ id: "t5", title: "   " })).toContain(
      "(untitled task)",
    );
  });

  it("round-trips: a formatted task is NOT re-detected (loop guard)", () => {
    const msg = formatTaskForKchat({
      id: "t6",
      title: "TODO: this looks like a task",
      priority: "high",
    });
    expect(detectTaskFromMessage(msg)).toBeNull();
  });
});

describe("detectTaskFromMessage", () => {
  it("returns null for ordinary chatter", () => {
    expect(detectTaskFromMessage("hey, lunch at noon?")).toBeNull();
    expect(detectTaskFromMessage("")).toBeNull();
    expect(detectTaskFromMessage("   ")).toBeNull();
  });

  it("returns null for non-string input", () => {
    expect(detectTaskFromMessage(undefined)).toBeNull();
    expect(detectTaskFromMessage(42)).toBeNull();
    expect(detectTaskFromMessage(null)).toBeNull();
  });

  it("detects a TODO: keyword prefix", () => {
    const t = detectTaskFromMessage("TODO: review the PR");
    expect(t).not.toBeNull();
    expect(t!.title).toBe("review the PR");
    expect(t!.status).toBe("todo");
    expect(t!.priority).toBe("medium");
  });

  it("detects a markdown checkbox, with and without a bullet", () => {
    expect(detectTaskFromMessage("- [ ] buy milk")!.title).toBe("buy milk");
    expect(detectTaskFromMessage("[x] already done")!.title).toBe(
      "already done",
    );
  });

  it("detects Action item:, Follow up:, and /task forms", () => {
    expect(detectTaskFromMessage("Action item: send invoice")!.title).toBe(
      "send invoice",
    );
    expect(detectTaskFromMessage("Follow up: ping vendor")!.title).toBe(
      "ping vendor",
    );
    expect(detectTaskFromMessage("/task draft the spec")!.title).toBe(
      "draft the spec",
    );
  });

  it("extracts an inline priority hint and strips it from the title", () => {
    const t = detectTaskFromMessage("TODO: fix the crash !critical");
    expect(t!.priority).toBe("critical");
    expect(t!.title).toBe("fix the crash");
  });

  it("supports the priority: form", () => {
    const t = detectTaskFromMessage("Task: triage priority: low");
    expect(t!.priority).toBe("low");
    expect(t!.title).toBe("triage");
  });

  it("extracts a valid due date and rejects an impossible one", () => {
    const ok = detectTaskFromMessage("TODO: release due: 2026-07-15");
    expect(ok!.dueDate).toBe("2026-07-15");

    const bad = detectTaskFromMessage("TODO: release due: 2026-13-40");
    expect(bad!.dueDate).toBeNull();
  });

  it("captures multi-line description after the first line", () => {
    const t = detectTaskFromMessage("TODO: ship\nremember to tag the release");
    expect(t!.title).toBe("ship");
    expect(t!.description).toBe("remember to tag the release");
  });

  it("never re-ingests a Tessera-authored task (loop prevention)", () => {
    const msg = `TODO: do the thing\n\n${TESSERA_TASK_FOOTER} (task abc)`;
    expect(detectTaskFromMessage(msg)).toBeNull();
  });

  it("returns null when the marker line has no actual title", () => {
    expect(detectTaskFromMessage("TODO:")).toBeNull();
    expect(detectTaskFromMessage("- [ ]   ")).toBeNull();
  });
});
