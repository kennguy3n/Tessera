import { useCallback, useEffect, useState } from "react";
import type {
  AutomationInfo,
  CreateAutomationRequest,
} from "../types/ipc";

interface UseAutomationListResult {
  automations: AutomationInfo[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

function getApi() {
  return typeof window !== "undefined" ? window.tessera : undefined;
}

export function useAutomationList(): UseAutomationListResult {
  const [automations, setAutomations] = useState<AutomationInfo[]>([]);
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
      const list = await api.automations.list();
      setAutomations(list);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    void refresh();
  }, [refresh]);

  return { automations, loading, error, refresh };
}

export function useAutomationMutations() {
  const create = useCallback(async (req: CreateAutomationRequest) => {
    const api = getApi();
    if (!api) throw new Error("Tessera bridge not available");
    return api.automations.create(req);
  }, []);

  const setEnabled = useCallback(async (id: string, enabled: boolean) => {
    const api = getApi();
    if (!api) throw new Error("Tessera bridge not available");
    return api.automations.setEnabled(id, enabled);
  }, []);

  const remove = useCallback(async (id: string) => {
    const api = getApi();
    if (!api) throw new Error("Tessera bridge not available");
    return api.automations.remove(id);
  }, []);

  return { create, setEnabled, remove };
}
