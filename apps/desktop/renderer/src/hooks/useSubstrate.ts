import { useCallback, useEffect, useMemo, useState } from "react";
import type { SubstrateMemoryInfo } from "../types/ipc";
import {
  parseConceptGraph,
  type ConceptGraphView,
} from "../utils/conceptGraph";

/**
 * Renderer hooks over the additive knowledge-substrate IPC surface
 * (`window.tessera.substrate.*`, registered by Session 1 in
 * `electron/ipc/substrate.ts`). These mirror the established
 * `useSources` / `useArtifacts` pattern: a small stateful hook that
 * owns the `loading` / `error` lifecycle and exposes a `refresh`
 * callback, plus action hooks that wrap the mutating bridge calls.
 *
 * All calls are guarded on `window.tessera` being present so the hooks
 * degrade cleanly in a cold-start window (before the preload bridge is
 * wired) and in the test harness.
 */

function getApi() {
  return typeof window !== "undefined" ? window.tessera : undefined;
}

export interface UseMemoriesResult {
  memories: SubstrateMemoryInfo[];
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Load the memory plane for `scope` (default scope when omitted).
 * Re-fetches whenever `scope` changes.
 *
 * `enabled` (default `true`) gates the automatic fetch: when `false`,
 * the hook performs no IPC and reports `loading: false` with an empty
 * list. Callers use this to avoid round-tripping the substrate when
 * the result would never be shown (e.g. the HomePage empty state that
 * returns before the insights card renders). The returned `refresh`
 * still works when invoked explicitly so an enabled-later or manual
 * refresh path is unaffected.
 */
export function useMemories(
  scope?: string | null,
  enabled = true,
): UseMemoriesResult {
  const [memories, setMemories] = useState<SubstrateMemoryInfo[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const api = getApi();
      if (api) {
        const list = await api.substrate.getMemories(scope ?? null);
        setMemories(list);
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [scope]);

  useEffect(() => {
    if (!enabled) {
      // Skip the round-trip entirely and settle into a clean,
      // non-loading empty state so a gated caller never sees a
      // spinner for data it isn't going to render.
      setMemories([]);
      setError(null);
      setLoading(false);
      return;
    }
    void refresh();
  }, [refresh, enabled]);

  return { memories, loading, error, refresh };
}

export interface UseMemoryActionsResult {
  pin: (id: string) => Promise<SubstrateMemoryInfo | null>;
  unpin: (id: string) => Promise<SubstrateMemoryInfo | null>;
  forget: (id: string) => Promise<boolean>;
  pending: string | null;
  error: string | null;
}

/**
 * Mutating memory actions (pin / unpin / forget). `pending` holds the
 * id of the in-flight memory so a row can show a busy state and disable
 * its buttons; only one mutation runs at a time per hook instance.
 */
export function useMemoryActions(): UseMemoryActionsResult {
  const [pending, setPending] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  const run = useCallback(
    async <T>(id: string, op: (api: NonNullable<ReturnType<typeof getApi>>) => Promise<T>, fallback: T): Promise<T> => {
      const api = getApi();
      if (!api) {
        setError("Tessera bridge not available");
        return fallback;
      }
      setPending(id);
      setError(null);
      try {
        return await op(api);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return fallback;
      } finally {
        setPending(null);
      }
    },
    [],
  );

  const pin = useCallback(
    (id: string) =>
      run(id, (api) => api.substrate.pinMemory(id), null),
    [run],
  );
  const unpin = useCallback(
    (id: string) =>
      run(id, (api) => api.substrate.unpinMemory(id), null),
    [run],
  );
  const forget = useCallback(
    (id: string) =>
      run(
        id,
        async (api) => {
          await api.substrate.forgetMemory(id);
          return true;
        },
        false,
      ),
    [run],
  );

  return { pin, unpin, forget, pending, error };
}

export interface UseConceptGraphResult {
  graph: ConceptGraphView;
  loading: boolean;
  error: string | null;
  refresh: () => Promise<void>;
}

/**
 * Load + parse the concept graph for `scope` (default scope when
 * omitted), bounded by `maxNodes`. The bridge returns a JSON string;
 * we parse it through {@link parseConceptGraph} so the component only
 * ever sees the typed, validated view.
 */
export function useConceptGraph(
  scope?: string | null,
  maxNodes?: number | null,
  enabled = true,
): UseConceptGraphResult {
  const [graph, setGraph] = useState<ConceptGraphView>(() =>
    parseConceptGraph("{}"),
  );
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);

  const refresh = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      const api = getApi();
      if (api) {
        const json = await api.substrate.getConceptGraph(
          scope ?? null,
          maxNodes ?? null,
        );
        setGraph(parseConceptGraph(json));
      }
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [scope, maxNodes]);

  useEffect(() => {
    if (!enabled) {
      // See `useMemories`: skip IPC and settle empty when gated off.
      setGraph(parseConceptGraph("{}"));
      setError(null);
      setLoading(false);
      return;
    }
    void refresh();
  }, [refresh, enabled]);

  return { graph, loading, error, refresh };
}

export interface KnowledgeInsights {
  /** Total memory objects extracted across all states. */
  totalEntities: number;
  /** Memories still in the working set (not archived / deleted). */
  activeMemories: number;
  /** Distinct concepts currently in the graph. */
  conceptsInGraph: number;
  /** Top entities by corroboration/retrieval/pin signal. */
  mostConnected: SubstrateMemoryInfo[];
}

/** Decay states that count as "active" (still in the working set). */
const ACTIVE_STATES: ReadonlySet<string> = new Set([
  "candidate",
  "reinforced",
  "consolidated",
  "canonical",
]);

/** True when a memory is still part of the live working set. */
export function isActiveMemory(memory: SubstrateMemoryInfo): boolean {
  return ACTIVE_STATES.has(memory.state.toLowerCase());
}

/**
 * Derive the HomePage "Knowledge insights" summary from the memory
 * plane and concept graph. Pure given its inputs so it can be unit
 * tested and memoized.
 */
export function deriveKnowledgeInsights(
  memories: SubstrateMemoryInfo[],
  graph: ConceptGraphView,
  topN = 5,
): KnowledgeInsights {
  const active = memories.filter(isActiveMemory);
  const mostConnected = [...active]
    .sort((a, b) => {
      const score = (m: SubstrateMemoryInfo) =>
        m.corroborationCount * 3 + m.retrievalCount + m.pinCount * 2;
      const diff = score(b) - score(a);
      if (diff !== 0) return diff;
      if (b.retentionScore !== a.retentionScore) {
        return b.retentionScore - a.retentionScore;
      }
      return a.content.localeCompare(b.content);
    })
    .slice(0, topN);

  return {
    totalEntities: memories.length,
    activeMemories: active.length,
    conceptsInGraph: graph.nodes.length,
    mostConnected,
  };
}

/**
 * Composite hook for the HomePage card: pulls the memory plane and the
 * concept graph (default scope) and derives the {@link KnowledgeInsights}
 * summary. Surfaces a single combined loading flag; errors are
 * swallowed into an empty insights object so the HomePage never breaks
 * on a substrate that hasn't been populated yet.
 */
export function useKnowledgeInsights(
  topN = 5,
  enabled = true,
): {
  insights: KnowledgeInsights;
  loading: boolean;
} {
  const { memories, loading: memLoading } = useMemories(null, enabled);
  const { graph, loading: graphLoading } = useConceptGraph(null, 256, enabled);
  const insights = useMemo(
    () => deriveKnowledgeInsights(memories, graph, topN),
    [memories, graph, topN],
  );
  return { insights, loading: enabled && (memLoading || graphLoading) };
}
