import { useCallback } from "react";
import { useNavigate } from "react-router-dom";
import Modal from "./Modal";
import Button from "./Button";
import type { CompareSourcesResult, ThemeInfo } from "../types/ipc";

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

/**
 * Format the bridge-side `similarityScore` (a value in `[0.0, 1.0]`)
 * as a percentage string with no fractional digit. Matches the
 * `to_markdown` rendering in
 * `crates/tessera_artifacts/src/comparison.rs` so the modal heading
 * matches what the user would see if they opened the comparison
 * artifact.
 */
export function formatSimilarity(score: number): string {
  // Guard against a malformed bridge response (NaN / Infinity)
  // landing on the renderer — `Math.round(NaN) * 100` would render
  // "NaN%" which is worse than just falling back to "0%". This is
  // exported for the regression test in
  // `ComparisonResultModal.test.tsx` so the contract is pinned.
  if (!Number.isFinite(score)) return "0%";
  const clamped = Math.max(0, Math.min(1, score));
  return `${Math.round(clamped * 100)}%`;
}

/**
 * Trigger a browser download of `markdown` named `filename`. Used
 * by the modal's "Download as Markdown" affordance. Implemented
 * client-side (Blob + Object URL) rather than going through the
 * bridge because the IPC `exportArtifactToFile` channel requires
 * a real artifact id + format pair, and the user might want to
 * snapshot the comparison without committing to the artifact path
 * — they can navigate to the persisted artifact via the modal's
 * "Open artifact" button if they want the IPC export path
 * instead.
 */
export function downloadMarkdown(filename: string, markdown: string): void {
  const blob = new Blob([markdown], { type: "text/markdown;charset=utf-8" });
  const url = URL.createObjectURL(blob);
  try {
    const a = document.createElement("a");
    a.href = url;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  } finally {
    URL.revokeObjectURL(url);
  }
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
    navigate(`/artifacts/${artifact.id}`);
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
        <strong>Similarity:</strong> {formatSimilarity(comparison.similarityScore)}
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

/**
 * Sanitize a source label so it is safe to use inside a download
 * filename across the three platforms the desktop app targets
 * (macOS, Windows, Linux). Strips the reserved-character set
 * `<>:"/\\|?*` plus control codepoints, collapses whitespace to a
 * single dash, and trims to a reasonable length so a 4 KB source
 * path can't produce a 4 KB filename.
 */
export function sanitizeForFilename(label: string): string {
  // Strip Windows-reserved characters + control codepoints +
  // whitespace into a single dash separator. Doing this in one
  // pass avoids the ordering trap where the control-char filter
  // would strip `\t` / `\n` BEFORE the whitespace collapse could
  // turn them into separators (producing "hello-worldtab" instead
  // of "hello-world-tab"). Then collapse runs and trim ends.
  // The `\u0000-\u001f` range deliberately covers ASCII control
  // codepoints (tab / newline / etc) so they get collapsed into the
  // same dash separator as the other reserved characters and
  // whitespace. eslint's `no-control-regex` flags this as suspect
  // (security: control chars in URL parsers are typically a red
  // flag) but here we are sanitizing FOR a filename, not parsing
  // an input — keeping the control-range is necessary to neutralize
  // them.
  // eslint-disable-next-line no-control-regex
  const reservedOrWhitespace = /[\u0000-\u001f<>:"/\\|?*\s]/g;
  const stripped = label
    .replace(reservedOrWhitespace, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "");
  // Re-strip trailing dashes after the length cap so a label that
  // produces "foo-bar-baz-..." longer than 60 characters can't leave
  // a trailing dash at position 60 (cosmetic, but a dot/dash-final
  // filename looks broken in file pickers). Trimming both ends keeps
  // the empty-result branch reachable for purely-stripped inputs.
  const trimmed = stripped.slice(0, 60).replace(/^-+|-+$/g, "");
  return trimmed.length === 0 ? "source" : trimmed;
}
