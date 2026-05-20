import { useState, useEffect, useCallback, useRef } from "react";
import { useParams, useNavigate } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import Button from "../components/Button";
import Card from "../components/Card";
import {
  DocumentEditor,
  SlideEditor,
  SheetEditor,
  BaseEditor,
  InfographicEditor,
  LandingPageEditor,
} from "../editors";
import { embedIcons } from "../services/iconResolver";
import {
  parseSlideContent,
  slidesToMarpMarkdown,
} from "../editors/SlideEditor";
import {
  parseInfographicContent,
  buildPreviewHtml as buildInfographicPreviewHtml,
} from "../editors/InfographicEditor";
import {
  parseLandingPageContent,
  buildLandingPreviewHtml,
} from "../editors/LandingPageEditor";
import type { ArtifactInfo } from "../types/ipc";

const ICON_AWARE_FORMATS = new Set(["html", "pdf", "docx"]);
// Artifact types whose content is raw text/markdown and may therefore
// contain `{{icon:lucide:home}}`-style tokens that `embedIcons` should
// resolve. JSON-structured artifact types (sheet, base, infographic,
// landing_page) embed icons through their schema fields
// (e.g. `"icon":"lucide:trending-up"`), and running the token regex
// replacer over stringified JSON would corrupt the structure when a user
// manually typed `{{icon:...}}` into a cell or field — the inline `<svg>`
// output contains unescaped `"` characters that break JSON.
const ICON_TOKEN_ARTIFACT_TYPES = new Set(["document"]);
// PPTX is intentionally NOT in BINARY_FORMATS — it does not flow through the
// Rust exporter (which rejects pptx); it has a dedicated Marp-CLI path.
const BINARY_FORMATS = new Set(["pdf", "docx", "xlsx"]);

/**
 * Display label for each supported export format. Centralised so the
 * dropdown UI and any future menu / palette stay in sync.
 */
const EXPORT_FORMAT_LABELS: Record<string, string> = {
  markdown: "Markdown (.md)",
  html: "HTML (.html)",
  json: "JSON (.json)",
  csv: "CSV (.csv)",
  pdf: "PDF (.pdf)",
  docx: "Word (.docx)",
  xlsx: "Excel (.xlsx)",
  pptx: "PowerPoint (.pptx, Marp)",
};

/**
 * Returns the list of export formats that make sense for a given artifact
 * type. Prevents nonsensical combinations like "Sheet → DOCX" (which would
 * render the sheet's `{columns, rows}` JSON as markdown) or "Document →
 * XLSX" (which would CSV-split the markdown content into a sheet).
 *
 * The mapping is intentionally explicit per type rather than a "deny-list"
 * because the deny-list approach silently broadens whenever a new format is
 * added. Keeping the list per type forces a deliberate decision each time.
 */
export function availableExportFormats(artifactType: string): string[] {
  switch (artifactType) {
    case "document":
      return ["markdown", "html", "json", "pdf", "docx"];
    case "slides":
      return ["markdown", "html", "json", "pdf", "pptx"];
    case "sheet":
      return ["csv", "json", "html", "pdf", "xlsx"];
    case "base":
      return ["csv", "json", "html", "pdf", "xlsx"];
    case "infographic":
      // Visual artifact — HTML preview, PDF print, JSON data export.
      return ["html", "json", "pdf"];
    case "landing_page":
      // Standalone web page — HTML primary, PDF for print, JSON data.
      return ["html", "json", "pdf"];
    default:
      // Unknown / future types: expose the safe-universal set rather than
      // nothing, so the user is never stranded with no export option.
      return ["json", "html", "pdf"];
  }
}

export default function ArtifactEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [artifact, setArtifact] = useState<ArtifactInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);

  // Tracks the latest *uncommitted* editor content. Editors publish into
  // this ref via their `onDraftChange` prop synchronously on every edit
  // (independent of the debounced auto-save), so an export triggered before
  // the 2 s auto-save fires still operates on the live editor state instead
  // of `artifact.content` (which only reflects the last persisted save).
  const draftContentRef = useRef<string | null>(null);
  const handleDraftChange = useCallback((next: string) => {
    draftContentRef.current = next;
  }, []);

  // Reset the draft when the user navigates to a different artifact so
  // we don't leak a previous artifact's draft into the new export.
  useEffect(() => {
    draftContentRef.current = null;
  }, [id]);

  const loadArtifact = useCallback(async () => {
    if (!id) return;
    setLoading(true);
    setError(null);
    try {
      const api = window.tessera;
      if (!api) throw new Error("Tessera API not available");
      const result = await api.artifacts.get(id);
      setArtifact(result);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setLoading(false);
    }
  }, [id]);

  useEffect(() => {
    loadArtifact();
  }, [loadArtifact]);

  const handleSave = useCallback(
    async (content: string) => {
      if (!id) return;
      try {
        const api = window.tessera;
        if (!api) return;
        const updated = await api.artifacts.update(id, content);
        setArtifact(updated);
      } catch {
        // silently handled — debounced auto-save
      }
    },
    [id],
  );

  const handleExport = useCallback(
    async (format: string) => {
      if (!id) return;
      setExporting(true);
      setExportStatus(null);
      try {
        const api = window.tessera;
        if (!api) return;

        // Prefer the live editor draft (captured synchronously via
        // onDraftChange) over the last-persisted server snapshot. Falls
        // back to the persisted content if the editor hasn't published a
        // draft yet (e.g. nothing edited since load, or the artifact type
        // doesn't emit drafts at all). This means clicking Export while
        // the 2 s auto-save is still pending still operates on the
        // current editor state instead of stale content.
        const liveContent = draftContentRef.current ?? artifact?.content ?? "";

        // For icon-aware formats, resolve {{icon:...}} tokens to inline SVG
        // for the export only — never persist back to the artifact store.
        // The IPC layer forwards `contentOverride` to the Rust bridge, which
        // applies it to an in-memory clone of the artifact before exporting,
        // leaving the editable `{{icon:lucide:home}}`-style tokens untouched
        // in the database.
        // Compute the override in two independent stages so the draft-vs-persisted
        // check is *always* performed, even when icon embedding is a no-op
        // (e.g. all `{{icon:...}}` tokens are unresolvable, so `embedIcons`
        // returns the input unchanged). Without this split the icon branch
        // could exit with `contentOverride === null` and the persisted (stale)
        // content would be exported instead of the live draft.
        let contentOverride: string | null = null;
        const artifactType = artifact?.artifactType ?? "";

        // Visual artifact types (infographic / landing_page) store their
        // model as structured JSON. Exporting that JSON straight through
        // the Rust HTML exporter would render `{"title":"...","sections":
        // [...]}` as paragraphs, not as the rich layout the user sees in
        // the live preview pane. For HTML export we pre-render the
        // artifact through the same preview builder that powers the
        // editor's preview (already exported from each editor module and
        // unit-tested there), and pass the resulting HTML fragment
        // through `contentOverride`. The Rust HTML exporter
        // (`crates/tessera_export/src/html.rs`) detects these artifact
        // types and inlines the override as raw HTML instead of running it
        // through the markdown-like line parser.
        //
        // If the parser throws (e.g. corrupted JSON), we deliberately
        // leave `contentOverride` null and let the Rust side fall back to
        // its `<pre>` wrapper: a legible JSON dump beats a broken page.
        if (format === "html") {
          if (artifactType === "infographic") {
            try {
              contentOverride = buildInfographicPreviewHtml(
                parseInfographicContent(liveContent),
              );
            } catch {
              // fall through — Rust exporter wraps raw JSON in <pre>
            }
          } else if (artifactType === "landing_page") {
            try {
              contentOverride = buildLandingPreviewHtml(
                parseLandingPageContent(liveContent),
              );
            } catch {
              // see above
            }
          }
        }

        // Token-based icon embedding only applies to artifact types whose
        // content is raw text/markdown. For JSON-structured artifacts the
        // icon is stored as a structured field, not a `{{icon:...}}` token;
        // running the regex replacer on stringified JSON would inject
        // unescaped `"` from the SVG output and corrupt the document.
        const isIconTokenArtifact = ICON_TOKEN_ARTIFACT_TYPES.has(artifactType);
        if (
          contentOverride === null &&
          isIconTokenArtifact &&
          ICON_AWARE_FORMATS.has(format) &&
          /\{\{icon:/.test(liveContent)
        ) {
          const embedded = embedIcons(liveContent);
          if (embedded !== liveContent) {
            contentOverride = embedded;
          }
        }
        // Independent of icon embedding: if the live editor draft has
        // diverged from the persisted snapshot, the export must see the
        // draft. `embedIcons` is content-preserving when nothing resolves,
        // so the icon branch (above) and the draft branch (here) don't
        // conflict — whichever produced a meaningful override wins.
        if (contentOverride === null && liveContent !== (artifact?.content ?? "")) {
          contentOverride = liveContent;
        }

        // PPTX has its own dedicated pipeline: the Marp CLI consumes the
        // raw Marp markdown directly. The generic Rust exporter rejects it,
        // so we route the slide artifact's marp source through the
        // `artifacts:exportMarp` IPC (which prompts the user via the native
        // save dialog) rather than going through `exportArtifact`.
        if (format === "pptx") {
          if (artifact?.artifactType !== "slides") {
            throw new Error(
              "PPTX export is only available for slide artifacts",
            );
          }
          const parsed = parseSlideContent(liveContent);
          // Resolve a single effective theme value up-front and reuse it
          // for both `slidesToMarpMarkdown(...)` AND `exportMarp({ theme })`
          // so the synthesised front-matter and the Marp CLI `--theme`
          // flag can never disagree. `parsed.marpTheme` is `undefined`
          // when the slide artifact has no `marp` block (e.g. structured
          // slides authored before Marp Mode shipped); the user-visible
          // default in that case is "default", matching what
          // `slidesToMarpMarkdown` would have fallen back to internally.
          // Defaulting here (instead of inside each call site) is what
          // keeps the two pipelines in sync — if a future caller forgets
          // to default, they still get the consistent value.
          const effectiveTheme = parsed.marpTheme ?? "default";
          // When NOT in Marp Mode, we synthesise Marp Markdown from the
          // structured slides. Pass the resolved theme through so the
          // generated front-matter matches the `--theme` flag we send to
          // the Marp CLI below.
          const marpMarkdown = parsed.marpMode
            ? parsed.marpSource
            : slidesToMarpMarkdown(parsed.slides, {
                theme: effectiveTheme,
              });
          if (!marpMarkdown.trim()) {
            throw new Error(
              "Slide artifact has no Marp content to export — add slides or enable Marp mode first",
            );
          }
          const safeName = `${artifact?.title ?? "artifact"}.pptx`.replace(
            /[^A-Za-z0-9._-]/g,
            "_",
          );
          const written = await api.artifacts.exportMarp({
            markdown: marpMarkdown,
            format: "pptx",
            outputPath: safeName,
            theme: effectiveTheme,
          });
          if (written === null) {
            // User dismissed the save dialog — surface a neutral status
            // rather than an error so the cancel feels like a no-op.
            setExportStatus("Export cancelled");
            setTimeout(() => setExportStatus(null), 3000);
            return;
          }
          setExportStatus(`Exported as pptx → ${written}`);
          setTimeout(() => setExportStatus(null), 4000);
          return;
        }

        if (BINARY_FORMATS.has(format)) {
          // Binary formats can't be copied to the clipboard as text; we send
          // a suggested filename to the main process, which prompts the user
          // via the native save dialog and returns the resolved absolute
          // path — or `null` if the user cancels, which we surface as a
          // neutral "Export cancelled" status (no file is written).
          const ext = format;
          const suggestedName = `${artifact?.title ?? "artifact"}.${ext}`.replace(
            /[^A-Za-z0-9._-]/g,
            "_",
          );
          const written = await api.artifacts.exportToFile(
            id,
            format,
            suggestedName,
            contentOverride,
          );
          if (written === null) {
            setExportStatus("Export cancelled");
            setTimeout(() => setExportStatus(null), 3000);
          } else {
            setExportStatus(`Exported as ${format} → ${written}`);
            setTimeout(() => setExportStatus(null), 4000);
          }
        } else {
          const result = await api.artifacts.exportArtifact(
            id,
            format,
            contentOverride,
          );
          await navigator.clipboard.writeText(result.content);
          setExportStatus(
            `Exported as ${result.format} — copied to clipboard`,
          );
          setTimeout(() => setExportStatus(null), 3000);
        }
      } catch (e) {
        setExportStatus(
          `Export failed: ${e instanceof Error ? e.message : "unknown error"}`,
        );
      } finally {
        setExporting(false);
      }
    },
    [id, artifact?.title, artifact?.content, artifact?.artifactType],
  );

  const handleExportEvidencePack = useCallback(async () => {
    if (!id) return;
    const api = window.tessera;
    if (!api) {
      setExportStatus("Export failed: Tessera bridge not available");
      return;
    }
    setExporting(true);
    setExportStatus(null);
    try {
      const safeTitle = (artifact?.title ?? "evidence-pack")
        .replace(/[^a-zA-Z0-9._-]+/g, "-")
        .replace(/-+/g, "-")
        .replace(/^-|-$/g, "") || "evidence-pack";
      const dialogResult = await api.dialog.showSaveDialog({
        title: "Export Evidence Pack",
        defaultPath: `${safeTitle}.zip`,
        buttonLabel: "Export",
        filters: [{ name: "Evidence Pack", extensions: ["zip"] }],
      });
      if (dialogResult.canceled || !dialogResult.filePath) {
        setExporting(false);
        return;
      }
      const outPath = await api.artifacts.exportEvidencePack(id, dialogResult.filePath);
      setExportStatus(`Evidence pack exported to ${outPath}`);
      setTimeout(() => setExportStatus(null), 6000);
    } catch (e) {
      setExportStatus(
        `Export failed: ${e instanceof Error ? e.message : "unknown error"}`,
      );
    } finally {
      setExporting(false);
    }
  }, [id, artifact?.title]);

  if (loading) {
    return (
      <div>
        <PageHeader title="Editor" description="Loading artifact..." />
        <p>Loading...</p>
      </div>
    );
  }

  if (error || !artifact) {
    return (
      <div>
        <PageHeader title="Editor" description="" />
        <Card>
          <p style={{ color: "var(--color-danger)" }}>
            {error || "Artifact not found"}
          </p>
          <Button variant="secondary" onClick={() => navigate("/")}>
            Back to Home
          </Button>
        </Card>
      </div>
    );
  }

  return (
    <div style={{ height: "100%", display: "flex", flexDirection: "column" }}>
      <PageHeader
        title={artifact.title}
        description={`${artifact.artifactType} — v${artifact.version}`}
        actions={
          <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
            <select
              aria-label="Export artifact"
              disabled={exporting}
              value=""
              onChange={(e) => {
                const v = e.target.value;
                if (v) {
                  handleExport(v);
                  e.target.value = "";
                }
              }}
              style={{
                padding: "var(--spacing-xs) var(--spacing-sm)",
                border: "1px solid var(--color-border)",
                borderRadius: "var(--radius-sm)",
                background: "var(--color-bg-elevated, #fff)",
                fontSize: "var(--font-size-sm)",
              }}
            >
              <option value="" disabled>
                Export…
              </option>
              {availableExportFormats(artifact.artifactType).map((fmt) => (
                <option key={fmt} value={fmt}>
                  {EXPORT_FORMAT_LABELS[fmt] ?? fmt}
                </option>
              ))}
            </select>
            <Button
              variant="secondary"
              onClick={handleExportEvidencePack}
              disabled={exporting}
              data-testid="export-evidence-pack"
            >
              Export Evidence Pack
            </Button>
            <Button variant="secondary" onClick={() => navigate("/")}>
              Back
            </Button>
          </div>
        }
      />
      {exportStatus && (
        <div
          style={{
            padding: "var(--spacing-sm) var(--spacing-md)",
            background: exportStatus.startsWith("Export failed")
              ? "var(--color-danger-bg, #fee)"
              : "var(--color-success-bg, #efe)",
            borderBottom: "1px solid var(--color-border)",
            fontSize: "var(--font-size-sm)",
          }}
        >
          {exportStatus}
        </div>
      )}
      <div style={{ flex: 1, minHeight: 0, overflow: "auto" }}>
        <EditorSwitch
          artifact={artifact}
          onSave={handleSave}
          onDraftChange={handleDraftChange}
        />
      </div>
    </div>
  );
}

function EditorSwitch({
  artifact,
  onSave,
  onDraftChange,
}: {
  artifact: ArtifactInfo;
  onSave: (content: string) => void;
  onDraftChange: (content: string) => void;
}) {
  switch (artifact.artifactType) {
    case "document":
      return (
        <DocumentEditor
          content={artifact.content}
          onSave={onSave}
          onDraftChange={onDraftChange}
        />
      );
    case "slides":
      return (
        <SlideEditor
          content={artifact.content}
          onSave={onSave}
          onDraftChange={onDraftChange}
        />
      );
    case "sheet":
      return (
        <SheetEditor
          content={artifact.content}
          onSave={onSave}
          onDraftChange={onDraftChange}
        />
      );
    case "base":
      return (
        <BaseEditor
          content={artifact.content}
          onSave={onSave}
          onDraftChange={onDraftChange}
        />
      );
    case "infographic":
      return (
        <InfographicEditor
          content={artifact.content}
          onSave={onSave}
          onDraftChange={onDraftChange}
        />
      );
    case "landing_page":
      return (
        <LandingPageEditor
          content={artifact.content}
          onSave={onSave}
          onDraftChange={onDraftChange}
        />
      );
    default:
      return (
        <Card>
          <p>Unknown artifact type: {artifact.artifactType}</p>
        </Card>
      );
  }
}
