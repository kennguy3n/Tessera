import { useState, useEffect, useCallback } from "react";
import type { ArtifactInfo } from "../types/ipc";

export function useArtifactList() {
  const [artifacts, setArtifacts] = useState<ArtifactInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const api = window.tessera;
      if (api) {
        const list = await api.artifacts.list();
        setArtifacts(list);
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

  return { artifacts, loading, error, refresh };
}

export function useRecentArtifacts(limit: number = 5) {
  const { artifacts, loading, error, refresh } = useArtifactList();

  const recent = [...artifacts]
    .sort(
      (a, b) =>
        new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime(),
    )
    .slice(0, limit);

  return { recent, loading, error, refresh };
}
