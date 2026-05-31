/**
 * Vision page — the renderer-side surface for the
 * `vision:*` IPC channels.
 *
 * The page is a single-shot tool, not a session: the user picks an
 * image, picks a mode (describe / OCR / chart), clicks Analyze, and
 * gets the model's structured output. There is no chat history,
 * no streaming, and no follow-up turns — the underlying llama-server
 * sidecar treats each `vision:describe` call as a stateless one-shot
 * with no conversation context.
 *
 * The page has four concerns:
 *
 *   1. **Availability gating.** Vision requires both (a) the
 *      `tessera_bridge` native addon to be loaded, AND (b) a
 *      vision-capability model (with its multimodal projector) on
 *      disk. We probe `tessera.vision.isAvailable()` on mount and
 *      whenever the focus returns, and render a banner pointing at
 *      Settings → Models if either prerequisite is missing.
 *
 *   2. **Image picker.** A button invokes
 *      `tessera.dialog.pickImage()` (a native OS file dialog locked
 *      to image extensions, with `dontAddToRecent: true`). The
 *      renderer holds the absolute path the user picked so the
 *      `vision:describe` IPC can forward it to the sidecar (the
 *      sidecar reads the file directly off disk; we never base64
 *      it through the IPC bridge to keep the surface tight).
 *
 *   3. **Mode toggle.** Three modes mirror the bridge's
 *      `VisionMode` enum:
 *        - `describe`: natural-language description of the image.
 *        - `ocr`: literal transcription of text in the image.
 *        - `chart`: structured extraction (axes, series, values)
 *           for charts and diagrams.
 *      `maxTokens` is a slider bounded at 64..2048 with a sensible
 *      512-token default — chart extraction in particular can run
 *      long if the user picks a dense bar chart.
 *
 *   4. **Save-as-Document.** The model output is reformatted as a
 *      Markdown document and persisted via `tessera.artifacts.create`
 *      + `tessera.artifacts.update`. The created artifact carries
 *      the source image's basename + the mode in its title so it
 *      sorts cleanly under Sources later. The path is NOT stored —
 *      the user may move/delete the image and we don't want to
 *      surface a broken-link artifact months later.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useNavigate } from "react-router-dom";
import PageHeader from "../components/PageHeader";
import Button from "../components/Button";
import Card from "../components/Card";
import { notifyArtifactsChanged } from "../hooks/useArtifacts";
import { useCspNonce } from "../utils/cspNonce";
import {
  type VisionMode,
  type VisionResult,
  VISION_MODE_OPTIONS,
  DEFAULT_VISION_MAX_TOKENS,
  MIN_VISION_MAX_TOKENS,
  MAX_VISION_MAX_TOKENS,
  buildVisionDocument,
} from "./visionPageUtils";

export default function VisionPage() {
  const cspNonce = useCspNonce();
  const navigate = useNavigate();

  const [available, setAvailable] = useState<boolean | null>(null);
  const [availabilityChecking, setAvailabilityChecking] = useState(true);
  const [imagePath, setImagePath] = useState<string | null>(null);
  const [mode, setMode] = useState<VisionMode>("describe");
  const [maxTokens, setMaxTokens] = useState<number>(DEFAULT_VISION_MAX_TOKENS);
  const [analysing, setAnalysing] = useState(false);
  const [result, setResult] = useState<VisionResult | null>(null);
  // The mode + maxTokens that were actually in effect when the
  // current `result` was produced. The live `mode` / `maxTokens`
  // controls remain enabled after analysis (so the user can pick
  // different settings for a follow-up run without re-picking the
  // image), but the Save-as-Document flow and the result-meta
  // display MUST read from this snapshot — not the live state —
  // because otherwise tweaking the controls after analysis would
  // silently produce a Markdown artifact whose provenance header
  // disagrees with the actual analysis that generated the body.
  // Devin Review PR #39 pass-1 🟡 finding.
  const [resultMeta, setResultMeta] = useState<{
    mode: VisionMode;
    maxTokens: number;
    imagePath: string;
  } | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  // Probe availability on mount. The sidecar isn't started here —
  // `vision:describe` will start it lazily on the first call. The
  // probe is cheap (a disk stat on the active-model-vision.json
  // record + the mmproj file).
  useEffect(() => {
    let cancelled = false;
    setAvailabilityChecking(true);
    void window.tessera.vision
      .isAvailable()
      .then((ok) => {
        if (!cancelled) setAvailable(ok);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      })
      .finally(() => {
        if (!cancelled) setAvailabilityChecking(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const onPickImage = useCallback(async () => {
    setError(null);
    try {
      const pick = await window.tessera.dialog.pickImage({
        title: "Choose an image to analyse",
      });
      if (pick.canceled || !pick.filePath) return;
      setImagePath(pick.filePath);
      setResult(null);
      setResultMeta(null);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    }
  }, []);

  const onAnalyze = useCallback(async () => {
    if (!imagePath) return;
    setError(null);
    setResult(null);
    setResultMeta(null);
    setAnalysing(true);
    // Snapshot the analysis parameters at call time so the result
    // panel and Save-as-Document flow can read them regardless of
    // how the live controls have moved since. Captured as locals
    // first so this remains a single atomic decision point even
    // if the IPC takes seconds and the user starts twisting
    // sliders during the wait.
    const snapshotMode = mode;
    const snapshotMaxTokens = maxTokens;
    const snapshotImagePath = imagePath;
    try {
      const out = await window.tessera.vision.describe({
        imagePath: snapshotImagePath,
        mode: snapshotMode,
        maxTokens: snapshotMaxTokens,
      });
      setResult(out);
      setResultMeta({
        mode: snapshotMode,
        maxTokens: snapshotMaxTokens,
        imagePath: snapshotImagePath,
      });
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
    } finally {
      setAnalysing(false);
    }
  }, [imagePath, mode, maxTokens]);

  const onSaveAsDocument = useCallback(async () => {
    if (!result || !resultMeta) return;
    setError(null);
    setSaving(true);
    try {
      // Build the artifact from the snapshot taken at analysis
      // time, NOT the live controls. The user may have nudged the
      // mode radio or maxTokens slider after the analysis
      // completed but before clicking Save; reading the live
      // values here would persist an artifact whose provenance
      // header (mode, token cap, source path) lies about what
      // actually produced the content. Devin Review PR #39 pass-1
      // 🟡 finding.
      const { title, markdown } = buildVisionDocument({
        imagePath: resultMeta.imagePath,
        mode: resultMeta.mode,
        maxTokens: resultMeta.maxTokens,
        result,
      });
      const artifact = await window.tessera.artifacts.create(
        title,
        "document",
      );
      await window.tessera.artifacts.update(artifact.id, markdown);
      // PR #87 Devin Review ANALYSIS_0005: broadcast so every
      // live `useArtifactList()` consumer picks up the newly
      // created artifact without a remount.
      notifyArtifactsChanged();
      navigate(`/artifacts/${encodeURIComponent(artifact.id)}/edit`);
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err));
      setSaving(false);
    }
  }, [result, resultMeta, navigate]);

  const imageBasename = useMemo(() => {
    if (!imagePath) return null;
    return imagePath.split(/[\\/]/).pop() ?? imagePath;
  }, [imagePath]);

  return (
    <div>
      <PageHeader
        title="Vision"
        description="Describe, OCR, or extract chart data from a local image using a vision-language model."
      />

      {availabilityChecking && (
        <Card>
          <p data-testid="vision-availability-checking">
            Checking vision-model availability…
          </p>
        </Card>
      )}

      {!availabilityChecking && available === false && (
        <Card>
          <div
            className="vision-unavailable"
            data-testid="vision-unavailable"
            role="alert"
          >
            <h2>Vision is unavailable on this host</h2>
            <p>
              No vision-capability model is installed (or the native
              bridge failed to load). Open Settings → Models to install
              a vision model, then return here.
            </p>
            <Button onClick={() => navigate("/settings")}>
              Go to Settings
            </Button>
          </div>
          <style nonce={cspNonce}>{`
            .vision-unavailable h2 {
              margin-top: 0;
              margin-bottom: var(--spacing-sm);
              font-size: var(--font-size-lg);
            }
            .vision-unavailable p {
              color: var(--color-text-secondary);
              margin-bottom: var(--spacing-md);
            }
          `}</style>
        </Card>
      )}

      {!availabilityChecking && available === true && (
        <>
          <Card>
            <div className="vision-picker">
              <div className="vision-picker-row">
                <Button
                  onClick={onPickImage}
                  data-testid="vision-pick-image"
                  disabled={analysing}
                >
                  {imagePath ? "Choose a different image" : "Choose image"}
                </Button>
                {imageBasename && (
                  <span
                    className="vision-image-name"
                    data-testid="vision-image-name"
                    title={imagePath ?? ""}
                  >
                    {imageBasename}
                  </span>
                )}
              </div>
              <p className="vision-hint">
                Supported formats: JPEG, PNG, WebP, GIF, BMP.
              </p>
            </div>
          </Card>

          <Card>
            <fieldset className="vision-mode">
              <legend>Mode</legend>
              <div
                className="vision-mode-options"
                role="radiogroup"
                aria-label="Vision mode"
              >
                {VISION_MODE_OPTIONS.map((opt) => {
                  const checked = mode === opt.id;
                  return (
                    <label
                      key={opt.id}
                      className={`vision-mode-option ${
                        checked ? "vision-mode-option-active" : ""
                      }`}
                    >
                      <input
                        type="radio"
                        name="vision-mode"
                        value={opt.id}
                        checked={checked}
                        onChange={() => setMode(opt.id)}
                        disabled={analysing}
                        data-testid={`vision-mode-${opt.id}`}
                      />
                      <span className="vision-mode-label">{opt.label}</span>
                      <span className="vision-mode-description">
                        {opt.description}
                      </span>
                    </label>
                  );
                })}
              </div>
            </fieldset>

            <div className="vision-max-tokens">
              <label htmlFor="vision-max-tokens-input">
                Max tokens:{" "}
                <span data-testid="vision-max-tokens-value">{maxTokens}</span>
              </label>
              <input
                id="vision-max-tokens-input"
                data-testid="vision-max-tokens-slider"
                type="range"
                min={MIN_VISION_MAX_TOKENS}
                max={MAX_VISION_MAX_TOKENS}
                step={64}
                value={maxTokens}
                onChange={(e) => setMaxTokens(Number(e.target.value))}
                disabled={analysing}
              />
              <p className="vision-hint">
                Higher values let chart-extract / long OCR finish without
                truncation, but cost more memory + time. 512 is a safe
                default.
              </p>
            </div>

            <div className="vision-actions">
              <Button
                onClick={onAnalyze}
                disabled={!imagePath || analysing}
                data-testid="vision-analyze"
              >
                {analysing ? "Analyzing…" : "Analyze"}
              </Button>
            </div>
          </Card>

          {error && (
            <Card>
              <div
                className="vision-error"
                data-testid="vision-error"
                role="alert"
              >
                <strong>Error:</strong> {error}
              </div>
              <style nonce={cspNonce}>{`
                .vision-error {
                  color: var(--color-error);
                }
              `}</style>
            </Card>
          )}

          {result && (
            <Card>
              <div className="vision-result">
                <div className="vision-result-header">
                  <h2>Result</h2>
                  <Button
                    onClick={onSaveAsDocument}
                    disabled={saving}
                    data-testid="vision-save-as-doc"
                  >
                    {saving ? "Saving…" : "Save as Document"}
                  </Button>
                </div>
                <pre
                  className="vision-result-content"
                  data-testid="vision-result-content"
                >
                  {result.content}
                </pre>
                <p className="vision-result-meta">
                  Tokens predicted: {result.tokensPredicted} of{" "}
                  {resultMeta?.maxTokens ?? maxTokens}
                  {!result.stop && " — output was truncated"}
                </p>
              </div>
            </Card>
          )}
        </>
      )}

      <style nonce={cspNonce}>{`
        .vision-picker-row {
          display: flex;
          align-items: center;
          gap: var(--spacing-md);
          flex-wrap: wrap;
        }
        .vision-image-name {
          font-family: var(--font-family-mono);
          font-size: var(--font-size-sm);
          color: var(--color-text-secondary);
          word-break: break-all;
        }
        .vision-hint {
          color: var(--color-text-secondary);
          font-size: var(--font-size-sm);
          margin-top: var(--spacing-sm);
          margin-bottom: 0;
        }
        .vision-mode {
          border: none;
          padding: 0;
          margin: 0 0 var(--spacing-md) 0;
        }
        .vision-mode legend {
          font-weight: var(--font-weight-semibold);
          margin-bottom: var(--spacing-sm);
        }
        .vision-mode-options {
          display: flex;
          flex-direction: column;
          gap: var(--spacing-sm);
        }
        .vision-mode-option {
          display: grid;
          grid-template-columns: auto auto 1fr;
          gap: var(--spacing-sm);
          align-items: center;
          padding: var(--spacing-sm);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-sm);
          cursor: pointer;
        }
        .vision-mode-option-active {
          border-color: var(--color-primary);
          background: var(--color-bg-subtle);
        }
        .vision-mode-label {
          font-weight: var(--font-weight-semibold);
        }
        .vision-mode-description {
          color: var(--color-text-secondary);
          font-size: var(--font-size-sm);
        }
        .vision-max-tokens {
          display: flex;
          flex-direction: column;
          gap: var(--spacing-sm);
          margin-bottom: var(--spacing-md);
        }
        .vision-max-tokens input[type="range"] {
          width: 100%;
        }
        .vision-actions {
          display: flex;
          justify-content: flex-end;
        }
        .vision-result-header {
          display: flex;
          align-items: center;
          justify-content: space-between;
          margin-bottom: var(--spacing-sm);
        }
        .vision-result-header h2 {
          margin: 0;
          font-size: var(--font-size-lg);
        }
        .vision-result-content {
          white-space: pre-wrap;
          word-wrap: break-word;
          font-family: var(--font-family-mono);
          font-size: var(--font-size-sm);
          background: var(--color-bg-subtle);
          padding: var(--spacing-md);
          border-radius: var(--radius-sm);
          max-height: 600px;
          overflow: auto;
        }
        .vision-result-meta {
          color: var(--color-text-secondary);
          font-size: var(--font-size-sm);
          margin-top: var(--spacing-sm);
        }
      `}</style>
    </div>
  );
}
