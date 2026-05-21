import { useCallback, useEffect, useState } from "react";
import type {
  CreateTaskRequest,
  TaskInfo,
  UpdateTaskRequest,
} from "../types/ipc";

interface UseTaskListResult {
  tasks: TaskInfo[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

function getApi() {
  return typeof window !== "undefined" ? window.tessera : undefined;
}

export function useTaskList(): UseTaskListResult {
  const [tasks, setTasks] = useState<TaskInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    const api = getApi();
    if (!api) {
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const list = await api.tasks.list();
      setTasks(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { tasks, loading, error, refresh };
}

export function useTaskMutations() {
  const create = useCallback(async (req: CreateTaskRequest) => {
    const api = getApi();
    if (!api) throw new Error("Tessera bridge not available");
    return api.tasks.create(req);
  }, []);

  const update = useCallback(async (id: string, req: UpdateTaskRequest) => {
    const api = getApi();
    if (!api) throw new Error("Tessera bridge not available");
    return api.tasks.update(id, req);
  }, []);

  const remove = useCallback(async (id: string) => {
    const api = getApi();
    if (!api) throw new Error("Tessera bridge not available");
    return api.tasks.remove(id);
  }, []);

  const reorder = useCallback(async (status: string, ids: string[]) => {
    const api = getApi();
    if (!api) throw new Error("Tessera bridge not available");
    return api.tasks.reorder(status, ids);
  }, []);

  return { create, update, remove, reorder };
}
