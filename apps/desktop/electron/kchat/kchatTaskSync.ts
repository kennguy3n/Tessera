/**
 * Bidirectional Tessera ↔ KChat task mapping (Session 8 Task 6).
 *
 * This module holds the *pure* translation logic that sits between
 * Tessera's task store and KChat messages. It is deliberately free
 * of IPC, the bridge, and the KChat client so it can be unit-tested
 * in isolation:
 *
 *   - {@link formatTaskForKchat} renders a Tessera task as a KChat
 *     message body. The wiring layer posts the result via
 *     `KchatClient.createPost`.
 *   - {@link detectTaskFromMessage} inspects an inbound KChat
 *     message and, when it looks like an actionable task, returns a
 *     normalised {@link DetectedTask} that the wiring layer turns
 *     into a `bridgeCreateTask` call. Non-task chatter returns
 *     `null` so the auto-create path stays opt-in and quiet.
 *
 * **Loop prevention.** A task Tessera posts to KChat must not be
 * re-detected and turned back into a new Tessera task. Every
 * Tessera-authored message carries {@link TESSERA_TASK_FOOTER};
 * `detectTaskFromMessage` short-circuits to `null` whenever it sees
 * that marker, so the round-trip terminates.
 */
import {
  TASK_PRIORITIES,
  TASK_STATUSES,
  type TaskPriority,
  type TaskStatus,
} from "../../shared/types";

/** Marker appended to every Tessera-authored task post. */
export const TESSERA_TASK_FOOTER = "— via Tessera";

/** A Tessera task in the minimal shape the formatter needs. */
export interface TaskForKchat {
  id: string;
  title: string;
  description?: string | null;
  status?: string | null;
  priority?: string | null;
  dueDate?: string | null;
  assignee?: string | null;
}

/** Normalised task extracted from an inbound KChat message. */
export interface DetectedTask {
  title: string;
  description: string;
  status: TaskStatus;
  priority: TaskPriority;
  dueDate: string | null;
}

const DEFAULT_STATUS: TaskStatus = "todo";
const DEFAULT_PRIORITY: TaskPriority = "medium";

/**
 * Keyword prefixes that mark a message as an actionable task. Each
 * is matched case-insensitively at the start of the (trimmed) first
 * non-empty line, optionally preceded by a markdown list bullet.
 */
const TASK_PREFIXES = [
  "todo:",
  "task:",
  "action item:",
  "action:",
  "follow up:",
  "follow-up:",
  "/task",
];

/** Markdown checkbox at the start of a line: `- [ ]`, `* [ ]`, `[ ]`. */
const CHECKBOX_RE = /^(?:[-*]\s+)?\[(?: |x|X)\]\s+(.*)$/;

/** Bullet/keyword prefix capture, e.g. `- TODO: ship it`. */
const PREFIX_RE = /^(?:[-*]\s+)?(.*)$/;

/**
 * Inline priority hint: `!high`, `(priority: critical)`,
 * `[priority=low]`. Returns the matched priority or null.
 */
const PRIORITY_RE = /(?:!|priority\s*[:=]\s*)\b(low|medium|high|critical)\b/i;

/** Inline due-date hint: `due: 2026-06-10` / `due 2026-06-10`. */
const DUE_RE = /due\s*[:=]?\s*(\d{4}-\d{2}-\d{2})/i;

/**
 * Render a Tessera task as a KChat message body. The output is
 * markdown KChat renders natively, and always ends with
 * {@link TESSERA_TASK_FOOTER} so the inbound detector skips it.
 */
export function formatTaskForKchat(task: TaskForKchat): string {
  const title = task.title.trim() || "(untitled task)";
  const status = normaliseStatus(task.status) ?? DEFAULT_STATUS;
  const priority = normalisePriority(task.priority) ?? DEFAULT_PRIORITY;

  const metaParts = [`Status: ${status}`, `Priority: ${priority}`];
  if (task.dueDate && task.dueDate.trim().length > 0) {
    metaParts.push(`Due: ${task.dueDate.trim()}`);
  }
  if (task.assignee && task.assignee.trim().length > 0) {
    metaParts.push(`Assignee: ${task.assignee.trim()}`);
  }

  const lines = [`**[Task] ${title}**`, metaParts.join(" · ")];
  const description = (task.description ?? "").trim();
  if (description.length > 0) {
    lines.push("", description);
  }
  lines.push("", `${TESSERA_TASK_FOOTER} (task ${task.id})`);
  return lines.join("\n");
}

/**
 * Inspect a KChat message and extract a task when it is clearly
 * actionable. Returns `null` for ordinary chatter and for any
 * Tessera-authored task post (loop prevention).
 *
 * Recognised shapes (first non-empty line):
 *   - markdown checkbox: `- [ ] Ship the release`
 *   - keyword prefix: `TODO: ...`, `Task: ...`, `Action item: ...`,
 *     `Follow up: ...`, `/task ...`
 *
 * Inline hints anywhere in the message refine the result:
 *   - `!high` / `priority: critical` → priority
 *   - `due: 2026-06-10` → dueDate
 */
export function detectTaskFromMessage(message: unknown): DetectedTask | null {
  if (typeof message !== "string") return null;
  const text = message.trim();
  if (text.length === 0) return null;
  // Loop guard: never re-ingest a task Tessera itself posted.
  if (text.includes(TESSERA_TASK_FOOTER)) return null;

  const lines = text.split(/\r?\n/);
  const firstLine = lines.find((l) => l.trim().length > 0);
  if (firstLine === undefined) return null;

  const titleRaw = extractTaskTitle(firstLine.trim());
  if (titleRaw === null) return null;

  const title = titleRaw.trim();
  if (title.length === 0) return null;

  // Description is everything after the first non-empty line, with
  // leading blank lines trimmed.
  const firstIdx = lines.indexOf(firstLine);
  const description = lines
    .slice(firstIdx + 1)
    .join("\n")
    .trim();

  const priority = extractPriority(text) ?? DEFAULT_PRIORITY;
  const dueDate = extractDueDate(text);

  return {
    title: stripInlineHints(title),
    description,
    status: DEFAULT_STATUS,
    priority,
    dueDate,
  };
}

/**
 * Return the task title from `line` if it carries a task marker, or
 * `null` when the line is not task-shaped.
 */
function extractTaskTitle(line: string): string | null {
  const checkbox = CHECKBOX_RE.exec(line);
  if (checkbox) return checkbox[1] ?? "";

  // Strip a leading bullet, then test for a keyword prefix.
  const stripped = PREFIX_RE.exec(line)?.[1] ?? line;
  const lower = stripped.toLowerCase();
  for (const prefix of TASK_PREFIXES) {
    if (lower.startsWith(prefix)) {
      return stripped.slice(prefix.length).trim();
    }
  }
  return null;
}

/** Remove inline priority / due hints from the extracted title. */
function stripInlineHints(title: string): string {
  return title
    .replace(PRIORITY_RE, "")
    .replace(DUE_RE, "")
    .replace(/\s{2,}/g, " ")
    .trim();
}

function extractPriority(text: string): TaskPriority | null {
  const m = PRIORITY_RE.exec(text);
  if (!m) return null;
  return normalisePriority(m[1]);
}

function extractDueDate(text: string): string | null {
  const m = DUE_RE.exec(text);
  if (!m) return null;
  const value = m[1];
  // Reject impossible calendar values (e.g. 2026-13-40) so a typo
  // doesn't become a bogus due date.
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  if (parsed.toISOString().slice(0, 10) !== value) return null;
  return value;
}

function normaliseStatus(value: unknown): TaskStatus | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return (TASK_STATUSES as readonly string[]).includes(lower)
    ? (lower as TaskStatus)
    : null;
}

function normalisePriority(value: unknown): TaskPriority | null {
  if (typeof value !== "string") return null;
  const lower = value.trim().toLowerCase();
  return (TASK_PRIORITIES as readonly string[]).includes(lower)
    ? (lower as TaskPriority)
    : null;
}
