import {
  useState,
  useEffect,
  useCallback,
  useRef,
  lazy,
  Suspense,
  type ReactNode,
} from "react";
import { useParams, useNavigate } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import ErrorBoundary from "../components/ErrorBoundary";
import Breadcrumb from "../components/Breadcrumb";
import Button from "../components/Button";
import Card from "../components/Card";
import PinButton from "../components/PinButton";
import StopGenerationButton from "../components/StopGenerationButton";
import ShareToKchatModal, {
  type KchatShareFormat,
} from "../components/ShareToKchatModal";
import { useTrackArtifactView } from "../hooks/useRecentlyViewedArtifacts";
import { usePinnedArtifacts } from "../hooks/usePinnedArtifacts";
import { notifyArtifactsChanged } from "../hooks/useArtifacts";
// LW-4: split each editor into its own lazy chunk. Only the editor for
// the artifact type actually being opened is fetched/parsed, so editing
// a document never loads the sheet formula engine or the Marp slide
// renderer (and vice-versa). The `../editors` barrel is intentionally
// bypassed here — importing from it would pull every editor's module
// graph into one chunk and defeat the split.
const DocumentEditor = lazy(() => import("../editors/DocumentEditor"));
const SlideEditor = lazy(() => import("../editors/SlideEditor"));
const SheetEditor = lazy(() => import("../editors/SheetEditor"));
const BaseEditor = lazy(() => import("../editors/BaseEditor"));
const InfographicEditor = lazy(() => import("../editors/InfographicEditor"));
const LandingPageEditor = lazy(() => import("../editors/LandingPageEditor"));
import {
  embedIcons,
  iconsToTextPlaceholder,
} from "../services/iconResolver";
import {
  parseSlideContent,
  slidesToMarpMarkdown,
} from "../editors/slideEditorHelpers";
import {
  parseInfographicContent,
  buildPreviewHtml as buildInfographicPreviewHtml,
  buildInfographicPrintableText,
} from "../editors/infographicEditorHelpers";
import {
  parseLandingPageContent,
  buildLandingPreviewHtml,
  buildLandingPagePrintableText,
} from "../editors/landingPageEditorHelpers";
import { availableExportFormats } from "./artifactExportFormats";
import type { ArtifactInfo } from "../types/ipc";

// Formats whose body can carry inline `<svg>` markup directly
// (HTML renders it; DOCX-rs forwards it inside drawing runs). PDF is
// deliberately excluded — the minimal PDF builder is text-only and
// would render escaped SVG markup as garbled literal text. PDF uses
// `iconsToTextPlaceholder` below instead.
const INLINE_ICON_FORMATS = new Set(["html", "docx"]);
const TEXT_ICON_FORMATS = new Set(["pdf"]);
const ICON_AWARE_FORMATS = new Set([
  ...INLINE_ICON_FORMATS,
  ...TEXT_ICON_FORMATS,
]);
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

export default function ArtifactEditorPage() {
  const { id } = useParams<{ id: string }>();
  const navigate = useNavigate();
  const [artifact, setArtifact] = useState<ArtifactInfo | null>(null);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<string | null>(null);
  // KChat share state. `kchatConnected` is null until the first
  // status probe completes so the button doesn't flash visible
  // before we know whether to render it.
  const [kchatConnected, setKchatConnected] = useState<boolean | null>(null);
  const [shareOpen, setShareOpen] = useState(false);

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

  // record this artifact's view in the recents
  // list as soon as the editor mounts. `useTrackArtifactView`
  // dedupes-and-promotes so a remount or re-render does not
  // generate write storms.
  useTrackArtifactView(id);
  const { isPinned, togglePin } = usePinnedArtifacts();

  // Probe KChat connection state on mount so the toolbar can
  // conditionally render the "Share to KChat" button. Polling on a
  // short interval would be wasteful; instead we re-check whenever
  // the modal closes so a fresh connect from Settings is picked up.
  useEffect(() => {
    const k = window.tessera?.kchat;
    if (!k) {
      setKchatConnected(false);
      return;
    }
    let cancelled = false;
    (async () => {
      try {
        const available = await k.isAvailable();
        if (cancelled) return;
        if (!available) {
          setKchatConnected(false);
          return;
        }
        const status = await k.status();
        if (!cancelled) {
          setKchatConnected(status.state === "connected");
        }
      } catch {
        if (!cancelled) setKchatConnected(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [shareOpen]);

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
        // the Rust exporters would render `{"title":"...","sections":
        // [...]}` as paragraphs, not as the rich layout the user sees in
        // the live preview pane.
        //
        // - HTML  → pre-render through the same preview builder that
        //   powers the editor's preview pane (already exported from each
        //   editor module and unit-tested there), and pass the resulting
        //   HTML fragment through `contentOverride`. The Rust HTML
        //   exporter (`crates/tessera_export/src/html.rs`) detects these
        //   artifact types and inlines the override as raw HTML instead
        //   of running it through the markdown-like line parser.
        // - PDF / DOCX → the Rust PDF builder is line-based and the DOCX
        //   writer chunks paragraphs the same way; raw HTML tag-soup is
        //   only marginally better than raw JSON there. Pre-render via
        //   the dedicated *PrintableText helpers (`# Title`, `## Heading`,
        //   blank-line-separated paragraphs) so the printed export
        //   matches the visible page top-to-bottom. Regression for
        //   "visual-artifact PDF export dumped raw JSON".
        //
        // If the parser throws (e.g. corrupted JSON), we deliberately
        // leave `contentOverride` null and let the Rust side fall back to
        // its `<pre>` (HTML) / line-by-line JSON dump (PDF) wrapper:
        // a legible default beats a broken page.
        if (format === "html" && artifactType === "infographic") {
          try {
            contentOverride = buildInfographicPreviewHtml(
              parseInfographicContent(liveContent),
            );
          } catch {
            // fall through — Rust exporter wraps raw JSON in <pre>
          }
        } else if (format === "html" && artifactType === "landing_page") {
          try {
            contentOverride = buildLandingPreviewHtml(
              parseLandingPageContent(liveContent),
            );
          } catch {
            // see above
          }
        } else if (
          (format === "pdf" || format === "docx") &&
          artifactType === "infographic"
        ) {
          try {
            contentOverride = buildInfographicPrintableText(
              parseInfographicContent(liveContent),
            );
          } catch {
            // fall through — line-based PDF builder will read the raw
            // JSON, which is still legible (just not pretty).
          }
        } else if (
          (format === "pdf" || format === "docx") &&
          artifactType === "landing_page"
        ) {
          try {
            contentOverride = buildLandingPagePrintableText(
              parseLandingPageContent(liveContent),
            );
          } catch {
            // see above
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
          // PDF: tokens → "[home]" text placeholders so the minimal
          // PDF builder produces a readable line. The Typst PDF
          // pipeline handles real icon rendering via Typst's native
          // SVG support, but this fallback PDF path is text-only.
          //
          // HTML / DOCX: tokens → inline `<svg>` markup, embedded
          // directly in the exported document.
          const replaced = TEXT_ICON_FORMATS.has(format)
            ? iconsToTextPlaceholder(liveContent)
            : embedIcons(liveContent);
          if (replaced !== liveContent) {
            contentOverride = replaced;
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

  // Wire global custom events to the editor's own state. The
  // keyboard-shortcut runner and the command palette dispatch
  // these events without coupling to this component, so any
  // save / export / share / pin / duplicate / delete shortcut
  // fired from anywhere in the app routes here as long
  // as this page is mounted.
  useEffect(() => {
    if (!id) return;
    const onSave = () => {
      const content = draftContentRef.current ?? artifact?.content ?? "";
      void handleSave(content);
    };
    const onExport = () => {
      const formats = artifact
        ? availableExportFormats(artifact.artifactType)
        : [];
      const fmt = formats[0];
      if (fmt) void handleExport(fmt);
    };
    const onTogglePin = () => {
      void togglePin(id);
    };
    const onShare = () => {
      if (kchatConnected) setShareOpen(true);
    };
    const onDuplicate = async () => {
      if (!artifact) return;
      try {
        const api = window.tessera;
        if (!api) return;
        const copy = await api.artifacts.create(
          `${artifact.title} (copy)`,
          artifact.artifactType,
          artifact.templateId ?? undefined,
        );
        // Persist the duplicated content as a follow-up update
        // because `artifacts.create` only sets up the metadata.
        await api.artifacts.update(copy.id, artifact.content);
        // PR #87: broadcast so every
        // live `useArtifactList()` consumer picks up the new
        // artifact without waiting for a remount.
        notifyArtifactsChanged();
        navigate(`/artifacts/${copy.id}/edit`);
      } catch {
        // Surface failures via the existing exportStatus channel
        // — there is no dedicated toast surface on this page yet.
        setExportStatus("Duplicate failed");
        setTimeout(() => setExportStatus(null), 3000);
      }
    };
    const onDelete = async () => {
      if (!id) return;
      if (!window.confirm("Delete this artifact? This cannot be undone.")) return;
      try {
        const api = window.tessera;
        if (!api) return;
        await api.artifacts.remove(id);
        // PR #87: broadcast so the
        // sidebar list / home recents / palette pickers refresh
        // immediately even before navigation back to Home.
        notifyArtifactsChanged();
        navigate("/");
      } catch {
        setExportStatus("Delete failed");
        setTimeout(() => setExportStatus(null), 3000);
      }
    };
    window.addEventListener("tessera:save", onSave);
    window.addEventListener("tessera:export", onExport);
    window.addEventListener("tessera:toggle-pin", onTogglePin);
    window.addEventListener("tessera:share", onShare);
    window.addEventListener("tessera:duplicate", onDuplicate);
    window.addEventListener("tessera:delete", onDelete);
    return () => {
      window.removeEventListener("tessera:save", onSave);
      window.removeEventListener("tessera:export", onExport);
      window.removeEventListener("tessera:toggle-pin", onTogglePin);
      window.removeEventListener("tessera:share", onShare);
      window.removeEventListener("tessera:duplicate", onDuplicate);
      window.removeEventListener("tessera:delete", onDelete);
    };
  }, [
    id,
    artifact,
    handleSave,
    handleExport,
    togglePin,
    navigate,
    kchatConnected,
  ]);

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
      <Breadcrumb
        items={[
          { label: "Home", to: "/" },
          {
            label:
              artifact.title.length > 0 ? artifact.title : "(untitled)",
          },
        ]}
      />
      <PageHeader
        title={artifact.title}
        description={`${artifact.artifactType} — v${artifact.version}${
          isPinned(artifact.id) ? " — Pinned" : ""
        }`}
        actions={
          <div style={{ display: "flex", gap: "var(--spacing-sm)" }}>
            <PinButton artifactId={artifact.id} withLabel />
            <StopGenerationButton />
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
            {kchatConnected && (
              <Button
                variant="secondary"
                onClick={() => setShareOpen(true)}
                disabled={exporting}
                data-testid="share-to-kchat"
              >
                Share to KChat
              </Button>
            )}
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
      {shareOpen && (
        <ShareToKchatModal
          isOpen={shareOpen}
          onClose={() => setShareOpen(false)}
          artifactId={artifact.id}
          artifactTitle={artifact.title}
          availableFormats={
            availableExportFormats(artifact.artifactType).filter(
              (f): f is KchatShareFormat =>
                f === "markdown" ||
                f === "html" ||
                f === "pdf" ||
                f === "docx" ||
                f === "json",
            )
          }
          defaultFormat={pickDefaultShareFormat(artifact.artifactType)}
        />
      )}
    </div>
  );
}

/** Picks the most natural default share format per artifact type. */
function pickDefaultShareFormat(artifactType: string): KchatShareFormat {
  switch (artifactType) {
    case "document":
      return "pdf";
    case "slides":
    case "infographic":
    case "landing_page":
      return "pdf";
    case "sheet":
    case "base":
      // KChat preview-renders JSON poorly; PDF prints the grid.
      return "pdf";
    default:
      return "markdown";
  }
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
  // Each editor renders inside its own named error boundary so a crash
  // in one editor surfaces the recovery UI (and writes a
  // `crash-report.json` entry tagged with the editor name) without
  // tearing down the surrounding ArtifactEditorPage chrome (header,
  // export controls, breadcrumb).
  let name: string;
  let editor: ReactNode;
  switch (artifact.artifactType) {
    case "document":
      name = "DocumentEditor";
      editor = (
        <DocumentEditor
          content={artifact.content}
          onSave={onSave}
          onDraftChange={onDraftChange}
        />
      );
      break;
    case "slides":
      name = "SlideEditor";
      editor = (
        <SlideEditor
          content={artifact.content}
          onSave={onSave}
          onDraftChange={onDraftChange}
          deckTitle={artifact.title}
        />
      );
      break;
    case "sheet":
      name = "SheetEditor";
      editor = (
        <SheetEditor
          content={artifact.content}
          onSave={onSave}
          onDraftChange={onDraftChange}
        />
      );
      break;
    case "base":
      name = "BaseEditor";
      editor = (
        <BaseEditor
          content={artifact.content}
          onSave={onSave}
          onDraftChange={onDraftChange}
        />
      );
      break;
    case "infographic":
      name = "InfographicEditor";
      editor = (
        <InfographicEditor
          content={artifact.content}
          onSave={onSave}
          onDraftChange={onDraftChange}
          artifactId={artifact.id}
        />
      );
      break;
    case "landing_page":
      name = "LandingPageEditor";
      editor = (
        <LandingPageEditor
          content={artifact.content}
          onSave={onSave}
          onDraftChange={onDraftChange}
          artifactId={artifact.id}
        />
      );
      break;
    default:
      return (
        <Card>
          <p>Unknown artifact type: {artifact.artifactType}</p>
        </Card>
      );
  }

  // `resetKeys` clears a caught editor crash when the boundary starts
  // guarding a different artifact (id) or editor type (name), so opening
  // another artifact of the same type doesn't leave the recovery UI from
  // the previous one on screen. ArtifactEditorPage reuses this subtree
  // across artifacts (it refetches by route id rather than remounting),
  // so a static key would not reset on an id-only change.
  return (
    <ErrorBoundary name={name} resetKeys={[artifact.id, name]}>
      <Suspense
        fallback={
          <div
            aria-busy="true"
            style={{
              padding: "var(--spacing-lg)",
              color: "var(--color-text-secondary)",
            }}
          >
            Loading editor...
          </div>
        }
      >
        {editor}
      </Suspense>
    </ErrorBoundary>
  );
}
