import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import Modal from "./Modal";
import Button from "./Button";
import type { CompareSourcesResult, ThemeInfo } from "../types/ipc";
import {
  downloadMarkdown,
  formatSimilarity,
  sanitizeForFilename,
} from "./comparisonResultModalHelpers";

interface ComparisonResultModalProps {
  isOpen: boolean;
  onClose: () => void;
  /**
   * Result of `api.artifacts.compareSources`. Carries the persisted
   * comparison artifact AND the structured comparison data the
   * Rust side already produced — the modal reads the structured
   * data directly rather than re-parsing the artifact markdown,
   * which would be circular and would lose theme-frequency data
   * that the markdown rendering rounds away.
   */
  result: CompareSourcesResult;
}

interface ThemeListProps {
  themes: ThemeInfo[];
  emptyMessage: string;
  testId: string;
}

function ThemeList({ themes, emptyMessage, testId }: ThemeListProps) {
  if (themes.length === 0) {
    return (
      <p
        data-testid={`${testId}-empty`}
        style={{
          fontStyle: "italic",
          color: "var(--color-text-secondary)",
          margin: 0,
        }}
      >
        {emptyMessage}
      </p>
    );
  }
  return (
    <ul
      data-testid={testId}
      style={{
        listStyle: "none",
        padding: 0,
        margin: 0,
        display: "flex",
        flexWrap: "wrap",
        gap: "var(--spacing-xs)",
      }}
    >
      {themes.map((theme) => (
        <li
          key={theme.label}
          data-testid={`${testId}-item-${theme.label}`}
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: "0.25rem",
            padding: "0.125rem 0.5rem",
            backgroundColor: "var(--color-bg-muted, var(--color-bg-page))",
            border: "1px solid var(--color-border)",
            borderRadius: "var(--radius-button)",
            fontSize: "var(--font-size-sm)",
          }}
        >
          <span>{theme.label}</span>
          <span
            style={{
              color: "var(--color-text-secondary)",
              fontVariantNumeric: "tabular-nums",
            }}
          >
            ({theme.frequency})
          </span>
        </li>
      ))}
    </ul>
  );
}

export default function ComparisonResultModal({
  isOpen,
  onClose,
  result,
}: ComparisonResultModalProps) {
  const navigate = useNavigate();
  const { artifact, comparison, labelA, labelB } = result;

  const handleOpenArtifact = useCallback(() => {
    onClose();
    // /artifacts/:id is NOT a registered route (the router only registers
    // /artifacts/:id/edit; the catch-all redirects to "/"), so navigating
    // there silently sends the user to Home. Open the editor directly,
    // matching HomePage's recent-artifact cards and the command palette.
    navigate(`/artifacts/${artifact.id}/edit`);
  }, [artifact.id, navigate, onClose]);

  const handleDownload = useCallback(() => {
    // Reuse the bridge-rendered markdown so the file matches the
    // persisted artifact byte-for-byte. The renderer cannot
    // re-render the markdown itself because the bridge applies
    // theme truncation (≤30 common, ≤20 unique) deterministically
    // before formatting — keeping the markdown identity is what
    // makes the download a faithful snapshot of the comparison.
    const filename = `comparison-${sanitizeForFilename(
      labelA,
    )}-vs-${sanitizeForFilename(labelB)}.md`;
    downloadMarkdown(filename, artifact.content);
  }, [artifact.content, labelA, labelB]);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={`Comparison: ${labelA} vs ${labelB}`}
    >
      <p
        data-testid="comparison-modal-similarity"
        style={{ marginTop: 0, marginBottom: "var(--spacing-md)" }}
      >
        <strong>Similarity:</strong>{" "}
        {formatSimilarity(comparison.similarityScore)}
      </p>

      <section
        aria-label="Common themes"
        style={{ marginBottom: "var(--spacing-md)" }}
      >
        <h3 style={{ margin: "0 0 var(--spacing-xs) 0" }}>
          Common themes ({comparison.commonThemes.length})
        </h3>
        <ThemeList
          themes={comparison.commonThemes}
          emptyMessage="No themes shared between the two sources."
          testId="comparison-modal-common"
        />
      </section>

      <section
        aria-label={`Unique to ${labelA}`}
        style={{ marginBottom: "var(--spacing-md)" }}
      >
        <h3 style={{ margin: "0 0 var(--spacing-xs) 0" }}>
          Unique to {labelA} ({comparison.uniqueToA.length})
        </h3>
        <ThemeList
          themes={comparison.uniqueToA}
          emptyMessage={`No themes unique to ${labelA}.`}
          testId="comparison-modal-unique-a"
        />
      </section>

      <section
        aria-label={`Unique to ${labelB}`}
        style={{ marginBottom: "var(--spacing-lg)" }}
      >
        <h3 style={{ margin: "0 0 var(--spacing-xs) 0" }}>
          Unique to {labelB} ({comparison.uniqueToB.length})
        </h3>
        <ThemeList
          themes={comparison.uniqueToB}
          emptyMessage={`No themes unique to ${labelB}.`}
          testId="comparison-modal-unique-b"
        />
      </section>

      <div
        style={{
          display: "flex",
          gap: "var(--spacing-sm)",
          flexWrap: "wrap",
          justifyContent: "flex-end",
        }}
      >
        <Button
          variant="secondary"
          onClick={handleDownload}
          data-testid="comparison-modal-download"
        >
          Download as Markdown
        </Button>
        <Button
          variant="secondary"
          onClick={handleOpenArtifact}
          data-testid="comparison-modal-open-artifact"
        >
          Open artifact
        </Button>
        <Button onClick={onClose} data-testid="comparison-modal-close">
          Close
        </Button>
      </div>
    </Modal>
  );
}
