import { useState, useEffect, useCallback } from "react";
import type { ReactNode } from "react";
import Button from "./Button";
import RelevanceBadge from "./RelevanceBadge";
import type {
  CitationInfo,
  AddCitationRequest,
  CitationFreshness,
  EnrichedSearchResult,
  KchatPostSearchHit,
  ReplaceCitationRequest,
  SearchHit,
  SubstrateConceptInfo,
  SubstrateMemoryInfo,
} from "../types/ipc";

/**
 * Empty knowledge plane — the additive "Knowledge" tab shows nothing
 * until an enriched search resolves (or when the substrate has no
 * observations for the query). Shared so a failed/absent enriched
 * search degrades to "no knowledge" rather than crashing the dialog.
 */
const EMPTY_KNOWLEDGE: EnrichedSearchResult = {
  hits: [],
  entities: [],
  facts: [],
  concepts: [],
  memories: [],
};

/**
 * Fetch the additive knowledge plane (entities, facts, concepts) for a
 * query via `sources:searchEnriched`. Returns an empty plane when the
 * API or the native bridge is unavailable, or when the enriched search
 * rejects — the "Knowledge" tab is purely additive and must never break
 * the existing "Sources" evidence flow.
 */
async function fetchKnowledgePlane(
  query: string,
  limit: number,
): Promise<EnrichedSearchResult> {
  const api = window.tessera;
  if (!api?.sources?.searchEnriched) return EMPTY_KNOWLEDGE;
  try {
    return await api.sources.searchEnriched(query, limit);
  } catch {
    return EMPTY_KNOWLEDGE;
  }
}

/**
 * renderer-side merged-evidence row.
 * The citation dialogs render file hits and KChat-post hits in a
 * single list so the user picks among ALL retrieved evidence
 * regardless of source kind. We keep the union discriminator
 * (`kind`) at the row level rather than building two separate
 * lists because the relevance scores are directly comparable
 * (both pipelines run the same FTS5 / RRF ranking) and
 * intermingling produces a better-than-segregated experience for
 * the user.
 */
type EvidenceRow =
  | { kind: "file"; hit: SearchHit }
  | { kind: "kchat_post"; hit: KchatPostSearchHit };

/**
 * Format a millisecond Unix timestamp into a short, locale-aware
 * date/time string for the KChat post badge. We intentionally
 * pick a stable concise format (`MMM d, HH:mm`) so the badge
 * fits the same line as the relevance score on a narrow
 * citation row.
 */
function formatKchatTimestamp(ms: number): string {
  if (!Number.isFinite(ms) || ms <= 0) return "";
  try {
    return new Date(ms).toLocaleString(undefined, {
      month: "short",
      day: "numeric",
      hour: "2-digit",
      minute: "2-digit",
    });
  } catch {
    return "";
  }
}

/**
 * Run both retrieval pipelines in parallel and interleave the
 * results by relevance score. Failures in either path do NOT
 * fail the whole dialog — the user still sees results from the
 * other path. This is the renderer-side equivalent of the
 * substrate's defence-in-depth: a stuck audit logger doesn't
 * crash the search, and a stuck kchat-search doesn't hide file
 * evidence.
 */
async function runMergedEvidenceSearch(
  query: string,
  limit: number,
): Promise<EvidenceRow[]> {
  const api = window.tessera;
  if (!api) return [];
  const [fileResult, postResult] = await Promise.allSettled([
    api.sources.searchSources(query, limit),
    // KChat surface is feature-gated: render gracefully when the
    // KChat API or `searchPosts` is not present on the host (e.g.
    // older preloads, locked-down enterprise tier).
    api.kchat && typeof api.kchat.searchPosts === "function"
      ? api.kchat.searchPosts(query, limit)
      : Promise.resolve([] as KchatPostSearchHit[]),
  ]);
  // Guard on Array.isArray, not just the settled status: a host can
  // *fulfil* with a non-array (e.g. `undefined` from an older preload,
  // a locked-down enterprise tier, or a partial bridge). Iterating that
  // would throw and — because the callers run this inside `Promise.all`
  // — reject the whole search, leaving the panel stuck on a blank
  // pre-search state. Treating a non-array as "no hits" keeps the
  // defence-in-depth promise: a broken path contributes nothing rather
  // than taking the other path's results down with it.
  const rows: EvidenceRow[] = [];
  if (fileResult.status === "fulfilled" && Array.isArray(fileResult.value)) {
    for (const hit of fileResult.value) rows.push({ kind: "file", hit });
  }
  if (postResult.status === "fulfilled" && Array.isArray(postResult.value)) {
    for (const hit of postResult.value) {
      rows.push({ kind: "kchat_post", hit });
    }
  }
  // Stable sort: highest relevance first, ties broken by
  // insertion order (i.e. file hits before KChat hits at the
  // same score) so the merged list is deterministic across
  // renders. The substrate already returns each list sorted, so
  // we only need an interleave-by-score pass here.
  rows.sort((a, b) => b.hit.relevanceScore - a.hit.relevanceScore);
  return rows;
}

interface CitationPanelProps {
  artifactId: string;
  isOpen: boolean;
  onClose: () => void;
}

type FreshnessMap = Record<string, CitationFreshness>;

export default function CitationPanel({ artifactId, isOpen, onClose }: CitationPanelProps) {
  const [citations, setCitations] = useState<CitationInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [freshness, setFreshness] = useState<FreshnessMap>({});
  const [pendingDelete, setPendingDelete] = useState<string | null>(null);
  const [replaceFor, setReplaceFor] = useState<CitationInfo | null>(null);

  const loadCitations = useCallback(async () => {
    setLoading(true);
    try {
      const api = window.tessera;
      if (!api) return;
      const list = await api.citations.list(artifactId);
      setCitations(list);

      // Check freshness in parallel — much faster for artifacts with
      // many citations than the previous sequential loop.
      const entries = await Promise.all(
        list.map(async (citation): Promise<[string, CitationFreshness]> => {
          try {
            const status = await api.citations.checkFreshness(citation.citationId);
            return [citation.citationId, status];
          } catch {
            return [citation.citationId, "changed"];
          }
        }),
      );
      const map: FreshnessMap = {};
      for (const [id, status] of entries) {
        map[id] = status;
      }
      setFreshness(map);
    } finally {
      setLoading(false);
    }
  }, [artifactId]);

  useEffect(() => {
    if (isOpen) loadCitations();
  }, [isOpen, loadCitations]);

  // Keyboard shortcut: Escape dismisses the innermost open surface
  // first, falling back to closing the whole panel only when no
  // sub-dialog is open. Without this hierarchy a single Escape would
  // close both an open sub-dialog AND the panel underneath it (the
  // panel's listener and the dialog's listener both fired), yanking
  // the panel out from under the user. Centralizing the precedence
  // here keeps it in one place and lets the sub-dialogs stay listener-free.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key !== "Escape") return;
      e.preventDefault();
      if (pendingDelete) {
        setPendingDelete(null);
      } else if (replaceFor) {
        setReplaceFor(null);
      } else if (showAdd) {
        setShowAdd(false);
      } else {
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose, pendingDelete, replaceFor, showAdd]);

  const confirmRemove = async (citationId: string) => {
    try {
      const api = window.tessera;
      if (!api) return;
      await api.citations.remove(artifactId, citationId);
      setCitations((prev) => prev.filter((c) => c.citationId !== citationId));
      setFreshness((prev) => {
        const next = { ...prev };
        delete next[citationId];
        return next;
      });
    } finally {
      setPendingDelete(null);
    }
  };

  const handleAdd = async (req: AddCitationRequest) => {
    try {
      const api = window.tessera;
      if (!api) return;
      const added = await api.citations.add(req);
      setCitations((prev) => [...prev, added]);
      setFreshness((prev) => ({ ...prev, [added.citationId]: "fresh" }));
      setShowAdd(false);
    } catch {
      // surfaced via toast in the parent; keep the dialog open so
      // the user can adjust their selection without losing context.
    }
  };

  const handleReplace = async (req: ReplaceCitationRequest) => {
    const api = window.tessera;
    if (!api) return;
    const result = await api.citations.replace(req);
    setCitations((prev) =>
      prev.map((c) =>
        c.citationId === req.citationId ? result.citation : c,
      ),
    );
    setFreshness((prev) => ({
      ...prev,
      [req.citationId]: "fresh",
    }));
    setReplaceFor(null);
  };

  if (!isOpen) return null;

  return (
    <div
      className="citation-panel"
      role="region"
      aria-label="Citations panel"
    >
      <div className="citation-panel-header">
        <h3>Citations ({citations.length})</h3>
        <div style={{ display: "flex", gap: "var(--spacing-xs)" }}>
          <Button
            variant="secondary"
            onClick={() => setShowAdd(true)}
            aria-label="Add a new citation"
          >
            Add
          </Button>
          <Button
            variant="secondary"
            onClick={onClose}
            aria-label="Close citations panel"
          >
            Close
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="citation-loading">Loading citations...</p>
      ) : citations.length === 0 ? (
        <p className="citation-empty">No citations attached to this artifact.</p>
      ) : (
        <ul className="citation-list" aria-label="Citation list">
          {citations.map((citation) => {
            const status = freshness[citation.citationId] ?? "fresh";
            // post-sourced citations
            // render with the KChat badge + channel display title
            // instead of a file path. The discriminator is
            // `sourceType === "kchat_post"` (set by
            // `buildCitationFields` when the row was first
            // picked). We branch on this here so the stored
            // citation list communicates "this evidence lives in
            // KChat" at a glance, matching the search-hit row
            // rendering above.
            const isKchatPost = citation.sourceType === "kchat_post";
            return (
              <li
                key={citation.citationId}
                className={
                  isKchatPost
                    ? "citation-item citation-item-kchat"
                    : "citation-item"
                }
                data-source-type={citation.sourceType}
              >
                <div className="citation-item-header">
                  {isKchatPost && (
                    <span
                      className="citation-source-badge citation-source-badge-kchat"
                      aria-label="KChat post"
                    >
                      KChat
                    </span>
                  )}
                  <span className="citation-source-title">
                    {isKchatPost
                      ? `#${citation.sourceTitle}`
                      : citation.sourceTitle}
                  </span>
                  {status === "changed" && (
                    <span
                      className="citation-changed-badge"
                      title="Source has changed since this citation was created"
                      aria-label="Source changed warning"
                    >
                      <span aria-hidden="true">⚠</span> Changed
                    </span>
                  )}
                  {status === "source_missing" && (
                    <span
                      className="citation-missing-badge"
                      title="The original source is no longer indexed"
                      aria-label="Source missing warning"
                    >
                      <span aria-hidden="true">⚠</span> Source missing
                    </span>
                  )}
                </div>
                <div className="citation-source-path">{citation.sourceUri}</div>
                {citation.page != null && (
                  <div className="citation-page">Page {citation.page}</div>
                )}
                <div className="citation-meta">
                  <span>Confidence: {(citation.confidence * 100).toFixed(0)}%</span>
                  <span>Used for: {citation.usedFor || "—"}</span>
                </div>
                <div className="citation-actions">
                  <Button
                    variant="secondary"
                    onClick={() => setReplaceFor(citation)}
                    aria-label={`Replace citation from ${citation.sourceTitle}`}
                  >
                    Replace
                  </Button>
                  <Button
                    variant="danger"
                    onClick={() => setPendingDelete(citation.citationId)}
                    aria-label={`Remove citation from ${citation.sourceTitle}`}
                  >
                    Remove
                  </Button>
                </div>
              </li>
            );
          })}
        </ul>
      )}

      {showAdd && (
        <AddCitationDialog
          artifactId={artifactId}
          onAdd={handleAdd}
          onCancel={() => setShowAdd(false)}
        />
      )}

      {replaceFor && (
        <ReplaceCitationDialog
          artifactId={artifactId}
          citation={replaceFor}
          onReplace={handleReplace}
          onCancel={() => setReplaceFor(null)}
        />
      )}

      {pendingDelete && (
        <ConfirmRemoveDialog
          onConfirm={() => confirmRemove(pendingDelete)}
          onCancel={() => setPendingDelete(null)}
        />
      )}
    </div>
  );
}

/**
 * render a single evidence row. Files
 * render as before (path + excerpt + relevance). KChat posts
 * render with a `KChat` badge, the sender/timestamp metadata,
 * the excerpt, the relevance, and a permalink anchor when the
 * IPC handler composed one (the anchor is presentational —
 * clicking the surrounding row still selects the citation; the
 * anchor `stopPropagation`s so opening the KChat link does NOT
 * also pick the citation).
 */
function EvidenceRowButton({
  row,
  onSelect,
  disabled,
}: {
  row: EvidenceRow;
  onSelect: (row: EvidenceRow) => void;
  disabled?: boolean;
}) {
  if (row.kind === "file") {
    return (
      <button
        type="button"
        className="citation-search-hit"
        onClick={() => onSelect(row)}
        disabled={disabled}
      >
        <span className="citation-hit-path">{row.hit.sourcePath}</span>
        <span className="citation-hit-excerpt">{row.hit.excerpt}</span>
        <RelevanceBadge score={row.hit.relevanceScore} />
      </button>
    );
  }
  const hit = row.hit;
  const timestamp = formatKchatTimestamp(hit.createdAtMs);
  // fall back to the raw object id when
  // the IPC handler couldn't resolve the display string (offline,
  // user removed from the channel, etc.). The row still renders
  // — the spec is "icon + sender + channel" with graceful
  // degradation, not "hide the row when names are missing".
  const senderLabel = hit.senderUsername ?? hit.senderUserId;
  const channelLabel = hit.channelDisplayName ?? hit.channelId;
  return (
    <button
      type="button"
      className="citation-search-hit citation-search-hit-kchat"
      onClick={() => onSelect(row)}
      disabled={disabled}
      data-source-kind="kchat_post"
    >
      <span className="citation-hit-path">
        <span
          className="citation-source-badge citation-source-badge-kchat"
          aria-label="KChat post"
        >
          KChat
        </span>
        <span
          className="citation-hit-kchat-channel"
          aria-label={`channel ${channelLabel}`}
        >
          #{channelLabel}
        </span>
        <span className="citation-hit-kchat-sender">@{senderLabel}</span>
        {timestamp && (
          <span className="citation-hit-kchat-timestamp"> · {timestamp}</span>
        )}
      </span>
      <span className="citation-hit-excerpt">{hit.excerpt}</span>
      <span className="citation-hit-trailing">
        {hit.permalink && (
          <a
            href={hit.permalink}
            className="citation-hit-kchat-permalink"
            target="_blank"
            rel="noreferrer noopener"
            onClick={(e) => e.stopPropagation()}
            aria-label="Open post in KChat"
          >
            Open in KChat
          </a>
        )}
        <RelevanceBadge score={hit.relevanceScore} />
      </span>
    </button>
  );
}

/**
 * Build an {@link AddCitationRequest} (and the same shape for
 * Replace) from a chosen evidence row. The `sourceType` /
 * `sourceUri` shape diverges between file and KChat hits:
 *
 *   - file hits: `sourceType="local_file"`, `sourceUri` is the
 *     absolute path (same as before).
 *   - KChat post: `sourceType="kchat_post"`, `sourceUri` is the
 *     `kchat://channel/<id>/post/<id>` URN (note: NOT the
 *     server-specific permalink — the URN is server-agnostic
 *     and round-trips across re-connects to the same workspace,
 *     where the permalink would break if the user re-connects
 *     to a renamed server URL). Title is the channel display
 *     name when the IPC handler resolved it, falling back to the
 *     raw channel id when offline
 *     so the stored citation remains retrievable end-to-end.
 *     Persisting the resolved name (rather than re-resolving on
 *     every render) means the artifact stays attributable even
 *     after the user disconnects from KChat.
 */
function buildCitationFields(row: EvidenceRow): {
  sourceId: string;
  sourceType: string;
  sourceTitle: string;
  sourceUri: string;
  chunkHash: string;
  confidence: number;
} {
  if (row.kind === "file") {
    return {
      sourceId: row.hit.sourceId,
      sourceType: "local_file",
      sourceTitle: row.hit.sourcePath.split("/").pop() || row.hit.sourcePath,
      sourceUri: row.hit.sourcePath,
      chunkHash: row.hit.chunkHash,
      confidence: row.hit.relevanceScore,
    };
  }
  const hit = row.hit;
  // prefer the resolved channel display
  // name as the stored sourceTitle so a saved citation reads
  // "#general" rather than "channel-xyz" in the artifact's
  // citation list. Fallback path is the raw channelId — that
  // also remains a valid retrieval key, so the citation is never
  // silently broken by the rename / disconnect path.
  const channelTitle = hit.channelDisplayName ?? hit.channelId;
  return {
    sourceId: hit.sourceId,
    sourceType: "kchat_post",
    sourceTitle: channelTitle,
    sourceUri: `kchat://channel/${hit.channelId}/post/${hit.postId}`,
    chunkHash: hit.chunkHash,
    confidence: hit.relevanceScore,
  };
}

/** The two result views in the search dialogs. */
type ResultTab = "sources" | "knowledge";

/**
 * Total count of knowledge items across the entity / fact / concept
 * planes — drives the "Knowledge (N)" tab label and the empty-state
 * copy. Memories are intentionally excluded from the badge because
 * they are a superset of entities + facts (showing them would
 * double-count what the user already sees in those sections).
 */
function knowledgeCount(k: EnrichedSearchResult): number {
  return k.entities.length + k.facts.length + k.concepts.length;
}

/**
 * Render the additive "Knowledge" plane of an enriched search:
 * entities and facts (observation-typed memory items) plus matching
 * concept-graph nodes. Each row shows its decay state and, for
 * concepts, how many sources it co-occurs in. Purely informational —
 * unlike the "Sources" tab these rows are not selectable as citations
 * (entities/concepts have no single chunk hash to attribute).
 */
function KnowledgeResultsView({ knowledge }: { knowledge: EnrichedSearchResult }) {
  const total = knowledgeCount(knowledge);
  if (total === 0) {
    return (
      <p className="citation-knowledge-empty">
        No entities, facts, or concepts found for this query. Run the
        observation pipeline on your sources to populate the knowledge
        layer.
      </p>
    );
  }
  return (
    <div className="citation-knowledge-results">
      {knowledge.entities.length > 0 && (
        <KnowledgeMemorySection
          title="Entities"
          items={knowledge.entities}
          kind="entity"
        />
      )}
      {knowledge.facts.length > 0 && (
        <KnowledgeMemorySection
          title="Facts"
          items={knowledge.facts}
          kind="fact"
        />
      )}
      {knowledge.concepts.length > 0 && (
        <section
          className="citation-knowledge-section"
          aria-label="Concepts"
        >
          <h5 className="citation-knowledge-heading">
            Concepts ({knowledge.concepts.length})
          </h5>
          <ul className="citation-knowledge-list">
            {knowledge.concepts.map((concept: SubstrateConceptInfo) => (
              <li
                key={concept.id}
                className="citation-knowledge-item citation-knowledge-item-concept"
                data-state={concept.state}
              >
                <span className="citation-knowledge-label">
                  {concept.label}
                </span>
                <span className="citation-knowledge-meta">
                  <span className="citation-knowledge-state">
                    {concept.state}
                  </span>
                  {concept.relatedSourceIds.length > 0 && (
                    <span className="citation-knowledge-sources">
                      {concept.relatedSourceIds.length} source
                      {concept.relatedSourceIds.length === 1 ? "" : "s"}
                    </span>
                  )}
                </span>
              </li>
            ))}
          </ul>
        </section>
      )}
    </div>
  );
}

function KnowledgeMemorySection({
  title,
  items,
  kind,
}: {
  title: string;
  items: SubstrateMemoryInfo[];
  kind: string;
}) {
  return (
    <section className="citation-knowledge-section" aria-label={title}>
      <h5 className="citation-knowledge-heading">
        {title} ({items.length})
      </h5>
      <ul className="citation-knowledge-list">
        {items.map((item) => (
          <li
            key={item.id}
            className={`citation-knowledge-item citation-knowledge-item-${kind}`}
            data-state={item.state}
          >
            <span className="citation-knowledge-label">{item.content}</span>
            <span className="citation-knowledge-meta">
              <span className="citation-knowledge-state">{item.state}</span>
              <span
                className="citation-knowledge-retention"
                title="Retention score"
              >
                {(item.retentionScore * 100).toFixed(0)}%
              </span>
            </span>
          </li>
        ))}
      </ul>
    </section>
  );
}

/**
 * Tabbed switch between the "Sources" (selectable evidence rows) and
 * "Knowledge" (entities / facts / concepts) views shared by the
 * Add/Replace citation dialogs. The Sources tab is unchanged from the
 * original flat list; Knowledge is additive.
 */
function SearchResultsTabs({
  activeTab,
  onTabChange,
  sourcesCount,
  knowledge,
  children,
}: {
  activeTab: ResultTab;
  onTabChange: (tab: ResultTab) => void;
  sourcesCount: number;
  knowledge: EnrichedSearchResult;
  children: ReactNode;
}) {
  return (
    <div className="citation-search-tabs-container">
      <div
        className="citation-search-tabs"
        role="tablist"
        aria-label="Search result views"
      >
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "sources"}
          className={
            activeTab === "sources"
              ? "citation-search-tab citation-search-tab-active"
              : "citation-search-tab"
          }
          onClick={() => onTabChange("sources")}
        >
          Sources ({sourcesCount})
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={activeTab === "knowledge"}
          className={
            activeTab === "knowledge"
              ? "citation-search-tab citation-search-tab-active"
              : "citation-search-tab"
          }
          onClick={() => onTabChange("knowledge")}
        >
          Knowledge ({knowledgeCount(knowledge)})
        </button>
      </div>
      <div role="tabpanel">
        {activeTab === "sources" ? (
          children
        ) : (
          <KnowledgeResultsView knowledge={knowledge} />
        )}
      </div>
    </div>
  );
}

function AddCitationDialog({
  artifactId,
  onAdd,
  onCancel,
}: {
  artifactId: string;
  onAdd: (req: AddCitationRequest) => void;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EvidenceRow[]>([]);
  const [knowledge, setKnowledge] =
    useState<EnrichedSearchResult>(EMPTY_KNOWLEDGE);
  const [activeTab, setActiveTab] = useState<ResultTab>("sources");
  const [searching, setSearching] = useState(false);
  const [searched, setSearched] = useState(false);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      // Run the existing merged evidence search (file + KChat) and the
      // additive knowledge-plane lookup in parallel. A failure in the
      // knowledge plane degrades to an empty "Knowledge" tab without
      // affecting the "Sources" results.
      const [rows, plane] = await Promise.all([
        runMergedEvidenceSearch(query, 10),
        fetchKnowledgePlane(query, 10),
      ]);
      setResults(rows);
      setKnowledge(plane);
      setSearched(true);
    } finally {
      setSearching(false);
    }
  };

  const selectHit = (row: EvidenceRow) => {
    const fields = buildCitationFields(row);
    const req: AddCitationRequest = {
      artifactId,
      sourceId: fields.sourceId,
      sourceType: fields.sourceType,
      sourceTitle: fields.sourceTitle,
      sourceUri: fields.sourceUri,
      chunkHash: fields.chunkHash,
      page: null,
      confidence: fields.confidence,
      usedFor: "",
    };
    onAdd(req);
  };

  return (
    <div className="citation-add-dialog" role="dialog" aria-label="Add citation">
      <h4>Add Citation from Sources</h4>
      <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
        <input
          className="input"
          placeholder="Search sources..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSearch();
          }}
          aria-label="Search sources for new citation"
        />
        <Button onClick={handleSearch} disabled={searching}>
          Search
        </Button>
      </div>
      {searched && (
        <SearchResultsTabs
          activeTab={activeTab}
          onTabChange={setActiveTab}
          sourcesCount={results.length}
          knowledge={knowledge}
        >
          {results.length > 0 ? (
            <div className="citation-search-results" role="list">
              {results.map((row, i) => (
                <EvidenceRowButton
                  key={
                    row.kind === "file"
                      ? `file-${row.hit.chunkHash}-${i}`
                      : `kchat-${row.hit.postId}-${row.hit.chunkHash}-${i}`
                  }
                  row={row}
                  onSelect={selectHit}
                />
              ))}
            </div>
          ) : (
            <p className="citation-search-empty">
              No matching chunks found for this query.
            </p>
          )}
        </SearchResultsTabs>
      )}
      <Button variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

function ReplaceCitationDialog({
  artifactId,
  citation,
  onReplace,
  onCancel,
}: {
  artifactId: string;
  citation: CitationInfo;
  onReplace: (req: ReplaceCitationRequest) => Promise<void>;
  onCancel: () => void;
}) {
  const [query, setQuery] = useState("");
  const [results, setResults] = useState<EvidenceRow[]>([]);
  const [knowledge, setKnowledge] =
    useState<EnrichedSearchResult>(EMPTY_KNOWLEDGE);
  const [activeTab, setActiveTab] = useState<ResultTab>("sources");
  const [searched, setSearched] = useState(false);
  const [searching, setSearching] = useState(false);
  const [replacing, setReplacing] = useState<string | null>(null);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const [rows, plane] = await Promise.all([
        runMergedEvidenceSearch(query, 10),
        fetchKnowledgePlane(query, 10),
      ]);
      setResults(rows);
      setKnowledge(plane);
      setSearched(true);
    } finally {
      setSearching(false);
    }
  };

  const selectHit = async (row: EvidenceRow) => {
    const fields = buildCitationFields(row);
    setReplacing(fields.chunkHash);
    try {
      await onReplace({
        artifactId,
        citationId: citation.citationId,
        sourceId: fields.sourceId,
        sourceType: fields.sourceType,
        sourceTitle: fields.sourceTitle,
        sourceUri: fields.sourceUri,
        chunkHash: fields.chunkHash,
        page: null,
        confidence: fields.confidence,
      });
    } finally {
      setReplacing(null);
    }
  };

  return (
    <div
      className="citation-add-dialog citation-replace-dialog"
      role="dialog"
      aria-label="Replace citation"
    >
      <h4>Replace Citation</h4>
      <p className="citation-replace-current">
        Currently sourced from <strong>{citation.sourceTitle}</strong>
      </p>
      <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
        <input
          className="input"
          placeholder="Search for replacement source..."
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") handleSearch();
          }}
          aria-label="Search sources for replacement"
          autoFocus
        />
        <Button onClick={handleSearch} disabled={searching}>
          Search
        </Button>
      </div>
      {searched && (
        <SearchResultsTabs
          activeTab={activeTab}
          onTabChange={setActiveTab}
          sourcesCount={results.length}
          knowledge={knowledge}
        >
          {results.length > 0 ? (
            <div className="citation-search-results" role="list">
              {results.map((row, i) => (
                <EvidenceRowButton
                  key={
                    row.kind === "file"
                      ? `file-${row.hit.chunkHash}-${i}`
                      : `kchat-${row.hit.postId}-${row.hit.chunkHash}-${i}`
                  }
                  row={row}
                  onSelect={selectHit}
                  disabled={replacing != null}
                />
              ))}
            </div>
          ) : (
            <p className="citation-search-empty">
              No matching chunks found for this query.
            </p>
          )}
        </SearchResultsTabs>
      )}
      <Button variant="secondary" onClick={onCancel}>
        Cancel
      </Button>
    </div>
  );
}

function ConfirmRemoveDialog({
  onConfirm,
  onCancel,
}: {
  onConfirm: () => void;
  onCancel: () => void;
}) {
  // Escape handling is owned by the parent CitationPanel, which
  // dismisses the innermost open surface first — so Escape here
  // cancels the removal without also closing the panel.
  return (
    <div
      className="citation-confirm-dialog"
      role="alertdialog"
      aria-label="Confirm citation removal"
    >
      <h4>Remove citation?</h4>
      <p>
        Removing only unlinks the provenance — the cited text stays
        in the artifact.
      </p>
      <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
        <Button variant="danger" onClick={onConfirm} autoFocus>
          Remove
        </Button>
        <Button variant="secondary" onClick={onCancel}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
