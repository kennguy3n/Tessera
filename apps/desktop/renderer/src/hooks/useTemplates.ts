import { useState, useEffect, useCallback } from "react";
import type { TemplateInfo } from "../types/ipc";

export function useTemplateList() {
  const [templates, setTemplates] = useState<TemplateInfo[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const api = window.tessera;
      if (api) {
        const list = await api.templates.list();
        setTemplates(list);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { templates, loading, error, refresh };
}
