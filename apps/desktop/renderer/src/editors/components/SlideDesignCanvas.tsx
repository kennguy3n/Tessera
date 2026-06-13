/**
 * SlideDesignCanvas — the block-editing region of the Slide editor's
 * WYSIWYG "Design view".
 *
 * Where the structured "Outline" canvas (`SlideBlockRow`) edits each
 * block as a neutral bordered `<textarea>` with the themed result only
 * visible in Present/Export, the Design view *is* the slide: it renders
 * directly on the same themed `.slide-canvas` surface (theme palette,
 * fonts, background and layout regions all apply) and edits the prose
 * in-place so what you type already looks like the final slide. This
 * component renders the blocks region only; the surrounding themed
 * `.slide-canvas` frame, title field, AI actions and speaker notes are
 * owned by `SlideEditor` and shared verbatim with the Outline view.
 *
 * Editing model
 * -------------
 * - `text` → chromeless, theme-typographed auto-growing textarea sitting
 *   transparently on the slide surface.
 * - `bullets` → a real themed `<ul>` where each bullet is its own
 *   inline field. Enter splits a bullet, Backspace at the start merges
 *   into the previous one, Delete at the end pulls the next one up — the
 *   caret-aware list transforms come from the pure, unit-tested helpers
 *   in `slideWysiwyg.ts`, and focus/caret are restored after each edit.
 * - `diagram` / `table` / `chart` → the live themed preview (shared with
 *   the Outline canvas via `SlideBlockPreviews`) plus a chromeless
 *   source editor, so DSL blocks stay editable in-place.
 * - `image` → the rendered image (or a click-to-pick dropzone) plus an
 *   alt-text field for accessibility.
 *
 * All editing routes through the same `onChangeBlock*` / `onMoveBlock` /
 * `onRemoveBlock` callbacks the structured canvas uses, so the two views
 * are fully interchangeable and persist identically.
 */
import {
  useCallback,
  useEffect,
  useLayoutEffect,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type ReactNode,
} from "react";
import type { Slide, SlideBlock } from "../slideEditorTypes";
import {
  SlideTablePreview,
  SlideChartPreview,
  MermaidPreview,
} from "./SlideBlockPreviews";
import {
  contentToBulletLines,
  bulletLinesToContent,
  splitBulletAt,
  mergeBulletBackward,
  mergeBulletForward,
  type BulletEdit,
} from "../slideWysiwyg";

export interface SlideDesignCanvasProps {
  slide: Slide;
  onChangeBlockContent: (blockIndex: number, content: string) => void;
  onChangeBlockAlt: (blockIndex: number, alt: string) => void;
  onImageFile: (blockIndex: number, file: File) => void;
  onMoveBlock: (from: number, to: number) => void;
  onRemoveBlock: (blockIndex: number) => void;
  onAppendBlock: () => void;
}

/** Grow a textarea to fit its content so the slide has no inner scrollbars. */
function autoGrow(el: HTMLTextAreaElement | null): void {
  if (!el) return;
  el.style.height = "auto";
  el.style.height = `${el.scrollHeight}px`;
}

export function SlideDesignCanvas({
  slide,
  onChangeBlockContent,
  onChangeBlockAlt,
  onImageFile,
  onMoveBlock,
  onRemoveBlock,
  onAppendBlock,
}: SlideDesignCanvasProps) {
  return (
    <div className="slide-blocks slide-blocks-design">
      {slide.blocks.map((block, bi) => (
        <DesignBlock
          key={block.id}
          block={block}
          blockIndex={bi}
          totalBlocks={slide.blocks.length}
          onChangeContent={(content) => onChangeBlockContent(bi, content)}
          onChangeAlt={(alt) => onChangeBlockAlt(bi, alt)}
          onImageFile={(file) => onImageFile(bi, file)}
          onMoveUp={() => onMoveBlock(bi, bi - 1)}
          onMoveDown={() => onMoveBlock(bi, bi + 1)}
          onRemove={() => onRemoveBlock(bi)}
        />
      ))}
      <button
        type="button"
        className="slide-design-add"
        onClick={onAppendBlock}
        aria-label="Add a block to this slide"
      >
        + Add block
      </button>
    </div>
  );
}

interface DesignBlockProps {
  block: SlideBlock;
  blockIndex: number;
  totalBlocks: number;
  onChangeContent: (content: string) => void;
  onChangeAlt: (alt: string) => void;
  onImageFile: (file: File) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
}

function DesignBlock({
  block,
  blockIndex,
  totalBlocks,
  onChangeContent,
  onChangeAlt,
  onImageFile,
  onMoveUp,
  onMoveDown,
  onRemove,
}: DesignBlockProps) {
  return (
    <div className="slide-design-block" data-block-type={block.type}>
      <div className="slide-design-block-controls" role="group" aria-label="Block controls">
        <button
          type="button"
          className="slide-design-ctl"
          onClick={onMoveUp}
          disabled={blockIndex === 0}
          aria-label="Move block up"
          title="Move block up"
        >
          ↑
        </button>
        <button
          type="button"
          className="slide-design-ctl"
          onClick={onMoveDown}
          disabled={blockIndex === totalBlocks - 1}
          aria-label="Move block down"
          title="Move block down"
        >
          ↓
        </button>
        <button
          type="button"
          className="slide-design-ctl slide-design-ctl-danger"
          onClick={onRemove}
          aria-label="Delete block"
          title="Delete block"
        >
          ✕
        </button>
      </div>
      <DesignBlockBody
        block={block}
        onChangeContent={onChangeContent}
        onChangeAlt={onChangeAlt}
        onImageFile={onImageFile}
      />
    </div>
  );
}

interface DesignBlockBodyProps {
  block: SlideBlock;
  onChangeContent: (content: string) => void;
  onChangeAlt: (alt: string) => void;
  onImageFile: (file: File) => void;
}

function DesignBlockBody({
  block,
  onChangeContent,
  onChangeAlt,
  onImageFile,
}: DesignBlockBodyProps) {
  switch (block.type) {
    case "text":
      return <DesignText content={block.content} onChange={onChangeContent} />;
    case "bullets":
      return (
        <DesignBullets content={block.content} onChange={onChangeContent} />
      );
    case "image":
      return (
        <DesignImage
          content={block.content}
          alt={block.alt ?? ""}
          onChangeAlt={onChangeAlt}
          onImageFile={onImageFile}
        />
      );
    case "diagram":
      return (
        <DesignSource
          label="Diagram (Mermaid)"
          content={block.content}
          onChange={onChangeContent}
          preview={<MermaidPreview dsl={block.content} />}
        />
      );
    case "table":
      return (
        <DesignSource
          label="Table (Markdown)"
          content={block.content}
          onChange={onChangeContent}
          preview={<SlideTablePreview source={block.content} />}
        />
      );
    case "chart":
      return (
        <DesignSource
          label="Chart (data)"
          content={block.content}
          onChange={onChangeContent}
          preview={<SlideChartPreview source={block.content} />}
        />
      );
    default:
      return null;
  }
}

function DesignText({
  content,
  onChange,
}: {
  content: string;
  onChange: (content: string) => void;
}) {
  return (
    <textarea
      className="slide-wys-text"
      aria-label="Text content"
      value={content}
      ref={autoGrow}
      onChange={(e) => {
        autoGrow(e.currentTarget);
        onChange(e.target.value);
      }}
      placeholder="Type body text…"
    />
  );
}

function DesignBullets({
  content,
  onChange,
}: {
  content: string;
  onChange: (content: string) => void;
}) {
  const lines = contentToBulletLines(content);
  const rowRefs = useRef<Array<HTMLTextAreaElement | null>>([]);
  // After a structural edit (split/merge) we want the caret to land on a
  // specific bullet at a specific offset once the new `content` has
  // re-rendered. Stash the target and apply it in a layout effect.
  const pendingFocus = useRef<{ index: number; caret: number } | null>(null);

  useLayoutEffect(() => {
    const target = pendingFocus.current;
    if (!target) return;
    pendingFocus.current = null;
    const el = rowRefs.current[target.index];
    if (el) {
      el.focus();
      const caret = Math.min(target.caret, el.value.length);
      el.setSelectionRange(caret, caret);
    }
  });

  const commit = useCallback(
    (edit: BulletEdit) => {
      pendingFocus.current = { index: edit.focusIndex, caret: edit.focusCaret };
      onChange(bulletLinesToContent(edit.lines));
    },
    [onChange],
  );

  const handleChange = (index: number, value: string) => {
    const next = lines.slice();
    next[index] = value;
    onChange(bulletLinesToContent(next));
  };

  const handleKeyDown = (
    e: ReactKeyboardEvent<HTMLTextAreaElement>,
    index: number,
  ) => {
    const el = e.currentTarget;
    const { selectionStart, selectionEnd, value } = el;
    const collapsed = selectionStart === selectionEnd;
    if (e.key === "Enter") {
      e.preventDefault();
      commit(splitBulletAt(lines, index, selectionStart));
      return;
    }
    if (e.key === "Backspace" && collapsed && selectionStart === 0) {
      const edit = mergeBulletBackward(lines, index);
      if (edit) {
        e.preventDefault();
        commit(edit);
      }
      return;
    }
    if (
      e.key === "Delete" &&
      collapsed &&
      selectionStart === value.length
    ) {
      const edit = mergeBulletForward(lines, index);
      if (edit) {
        e.preventDefault();
        commit(edit);
      }
    }
  };

  return (
    <ul className="slide-wys-bullets" aria-label="Bullet list">
      {lines.map((line, i) => (
        <li key={i} className="slide-wys-bullet">
          <textarea
            className="slide-wys-bullet-input"
            aria-label={`Bullet ${i + 1}`}
            rows={1}
            value={line}
            ref={(el) => {
              rowRefs.current[i] = el;
              autoGrow(el);
            }}
            onChange={(e) => {
              autoGrow(e.currentTarget);
              handleChange(i, e.target.value);
            }}
            onKeyDown={(e) => handleKeyDown(e, i)}
            placeholder="Bullet"
          />
        </li>
      ))}
    </ul>
  );
}

function DesignImage({
  content,
  alt,
  onChangeAlt,
  onImageFile,
}: {
  content: string;
  alt: string;
  onChangeAlt: (alt: string) => void;
  onImageFile: (file: File) => void;
}) {
  const inputRef = useRef<HTMLInputElement | null>(null);
  const hasImage = content.trim().length > 0;
  return (
    <div className="slide-wys-image">
      <button
        type="button"
        className="slide-wys-image-drop"
        onClick={() => inputRef.current?.click()}
        aria-label={hasImage ? "Replace image" : "Add image"}
      >
        {hasImage ? (
          <img src={content} alt={alt} className="slide-wys-image-preview" />
        ) : (
          <span className="slide-wys-image-placeholder">
            Click to add an image
          </span>
        )}
      </button>
      <input
        ref={inputRef}
        type="file"
        accept="image/*"
        className="slide-wys-image-file"
        onChange={(e) => {
          const file = e.target.files?.[0];
          if (file) onImageFile(file);
          // Reset so picking the same file twice still fires `change`.
          e.target.value = "";
        }}
      />
      <input
        type="text"
        className="slide-wys-image-alt"
        aria-label="Image alt text"
        value={alt}
        onChange={(e) => onChangeAlt(e.target.value)}
        placeholder="Describe this image (alt text)"
      />
    </div>
  );
}

function DesignSource({
  label,
  content,
  onChange,
  preview,
}: {
  label: string;
  content: string;
  onChange: (content: string) => void;
  preview: ReactNode;
}) {
  const [showSource, setShowSource] = useState(false);
  return (
    <div className="slide-wys-source-block">
      <div className="slide-wys-source-preview">{preview}</div>
      <div className="slide-wys-source-controls">
        <button
          type="button"
          className="slide-design-ctl"
          aria-expanded={showSource}
          onClick={() => setShowSource((v) => !v)}
        >
          {showSource ? "Hide source" : `Edit ${label}`}
        </button>
      </div>
      {showSource && (
        <SourceArea label={label} content={content} onChange={onChange} />
      )}
    </div>
  );
}

function SourceArea({
  label,
  content,
  onChange,
}: {
  label: string;
  content: string;
  onChange: (content: string) => void;
}) {
  const ref = useRef<HTMLTextAreaElement | null>(null);
  useEffect(() => {
    autoGrow(ref.current);
  }, [content]);
  return (
    <textarea
      ref={ref}
      className="slide-wys-source"
      aria-label={`${label} source`}
      value={content}
      onChange={(e) => {
        autoGrow(e.currentTarget);
        onChange(e.target.value);
      }}
      spellCheck={false}
    />
  );
}
