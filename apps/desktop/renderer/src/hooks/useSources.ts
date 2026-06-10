import { useState, useEffect, useCallback } from "react";
import type {
  SourceInfo,
  SourceDetailInfo,
  SearchHit,
  SubstrateRelatedSuggestionInfo,
} from "../types/ipc";

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

/**
 * Concept-graph-driven "related sources" suggestions for the
 * artifact-creation flow. Given the user's current source selection,
 * it asks the knowledge substrate (`substrate:suggestRelatedSources`)
 * which other indexed sources co-occur — by entity — with the
 * selected ones, so the UI can prompt "You have N sources about
 * [entity]. Include them?".
 *
 * The fetch is purely additive: any failure (no bridge, substrate
 * error, empty graph) resolves to an empty suggestion list rather than
 * surfacing an error, so the manual checkbox flow always keeps working.
 * An empty selection short-circuits to `[]` without an IPC round-trip.
 */
export function useRelatedSourceSuggestions(
  selectedSourceIds: string[],
  maxSuggestions = 5,
) {
  const [suggestions, setSuggestions] = useState<
    SubstrateRelatedSuggestionInfo[]
  >([]);
  const [loading, setLoading] = useState(false);

  // Stable primitive key so the effect re-runs only when the actual set
  // of selected ids changes, not on every parent re-render that hands us
  // a fresh array instance. Order-independent so reselecting the same
  // sources in a different order doesn't refetch.
  const selectionKey = [...selectedSourceIds].sort().join("|");

  useEffect(() => {
    let cancelled = false;
    const ids = selectionKey ? selectionKey.split("|") : [];
    if (ids.length === 0) {
      setSuggestions([]);
      setLoading(false);
      return () => {
        cancelled = true;
      };
    }
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api?.substrate?.suggestRelatedSources) {
      setSuggestions([]);
      return () => {
        cancelled = true;
      };
    }
    setLoading(true);
    api.substrate
      .suggestRelatedSources(ids, maxSuggestions)
      .then((result) => {
        if (!cancelled) setSuggestions(result);
      })
      .catch(() => {
        if (!cancelled) setSuggestions([]);
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });
    return () => {
      cancelled = true;
    };
  }, [selectionKey, maxSuggestions]);

  return { suggestions, loading };
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
