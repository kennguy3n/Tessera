/**
 * AI assistant UI for the Slide editor — the Gamma-grade generation
 * surface, wired exclusively to the LOCAL on-device model
 * (`window.tessera.model`) and local image generation
 * (`window.tessera.imagegen`). No network/cloud AI, no third-party
 * content egress.
 *
 * Two exported pieces, both thin shells over the pure logic in
 * `slideAiHelpers.ts` and the streaming lifecycle in
 * `hooks/useModelGeneration.ts`:
 *
 *   - {@link SlideDeckGenerator} — "generate a deck" from a prompt:
 *     streams an outline with a live preview, parses it into real
 *     slides, and applies them on confirm.
 *
 *   - {@link SlideAiActions} — per-slide actions: condense / expand /
 *     rewrite bullets, draft speaker notes, and suggest (then
 *     optionally render) an image.
 *
 * All copy, spacing and colour come from the design system tokens via
 * the `slide-ai-*` classes in `components.css`; every control is
 * keyboard-reachable with the shared focus ring, and motion is gated
 * on `prefers-reduced-motion` in CSS.
 */
import { useCallback, useEffect, useMemo, useState } from "react";
import { useModelGeneration } from "../hooks/useModelGeneration";
import {
  buildDeckPrompt,
  buildDeckRestylePrompt,
  buildImagePromptSuggestion,
  buildLayoutSuggestionPrompt,
  buildNotesPrompt,
  buildRewritePrompt,
  buildSlideRegeneratePrompt,
  clampDeckSlideCount,
  mergeRestyledDeck,
  outlineToSlides,
  parseBulletResponse,
  parseDeckOutline,
  parseImagePromptResponse,
  parseLayoutSuggestion,
  parseNotesResponse,
  parseRegeneratedSlide,
  type DeckTone,
  type RegeneratedSlide,
  type SlideRewriteMode,
} from "./slideAiHelpers";
import type { Slide, SlideLayout } from "./slideEditorTypes";
import { getSlideLayout } from "./slideLayouts";
import { SkillRunnerPanel } from "./components/SkillRunnerPanel";
import { getSkillsForSurface } from "../skills/skillLibrary";

/**
 * Probe the local text model's availability so the AI surface can gate
 * itself with a clear "start a model" message instead of firing a
 * generation that will immediately fail. Re-probes whenever `active`
 * flips true (e.g. the deck panel opens) so a model started after the
 * editor mounted is picked up without a reload.
 */
function useModelAvailability(active: boolean): boolean | null {
  const [available, setAvailable] = useState<boolean | null>(null);
  useEffect(() => {
    if (!active) return;
    let cancelled = false;
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api?.model?.status) {
      setAvailable(false);
      return;
    }
    void api.model
      .status()
      .then((status) => {
        if (!cancelled) setAvailable(status.available);
      })
      .catch(() => {
        if (!cancelled) setAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, [active]);
  return available;
}

const TONE_OPTIONS: ReadonlyArray<{ value: DeckTone; label: string }> = [
  { value: "professional", label: "Professional" },
  { value: "casual", label: "Casual" },
  { value: "academic", label: "Academic" },
  { value: "persuasive", label: "Persuasive" },
];

const UNAVAILABLE_HINT =
  "Start a local model in Settings → Models to use the AI assistant.";

export interface SlideDeckGeneratorProps {
  /** Whether the panel is expanded. */
  open: boolean;
  /** Collapse the panel. */
  onClose: () => void;
  /** Apply the generated deck. The editor replaces the deck wholesale. */
  onApply: (slides: Slide[]) => void;
}

type DeckPanelMode = "quick" | "skills";

/**
 * "Generate a deck" panel: prompt + options → streamed outline preview
 * → parsed slides → Apply. A "Skills" tab swaps the one-shot prompt for
 * a deliberate multi-step skill (outline → expand → tighten) whose final
 * deck markdown flows through the SAME parse → apply path.
 */
export function SlideDeckGenerator({
  open,
  onClose,
  onApply,
}: SlideDeckGeneratorProps) {
  const gen = useModelGeneration();
  const modelAvailable = useModelAvailability(open);
  const [topic, setTopic] = useState("");
  const [audience, setAudience] = useState("");
  const [tone, setTone] = useState<DeckTone>("professional");
  const [slideCount, setSlideCount] = useState(6);
  const [preview, setPreview] = useState<Slide[] | null>(null);
  const [noUsableDeck, setNoUsableDeck] = useState(false);

  const [panelMode, setPanelMode] = useState<DeckPanelMode>("quick");
  const deckSkills = useMemo(() => getSkillsForSurface("slide"), []);
  const [skillId, setSkillId] = useState(deckSkills[0]?.id ?? "");
  const selectedSkill =
    deckSkills.find((s) => s.id === skillId) ?? deckSkills[0];
  const [skillNoUsableDeck, setSkillNoUsableDeck] = useState(false);

  // A skill's final output is the same `## heading` + `- bullet` deck
  // markdown the quick generator parses, so the apply path is identical:
  // parse -> slides -> replace the deck wholesale. A skill that produced
  // no parseable slides surfaces the same "no usable deck" guidance
  // rather than silently clearing the deck.
  const applyDeckFromSkill = useCallback(
    (text: string) => {
      const slides = outlineToSlides(parseDeckOutline(text));
      if (slides.length === 0) {
        setSkillNoUsableDeck(true);
        return;
      }
      setSkillNoUsableDeck(false);
      onApply(slides);
      onClose();
    },
    [onApply, onClose],
  );

  const onGenerate = useCallback(async () => {
    const trimmed = topic.trim();
    if (!trimmed) return;
    setPreview(null);
    setNoUsableDeck(false);
    const prompt = buildDeckPrompt({
      topic: trimmed,
      slideCount,
      audience,
      tone,
    });
    const result = await gen.run({
      prompt,
      // Generous budget: a 20-slide outline with bullets is well under
      // this, but a small headroom avoids truncating the last slide.
      maxTokens: 2048,
      temperature: 0.7,
    });
    if (result.status !== "completed") return;
    const slides = outlineToSlides(parseDeckOutline(result.text));
    if (slides.length === 0) {
      setNoUsableDeck(true);
      return;
    }
    setPreview(slides);
  }, [gen, topic, slideCount, audience, tone]);

  const onApplyClick = useCallback(() => {
    if (!preview || preview.length === 0) return;
    onApply(preview);
    setPreview(null);
    setTopic("");
    onClose();
  }, [preview, onApply, onClose]);

  if (!open) return null;

  const disabled = gen.isStreaming || !topic.trim() || modelAvailable === false;

  return (
    <div className="slide-ai-panel" role="region" aria-label="Generate deck">
      <div className="slide-ai-panel-header">
        <h2 className="slide-ai-panel-title">Generate a deck</h2>
        <button
          type="button"
          className="btn-sm"
          onClick={onClose}
          aria-label="Close deck generator"
        >
          ×
        </button>
      </div>

      {modelAvailable === false && (
        <p className="slide-ai-hint" role="status">
          {UNAVAILABLE_HINT}
        </p>
      )}

      {deckSkills.length > 0 && (
        <div
          className="slide-ai-mode-row"
          role="group"
          aria-label="Deck generation mode"
        >
          <button
            type="button"
            className={panelMode === "quick" ? "btn-sm active" : "btn-sm"}
            aria-pressed={panelMode === "quick"}
            data-testid="slide-ai-mode-quick"
            onClick={() => setPanelMode("quick")}
          >
            Quick
          </button>
          <button
            type="button"
            className={panelMode === "skills" ? "btn-sm active" : "btn-sm"}
            aria-pressed={panelMode === "skills"}
            data-testid="slide-ai-mode-skills"
            onClick={() => setPanelMode("skills")}
          >
            Skill
          </button>
        </div>
      )}

      {panelMode === "skills" && selectedSkill ? (
        <>
          {deckSkills.length > 1 && (
            <label className="slide-ai-field">
              <span className="slide-ai-field-label">Skill</span>
              <select
                className="slide-ai-select"
                value={skillId}
                onChange={(e) => setSkillId(e.target.value)}
                aria-label="Choose a skill"
              >
                {deckSkills.map((s) => (
                  <option key={s.id} value={s.id}>
                    {s.name}
                  </option>
                ))}
              </select>
            </label>
          )}
          <SkillRunnerPanel
            key={selectedSkill.id}
            skill={selectedSkill}
            onApply={applyDeckFromSkill}
            applyLabel="Apply deck"
          />
          {skillNoUsableDeck && (
            <p className="slide-ai-error" role="alert">
              The skill didn’t return a usable outline. Try a more specific
              topic.
            </p>
          )}
        </>
      ) : (
        <>
          <label className="slide-ai-field">
            <span className="slide-ai-field-label">Topic or brief</span>
            <textarea
              className="slide-ai-textarea"
              value={topic}
              onChange={(e) => setTopic(e.target.value)}
              placeholder="e.g. A quarterly sales review for the APAC region…"
              rows={3}
              disabled={gen.isStreaming}
            />
          </label>

          <div className="slide-ai-field-row">
            <label className="slide-ai-field">
              <span className="slide-ai-field-label">Slides</span>
              <input
                type="number"
                className="slide-ai-number"
                value={slideCount}
                min={3}
                max={20}
                onChange={(e) =>
                  setSlideCount(clampDeckSlideCount(Number(e.target.value)))
                }
                disabled={gen.isStreaming}
                aria-label="Number of slides"
              />
            </label>
            <label className="slide-ai-field">
              <span className="slide-ai-field-label">Tone</span>
              <select
                className="slide-ai-select"
                value={tone}
                onChange={(e) => setTone(e.target.value as DeckTone)}
                disabled={gen.isStreaming}
                aria-label="Deck tone"
              >
                {TONE_OPTIONS.map((opt) => (
                  <option key={opt.value} value={opt.value}>
                    {opt.label}
                  </option>
                ))}
              </select>
            </label>
          </div>

          <label className="slide-ai-field">
            <span className="slide-ai-field-label">Audience (optional)</span>
            <input
              type="text"
              className="slide-ai-input"
              value={audience}
              onChange={(e) => setAudience(e.target.value)}
              placeholder="e.g. Regional sales managers"
              disabled={gen.isStreaming}
            />
          </label>

          <div className="slide-ai-actions-row">
            {gen.isStreaming ? (
              <button
                type="button"
                className="btn-sm danger"
                onClick={gen.cancel}
                aria-label="Stop generating deck"
              >
                Stop
              </button>
            ) : (
              <button
                type="button"
                className="btn-sm primary"
                onClick={() => void onGenerate()}
                disabled={disabled}
              >
                Generate
              </button>
            )}
            {preview && !gen.isStreaming && (
              <button
                type="button"
                className="btn-sm primary"
                onClick={onApplyClick}
              >
                Apply {preview.length} slide{preview.length === 1 ? "" : "s"}
              </button>
            )}
          </div>

          {gen.error && (
            <p className="slide-ai-error" role="alert">
              {gen.error}
            </p>
          )}
          {noUsableDeck && !gen.isStreaming && (
            <p className="slide-ai-error" role="alert">
              The model didn’t return a usable outline. Try a more specific
              topic.
            </p>
          )}

          {(gen.isStreaming || gen.text) && !preview && (
            <pre
              className="slide-ai-stream"
              aria-live="polite"
              aria-label="Generation preview"
            >
              {gen.text || "…"}
            </pre>
          )}

          {preview && (
            <ol className="slide-ai-preview-list" aria-label="Generated slides">
              {preview.map((slide, i) => (
                <li key={slide.id} className="slide-ai-preview-item">
                  <span className="slide-ai-preview-num">{i + 1}</span>
                  <span className="slide-ai-preview-title">
                    {slide.title || "Untitled slide"}
                  </span>
                </li>
              ))}
            </ol>
          )}
        </>
      )}
    </div>
  );
}

export interface SlideDeckRestylerProps {
  /** Whether the panel is expanded. */
  open: boolean;
  /** Collapse the panel. */
  onClose: () => void;
  /** The current deck to restyle. */
  slides: Slide[];
  /** Apply the restyled deck. The editor replaces the deck wholesale. */
  onApply: (slides: Slide[]) => void;
}

/**
 * "Restyle deck" panel: takes the EXISTING deck, asks the on-device
 * model to tighten the copy and re-pick the best layout per slide
 * (preserving meaning, order, images and notes via
 * {@link mergeRestyledDeck}), streams a live preview, and applies the
 * reconciled deck on confirm. Mirrors {@link SlideDeckGenerator} but
 * operates on the current deck instead of a free-text topic, so there
 * is no prompt field — the deck itself is the input.
 */
export function SlideDeckRestyler({
  open,
  onClose,
  slides,
  onApply,
}: SlideDeckRestylerProps) {
  const gen = useModelGeneration();
  const modelAvailable = useModelAvailability(open);
  const [tone, setTone] = useState<DeckTone>("professional");
  const [preview, setPreview] = useState<Slide[] | null>(null);
  const [noUsableDeck, setNoUsableDeck] = useState(false);

  const onRestyle = useCallback(async () => {
    if (slides.length === 0) return;
    setPreview(null);
    setNoUsableDeck(false);
    const result = await gen.run({
      prompt: buildDeckRestylePrompt({ slides, tone }),
      maxTokens: 2048,
      // Lower than generation: a restyle should stay close to the
      // existing content rather than invent freely.
      temperature: 0.5,
    });
    if (result.status !== "completed") return;
    const restyled = outlineToSlides(parseDeckOutline(result.text));
    if (restyled.length === 0) {
      setNoUsableDeck(true);
      return;
    }
    setPreview(mergeRestyledDeck(slides, restyled));
  }, [gen, slides, tone]);

  const onApplyClick = useCallback(() => {
    if (!preview || preview.length === 0) return;
    onApply(preview);
    setPreview(null);
    onClose();
  }, [preview, onApply, onClose]);

  if (!open) return null;

  const disabled =
    gen.isStreaming || slides.length === 0 || modelAvailable === false;

  return (
    <div className="slide-ai-panel" role="region" aria-label="Restyle deck">
      <div className="slide-ai-panel-header">
        <h2 className="slide-ai-panel-title">Restyle deck</h2>
        <button
          type="button"
          className="btn-sm"
          onClick={onClose}
          aria-label="Close deck restyler"
        >
          ×
        </button>
      </div>

      {modelAvailable === false && (
        <p className="slide-ai-hint" role="status">
          {UNAVAILABLE_HINT}
        </p>
      )}

      <p className="slide-ai-hint">
        Tightens every slide’s wording and re-picks the best layout, keeping
        your content, order, images and notes.
      </p>

      <label className="slide-ai-field">
        <span className="slide-ai-field-label">Tone</span>
        <select
          className="slide-ai-select"
          value={tone}
          onChange={(e) => setTone(e.target.value as DeckTone)}
          disabled={gen.isStreaming}
          aria-label="Restyle tone"
        >
          {TONE_OPTIONS.map((opt) => (
            <option key={opt.value} value={opt.value}>
              {opt.label}
            </option>
          ))}
        </select>
      </label>

      <div className="slide-ai-actions-row">
        {gen.isStreaming ? (
          <button
            type="button"
            className="btn-sm danger"
            onClick={gen.cancel}
            aria-label="Stop restyling deck"
          >
            Stop
          </button>
        ) : (
          <button
            type="button"
            className="btn-sm primary"
            onClick={() => void onRestyle()}
            disabled={disabled}
          >
            Restyle
          </button>
        )}
        {preview && !gen.isStreaming && (
          <button
            type="button"
            className="btn-sm primary"
            onClick={onApplyClick}
          >
            Apply {preview.length} slide{preview.length === 1 ? "" : "s"}
          </button>
        )}
      </div>

      {gen.error && (
        <p className="slide-ai-error" role="alert">
          {gen.error}
        </p>
      )}
      {noUsableDeck && !gen.isStreaming && (
        <p className="slide-ai-error" role="alert">
          The model didn’t return a usable restyle. Try again.
        </p>
      )}

      {(gen.isStreaming || gen.text) && !preview && (
        <pre
          className="slide-ai-stream"
          aria-live="polite"
          aria-label="Restyle preview"
        >
          {gen.text || "…"}
        </pre>
      )}

      {preview && (
        <ol className="slide-ai-preview-list" aria-label="Restyled slides">
          {preview.map((slide, i) => (
            <li key={slide.id} className="slide-ai-preview-item">
              <span className="slide-ai-preview-num">{i + 1}</span>
              <span className="slide-ai-preview-title">
                {slide.title || "Untitled slide"}
              </span>
            </li>
          ))}
        </ol>
      )}
    </div>
  );
}

type ActiveAiAction =
  | SlideRewriteMode
  | "notes"
  | "image"
  | "layout"
  | "regen"
  | null;

export interface SlideAiActionsProps {
  /** The slide the actions operate on. */
  slide: Slide;
  /** Apply rewritten bullets to the slide. */
  onApplyBullets: (bullets: string[]) => void;
  /** Apply generated speaker notes (also reveals the notes pane). */
  onApplyNotes: (notes: string) => void;
  /**
   * Apply a regenerated slide (fresh title + bullets) to the active
   * slide, preserving its layout, notes and images. Optional so the
   * action degrades gracefully when the host doesn't support it.
   */
  onApplyRegenerated?: (regen: RegeneratedSlide) => void;
  /**
   * Deck title (the first slide's title), woven into the regenerate
   * prompt for topic/tone context. Optional.
   */
  deckTitle?: string;
  /**
   * Apply an AI-suggested layout to the slide. Optional so the action
   * row degrades gracefully when the host doesn't support changing the
   * active slide's layout.
   */
  onApplyLayout?: (layout: SlideLayout) => void;
  /**
   * Insert a generated image (asset URL + alt text) as a new image
   * block. Only offered when image generation is available AND the
   * editor has an artifact id to route the asset under.
   */
  onInsertImage?: (assetUrl: string, alt: string) => void;
  /**
   * Owning artifact id, required to route generated images on disk.
   * When absent, the image action degrades to suggesting a prompt the
   * user can copy rather than generating an asset.
   */
  artifactId?: string;
}

/**
 * Per-slide AI action row rendered beneath the active slide's blocks.
 */
export function SlideAiActions({
  slide,
  onApplyBullets,
  onApplyNotes,
  onApplyRegenerated,
  deckTitle,
  onApplyLayout,
  onInsertImage,
  artifactId,
}: SlideAiActionsProps) {
  const gen = useModelGeneration();
  const modelAvailable = useModelAvailability(true);
  const [active, setActive] = useState<ActiveAiAction>(null);
  const [imagePrompt, setImagePrompt] = useState("");
  const [imagegenAvailable, setImagegenAvailable] = useState<boolean | null>(
    null,
  );
  const [imageInFlight, setImageInFlight] = useState(false);
  const [imageError, setImageError] = useState<string | null>(null);
  const [layoutNotice, setLayoutNotice] = useState<string | null>(null);

  // Clear the transient layout notice when the active slide changes so
  // a "applied X layout" message never lingers on a different slide.
  useEffect(() => {
    setLayoutNotice(null);
  }, [slide.id]);

  useEffect(() => {
    let cancelled = false;
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    if (!api?.imagegen?.isAvailable) {
      setImagegenAvailable(false);
      return;
    }
    void api.imagegen
      .isAvailable()
      .then((ok) => {
        if (!cancelled) setImagegenAvailable(ok);
      })
      .catch(() => {
        if (!cancelled) setImagegenAvailable(false);
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const runRewrite = useCallback(
    async (mode: SlideRewriteMode) => {
      setActive(mode);
      setLayoutNotice(null);
      const result = await gen.run({
        prompt: buildRewritePrompt(slide, mode),
        maxTokens: 1024,
        temperature: 0.6,
      });
      setActive(null);
      if (result.status !== "completed") return;
      const bullets = parseBulletResponse(result.text);
      if (bullets.length > 0) onApplyBullets(bullets);
    },
    [gen, slide, onApplyBullets],
  );

  const runRegenerate = useCallback(async () => {
    setActive("regen");
    setLayoutNotice(null);
    const result = await gen.run({
      prompt: buildSlideRegeneratePrompt(slide, deckTitle),
      maxTokens: 512,
      temperature: 0.7,
    });
    setActive(null);
    if (result.status !== "completed") return;
    const regen = parseRegeneratedSlide(result.text);
    if (regen && onApplyRegenerated) onApplyRegenerated(regen);
  }, [gen, slide, deckTitle, onApplyRegenerated]);

  const runNotes = useCallback(async () => {
    setActive("notes");
    setLayoutNotice(null);
    const result = await gen.run({
      prompt: buildNotesPrompt(slide),
      maxTokens: 512,
      temperature: 0.6,
    });
    setActive(null);
    if (result.status !== "completed") return;
    const notes = parseNotesResponse(result.text);
    if (notes) onApplyNotes(notes);
  }, [gen, slide, onApplyNotes]);

  const runImagePrompt = useCallback(async () => {
    setActive("image");
    setImageError(null);
    setLayoutNotice(null);
    const result = await gen.run({
      prompt: buildImagePromptSuggestion(slide),
      maxTokens: 256,
      temperature: 0.8,
    });
    setActive(null);
    if (result.status !== "completed") return;
    setImagePrompt(parseImagePromptResponse(result.text));
  }, [gen, slide]);

  const runSuggestLayout = useCallback(async () => {
    setActive("layout");
    setLayoutNotice(null);
    // Low temperature: layout selection is a classification, not a
    // creative task — we want the model to commit to one id.
    const result = await gen.run({
      prompt: buildLayoutSuggestionPrompt(slide),
      maxTokens: 32,
      temperature: 0.2,
    });
    setActive(null);
    if (result.status !== "completed") return;
    const layout = parseLayoutSuggestion(result.text);
    if (!layout || !onApplyLayout) {
      setLayoutNotice("The model didn’t suggest a usable layout.");
      return;
    }
    onApplyLayout(layout);
    setLayoutNotice(`Applied “${getSlideLayout(layout).label}” layout.`);
  }, [gen, slide, onApplyLayout]);

  const onGenerateImage = useCallback(async () => {
    const api = typeof window !== "undefined" ? window.tessera : undefined;
    const prompt = imagePrompt.trim();
    if (!prompt || !artifactId || !api?.imagegen?.generate) return;
    setImageInFlight(true);
    setImageError(null);
    try {
      const out = await api.imagegen.generate({
        prompt,
        width: 1536,
        height: 1024,
        artifactId,
      });
      onInsertImage?.(out.assetUrl, prompt);
      setImagePrompt("");
    } catch (e: unknown) {
      setImageError(e instanceof Error ? e.message : String(e));
    } finally {
      setImageInFlight(false);
    }
  }, [imagePrompt, artifactId, onInsertImage]);

  if (modelAvailable === false) {
    return (
      <div className="slide-ai-actions" role="group" aria-label="AI actions">
        <span className="slide-ai-actions-label">AI</span>
        <span className="slide-ai-hint">{UNAVAILABLE_HINT}</span>
      </div>
    );
  }

  const busy = gen.isStreaming;
  const canGenerateImage =
    imagegenAvailable === true && !!artifactId && !!onInsertImage;

  return (
    <div className="slide-ai-actions" role="group" aria-label="AI actions">
      <span className="slide-ai-actions-label">AI</span>
      <button
        type="button"
        className="btn-xs"
        onClick={() => void runRewrite("concise")}
        disabled={busy}
        title="Condense the slide's bullets"
      >
        {active === "concise" ? "Condensing…" : "Condense"}
      </button>
      <button
        type="button"
        className="btn-xs"
        onClick={() => void runRewrite("expand")}
        disabled={busy}
        title="Add supporting bullets"
      >
        {active === "expand" ? "Expanding…" : "Expand"}
      </button>
      <button
        type="button"
        className="btn-xs"
        onClick={() => void runRewrite("rewrite")}
        disabled={busy}
        title="Rewrite the bullets for clarity"
      >
        {active === "rewrite" ? "Rewriting…" : "Rewrite"}
      </button>
      {onApplyRegenerated && (
        <button
          type="button"
          className="btn-xs"
          onClick={() => void runRegenerate()}
          disabled={busy}
          title="Regenerate this slide with a fresh title and bullets"
        >
          {active === "regen" ? "Regenerating…" : "Regenerate"}
        </button>
      )}
      <button
        type="button"
        className="btn-xs"
        onClick={() => void runNotes()}
        disabled={busy}
        title="Draft speaker notes"
      >
        {active === "notes" ? "Writing…" : "Speaker notes"}
      </button>
      {onApplyLayout && (
        <button
          type="button"
          className="btn-xs"
          onClick={() => void runSuggestLayout()}
          disabled={busy}
          title="Let AI pick the best layout for this slide"
        >
          {active === "layout" ? "Choosing…" : "Suggest layout"}
        </button>
      )}
      <button
        type="button"
        className="btn-xs"
        onClick={() => void runImagePrompt()}
        disabled={busy}
        title="Suggest an image for this slide"
      >
        {active === "image" ? "Thinking…" : "Suggest image"}
      </button>
      {busy && (
        <button
          type="button"
          className="btn-xs danger"
          onClick={gen.cancel}
          aria-label="Stop AI action"
        >
          Stop
        </button>
      )}

      {gen.error && (
        <span className="slide-ai-error" role="alert">
          {gen.error}
        </span>
      )}

      {layoutNotice && (
        <span className="slide-ai-hint" role="status">
          {layoutNotice}
        </span>
      )}

      {imagePrompt && (
        <div className="slide-ai-image-suggestion">
          <label className="slide-ai-field-label" htmlFor="slide-ai-img-prompt">
            Suggested image prompt
          </label>
          <textarea
            id="slide-ai-img-prompt"
            className="slide-ai-textarea"
            value={imagePrompt}
            onChange={(e) => setImagePrompt(e.target.value)}
            rows={2}
          />
          {canGenerateImage ? (
            <button
              type="button"
              className="btn-sm primary"
              onClick={() => void onGenerateImage()}
              disabled={imageInFlight}
            >
              {imageInFlight ? "Generating image…" : "Generate & insert image"}
            </button>
          ) : (
            <p className="slide-ai-hint">
              Copy this into an image block, or install an image model to
              generate it here.
            </p>
          )}
          {imageError && (
            <p className="slide-ai-error" role="alert">
              {imageError}
            </p>
          )}
        </div>
      )}
    </div>
  );
}
