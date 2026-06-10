import { useCallback, useMemo, useState } from "react";
import PageHeader from "../components/PageHeader";
import Card from "../components/Card";
import Button from "../components/Button";
import StatusBadge from "../components/StatusBadge";
import SearchInput from "../components/SearchInput";
import EmptyState from "../components/EmptyState";
import ConceptGraphPanel from "../components/ConceptGraphPanel";
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
  type DecayBucket,
} from "../utils/memories";
import type { SubstrateMemoryInfo } from "../types/ipc";

/**
 * Shared layout CSS for every memory row. Hoisted to a module-level
 * constant and injected ONCE by `MemoryPage` (not per-row): the rules
 * are identical for every row, so emitting one `<style>` per memory
 * shipped N duplicate stylesheets into the DOM for an N-item list.
 * Rendering it a single time keeps the injected CSS O(1) regardless of
 * how many memories are shown. (Devin Review PR #120.)
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
`;

/**
 * "What Tessera knows" dashboard. Surfaces the substrate memory plane —
 * the entities, facts, tasks, and decisions extracted from every source
 * — with their decay state, retention score, and source citation, plus
 * per-item pin / unpin / forget controls, a decay-bucket filter, and
 * free-text search. The concept graph for the same knowledge is mounted
 * below as an interactive panel.
 *
 * All data flows through `window.tessera.substrate.*` (Session 1 IPC).
 */
export default function MemoryPage() {
  const cspNonce = useCspNonce();
  const { memories, loading, error, refresh } = useMemories(null);
  const { pin, unpin, forget, pending } = useMemoryActions();
  const [bucket, setBucket] = useState<DecayBucket | "all">("all");
  const [query, setQuery] = useState("");

  const counts = useMemo(() => countByBucket(memories), [memories]);
  const visible = useMemo(
    () => filterMemories(memories, { bucket, query }),
    [memories, bucket, query],
  );

  const handlePinToggle = useCallback(
    async (mem: SubstrateMemoryInfo) => {
      const ok =
        mem.pinCount > 0 ? await unpin(mem.id) : await pin(mem.id);
      if (ok) await refresh();
    },
    [pin, unpin, refresh],
  );

  const handleForget = useCallback(
    async (mem: SubstrateMemoryInfo) => {
      const confirmed =
        typeof window === "undefined" ||
        window.confirm(
          "Forget this memory? It will be cryptographically dropped from the substrate and cannot be recovered.",
        );
      if (!confirmed) return;
      const ok = await forget(mem.id);
      if (ok) await refresh();
    },
    [forget, refresh],
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
      ) : memories.length === 0 ? (
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
                label={`All (${memories.length})`}
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
                    busy={pending === mem.id}
                    onPinToggle={() => void handlePinToggle(mem)}
                    onForget={() => void handleForget(mem)}
                  />
                ))}
              </ul>
            )}
          </section>

          <section
            aria-label="Knowledge graph"
            style={{ marginTop: "var(--spacing-xl)" }}
          >
            <h2 style={{ marginBottom: "var(--spacing-md)" }}>
              Concept graph
            </h2>
            <ConceptGraphPanel memories={memories} />
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
