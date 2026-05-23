import { useState, useEffect, useCallback } from "react";
import Button from "./Button";
import RelevanceBadge from "./RelevanceBadge";
import type {
  CitationInfo,
  AddCitationRequest,
  CitationFreshness,
  ReplaceCitationRequest,
  SearchHit,
} from "../types/ipc";

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

  // Keyboard shortcut: Escape closes the panel.
  useEffect(() => {
    if (!isOpen) return;
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onClose();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [isOpen, onClose]);

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
            return (
              <li key={citation.citationId} className="citation-item">
                <div className="citation-item-header">
                  <span className="citation-source-title">{citation.sourceTitle}</span>
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
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const api = window.tessera;
      if (!api) return;
      const hits = await api.sources.searchSources(query, 10);
      setResults(hits);
    } finally {
      setSearching(false);
    }
  };

  const selectHit = (hit: SearchHit) => {
    const req: AddCitationRequest = {
      artifactId,
      sourceId: hit.sourceId,
      sourceType: "local_file",
      sourceTitle: hit.sourcePath.split("/").pop() || hit.sourcePath,
      sourceUri: hit.sourcePath,
      chunkHash: hit.chunkHash,
      page: null,
      confidence: hit.relevanceScore,
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
      {results.length > 0 && (
        <div className="citation-search-results" role="list">
          {results.map((hit, i) => (
            <button
              key={i}
              type="button"
              className="citation-search-hit"
              onClick={() => selectHit(hit)}
            >
              <span className="citation-hit-path">{hit.sourcePath}</span>
              <span className="citation-hit-excerpt">{hit.excerpt}</span>
              <RelevanceBadge score={hit.relevanceScore} />
            </button>
          ))}
        </div>
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
  const [results, setResults] = useState<SearchHit[]>([]);
  const [searching, setSearching] = useState(false);
  const [replacing, setReplacing] = useState<string | null>(null);

  const handleSearch = async () => {
    if (!query.trim()) return;
    setSearching(true);
    try {
      const api = window.tessera;
      if (!api) return;
      const hits = await api.sources.searchSources(query, 10);
      setResults(hits);
    } finally {
      setSearching(false);
    }
  };

  const selectHit = async (hit: SearchHit) => {
    setReplacing(hit.chunkHash);
    try {
      await onReplace({
        artifactId,
        citationId: citation.citationId,
        sourceId: hit.sourceId,
        sourceType: "local_file",
        sourceTitle: hit.sourcePath.split("/").pop() || hit.sourcePath,
        sourceUri: hit.sourcePath,
        chunkHash: hit.chunkHash,
        page: null,
        confidence: hit.relevanceScore,
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
      {results.length > 0 && (
        <div className="citation-search-results" role="list">
          {results.map((hit, i) => (
            <button
              key={i}
              type="button"
              className="citation-search-hit"
              onClick={() => selectHit(hit)}
              disabled={replacing != null}
            >
              <span className="citation-hit-path">{hit.sourcePath}</span>
              <span className="citation-hit-excerpt">{hit.excerpt}</span>
              <RelevanceBadge score={hit.relevanceScore} />
            </button>
          ))}
        </div>
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
  // Trap Escape so the destructive dialog never disappears
  // without an explicit user choice.
  useEffect(() => {
    const handler = (e: KeyboardEvent) => {
      if (e.key === "Escape") {
        e.preventDefault();
        onCancel();
      }
    };
    window.addEventListener("keydown", handler);
    return () => window.removeEventListener("keydown", handler);
  }, [onCancel]);

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
