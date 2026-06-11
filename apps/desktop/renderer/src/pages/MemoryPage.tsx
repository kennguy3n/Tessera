import { useCallback, useMemo, useState } from "react";
import PageHeader from "../components/PageHeader";
import Card from "../components/Card";
import Button from "../components/Button";
import StatusBadge from "../components/StatusBadge";
import SearchInput from "../components/SearchInput";
import EmptyState from "../components/EmptyState";
import ConceptGraphPanel from "../components/ConceptGraphPanel";
import { useToast } from "../components/toastContext";
import { useCspNonce } from "../utils/cspNonce";
import { useMemories, useMemoryActions } from "../hooks/useSubstrate";
import {
  countByBucket,
  decayBadgeVariant,
  decayBucket,
  DECAY_BUCKETS,
  filterMemories,
  formatRetention,
  observationTypeLabel,
  sortByRetention,
  type DecayBucket,
} from "../utils/memories";
import type { SubstrateMemoryInfo } from "../types/ipc";

/**
 * Shared layout CSS for every memory row. Hoisted to a module-level
 * constant and injected ONCE by `MemoryPage` (not per-row): the rules
 * are identical for every row, so emitting one `<style>` per memory
 * shipped N duplicate stylesheets into the DOM for an N-item list.
 * Rendering it a single time keeps the injected CSS O(1) regardless of
 * how many memories are shown.
 */
const MEMORY_ROW_STYLES = `
  .memory-row-head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--spacing-sm);
    margin-bottom: var(--spacing-sm);
  }
  .memory-type {
    font-weight: 600;
    font-size: var(--font-size-sm);
    text-transform: uppercase;
    letter-spacing: 0.04em;
    color: var(--color-text-secondary);
  }
  .memory-badges {
    display: inline-flex;
    align-items: center;
    gap: var(--spacing-sm);
  }
  .memory-retention {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }
  .memory-content {
    margin: 0 0 var(--spacing-sm);
    line-height: 1.5;
  }
  .memory-row-foot {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--spacing-sm);
    flex-wrap: wrap;
  }
  .memory-cite {
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }
  .memory-actions {
    display: inline-flex;
    gap: var(--spacing-sm);
  }
  .memory-cap-note {
    margin: 0 0 var(--spacing-md);
    font-size: var(--font-size-sm);
    color: var(--color-text-secondary);
  }
`;

/**
 * Upper bound on rows rendered at once. The substrate can hold a very
 * large memory plane; rendering tens of thousands of DOM nodes would
 * jank the page with no user benefit (nobody scans a 10k list by eye).
 * We sort by retention first, then cap, so the most-retained memories
 * are always the ones shown and a note explains the cap + points at the
 * search/filter controls for narrowing the rest.
 */
const MAX_VISIBLE_MEMORIES = 200;

/**
 * Optimistic, per-memory override applied on top of the substrate's
 * canonical list while a pin/unpin/forget mutation is in flight (and
 * until the post-mutation refresh lands). Keeping the override map
 * keyed by id — rather than mutating the hook-owned list — means the
 * authoritative refresh always wins once it resolves, so an optimistic
 * value can never get "stuck" out of sync with the substrate.
 */
interface MemoryOverride {
  pinCount?: number;
  forgotten?: boolean;
}

/**
 * "What Tessera knows" dashboard. Surfaces the substrate memory plane —
 * the entities, facts, tasks, and decisions extracted from every source
 * — with their decay state, retention score, and source citation, plus
 * per-item pin / unpin / forget controls, a decay-bucket filter, and
 * free-text search. The concept graph for the same knowledge is mounted
 * below as an interactive panel.
 *
 * Mutations apply optimistically (the row updates/disappears instantly)
 * and are reconciled against the substrate by a refresh, with a toast
 * confirming success or surfacing a failure + rolling the row back.
 *
 * All data flows through `window.tessera.substrate.*`.
 */
export default function MemoryPage() {
  const cspNonce = useCspNonce();
  const { addToast } = useToast();
  const { memories, loading, error, refresh } = useMemories(null);
  const { pin, unpin, forget, pending } = useMemoryActions();
  const [bucket, setBucket] = useState<DecayBucket | "all">("all");
  const [query, setQuery] = useState("");
  const [overrides, setOverrides] = useState<Record<string, MemoryOverride>>(
    {},
  );

  const clearOverride = useCallback((id: string) => {
    setOverrides((prev) => {
      if (!(id in prev)) return prev;
      const next = { ...prev };
      delete next[id];
      return next;
    });
  }, []);

  // The substrate list with in-flight optimistic overrides applied:
  // forgotten rows are dropped and pin counts reflect the pending toggle.
  const effective = useMemo(() => {
    return memories
      .filter((m) => !overrides[m.id]?.forgotten)
      .map((m) => {
        const ov = overrides[m.id];
        return ov?.pinCount !== undefined ? { ...m, pinCount: ov.pinCount } : m;
      });
  }, [memories, overrides]);

  const counts = useMemo(() => countByBucket(effective), [effective]);
  const sorted = useMemo(
    () => sortByRetention(filterMemories(effective, { bucket, query })),
    [effective, bucket, query],
  );
  const visible = useMemo(
    () => sorted.slice(0, MAX_VISIBLE_MEMORIES),
    [sorted],
  );
  const hiddenCount = sorted.length - visible.length;

  const handlePinToggle = useCallback(
    async (mem: SubstrateMemoryInfo) => {
      const wasPinned = mem.pinCount > 0;
      // Optimistically reflect the toggle so the label flips instantly.
      setOverrides((prev) => ({
        ...prev,
        [mem.id]: {
          ...prev[mem.id],
          pinCount: wasPinned ? Math.max(0, mem.pinCount - 1) : mem.pinCount + 1,
        },
      }));
      const result = wasPinned ? await unpin(mem.id) : await pin(mem.id);
      if (result) {
        addToast(wasPinned ? "Memory unpinned" : "Memory pinned", "success");
        // Reconcile against the substrate without a loading flash: the row
        // already reflects the change optimistically.
        await refresh({ silent: true });
        clearOverride(mem.id);
      } else {
        addToast("Couldn't update this memory. Please try again.", "error");
        clearOverride(mem.id);
      }
    },
    [pin, unpin, refresh, addToast, clearOverride],
  );

  const handleForget = useCallback(
    async (mem: SubstrateMemoryInfo) => {
      const confirmed =
        typeof window === "undefined" ||
        window.confirm(
          "Forget this memory? It will be cryptographically dropped from the substrate and cannot be recovered.",
        );
      if (!confirmed) return;
      // Optimistically remove the row; restore it if the mutation fails.
      setOverrides((prev) => ({
        ...prev,
        [mem.id]: { ...prev[mem.id], forgotten: true },
      }));
      const ok = await forget(mem.id);
      if (ok) {
        addToast("Memory forgotten", "success");
        await refresh({ silent: true });
        clearOverride(mem.id);
      } else {
        addToast("Couldn't forget this memory. Please try again.", "error");
        clearOverride(mem.id);
      }
    },
    [forget, refresh, addToast, clearOverride],
  );

  return (
    <div>
      <PageHeader
        title="Memory"
        description="What Tessera knows — entities, facts, tasks, and decisions extracted from your sources."
      />

      {error && (
        <Card>
          <p style={{ color: "var(--color-danger)" }} role="alert">
            {error}
          </p>
          <Button variant="secondary" onClick={() => void refresh()}>
            Retry
          </Button>
        </Card>
      )}

      {loading ? (
        <p>Loading memories...</p>
      ) : error ? null : memories.length === 0 ? (
        // Only show the "no memories yet" empty state on a *successful*
        // empty fetch. On error the card above already explains the
        // failure + offers Retry; rendering the empty state too would
        // wrongly imply the substrate has no data.
        <EmptyState
          title="No memories yet"
          message="Tessera extracts entities, facts, tasks, and decisions from your sources as they are indexed. Add and index a source to start building memory."
        />
      ) : (
        <>
          <style nonce={cspNonce}>{MEMORY_ROW_STYLES}</style>
          <section
            aria-label="Memory filters"
            style={{ marginBottom: "var(--spacing-lg)" }}
          >
            <div
              data-testid="memory-bucket-filter"
              style={{
                display: "flex",
                flexWrap: "wrap",
                gap: "var(--spacing-sm)",
                marginBottom: "var(--spacing-md)",
              }}
            >
              <FilterChip
                label={`All (${effective.length})`}
                active={bucket === "all"}
                onClick={() => setBucket("all")}
                testId="memory-filter-all"
              />
              {DECAY_BUCKETS.map((b) => (
                <FilterChip
                  key={b}
                  label={`${b.charAt(0).toUpperCase()}${b.slice(1)} (${counts[b]})`}
                  active={bucket === b}
                  onClick={() => setBucket(b)}
                  testId={`memory-filter-${b}`}
                />
              ))}
            </div>
            <SearchInput
              placeholder="Search within memories..."
              aria-label="Search within memories"
              value={query}
              onSearch={setQuery}
            />
          </section>

          <section aria-label="Memories">
            {visible.length === 0 ? (
              <p data-testid="memory-no-results">
                No memories match the current filter.
              </p>
            ) : (
              <>
                {hiddenCount > 0 && (
                  <p className="memory-cap-note" data-testid="memory-cap-note">
                    Showing the {MAX_VISIBLE_MEMORIES} most-retained memories.{" "}
                    {hiddenCount} more are hidden — narrow the list with search
                    or the filters above.
                  </p>
                )}
                <ul
                  data-testid="memory-list"
                  style={{
                    listStyle: "none",
                    margin: 0,
                    padding: 0,
                    display: "flex",
                    flexDirection: "column",
                    gap: "var(--spacing-md)",
                  }}
                >
                  {visible.map((mem) => (
                    <MemoryRow
                      key={mem.id}
                      memory={mem}
                      busy={pending.has(mem.id)}
                      onPinToggle={() => void handlePinToggle(mem)}
                      onForget={() => void handleForget(mem)}
                    />
                  ))}
                </ul>
              </>
            )}
          </section>

          <section
            aria-label="Knowledge graph"
            style={{ marginTop: "var(--spacing-xl)" }}
          >
            <h2 style={{ marginBottom: "var(--spacing-md)" }}>Concept graph</h2>
            <ConceptGraphPanel memories={effective} />
          </section>
        </>
      )}
    </div>
  );
}

function FilterChip({
  label,
  active,
  onClick,
  testId,
}: {
  label: string;
  active: boolean;
  onClick: () => void;
  testId: string;
}) {
  return (
    <button
      type="button"
      data-testid={testId}
      aria-pressed={active}
      onClick={onClick}
      className={`badge ${active ? "badge-info" : ""}`}
      style={{
        cursor: "pointer",
        border: active
          ? "1px solid var(--color-primary)"
          : "1px solid var(--color-border)",
        background: active ? undefined : "transparent",
        padding: "0.25rem 0.625rem",
      }}
    >
      {label}
    </button>
  );
}

function MemoryRow({
  memory,
  busy,
  onPinToggle,
  onForget,
}: {
  memory: SubstrateMemoryInfo;
  busy: boolean;
  onPinToggle: () => void;
  onForget: () => void;
}) {
  const bucket = decayBucket(memory.state);
  const pinned = memory.pinCount > 0;
  return (
    <li>
      <Card data-testid={`memory-item-${memory.id}`}>
        <div className="memory-row-head">
          <span className="memory-type">
            {observationTypeLabel(memory.observationType)}
          </span>
          <div className="memory-badges">
            <StatusBadge status={bucket} variant={decayBadgeVariant(bucket)} />
            <span
              className="memory-retention"
              title="Retention score"
              data-testid={`memory-retention-${memory.id}`}
            >
              {formatRetention(memory.retentionScore)} retained
            </span>
          </div>
        </div>

        <p className="memory-content">{memory.content}</p>

        <div className="memory-row-foot">
          <span className="memory-cite" data-testid={`memory-cite-${memory.id}`}>
            {memory.sourceId
              ? `Source ${memory.sourceId.slice(0, 8)}…`
              : "No source citation"}
            {pinned ? ` · pinned ${memory.pinCount}×` : ""}
          </span>
          <div className="memory-actions">
            <Button
              variant="secondary"
              disabled={busy}
              aria-pressed={pinned}
              data-testid={`memory-pin-${memory.id}`}
              onClick={onPinToggle}
            >
              {pinned ? "Unpin" : "Pin"}
            </Button>
            <Button
              variant="secondary"
              disabled={busy}
              data-testid={`memory-forget-${memory.id}`}
              onClick={onForget}
            >
              Forget
            </Button>
          </div>
        </div>
      </Card>
    </li>
  );
}
