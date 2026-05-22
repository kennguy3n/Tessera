/**
 * IPC handlers for the `tasks:*` channels.
 *
 * The bridge expects a JSON-encoded `CreateTaskRequest` /
 * `UpdateTaskRequest` because serde defaults and `Option<Option<...>>`
 * don't round-trip cleanly through napi's auto-generated TS bindings.
 * We accept a typed object from the renderer (validated by the zod
 * schemas in `./schemas.ts`), then re-serialize here, so the renderer
 * sees a normal IPC signature while the bridge keeps its strict Rust
 * deserialization (with `parse_opt_rfc3339` / `parse_opt_source_id`
 * validation surfacing parse errors as IPC rejections — see the
 * typed-parse regression tests in `tessera_bridge::tasks`).
 */
import { ipcMain } from "electron";
import { getBridge } from "../appState";
import { assertId, assertString, assertStringArray } from "./validate";
import { CreateTaskSchema, UpdateTaskSchema } from "./schemas";

export function registerTasksHandlers(): void {
  ipcMain.handle("tasks:create", async (_event, req: unknown) => {
    const parsed = CreateTaskSchema.parse(req);
    const bridge = getBridge();
    if (!bridge) throw new Error("Native bridge not available");
    // Map camelCase renderer field names to snake_case the bridge expects.
    const payload: Record<string, unknown> = {
      title: parsed.title,
      description: parsed.description ?? "",
      status: parsed.status ?? "todo",
      priority: parsed.priority ?? "medium",
      assignee: parsed.assignee ?? null,
      due_date: parsed.dueDate ?? null,
      source_id: parsed.sourceId ?? null,
      extracted_item_id: parsed.extractedItemId ?? null,
    };
    return bridge.bridgeCreateTask(JSON.stringify(payload));
  });

  ipcMain.handle("tasks:list", async () => {
    const bridge = getBridge();
    if (!bridge) throw new Error("Native bridge not available");
    return bridge.bridgeListTasks();
  });

  ipcMain.handle("tasks:get", async (_event, taskId: unknown) => {
    const validated = assertId(taskId, "taskId");
    const bridge = getBridge();
    if (!bridge) throw new Error("Native bridge not available");
    return bridge.bridgeGetTask(validated);
  });

  ipcMain.handle(
    "tasks:update",
    async (_event, taskId: unknown, req: unknown) => {
      const id = assertId(taskId, "taskId");
      const parsed = UpdateTaskSchema.parse(req);
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      const payload: Record<string, unknown> = {};
      if (parsed.title !== undefined) payload.title = parsed.title;
      if (parsed.description !== undefined)
        payload.description = parsed.description;
      if (parsed.status !== undefined) payload.status = parsed.status;
      if (parsed.priority !== undefined) payload.priority = parsed.priority;
      if (parsed.position !== undefined) payload.position = parsed.position;
      // `assignee` / `due_date` use the `Option<Option<...>>` sentinel
      // pattern on the bridge side:
      //   undefined (key omitted) -> field unchanged
      //   null                    -> explicit clear -> Some(None)
      //   string                  -> set            -> Some(Some(s))
      if (parsed.assignee !== undefined) payload.assignee = parsed.assignee;
      if (parsed.dueDate !== undefined) payload.due_date = parsed.dueDate;
      return bridge.bridgeUpdateTask(id, JSON.stringify(payload));
    },
  );

  ipcMain.handle("tasks:delete", async (_event, taskId: unknown) => {
    const validated = assertId(taskId, "taskId");
    const bridge = getBridge();
    if (!bridge) throw new Error("Native bridge not available");
    return bridge.bridgeDeleteTask(validated);
  });

  ipcMain.handle(
    "tasks:reorder",
    async (_event, status: unknown, ids: unknown) => {
      const s = assertString(status, "status", { maxLen: 64 });
      const idList = assertStringArray(ids, "ids", { itemMaxLen: 128 });
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      bridge.bridgeReorderTasks(s, idList);
    },
  );
}
