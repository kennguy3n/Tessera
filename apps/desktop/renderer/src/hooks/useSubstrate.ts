import { useCallback, useEffect, useRef, useState } from "react";
import type { SubstrateMemoryInfo } from "../types/ipc";
import {
  parseConceptGraph,
  type ConceptGraphView,
} from "../utils/conceptGraph";

/**
 * Renderer hooks over the additive knowledge-substrate IPC surface
 * (`window.tessera.substrate.*`, registered in
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

/**
 * A single stable empty graph, reused for both the initial state and the
 * gated-off ("disabled") path of {@link useConceptGraph}. Reusing one
 * reference keeps `graph` referentially stable across disabled-path effect
 * runs — React bails out via `Object.is` instead of forcing a redundant
 * re-render with a logically-unchanged value. Safe to share because
 * `parseConceptGraph` deep-freezes the view, so the immutability the
 * callers rely on (they only ever replace it via `setGraph`) is now
 * enforced at runtime rather than by convention.
 */
const EMPTY_CONCEPT_GRAPH: ConceptGraphView = parseConceptGraph("{}");

/**
 * Options for a {@link UseMemoriesResult.refresh} call.
 *
 * `silent` re-fetches WITHOUT flipping `loading` back to `true`. It exists
 * for background reconciliation after a mutation (pin / unpin / forget):
 * the row already updated optimistically, so toggling the page-level
 * loading flag would tear the whole list down and re-mount it on every
 * action — an avoidable flash. A silent refresh swaps in the canonical
 * data underneath the rendered list instead.
 */
export interface RefreshOptions {
  silent?: boolean;
}

export interface UseMemoriesResult {
  memories: SubstrateMemoryInfo[];
  loading: boolean;
  error: string | null;
  refresh: (options?: RefreshOptions) => Promise<void>;
}

/**
 * Load the memory plane for `scope` (default scope when omitted).
 * Re-fetches whenever `scope` changes.
 *
 * `enabled` (default `true`) gates the automatic fetch: when `false`,
 * the hook performs no IPC and reports `loading: false` with an empty
 * list. The returned `refresh` still works when invoked explicitly so
 * an enabled-later or manual refresh path is unaffected.
 */
export function useMemories(
  scope?: string | null,
  enabled = true,
): UseMemoriesResult {
  const [memories, setMemories] = useState<SubstrateMemoryInfo[]>([]);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  // Monotonic request token. Only the most-recently-issued fetch is
  // allowed to commit its result, so a slow response for an old `scope`
  // can never clobber the state of a newer one (and a late response after
  // the hook gated off is ignored). The disabled-path effect bumps it too.
  const requestRef = useRef(0);

  const refresh = useCallback(
    async (options?: RefreshOptions) => {
      const token = ++requestRef.current;
      const silent = options?.silent ?? false;
      if (!silent) setLoading(true);
      setError(null);
      try {
        const api = getApi();
        if (api) {
          const list = await api.substrate.getMemories(scope ?? null);
          if (token === requestRef.current) setMemories(list);
        }
      } catch (err) {
        if (token === requestRef.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (token === requestRef.current && !silent) setLoading(false);
      }
    },
    [scope],
  );

  useEffect(() => {
    if (!enabled) {
      // Skip the round-trip entirely and settle into a clean,
      // non-loading empty state so a gated caller never sees a
      // spinner for data it isn't going to render. Bump the request
      // token so any fetch still in flight from a previously-enabled
      // render can't commit its result over this empty state.
      requestRef.current++;
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
  /** Set of memory ids with a mutation currently in flight. */
  pending: ReadonlySet<string>;
  error: string | null;
}

const EMPTY_PENDING: ReadonlySet<string> = new Set();

/**
 * Mutating memory actions (pin / unpin / forget). `pending` is the set of
 * memory ids with a mutation in flight, so each row can independently show
 * a busy state and disable its buttons. At most one mutation runs per id
 * at a time: a duplicate request for an id already in flight is ignored
 * (rather than overwriting the busy tracking and clearing it early), while
 * mutations on *different* rows are free to run concurrently.
 */
export function useMemoryActions(): UseMemoryActionsResult {
  const [pending, setPending] = useState<ReadonlySet<string>>(EMPTY_PENDING);
  const [error, setError] = useState<string | null>(null);
  // Synchronous source of truth for in-flight ids. A ref (not the `pending`
  // state) is read in `run` so two clicks in the same tick see each other
  // before React has re-rendered; `pending` is just its render-visible
  // mirror.
  const inFlight = useRef<Set<string>>(new Set());

  const run = useCallback(
    async <T>(
      id: string,
      op: (api: NonNullable<ReturnType<typeof getApi>>) => Promise<T>,
      fallback: T,
    ): Promise<T> => {
      const api = getApi();
      if (!api) {
        setError("Tessera bridge not available");
        return fallback;
      }
      // Enforce one-mutation-per-id: ignore a duplicate while the previous
      // one for the same id is still resolving.
      if (inFlight.current.has(id)) return fallback;
      inFlight.current.add(id);
      setPending(new Set(inFlight.current));
      setError(null);
      try {
        return await op(api);
      } catch (err) {
        setError(err instanceof Error ? err.message : String(err));
        return fallback;
      } finally {
        inFlight.current.delete(id);
        setPending(new Set(inFlight.current));
      }
    },
    [],
  );

  const pin = useCallback(
    (id: string) => run(id, (api) => api.substrate.pinMemory(id), null),
    [run],
  );
  const unpin = useCallback(
    (id: string) => run(id, (api) => api.substrate.unpinMemory(id), null),
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
  refresh: (options?: RefreshOptions) => Promise<void>;
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
  const [graph, setGraph] = useState<ConceptGraphView>(EMPTY_CONCEPT_GRAPH);
  const [loading, setLoading] = useState(enabled);
  const [error, setError] = useState<string | null>(null);
  // See `useMemories`: only the latest fetch may commit, so a slow response
  // for an old `scope`/`maxNodes` can't overwrite a newer one.
  const requestRef = useRef(0);

  const refresh = useCallback(
    async (options?: RefreshOptions) => {
      const token = ++requestRef.current;
      const silent = options?.silent ?? false;
      if (!silent) setLoading(true);
      setError(null);
      try {
        const api = getApi();
        if (api) {
          const json = await api.substrate.getConceptGraph(
            scope ?? null,
            maxNodes ?? null,
          );
          if (token === requestRef.current) setGraph(parseConceptGraph(json));
        }
      } catch (err) {
        if (token === requestRef.current) {
          setError(err instanceof Error ? err.message : String(err));
        }
      } finally {
        if (token === requestRef.current && !silent) setLoading(false);
      }
    },
    [scope, maxNodes],
  );

  useEffect(() => {
    if (!enabled) {
      // See `useMemories`: skip IPC and settle empty when gated off. Reuse the
      // shared empty graph so the value stays referentially stable, and bump
      // the request token so an in-flight fetch can't commit over it.
      requestRef.current++;
      setGraph(EMPTY_CONCEPT_GRAPH);
      setError(null);
      setLoading(false);
      return;
    }
    void refresh();
  }, [refresh, enabled]);

  return { graph, loading, error, refresh };
}
