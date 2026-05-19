import { useState, useEffect, useCallback } from "react";
import Button from "./Button";
import type { CitationInfo, AddCitationRequest, SearchHit } from "../types/ipc";

interface CitationPanelProps {
  artifactId: string;
  isOpen: boolean;
  onClose: () => void;
}

export default function CitationPanel({ artifactId, isOpen, onClose }: CitationPanelProps) {
  const [citations, setCitations] = useState<CitationInfo[]>([]);
  const [loading, setLoading] = useState(true);
  const [showAdd, setShowAdd] = useState(false);
  const [changedCitations, setChangedCitations] = useState<Set<string>>(new Set());

  const loadCitations = useCallback(async () => {
    setLoading(true);
    try {
      const api = window.tessera;
      if (!api) return;
      const list = await api.citations.list(artifactId);
      setCitations(list);

      // Check for source changes
      const changed = new Set<string>();
      for (const citation of list) {
        try {
          const isChanged = await api.citations.checkChanged(
            citation.citationId,
            citation.chunkHash,
          );
          if (isChanged) changed.add(citation.citationId);
        } catch {
          // skip check failures
        }
      }
      setChangedCitations(changed);
    } finally {
      setLoading(false);
    }
  }, [artifactId]);

  useEffect(() => {
    if (isOpen) loadCitations();
  }, [isOpen, loadCitations]);

  const handleRemove = async (citationId: string) => {
    try {
      const api = window.tessera;
      if (!api) return;
      await api.citations.remove(artifactId, citationId);
      setCitations((prev) => prev.filter((c) => c.citationId !== citationId));
    } catch {
      // handle error
    }
  };

  const handleAdd = async (req: AddCitationRequest) => {
    try {
      const api = window.tessera;
      if (!api) return;
      const added = await api.citations.add(req);
      setCitations((prev) => [...prev, added]);
      setShowAdd(false);
    } catch {
      // handle error
    }
  };

  if (!isOpen) return null;

  return (
    <div className="citation-panel">
      <div className="citation-panel-header">
        <h3>Citations ({citations.length})</h3>
        <div style={{ display: "flex", gap: "var(--spacing-xs)" }}>
          <Button variant="secondary" onClick={() => setShowAdd(true)}>
            Add
          </Button>
          <Button variant="secondary" onClick={onClose}>
            Close
          </Button>
        </div>
      </div>

      {loading ? (
        <p className="citation-loading">Loading citations...</p>
      ) : citations.length === 0 ? (
        <p className="citation-empty">No citations attached to this artifact.</p>
      ) : (
        <div className="citation-list">
          {citations.map((citation) => (
            <div key={citation.citationId} className="citation-item">
              <div className="citation-item-header">
                <span className="citation-source-title">{citation.sourceTitle}</span>
                {changedCitations.has(citation.citationId) && (
                  <span className="citation-changed-badge" title="Source has changed since this citation was created">
                    Changed
                  </span>
                )}
              </div>
              <div className="citation-source-path">{citation.sourceUri}</div>
              {citation.page != null && (
                <div className="citation-page">Page {citation.page}</div>
              )}
              <div className="citation-meta">
                <span>Confidence: {(citation.confidence * 100).toFixed(0)}%</span>
                <span>Used for: {citation.usedFor}</span>
              </div>
              <div className="citation-actions">
                <Button
                  variant="danger"
                  onClick={() => handleRemove(citation.citationId)}
                >
                  Remove
                </Button>
              </div>
            </div>
          ))}
        </div>
      )}

      {showAdd && (
        <AddCitationDialog
          artifactId={artifactId}
          onAdd={handleAdd}
          onCancel={() => setShowAdd(false)}
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
      sourceId: "",
      sourceType: "local_file",
      sourceTitle: hit.sourcePath.split("/").pop() || hit.sourcePath,
      sourceUri: hit.sourcePath,
      chunkHash: "",
      page: null,
      confidence: hit.relevanceScore,
      usedFor: "",
    };
    onAdd(req);
  };

  return (
    <div className="citation-add-dialog">
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
        />
        <Button onClick={handleSearch} disabled={searching}>
          Search
        </Button>
      </div>
      {results.length > 0 && (
        <div className="citation-search-results">
          {results.map((hit, i) => (
            <button
              key={i}
              type="button"
              className="citation-search-hit"
              onClick={() => selectHit(hit)}
            >
              <span className="citation-hit-path">{hit.sourcePath}</span>
              <span className="citation-hit-excerpt">{hit.excerpt}</span>
              <span className="citation-hit-score">
                {(hit.relevanceScore * 100).toFixed(0)}%
              </span>
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
