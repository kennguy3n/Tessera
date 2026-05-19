import { useState, useEffect, useCallback } from "react";
import type { SourceInfo, SourceDetailInfo, SearchHit } from "../types/ipc";

export function useSourceList() {
  const [sources, setSources] = useState<SourceInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const api = window.tessera;
      if (api) {
        const list = await api.sources.listSources();
        setSources(list);
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

  return { sources, loading, error, refresh };
}

export function useAddSource() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const addFolder = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const api = window.tessera;
      if (!api) throw new Error("Tessera API not available");
      const result = await api.sources.addLocalFolder(path);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  const addFile = useCallback(async (path: string) => {
    setLoading(true);
    setError(null);
    try {
      const api = window.tessera;
      if (!api) throw new Error("Tessera API not available");
      const result = await api.sources.addLocalFile(path);
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return { addFolder, addFile, loading, error };
}

export function useRemoveSource() {
  const [loading, setLoading] = useState(false);

  const remove = useCallback(async (id: string) => {
    setLoading(true);
    try {
      const api = window.tessera;
      if (!api) throw new Error("Tessera API not available");
      await api.sources.removeSource(id);
    } finally {
      setLoading(false);
    }
  }, []);

  return { remove, loading };
}

export function useSearchSources() {
  const [results, setResults] = useState<SearchHit[]>([]);
  const [loading, setLoading] = useState(false);

  const search = useCallback(async (query: string, limit: number = 20) => {
    setLoading(true);
    try {
      const api = window.tessera;
      if (!api) {
        setResults([]);
        return;
      }
      const hits = await api.sources.searchSources(query, limit);
      setResults(hits);
    } finally {
      setLoading(false);
    }
  }, []);

  return { results, search, loading };
}

export function useSourceDetail(id: string | undefined) {
  const [detail, setDetail] = useState<SourceDetailInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    if (!id) {
      setDetail(null);
      setLoading(false);
      return;
    }
    setLoading(true);
    setError(null);
    try {
      const api = window.tessera;
      if (!api) throw new Error("Tessera API not available");
      const result = await api.sources.getDetail(id);
      setDetail(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    refresh();
  }, [refresh]);

  return { detail, loading, error, refresh };
}

export function useReindexSource() {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const reindex = useCallback(async (id: string) => {
    setLoading(true);
    setError(null);
    try {
      const api = window.tessera;
      if (!api) throw new Error("Tessera API not available");
      return await api.sources.reindex(id);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      setError(message);
      throw err;
    } finally {
      setLoading(false);
    }
  }, []);

  return { reindex, loading, error };
}
