/**
 * SlideThumbnail — a read-only, scaled-down render of a single template
 * slide, used as the live preview in the template gallery.
 *
 * Rather than screenshotting decks or mounting the editable
 * `SlideDesignCanvas` (textareas, "+ Add block" affordances, focus
 * traps — none of which belong inside a clickable gallery card), this
 * renders the *same* themed `.slide-canvas` surface the editor uses:
 * the canvas carries `data-slide-theme` / `data-slide-layout` /
 * `data-slide-bg`, so every theme palette, layout grid and slot-driven
 * typography rule in `components.css` applies verbatim. Block bodies are
 * rendered statically (prose as plain elements, `table` / `chart` /
 * `diagram` through the shared {@link SlideBlockPreviews}) so the
 * preview never drifts from the real slide renderer.
 *
 * Scaling is pure CSS: the outer `.slide-thumb-frame` is a 16:9
 * container query, and the inner fixed 960×540 canvas is shrunk with
 * `transform: scale(calc(100cqw / 960))`. No `ResizeObserver`, no JS
 * measurement, no layout thrash — the card can be as small or large as
 * the grid wants and the slide stays pixel-proportional.
 *
 * The thumbnail is decorative: it is `aria-hidden` and non-interactive
 * (`pointer-events: none`), because the gallery card itself carries the
 * accessible name and the click target.
 */
import { getSlideTheme } from "../slideThemes";
import type { TemplateSlide } from "../slideTemplates";
import {
  SlideTablePreview,
  SlideChartPreview,
  MermaidPreview,
} from "./SlideBlockPreviews";

export interface SlideThumbnailProps {
  /** Slide blueprint to render — typically a template's first slide. */
  slide: TemplateSlide;
  /** Resolved theme id (already defaulted by the caller). */
  themeId: string;
  /** Optional extra class for the outer frame. */
  className?: string;
}

type TemplateBlock = TemplateSlide["blocks"][number];

/** Render one block's body with the same markup the live slide uses. */
function ThumbnailBlockBody({ block }: { block: TemplateBlock }) {
  switch (block.type) {
    case "bullets": {
      const lines = block.content
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line.length > 0);
      return (
        <div className="slide-block-content">
          <ul className="slide-thumb-bullets">
            {lines.map((line, i) => (
              <li key={i}>{line}</li>
            ))}
          </ul>
        </div>
      );
    }
    case "table":
      return <SlideTablePreview source={block.content} />;
    case "chart":
      return <SlideChartPreview source={block.content} />;
    case "diagram":
      return <MermaidPreview dsl={block.content} />;
    case "image":
      return block.content.trim().length > 0 ? (
        <img className="slide-thumb-image" src={block.content} alt="" />
      ) : (
        <div className="slide-thumb-image-placeholder" />
      );
    case "text":
    default:
      return <div className="slide-block-content">{block.content}</div>;
  }
}

export function SlideThumbnail({
  slide,
  themeId,
  className,
}: SlideThumbnailProps) {
  const bgStyle = getSlideTheme(themeId).bgStyle;
  const frameClass = className
    ? `slide-thumb-frame ${className}`
    : "slide-thumb-frame";
  return (
    <div className={frameClass} aria-hidden="true">
      <div
        className="slide-canvas slide-thumb-canvas"
        data-slide-theme={themeId}
        data-slide-layout={slide.layout}
        data-slide-bg={bgStyle ?? undefined}
      >
        {slide.title.length > 0 && (
          <div className="slide-title-input slide-thumb-title">
            {slide.title}
          </div>
        )}
        <div className="slide-blocks">
          {slide.blocks.map((block, i) => (
            <div className="slide-block" data-slot={block.slot} key={i}>
              <ThumbnailBlockBody block={block} />
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
