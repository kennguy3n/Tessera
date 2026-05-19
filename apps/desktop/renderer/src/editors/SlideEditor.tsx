import { useState, useCallback, useRef, useEffect } from "react";

export interface SlideBlock {
  type: "text" | "bullets";
  content: string;
}

export interface Slide {
  title: string;
  blocks: SlideBlock[];
  notes: string;
}

export interface SlideContent {
  slides: Slide[];
}

interface SlideEditorProps {
  content: string;
  onSave: (content: string) => void;
  autoSaveMs?: number;
}

export default function SlideEditor({
  content,
  onSave,
  autoSaveMs = 2000,
}: SlideEditorProps) {
  const [slides, setSlides] = useState<Slide[]>(() => parseSlideContent(content));
  const [activeIndex, setActiveIndex] = useState(0);
  const [showNotes, setShowNotes] = useState(false);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef(content);

  const debouncedSave = useCallback(
    (updatedSlides: Slide[]) => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        const data: SlideContent = { slides: updatedSlides };
        const json = JSON.stringify(data);
        lastSavedRef.current = json;
        onSave(json);
      }, autoSaveMs);
    },
    [onSave, autoSaveMs],
  );

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  // Sync external content prop changes (e.g., version restore)
  useEffect(() => {
    if (content !== lastSavedRef.current) {
      setSlides(parseSlideContent(content));
      lastSavedRef.current = content;
    }
  }, [content]);

  const updateSlide = useCallback(
    (index: number, patch: Partial<Slide>) => {
      setSlides((prev) => {
        const updated = [...prev];
        updated[index] = { ...updated[index], ...patch };
        debouncedSave(updated);
        return updated;
      });
    },
    [debouncedSave],
  );

  const addSlide = useCallback(() => {
    setSlides((prev) => {
      const updated = [
        ...prev,
        { title: "New Slide", blocks: [{ type: "text" as const, content: "" }], notes: "" },
      ];
      setActiveIndex(updated.length - 1);
      debouncedSave(updated);
      return updated;
    });
  }, [debouncedSave]);

  const removeSlide = useCallback(
    (index: number) => {
      setSlides((prev) => {
        if (prev.length <= 1) return prev;
        const updated = prev.filter((_, i) => i !== index);
        const newIndex = Math.min(activeIndex, updated.length - 1);
        setActiveIndex(newIndex);
        debouncedSave(updated);
        return updated;
      });
    },
    [activeIndex, debouncedSave],
  );

  const moveSlide = useCallback(
    (from: number, to: number) => {
      if (to < 0 || to >= slides.length) return;
      setSlides((prev) => {
        const updated = [...prev];
        const [moved] = updated.splice(from, 1);
        updated.splice(to, 0, moved);
        setActiveIndex(to);
        debouncedSave(updated);
        return updated;
      });
    },
    [slides.length, debouncedSave],
  );

  const activeSlide = slides[activeIndex];

  return (
    <div className="slide-editor">
      <div className="slide-editor-sidebar">
        <div className="slide-thumbnails">
          {slides.map((slide, i) => (
            <button
              key={i}
              type="button"
              className={`slide-thumb ${i === activeIndex ? "active" : ""}`}
              onClick={() => setActiveIndex(i)}
            >
              <span className="slide-thumb-number">{i + 1}</span>
              <span className="slide-thumb-title">{slide.title || "Untitled"}</span>
            </button>
          ))}
        </div>
        <div className="slide-sidebar-actions">
          <button type="button" className="btn-sm" onClick={addSlide}>
            + Add Slide
          </button>
        </div>
      </div>

      <div className="slide-editor-main">
        <div className="slide-editor-toolbar">
          <button
            type="button"
            className="btn-sm"
            onClick={() => moveSlide(activeIndex, activeIndex - 1)}
            disabled={activeIndex === 0}
          >
            Prev
          </button>
          <span>
            Slide {activeIndex + 1} / {slides.length}
          </span>
          <button
            type="button"
            className="btn-sm"
            onClick={() => moveSlide(activeIndex, activeIndex + 1)}
            disabled={activeIndex === slides.length - 1}
          >
            Next
          </button>
          <button
            type="button"
            className="btn-sm danger"
            onClick={() => removeSlide(activeIndex)}
            disabled={slides.length <= 1}
          >
            Delete
          </button>
          <button
            type="button"
            className={`btn-sm ${showNotes ? "active" : ""}`}
            onClick={() => setShowNotes(!showNotes)}
          >
            Notes
          </button>
        </div>

        {activeSlide && (
          <div className="slide-canvas">
            <input
              className="slide-title-input"
              value={activeSlide.title}
              onChange={(e) => updateSlide(activeIndex, { title: e.target.value })}
              placeholder="Slide Title"
            />
            <div className="slide-blocks">
              {activeSlide.blocks.map((block, bi) => (
                <div key={bi} className="slide-block">
                  <select
                    value={block.type}
                    onChange={(e) => {
                      const newBlocks = [...activeSlide.blocks];
                      newBlocks[bi] = { ...newBlocks[bi], type: e.target.value as "text" | "bullets" };
                      updateSlide(activeIndex, { blocks: newBlocks });
                    }}
                  >
                    <option value="text">Text</option>
                    <option value="bullets">Bullets</option>
                  </select>
                  <textarea
                    className="slide-block-content"
                    value={block.content}
                    onChange={(e) => {
                      const newBlocks = [...activeSlide.blocks];
                      newBlocks[bi] = { ...newBlocks[bi], content: e.target.value };
                      updateSlide(activeIndex, { blocks: newBlocks });
                    }}
                    placeholder={
                      block.type === "bullets"
                        ? "One bullet point per line..."
                        : "Enter text content..."
                    }
                    rows={4}
                  />
                </div>
              ))}
              <button
                type="button"
                className="btn-sm"
                onClick={() => {
                  const newBlocks = [
                    ...activeSlide.blocks,
                    { type: "text" as const, content: "" },
                  ];
                  updateSlide(activeIndex, { blocks: newBlocks });
                }}
              >
                + Add Block
              </button>
            </div>

            {showNotes && (
              <div className="slide-notes">
                <label className="slide-notes-label">Speaker Notes</label>
                <textarea
                  className="slide-notes-input"
                  value={activeSlide.notes}
                  onChange={(e) => updateSlide(activeIndex, { notes: e.target.value })}
                  placeholder="Speaker notes for this slide..."
                  rows={3}
                />
              </div>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

function parseSlideContent(content: string): Slide[] {
  if (!content) {
    return [{ title: "Title Slide", blocks: [{ type: "text", content: "" }], notes: "" }];
  }
  try {
    const parsed = JSON.parse(content) as SlideContent;
    if (parsed.slides && Array.isArray(parsed.slides) && parsed.slides.length > 0) {
      return parsed.slides;
    }
  } catch {
    // Not JSON — treat as single text slide
  }
  return [{ title: "Slide 1", blocks: [{ type: "text", content }], notes: "" }];
}
