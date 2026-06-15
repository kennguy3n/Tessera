import {
  useState,
  useCallback,
  useRef,
  useEffect,
  useId,
  useMemo,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from "react";
import {
  renderMarp,
  MarpRenderError,
  type MarpRenderOptions,
} from "../services/marpRenderer";
import {
  applyMarpToShadow,
  extractFrontmatterTheme,
  parseSlideContent,
  setFrontmatterTheme,
  buildSlideFromLayout,
  buildBlock,
  duplicateSlideAt,
  moveSlide as moveSlideHelper,
  moveBlock,
  removeBlock as removeBlockHelper,
  discardUploadTokensForSlide,
  discardUploadTokensForBlock,
  uploadTokenKey,
  appendBlock,
  replaceBlock,
  computeDeckWordCounts,
  findInSlides,
  fileToDataUrl,
  buildPresentationSlides,
  nextBlockForTypeChange,
  buildDeckFromTemplate,
  buildSlideFromPreset,
  resolveThemeId,
  type ParsedSlideContent,
  type SlideFindMatch,
} from "./slideEditorHelpers";
import {
  SlideTablePreview,
  SlideChartPreview,
  MermaidPreview,
} from "./components/SlideBlockPreviews";
import { SlideDesignCanvas } from "./components/SlideDesignCanvas";
import { BrandKitBuilderModal } from "./components/BrandKitBuilderModal";
import { SlideThumbnail } from "./components/SlideThumbnail";
import {
  SLIDE_THEMES,
  getSlideTheme,
  SLIDE_BG_STYLES,
  DEFAULT_SLIDE_THEME_ID,
  type SlideBgStyle,
} from "./slideThemes";
import { brandKitCssVars, type BrandKit } from "./slideBrandKit";
import { useBrandKits } from "./useBrandKits";
import { SLIDE_LAYOUTS, resolveSlideLayout } from "./slideLayouts";
import { resolveIconComponent } from "../services/iconResolver";
import {
  SLIDE_TEMPLATES,
  INSERT_CARD_PRESETS,
  TEMPLATE_CATEGORIES,
  ALL_TEMPLATES_CATEGORY,
  filterSlideTemplates,
  type TemplateCategoryFilter,
} from "./slideTemplates";

import {
  applyBulletsToSlide,
  applyRegeneratedSlide,
  type RegeneratedSlide,
} from "./slideAiHelpers";
import { useFocusTrap } from "../hooks/useFocusTrap";
import {
  SlideAiActions,
  SlideDeckGenerator,
  SlideDeckRestyler,
} from "./SlideAiPanel";
import type {
  MarpModeState,
  Slide,
  SlideAspectRatio,
  SlideBlock,
  SlideBlockType,
  SlideContent,
  SlideLayout,
} from "./slideEditorTypes";

export type {
  SlideBlockType,
  SlideBlock,
  Slide,
  MarpModeState,
  SlideContent,
} from "./slideEditorTypes";

interface SlideEditorProps {
  content: string;
  onSave: (content: string) => void;
  /** See SheetEditor.onDraftChange — published synchronously on every edit. */
  onDraftChange?: (content: string) => void;
  autoSaveMs?: number;
  /**
   * The artifact's name, forwarded to presenter mode so both windows are
   * titled with the real deck name rather than the generic default.
   * Optional: the IPC layer falls back to "Presentation" when absent.
   */
  deckTitle?: string;
  /**
   * Owning artifact id, forwarded to the AI image-generation flow so
   * generated assets are routed under `<userData>/generated-images/
   * <artifactId>/`. Optional: when absent the per-slide "suggest
   * image" action degrades to suggesting a prompt the user can copy
   * rather than rendering an asset.
   */
  artifactId?: string;
}

/**
 * Local helper component for the Speaker Notes textarea. Lives at a
 * separate component scope so we can call `useId()` to wire the
 * sibling-pattern `<label>` to the `<textarea>` via htmlFor /
 * matching id, satisfying the WCAG SC 1.3.1 / SC 4.1.2 requirement
 * that every form control has a programmatically associated label.
 */
function SpeakerNotesField({
  notes,
  onChange,
}: {
  notes: string;
  onChange: (next: string) => void;
}) {
  const id = useId();
  return (
    <div className="slide-notes">
      <label htmlFor={id} className="slide-notes-label">
        Speaker Notes
      </label>
      <textarea
        id={id}
        className="slide-notes-input"
        value={notes}
        onChange={(e) => onChange(e.target.value)}
        placeholder="Speaker notes for this slide..."
        rows={3}
      />
    </div>
  );
}

/**
 * Human-readable label for each layout choice in the Add Slide menu.
 * Kept here (rather than in `slideEditorTypes.ts`) so the helpers
 * module stays display-string-free — those types are consumed by
 * non-UI callers (e.g. the future export pipeline) and shouldn't ship
 * a hard dependency on English labels.
 */
const LAYOUT_LABELS: Record<SlideLayout, string> = Object.fromEntries(
  SLIDE_LAYOUTS.map((l) => [l.id, l.label]),
) as Record<SlideLayout, string>;

const LAYOUT_ORDER: SlideLayout[] = SLIDE_LAYOUTS.map((l) => l.id);

/**
 * Per-layout display metadata (icon name + emoji/text glyph fallback)
 * keyed by layout id, derived once from the catalogue. Lets the
 * Add-Slide menu surface a real vector icon while keeping the emoji
 * glyph as a guaranteed fallback for any layout whose `iconName`
 * doesn't resolve in the bundled icon set.
 */
const LAYOUT_META: Record<SlideLayout, { iconName?: string; glyph: string }> =
  Object.fromEntries(
    SLIDE_LAYOUTS.map((l) => [l.id, { iconName: l.iconName, glyph: l.glyph }]),
  ) as Record<SlideLayout, { iconName?: string; glyph: string }>;

/**
 * Render a menu glyph as a crisp Lucide vector icon when `iconName`
 * resolves, otherwise fall back to the emoji/text `glyph`. Resolution
 * is a cheap namespace lookup (no async, no hooks) so it's safe to call
 * inside a `.map()` over menu items. The icon is purely decorative —
 * the adjacent text label carries the accessible name — so it's marked
 * `aria-hidden`.
 */
function SlideMenuIcon({
  iconName,
  glyph,
  size = 16,
}: {
  iconName?: string;
  glyph: string;
  size?: number;
}) {
  const Icon = iconName
    ? resolveIconComponent({ set: "lucide", name: iconName })
    : null;
  if (Icon) {
    return <Icon size={size} aria-hidden="true" focusable="false" />;
  }
  return <span aria-hidden="true">{glyph}</span>;
}

export default function SlideEditor({
  content,
  onSave,
  onDraftChange,
  autoSaveMs = 2000,
  deckTitle,
  artifactId,
}: SlideEditorProps) {
  // Parse the initial content exactly once. Subsequent prop-driven changes
  // are handled by the sync effect below; recomputing on every keystroke
  // (via useMemo on `content`) would re-parse for nothing — the result is
  // only ever read by the useState initializers, which run on mount.
  const initialRef = useRef<ParsedSlideContent | null>(null);
  if (initialRef.current === null) {
    initialRef.current = parseSlideContent(content);
  }
  const initial = initialRef.current;
  const [slides, setSlides] = useState<Slide[]>(() => initial.slides);
  const [activeIndex, setActiveIndex] = useState(0);
  const [showNotes, setShowNotes] = useState(false);
  // Outline (form-field) vs. Design (WYSIWYG) editing surface. Both edit
  // the same `slides` state through the same callbacks, so toggling is a
  // pure view switch with no data conversion. Marp mode is exclusive of
  // both (it edits raw Markdown), so it takes precedence when enabled.
  const [designView, setDesignView] = useState(false);
  const [marpMode, setMarpMode] = useState<boolean>(() => initial.marpMode);
  const [marpSource, setMarpSource] = useState<string>(
    () => initial.marpSource,
  );
  const [marpTheme, setMarpTheme] = useState<MarpRenderOptions["theme"]>(
    () => initial.marpTheme ?? "default",
  );
  const [themeId, setThemeId] = useState<string>(() => initial.themeId);
  // Deck-wide aspect ratio (16:9 legacy default). Seeded from the parsed
  // content so a restored deck keeps its ratio; persisted via the
  // debounced save like `themeId`.
  const [aspectRatio, setAspectRatio] = useState<SlideAspectRatio>(
    () => initial.aspectRatio,
  );
  // Active brand-kit id (re-skins the curated theme). `undefined` ⇒ no
  // brand kit, the legacy/default case. Validity against the live store
  // is resolved below via `useBrandKits`, so a stale/foreign id here
  // simply degrades to "no brand kit" at render.
  const [brandKitId, setBrandKitId] = useState<string | undefined>(
    () => initial.brandKitId,
  );
  const [brandBuilderOpen, setBrandBuilderOpen] = useState(false);
  const [deckGenOpen, setDeckGenOpen] = useState(false);
  const [deckRestyleOpen, setDeckRestyleOpen] = useState(false);
  const [layoutMenuOpen, setLayoutMenuOpen] = useState(false);
  const [templatePickerOpen, setTemplatePickerOpen] = useState(false);
  const [templateCategory, setTemplateCategory] =
    useState<TemplateCategoryFilter>(ALL_TEMPLATES_CATEGORY);
  const [templateQuery, setTemplateQuery] = useState("");
  const [themePickerOpen, setThemePickerOpen] = useState(false);
  const [insertPresetOpen, setInsertPresetOpen] = useState(false);
  const [findPanelOpen, setFindPanelOpen] = useState(false);
  const [findQuery, setFindQuery] = useState("");
  const [findCaseSensitive, setFindCaseSensitive] = useState(false);
  const [findActiveIndex, setFindActiveIndex] = useState(0);
  // Drag-and-drop reorder state. We track IDs (not indices) so the
  // dragged item survives a setState that re-renders the list with a
  // different array order — the source's index could change between
  // dragStart and drop, but its id can't.
  const [draggedSlideId, setDraggedSlideId] = useState<string | null>(null);
  const [draggedBlockId, setDraggedBlockId] = useState<string | null>(null);
  const saveTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  const lastSavedRef = useRef(content);

  // Track the current Marp state in a ref so the save path can read the
  // latest value at *flush* time rather than capturing it at callback
  // creation time. This eliminates a closure-capture hazard where mutators
  // like `updateSlide` would otherwise serialise stale marp state when
  // Marp Mode / theme / source had been changed between callback creation
  // and the debounce timer firing.
  const marpStateRef = useRef<MarpModeState>({
    enabled: marpMode,
    source: marpSource,
    theme: marpTheme,
  });
  useEffect(() => {
    marpStateRef.current = {
      enabled: marpMode,
      source: marpSource,
      theme: marpTheme,
    };
  }, [marpMode, marpSource, marpTheme]);

  // Mirror the curated deck theme into a ref so the debounced save
  // path can read the freshest value at flush time, exactly like
  // `marpStateRef` above. Without this, a save scheduled from a slide
  // mutator (which doesn't take a theme argument) would serialise the
  // theme captured when the callback was created, dropping a
  // theme-switch that happened between the edit and the timer firing.
  const themeIdRef = useRef<string>(themeId);
  useEffect(() => {
    themeIdRef.current = themeId;
  }, [themeId]);

  // Mirror the deck aspect ratio into a ref for the same flush-time
  // consistency reason as `themeIdRef`: a save scheduled from a slide
  // mutator (which takes no ratio argument) must serialise the freshest
  // chosen ratio, not the value captured when the callback was created.
  const aspectRatioRef = useRef<SlideAspectRatio>(aspectRatio);
  useEffect(() => {
    aspectRatioRef.current = aspectRatio;
  }, [aspectRatio]);

  // Mirror the active brand-kit id into a ref for the same flush-time
  // consistency the theme + marp refs guarantee: a save scheduled from a
  // slide mutator must serialise the freshest brand id, not a stale
  // closure capture from when the mutator was created.
  const brandKitIdRef = useRef<string | undefined>(brandKitId);
  useEffect(() => {
    brandKitIdRef.current = brandKitId;
  }, [brandKitId]);

  // Resolve the deck's persisted brand-kit id against the live store.
  // An unknown id (kit deleted on this or another machine, or a hand-
  // edited deck) resolves to `null`, so the canvas silently renders with
  // its curated theme — no brand overrides — exactly like a legacy deck.
  const { brandKitById } = useBrandKits();
  const activeBrandKit = useMemo(
    () => brandKitById(brandKitId),
    [brandKitById, brandKitId],
  );
  // The brand kit's `--slide-*` overrides, stamped INLINE on the canvas
  // so they win over the stylesheet's `[data-slide-theme]` declarations
  // (same element ⇒ inline beats selector) without touching the curated
  // theme CSS or any slide content.
  const brandStyle = useMemo<CSSProperties | undefined>(
    () =>
      activeBrandKit
        ? (brandKitCssVars(activeBrandKit) as CSSProperties)
        : undefined,
    [activeBrandKit],
  );

  // Mirror activeIndex into a ref so callbacks that run inside
  // `setSlides` updaters can read the freshest committed value
  // rather than a potentially stale closure capture. Used by
  // `insertPreset` to determine the insertion position.
  const activeIndexRef = useRef(activeIndex);
  useEffect(() => {
    activeIndexRef.current = activeIndex;
  }, [activeIndex]);

  // Mirror the open flag of each blocking modal into a ref so the always-on
  // global navigation listener (attached once, below) can suppress
  // Ctrl+PageUp/Dn while a modal is up without being re-attached on
  // every toggle.
  const templatePickerOpenRef = useRef(false);
  useEffect(() => {
    templatePickerOpenRef.current = templatePickerOpen;
  }, [templatePickerOpen]);
  const brandBuilderOpenRef = useRef(false);
  useEffect(() => {
    brandBuilderOpenRef.current = brandBuilderOpen;
  }, [brandBuilderOpen]);

  // Refs for the "+ Add Slide" trigger button and its layout-picker
  // popover. The click-outside effect below uses these to discriminate
  // "click inside the menu / on the toggle button" (which it must
  // ignore, since the toggle and the menu items handle their own
  // state) from "click outside" (which should dismiss the popover).
  const layoutMenuRef = useRef<HTMLDivElement | null>(null);
  const layoutButtonRef = useRef<HTMLButtonElement | null>(null);
  const themePickerRef = useRef<HTMLDivElement | null>(null);
  const themePickerTriggerRef = useRef<HTMLButtonElement | null>(null);
  const insertPresetRef = useRef<HTMLDivElement | null>(null);
  const insertPresetTriggerRef = useRef<HTMLButtonElement | null>(null);
  const templatePickerRef = useRef<HTMLDivElement | null>(null);

  // The toolbar popovers (Add-Slide layout menu, AI Deck, theme picker,
  // insert-preset menu) are mutually exclusive: opening one closes the
  // others so they can never visually stack or strand keyboard focus in
  // a popover hidden behind another. Passing `null` closes them all.
  const openExclusiveMenu = useCallback(
    (menu: "layout" | "deck" | "restyle" | "theme" | "insert" | null) => {
      setLayoutMenuOpen(menu === "layout");
      setDeckGenOpen(menu === "deck");
      setDeckRestyleOpen(menu === "restyle");
      setThemePickerOpen(menu === "theme");
      setInsertPresetOpen(menu === "insert");
    },
    [],
  );

  const closeTemplatePicker = useCallback(
    () => setTemplatePickerOpen(false),
    [],
  );

  // Close the layout picker when the user clicks anywhere outside it.
  // We listen on `mousedown` (not `click`) so the dismiss happens
  // before any focused control inside the popover loses focus on
  // another input, matching the dismiss model used by other native
  // popovers (the menu button itself toggles state via its own
  // onClick, so we deliberately skip events originating from the
  // button to avoid the "open → outside-handler-closes → button
  // onClick-reopens" double-toggle).
  useEffect(() => {
    if (!layoutMenuOpen) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (layoutMenuRef.current?.contains(target)) return;
      if (layoutButtonRef.current?.contains(target)) return;
      setLayoutMenuOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLayoutMenuOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [layoutMenuOpen]);

  // Close the theme picker on click-outside or Escape.
  useEffect(() => {
    if (!themePickerOpen) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (themePickerRef.current?.contains(target)) return;
      if (themePickerTriggerRef.current?.contains(target)) return;
      setThemePickerOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setThemePickerOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [themePickerOpen]);

  // Close the insert-preset dropdown on click-outside or Escape.
  useEffect(() => {
    if (!insertPresetOpen) return undefined;
    const onPointerDown = (event: MouseEvent) => {
      const target = event.target as Node | null;
      if (!target) return;
      if (insertPresetRef.current?.contains(target)) return;
      if (insertPresetTriggerRef.current?.contains(target)) return;
      setInsertPresetOpen(false);
    };
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") setInsertPresetOpen(false);
    };
    document.addEventListener("mousedown", onPointerDown);
    document.addEventListener("keydown", onKey);
    return () => {
      document.removeEventListener("mousedown", onPointerDown);
      document.removeEventListener("keydown", onKey);
    };
  }, [insertPresetOpen]);

  // The template picker is a true modal: trap keyboard focus inside it,
  // close it on Escape, and restore focus to the trigger on close. The
  // shared hook also handles the deferred initial focus so the first
  // template card is reachable by keyboard the moment the modal opens.
  useFocusTrap(templatePickerOpen, templatePickerRef, closeTemplatePicker);

  // Global Ctrl+PageUp / Ctrl+PageDown — navigate to the previous /
  // next slide regardless of which control inside the editor has
  // focus. Matches Google Slides / LibreOffice Impress / Keynote and
  // mirrors the document-editor's `Ctrl+F` find shortcut wiring
  // (DocumentEditor.tsx: same global-listener pattern).
  //
  // Behaviour notes:
  //   * `PageUp` / `PageDown` aren't text-editing keys in any
  //     browser-shipped textarea / input, so swallowing them with
  //     `preventDefault()` doesn't conflict with native edit gestures.
  //   * Cmd is treated identically to Ctrl so macOS users get the
  //     same shortcut without a separate code path. The browser
  //     itself doesn't reserve `Cmd+PageUp/Dn` on macOS (it's not a
  //     tab-switch chord like `Cmd+Opt+Arrow`), so there's no
  //     accelerator collision.
  //   * The listener is attached ONCE for the component lifetime
  //     and reads the latest `navigateBy` via a ref. This avoids
  //     detaching / re-attaching the document-level listener every
  //     time `slides.length` changes (which is every keystroke
  //     that adds/removes a slide). The `navigateByRef` is updated
  //     inline below `navigateBy`'s declaration so the listener
  //     always sees the freshest closure without being recreated.
  const navigateByRef = useRef<(delta: number) => void>(() => {});
  useEffect(() => {
    const onNavKey = (event: KeyboardEvent) => {
      if (!event.ctrlKey && !event.metaKey) return;
      // The template picker and brand builder are true modals — don't let
      // slide navigation run behind their backdrop while one is open.
      if (templatePickerOpenRef.current || brandBuilderOpenRef.current) return;
      if (event.key === "PageUp") {
        event.preventDefault();
        navigateByRef.current(-1);
      } else if (event.key === "PageDown") {
        event.preventDefault();
        navigateByRef.current(1);
      }
    };
    document.addEventListener("keydown", onNavKey);
    return () => document.removeEventListener("keydown", onNavKey);
  }, []);

  const debouncedSave = useCallback(
    (updatedSlides: Slide[], marpState?: MarpModeState) => {
      // Serialise eagerly so onDraftChange fires with the same payload
      // the debounced onSave will commit. Doing it here (rather than
      // inside the timer) also avoids reading marpStateRef twice and
      // potentially seeing different state.
      const data: SlideContent = {
        slides: updatedSlides,
        marp: marpState ?? marpStateRef.current,
        themeId: themeIdRef.current,
        aspectRatio: aspectRatioRef.current,
        // `JSON.stringify` drops `undefined`, so a deck that never set a
        // brand kit serialises exactly as before (no `brandKitId` key) —
        // keeping legacy decks byte-identical and the field truly additive.
        brandKitId: brandKitIdRef.current,
      };
      const json = JSON.stringify(data);
      // Publish the draft immediately (no debounce) so exporting before
      // the auto-save fires still captures the live editor state.
      onDraftChange?.(json);
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
      saveTimeoutRef.current = setTimeout(() => {
        lastSavedRef.current = json;
        onSave(json);
      }, autoSaveMs);
    },
    [onSave, onDraftChange, autoSaveMs],
  );

  useEffect(() => {
    return () => {
      if (saveTimeoutRef.current) clearTimeout(saveTimeoutRef.current);
    };
  }, []);

  // Sync external content prop changes (e.g., version restore).
  //
  // A version restore is a hard swap of the deck — every per-slide /
  // per-block piece of in-flight state attached to the *old* deck has
  // to be torn down or it ends up pointing at slides / blocks that no
  // longer exist:
  //
  //   * `activeIndex` is clamped against the new deck length, mirroring
  //     the careful index-management `removeSlide` already does. Without
  //     this, restoring an older version with fewer slides leaves the
  //     canvas blank (the JSX guards on `activeSlide &&` so we don't
  //     crash, but the user has to manually click a thumbnail to recover).
  //     Devin Review PR #82 (ANALYSIS_…_0001) flagged the asymmetry with
  //     `removeSlide`.
  //   * `draggedSlideId` / `draggedBlockId` cleared so an in-flight drag
  //     started before the restore can't fall through to `onDrop` with a
  //     dead source id (the source slide / block has been swapped out
  //     from under the drag).
  //   * `uploadTokensRef` cleared because every entry is keyed by
  //     `(slideId|blockId)` and those ids no longer resolve to anything
  //     in the new deck. Leaving stale tokens means a late-resolving
  //     `fileToDataUrl` from before the restore would see a
  //     `currentToken !== ownToken` mismatch (good, it bails) but the
  //     entry itself would persist forever — same leak the round 7 fix
  //     closed for block deletion, just at the deck level.
  //   * Every transient overlay (the toolbar popovers, the template
  //     picker modal, the find panel) is dismissed. They all reference
  //     the old deck — the find panel's match list indexes into slides
  //     that no longer exist, and an open popover/modal floating over a
  //     freshly swapped deck is disorienting — so a hard swap resets the
  //     editor chrome to a clean state.
  useEffect(() => {
    if (content !== lastSavedRef.current) {
      const parsed = parseSlideContent(content);
      setSlides(parsed.slides);
      setActiveIndex((prev) =>
        Math.min(prev, Math.max(0, parsed.slides.length - 1)),
      );
      setMarpMode(parsed.marpMode);
      setMarpSource(parsed.marpSource);
      setMarpTheme(parsed.marpTheme ?? "default");
      setThemeId(parsed.themeId);
      themeIdRef.current = parsed.themeId;
      setAspectRatio(parsed.aspectRatio);
      aspectRatioRef.current = parsed.aspectRatio;
      setBrandKitId(parsed.brandKitId);
      brandKitIdRef.current = parsed.brandKitId;
      setDraggedSlideId(null);
      setDraggedBlockId(null);
      uploadTokensRef.current.clear();
      openExclusiveMenu(null);
      setTemplatePickerOpen(false);
      // Dismiss the brand builder too. It seeds its draft once from the
      // deck's `themeId`/`brandKitId` at mount (`useState` initialiser), so
      // a hard deck swap would leave it editing a stale draft and a save
      // could re-apply an old kit or a mismatched theme. Reopening reseeds
      // it against the freshly swapped deck.
      setBrandBuilderOpen(false);
      // Close the find panel *and* clear its query (mirroring the panel's
      // own close button). A non-empty query would otherwise survive the
      // swap, re-run `findMatches` against the new deck, and silently jump
      // `activeIndex` to the first match even though the panel is hidden.
      setFindPanelOpen(false);
      setFindQuery("");
      lastSavedRef.current = content;
    }
  }, [content, openExclusiveMenu]);

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

  /**
   * Add a new slide using the given layout. The new slide is inserted
   * at the end of the deck and becomes the active slide; this matches
   * the prior single-button "+ Add Slide" behaviour for users who don't
   * care about layout, while letting power-users pre-populate the
   * block skeleton in one click.
   */
  const addSlide = useCallback(
    (layout: SlideLayout) => {
      setSlides((prev) => {
        const updated = [...prev, buildSlideFromLayout(layout)];
        setActiveIndex(updated.length - 1);
        debouncedSave(updated);
        return updated;
      });
      setLayoutMenuOpen(false);
    },
    [debouncedSave],
  );

  const changeLayout = useCallback(
    (newLayout: SlideLayout) => {
      setSlides((prev) => {
        const updated = [...prev];
        updated[activeIndex] = { ...updated[activeIndex], layout: newLayout };
        debouncedSave(updated);
        return updated;
      });
    },
    [activeIndex, debouncedSave],
  );

  const duplicateSlide = useCallback(
    (index: number) => {
      setSlides((prev) => {
        const { slides: next, insertedAt } = duplicateSlideAt(prev, index);
        // `duplicateSlideAt` returns the input array unchanged + `-1` on an
        // out-of-range index. Bail out of the setState so React doesn't
        // commit an identical reference (which would still trigger
        // child reconciliation if we let the new array escape).
        if (insertedAt < 0) return prev;
        setActiveIndex(insertedAt);
        debouncedSave(next);
        return next;
      });
    },
    [debouncedSave],
  );

  const removeSlide = useCallback(
    (index: number) => {
      setSlides((prev) => {
        if (prev.length <= 1) return prev;
        if (index < 0 || index >= prev.length) return prev;
        // Free upload-race tokens for every block in the slide we're
        // about to drop. The `uploadTokensRef` Map otherwise accumulates
        // dead `${slideId}|${blockId}` entries for the lifetime of the
        // editor. The entries are tiny (a string key + small int) but a
        // long editing session that adds/removes many slides would let
        // the Map grow without bound. We delete based on the OUTGOING
        // slide (read from `prev[index]` not `slides`) so this is safe
        // inside a `setSlides` updater even if React batches multiple
        // removes.
        const removed = prev[index];
        if (removed) {
          discardUploadTokensForSlide(
            uploadTokensRef.current,
            removed.id,
            removed.blocks,
          );
        }
        const updated = prev.filter((_, i) => i !== index);
        // Adjust the active pointer relative to the deletion point so the
        // user stays anchored on roughly the same slide:
        //   • deleting *before* active → all surviving slides shift left
        //     by one, so the active index must decrement to track the
        //     same content.
        //   • deleting *at* active → keep the index but clamp to the new
        //     last slide so we never point past the end (this leaves the
        //     focus on what was the next slide; if we deleted the last
        //     slide, we fall back to the new last slide).
        //   • deleting *after* active → the active slide is untouched and
        //     stays at its original index.
        setActiveIndex((current) => {
          let next: number;
          if (index < current) {
            next = current - 1;
          } else if (index === current) {
            next = Math.min(current, updated.length - 1);
          } else {
            next = current;
          }
          return Math.max(0, Math.min(next, updated.length - 1));
        });
        debouncedSave(updated);
        return updated;
      });
    },
    [debouncedSave],
  );

  const moveSlide = useCallback(
    (from: number, to: number) => {
      setSlides((prev) => {
        const updated = moveSlideHelper(prev, from, to);
        // `moveSlideHelper` is reference-stable on out-of-range / same-
        // position moves, so React skips the re-render entirely when
        // the user drag-drops a slide back onto itself.
        if (updated === prev) return prev;
        // Keep the active pointer anchored to the moved slide so the
        // canvas continues to render what the user just dragged.
        // `setActiveIndex` receives the *new* index because the helper
        // already placed the moved slide at `to` in the next array.
        setActiveIndex(to);
        debouncedSave(updated);
        return updated;
      });
    },
    [debouncedSave],
  );

  // Switch the curated deck theme. We update the ref synchronously
  // (before `debouncedSave`) so the save serialises the just-chosen
  // theme rather than the `themeIdRef` value the effect hasn't flushed
  // yet — the same flush-time-consistency contract `marpStateRef` has.
  const changeTheme = useCallback(
    (nextThemeId: string) => {
      setThemeId(nextThemeId);
      themeIdRef.current = nextThemeId;
      debouncedSave(slides);
    },
    [debouncedSave, slides],
  );

  // Switch the deck-wide aspect ratio. Mirrors `changeTheme`: the ref is
  // updated synchronously before the debounced save so the just-chosen
  // ratio is serialised even though `debouncedSave(slides)` doesn't take
  // a ratio argument.
  const changeAspectRatio = useCallback(
    (next: SlideAspectRatio) => {
      setAspectRatio(next);
      aspectRatioRef.current = next;
      debouncedSave(slides);
    },
    [debouncedSave, slides],
  );

  // Set (or clear) the active slide's per-slide background override.
  // An empty selection clears the override so the slide inherits the
  // theme's default `bgStyle` again. Routed through `updateSlide` so it
  // persists and round-trips like any other per-slide edit.
  const changeSlideBackground = useCallback(
    (value: SlideBgStyle | "") => {
      updateSlide(activeIndex, {
        background: value === "" ? undefined : value,
      });
    },
    [updateSlide, activeIndex],
  );

  // Apply a brand kit to the deck. A kit re-skins a curated base theme,
  // so we also switch the deck to the kit's `baseThemeId` (validated via
  // `resolveThemeId`, which degrades an unknown id to the default) — that
  // way the brand overrides layer over the theme they were authored
  // against. Refs are updated synchronously for the same flush-time
  // consistency `changeTheme` relies on.
  const applyBrandKit = useCallback(
    (kit: BrandKit) => {
      const baseTheme = resolveThemeId(kit.baseThemeId);
      setThemeId(baseTheme);
      themeIdRef.current = baseTheme;
      setBrandKitId(kit.id);
      brandKitIdRef.current = kit.id;
      debouncedSave(slides);
    },
    [debouncedSave, slides],
  );

  // Detach the brand kit, returning the deck to its plain curated theme.
  // The curated `themeId` is intentionally left untouched (the kit only
  // re-skinned it) so removal is a clean, content-preserving toggle.
  const clearBrandKit = useCallback(() => {
    setBrandKitId(undefined);
    brandKitIdRef.current = undefined;
    debouncedSave(slides);
  }, [debouncedSave, slides]);

  // Templates visible in the gallery for the current category +
  // search. Pure + memoised so typing in the search box doesn't
  // re-filter the whole catalogue on unrelated renders.
  const visibleTemplates = useMemo(
    () =>
      filterSlideTemplates(SLIDE_TEMPLATES, templateCategory, templateQuery),
    [templateCategory, templateQuery],
  );

  // Apply a pre-built deck template. Replaces the entire deck with
  // the template's slides and optionally switches to the suggested
  // theme if the template declares one.
  const applyTemplate = useCallback(
    (template: (typeof SLIDE_TEMPLATES)[number]) => {
      const newSlides = buildDeckFromTemplate(template);
      if (newSlides.length === 0) return;
      setSlides(newSlides);
      setActiveIndex(0);
      setMarpMode(false);
      setTemplatePickerOpen(false);
      // Dismiss the brand builder — like the version-restore path, a deck
      // swap invalidates the draft it seeded at mount.
      setBrandBuilderOpen(false);
      // Clear stale drag/upload state — the entire deck is being
      // replaced, so ids from the previous deck are invalid (mirrors
      // the version-restore sync effect at line 391-408).
      setDraggedSlideId(null);
      setDraggedBlockId(null);
      uploadTokensRef.current.clear();
      // Clear the find query too — otherwise a stale query re-runs
      // against the new deck and the jump effect overrides the
      // setActiveIndex(0) above (same hazard as the restore path).
      setFindPanelOpen(false);
      setFindQuery("");
      // Detach any active brand kit. A template is a fresh, self-contained
      // design that declares its own `suggestedTheme`; carrying a kit
      // authored against a different base theme would leave the deck in an
      // inconsistent `themeId !== baseThemeId` state, and a later re-apply
      // from the builder would silently snap the theme back. This mirrors
      // the version-restore sync effect, which resets `brandKitId` from the
      // incoming (brand-less) deck. The ref is cleared synchronously so the
      // save below serialises the detach.
      setBrandKitId(undefined);
      brandKitIdRef.current = undefined;
      if (template.suggestedTheme) {
        setThemeId(template.suggestedTheme);
        themeIdRef.current = template.suggestedTheme;
      }
      debouncedSave(newSlides, {
        enabled: false,
        source: marpSource,
        theme: marpTheme,
      });
    },
    [debouncedSave, marpSource, marpTheme],
  );

  // Insert a single slide from an insert-card preset after the
  // current active slide. Reads `activeIndexRef` (not the closure-
  // captured `activeIndex`) inside the `setSlides` updater so the
  // insertion position reflects the latest committed value even if
  // a queued state update changed it before React re-rendered.
  const insertPreset = useCallback(
    (preset: (typeof INSERT_CARD_PRESETS)[number]) => {
      const newSlide = buildSlideFromPreset(preset);
      setSlides((prev) => {
        const idx = Math.min(activeIndexRef.current + 1, prev.length);
        const next = [...prev.slice(0, idx), newSlide, ...prev.slice(idx)];
        setActiveIndex(idx);
        debouncedSave(next);
        return next;
      });
      setInsertPresetOpen(false);
    },
    [debouncedSave],
  );

  // Replace the entire deck with an AI-generated one. We anchor the
  // active slide to 0 and reveal the canvas at the first slide so the
  // user immediately sees the result. The deck is saved through the
  // normal debounced path so it round-trips like any manual edit.
  const applyGeneratedDeck = useCallback(
    (generated: Slide[]) => {
      if (generated.length === 0) return;
      setSlides(generated);
      setActiveIndex(0);
      setMarpMode(false);
      setDeckGenOpen(false);
      setDeckRestyleOpen(false);
      // Dismiss the brand builder — like the version-restore path, a deck
      // swap invalidates the draft it seeded at mount.
      setBrandBuilderOpen(false);
      // Clear stale drag/upload state — the entire deck is being
      // replaced, matching applyTemplate and the version-restore
      // sync effect.
      setDraggedSlideId(null);
      setDraggedBlockId(null);
      uploadTokensRef.current.clear();
      // See applyTemplate: a surviving find query would re-jump the
      // active slide away from the freshly-anchored slide 0.
      setFindPanelOpen(false);
      setFindQuery("");
      // Detach any active brand kit — a generated deck is a wholesale
      // replacement, so (like applyTemplate and the version-restore path)
      // it starts brand-less rather than inheriting the previous deck's
      // skin. The ref is cleared synchronously so the save serialises it.
      setBrandKitId(undefined);
      brandKitIdRef.current = undefined;
      debouncedSave(generated, {
        enabled: false,
        source: marpSource,
        theme: marpTheme,
      });
    },
    [debouncedSave, marpSource, marpTheme],
  );

  // Pure navigation — change which slide is active without touching
  // the deck order. introduces this as the canonical
  // "navigate by N slides" primitive, shared by:
  //
  //   * the toolbar Prev / Next buttons,
  //   * the `Ctrl+PageUp` / `Ctrl+PageDown` global keyboard shortcuts,
  //   * the sidebar Arrow-Up / Arrow-Down handler.
  //
  // Uses the functional `setActiveIndex` form so the closure doesn't
  // capture a stale `activeIndex` — `current` is always the freshest
  // committed value at update-time.
  //
  // `slides.length` IS captured from the closure at callback-creation
  // time (not dynamically re-read on each invocation), but listing it
  // in `useCallback`'s dep array means React re-creates `navigateBy`
  // on every length change. Combined with the inline
  // `navigateByRef.current = navigateBy` re-binding (line below), the
  // document-level keydown listener always invokes a navigateBy whose
  // captured length matches the latest committed render — so a key
  // press fired after the deck shrinks still clamps against the new,
  // smaller length, not a stale pre-shrink value.
  //
  // Clamping (rather than wrapping or no-oping past the edge) matches
  // LibreOffice Impress and Google Slides behaviour: holding the key
  // at the last slide is a no-op, not a wrap-to-first.
  const navigateBy = useCallback(
    (delta: number) => {
      setActiveIndex((current) => {
        if (slides.length === 0) return current;
        const next = current + delta;
        return Math.max(0, Math.min(slides.length - 1, next));
      });
    },
    [slides.length],
  );
  // Keep `navigateByRef` pointed at the latest `navigateBy` closure
  // so the global Ctrl+PageUp/Down listener (attached once at mount)
  // always invokes the current implementation. `navigateBy` itself
  // changes identity whenever `slides.length` does — without the ref
  // dance, we'd be detaching and re-attaching a document-level
  // keydown listener on every deck-size change.
  navigateByRef.current = navigateBy;

  // Same primitive as `navigateBy` but for absolute targets (Home,
  // End, sidebar click). The thumb buttons themselves still wire
  // `onClick={() => setActiveIndex(i)}` directly because they pass a
  // known-valid index from the render `slides.map(...)`; this helper
  // is the public form that can be called with anything (e.g.
  // `goToSlide(slides.length - 1)` for End, which would be a stale
  // value if the deck shrank between keydown and the setState fire).
  const goToSlide = useCallback(
    (target: number) => {
      setActiveIndex(() => {
        if (slides.length === 0) return 0;
        return Math.max(0, Math.min(slides.length - 1, target));
      });
    },
    [slides.length],
  );

  // Launch presenter mode: hand the main process a flattened, plain-
  // text snapshot of the deck (see `buildPresentationSlides`) plus the
  // current slide as the entry point. Main opens a fullscreen audience
  // window and a second presenter window (speaker notes + next-slide
  // preview); the two stay in sync without further IPC. No-op on an
  // empty deck. `window.tessera` is always present in the packaged app
  // but may be absent in non-Electron contexts, so we guard defensively.
  const startPresentation = useCallback(() => {
    if (slides.length === 0) return;
    const trimmedTitle = deckTitle?.trim();
    void window.tessera?.slides?.startPresentation({
      slides: buildPresentationSlides(slides),
      startIndex: activeIndex,
      // Only forward a real title; the main process defaults to
      // "Presentation" when it's absent.
      ...(trimmedTitle ? { deckTitle: trimmedTitle } : {}),
    });
  }, [slides, activeIndex, deckTitle]);

  // Refs to each `.slide-thumb` <button>, keyed by `slide.id`. Used by
  // the sidebar arrow-key handler to programmatically focus the newly
  // active thumb so the focus ring follows the user's selection.
  //
  // Keying by `slide.id` (not array index) is important: when a
  // reorder happens, the thumb's index changes but its id (and DOM
  // element identity, because the React key is also `slide.id`) is
  // stable. The handler can therefore look up "the thumb the active
  // slide *is now*" without caring about reorder.
  //
  // We delete from the map on unmount (the ref callback receives
  // `null` when React detaches the element) so removed slides don't
  // leave dangling DOM references after the slide is deleted from
  // the deck.
  const thumbRefs = useRef<Map<string, HTMLButtonElement | null>>(new Map());

  // Per-id ref-callback cache. React's ref protocol detaches and
  // re-attaches the DOM node whenever the ref-callback's identity
  // changes between renders, so handing each thumb a fresh closure
  // on every render (the obvious `(id) => (node) => ...` shape)
  // means every commit fires N detach + N attach calls for an
  // N-slide deck. With this cache, `setThumbRef(slide.id)` returns
  // the SAME closure across renders for the same id, so React sees
  // a stable ref and skips the churn entirely.
  //
  // The cache entry is deleted alongside the `thumbRefs` entry
  // when React calls the ref with `null` on unmount, so removing
  // a slide reclaims both the DOM-pointer entry AND the closure
  // entry. Re-mounting a previously-seen id (rare — only happens
  // if a deleted slide is re-added via undo) mints a fresh
  // closure on the next `setThumbRef(id)` call.
  const thumbRefCallbacksRef = useRef<
    Map<string, (node: HTMLButtonElement | null) => void>
  >(new Map());
  const setThumbRef = useCallback((id: string) => {
    const cache = thumbRefCallbacksRef.current;
    let cb = cache.get(id);
    if (!cb) {
      cb = (node: HTMLButtonElement | null) => {
        if (node) {
          thumbRefs.current.set(id, node);
        } else {
          thumbRefs.current.delete(id);
          thumbRefCallbacksRef.current.delete(id);
        }
      };
      cache.set(id, cb);
    }
    return cb;
  }, []);

  // Arrow-key navigation handler attached to each thumb's <button>.
  // Mirrors the standard listbox-pattern keyboard contract:
  //
  //   ArrowUp   → navigate to previous slide
  //   ArrowDown → navigate to next slide
  //   Home      → jump to first slide
  //   End       → jump to last slide
  //
  // this is the third entry point into the shared
  // `navigateBy` / `goToSlide` navigation primitives, alongside the
  // toolbar Prev/Next buttons and the global Ctrl+PageUp/Dn
  // shortcut. Matches the WAI-ARIA "listbox" authoring practice for
  // a vertically-oriented set of options.
  //
  // After updating the active index we programmatically focus the
  // target thumb so the focus ring follows the selection. The
  // target thumb is already mounted (only the `active` class
  // changes between renders, not the element identity), so the
  // focus call works synchronously without waiting for React to
  // re-render.
  const handleThumbKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLButtonElement>, slideIndex: number) => {
      let targetIndex: number | null = null;
      if (event.key === "ArrowUp") {
        targetIndex = Math.max(0, slideIndex - 1);
      } else if (event.key === "ArrowDown") {
        targetIndex = Math.min(slides.length - 1, slideIndex + 1);
      } else if (event.key === "Home") {
        targetIndex = 0;
      } else if (event.key === "End") {
        targetIndex = slides.length - 1;
      } else {
        return;
      }
      // Always preventDefault on the keys we handle, even on edge no-ops
      // (e.g. ArrowUp at index 0). Otherwise the browser would scroll
      // the sidebar container in response to the arrow key, which
      // produces a confusing "the keypress did SOMETHING but not what
      // I expected" feel.
      event.preventDefault();
      if (targetIndex === slideIndex) return;
      goToSlide(targetIndex);
      const target = slides[targetIndex];
      if (target) {
        const node = thumbRefs.current.get(target.id);
        node?.focus();
      }
    },
    [goToSlide, slides],
  );

  // ───── Block-level mutators (delegate to helpers) ─────────────────
  //
  // Each one is a one-liner over the corresponding helper from
  // `slideEditorHelpers.ts`. The helpers return reference-stable
  // results on no-op inputs (out-of-range indices, identical from/to,
  // …) so we don't need to special-case those here — React's setState
  // does the identity check itself.

  const onBlockMove = useCallback(
    (slideIndex: number, from: number, to: number) => {
      setSlides((prev) => {
        const slide = prev[slideIndex];
        if (!slide) return prev;
        const updatedSlide = moveBlock(slide, from, to);
        if (updatedSlide === slide) return prev;
        const next = [...prev];
        next[slideIndex] = updatedSlide;
        debouncedSave(next);
        return next;
      });
    },
    [debouncedSave],
  );

  const onBlockRemove = useCallback(
    (slideIndex: number, blockIndex: number) => {
      setSlides((prev) => {
        const slide = prev[slideIndex];
        if (!slide) return prev;
        const updatedSlide = removeBlockHelper(slide, blockIndex);
        if (updatedSlide === slide) return prev;
        // Free the upload-race token for the dropped block so the Map
        // doesn't accumulate dead entries. Read the block off
        // `prev[slideIndex]` (the freshest state inside the updater)
        // rather than the outer `slides` closure so a concurrent
        // remove doesn't free the wrong key. `removeBlockHelper`
        // returns the SAME slide ref on out-of-range indices — we
        // already early-return above in that case, so reaching this
        // point guarantees the helper finds the outgoing block to
        // discard.
        discardUploadTokensForBlock(uploadTokensRef.current, slide, blockIndex);
        const next = [...prev];
        next[slideIndex] = updatedSlide;
        debouncedSave(next);
        return next;
      });
    },
    [debouncedSave],
  );

  const onBlockAppend = useCallback(
    (slideIndex: number, block: SlideBlock) => {
      setSlides((prev) => {
        const slide = prev[slideIndex];
        if (!slide) return prev;
        const updatedSlide = appendBlock(slide, block);
        const next = [...prev];
        next[slideIndex] = updatedSlide;
        debouncedSave(next);
        return next;
      });
    },
    [debouncedSave],
  );

  // Replace the active slide's primary text/bullets block with AI-
  // rewritten bullets, preserving image/diagram blocks (see
  // `applyBulletsToSlide`). Goes through the same `setSlides` +
  // `debouncedSave` path as a manual edit so it round-trips and
  // undo-friendly state stays consistent.
  const applySlideBullets = useCallback(
    (slideIndex: number, bullets: string[]) => {
      setSlides((prev) => {
        const slide = prev[slideIndex];
        if (!slide) return prev;
        const updatedSlide = applyBulletsToSlide(slide, bullets);
        if (updatedSlide === slide) return prev;
        const next = [...prev];
        next[slideIndex] = updatedSlide;
        debouncedSave(next);
        return next;
      });
    },
    [debouncedSave],
  );

  // Replace the active slide's title + primary bullets with an AI-
  // regenerated version, preserving the slide's layout, notes, images
  // and diagrams (see `applyRegeneratedSlide`). Same `setSlides` +
  // `debouncedSave` path as a manual edit.
  const regenerateSlide = useCallback(
    (slideIndex: number, regen: RegeneratedSlide) => {
      setSlides((prev) => {
        const slide = prev[slideIndex];
        if (!slide) return prev;
        const updatedSlide = applyRegeneratedSlide(slide, regen);
        if (updatedSlide === slide) return prev;
        const next = [...prev];
        next[slideIndex] = updatedSlide;
        debouncedSave(next);
        return next;
      });
    },
    [debouncedSave],
  );

  const onBlockReplace = useCallback(
    (slideIndex: number, blockIndex: number, block: SlideBlock) => {
      setSlides((prev) => {
        const slide = prev[slideIndex];
        if (!slide) return prev;
        const updatedSlide = replaceBlock(slide, blockIndex, block);
        if (updatedSlide === slide) return prev;
        const next = [...prev];
        next[slideIndex] = updatedSlide;
        debouncedSave(next);
        return next;
      });
    },
    [debouncedSave],
  );

  // ───── Find panel ─────────────────────────────────────────────────
  //
  // Recompute matches every time the query / case-sensitivity / slide
  // data changes. The match list is memoised so re-renders that don't
  // touch any of the four inputs (e.g. block-content edits on a
  // different slide than the active match) don't trigger a re-walk.

  const findMatches = useMemo<SlideFindMatch[]>(
    () => findInSlides(slides, findQuery, { caseSensitive: findCaseSensitive }),
    [slides, findQuery, findCaseSensitive],
  );

  // Clamp the active match index against the live match count so the
  // status line never shows "5 of 3". We do this inline (rather than in
  // an effect) so the render synchronously sees the clamped value —
  // following the same pattern PR 6 used for the slash-menu highlight.
  const effectiveFindIndex =
    findMatches.length === 0
      ? 0
      : Math.max(0, Math.min(findActiveIndex, findMatches.length - 1));

  // Sync the React state when the inline clamp produced a different
  // value. We only write when the values actually differ to avoid a
  // setState loop.
  useEffect(() => {
    if (effectiveFindIndex !== findActiveIndex) {
      setFindActiveIndex(effectiveFindIndex);
    }
  }, [effectiveFindIndex, findActiveIndex]);

  // Jump the active-slide pointer to whichever slide the active match
  // lives on so the user sees the matched content immediately.
  useEffect(() => {
    if (findMatches.length === 0) return;
    const match = findMatches[effectiveFindIndex];
    if (match && match.slideIndex !== activeIndex) {
      setActiveIndex(match.slideIndex);
    }
    // We deliberately omit `activeIndex` from the deps so we don't
    // re-jump when the user manually clicks a different thumbnail
    // while the find panel is open — only an explicit Next / Prev
    // (which changes `effectiveFindIndex`) should reseat the view.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [effectiveFindIndex, findMatches]);

  const navigateFind = useCallback(
    (direction: "next" | "previous") => {
      if (findMatches.length === 0) return;
      setFindActiveIndex((prev) => {
        const len = findMatches.length;
        if (direction === "next") return (prev + 1) % len;
        return (prev - 1 + len) % len;
      });
    },
    [findMatches.length],
  );

  // ───── Image-block upload ─────────────────────────────────────────
  //
  // `fileToDataUrl` returns a promise; on resolution we replace the
  // block in-place with the data URL. On rejection (the FileReader
  // failing — extremely rare for browser uploads but possible for a
  // race-condition during a tab close) we log to the console rather
  // than surfacing an error to the user, because the block is still
  // in a valid empty state.
  //
  // Concurrent-upload race: the user can pick file A, then immediately
  // pick file B before A's FileReader completes. Without coordination,
  // whichever read finishes LAST wins — regardless of which was picked
  // last (FileReader resolution order is not deterministic across
  // sizes; a large A picked first then a small B could resolve in B-A
  // order, but the opposite is also possible). We solve this with a
  // per-block sequence counter: every upload bumps the counter for
  // its (slideId, blockId) key and captures the post-bump value
  // as its token. After awaiting, the resolver checks whether the
  // counter has advanced past its token — if so, a newer upload has
  // started, and the stale result is discarded silently.
  //
  // The key uses `slide.id` AND `block.id` (both stable across drag-
  // reorders) rather than positional indices, because PR 8 introduces
  // drag-and-drop reorder at BOTH the slide and block levels. If the
  // user picks a file then drags either the containing slide or the
  // block to a new position before the FileReader resolves, an
  // index-based key would (a) misroute the result onto whichever
  // slide/block now occupies the old index — silent corruption —
  // and (b) silently lose the upload if no image block sits at that
  // (slideIndex, blockIndex) coordinate anymore. Keying off the
  // stable IDs makes the upload follow the target block through any
  // reorder, and the `findIndex` lookups inside the setSlides updater
  // resolve the live positions against React's latest state.
  const uploadTokensRef = useRef<Map<string, number>>(new Map());

  const onImageUpload = useCallback(
    async (slideId: string, blockId: string, file: File) => {
      const tokenKey = uploadTokenKey(slideId, blockId);
      const nextToken = (uploadTokensRef.current.get(tokenKey) ?? 0) + 1;
      uploadTokensRef.current.set(tokenKey, nextToken);
      try {
        const dataUrl = await fileToDataUrl(file);
        // Race guard: if another upload to the same block has started
        // after this one began, drop the stale result so the newer
        // upload's URL is the one that lands in the block.
        if (uploadTokensRef.current.get(tokenKey) !== nextToken) return;
        setSlides((prev) => {
          // Resolve slide-then-block by id against the freshest state
          // React hands us, so a drag-reorder at either level between
          // dragstart and FileReader resolution still routes the data
          // URL onto the originally targeted block. If either entity
          // no longer exists (user removed the slide / block mid-
          // upload), bail out cleanly.
          const slideIndex = prev.findIndex((s) => s.id === slideId);
          if (slideIndex < 0) return prev;
          const slide = prev[slideIndex];
          const blockIndex = slide.blocks.findIndex((b) => b.id === blockId);
          if (blockIndex < 0) return prev;
          const block = slide.blocks[blockIndex];
          if (block.type !== "image") return prev;
          const updatedSlide = replaceBlock(slide, blockIndex, {
            id: block.id,
            type: "image",
            content: dataUrl,
            alt: block.alt ?? "",
          });
          if (updatedSlide === slide) return prev;
          const next = [...prev];
          next[slideIndex] = updatedSlide;
          debouncedSave(next);
          return next;
        });
      } catch (err) {
        // Surface the failure in the dev console; the block stays in
        // its previous (probably empty) state so the user can retry.
        // Only log if this is still the latest upload for the block
        // — a stale rejection is just noise.
        if (uploadTokensRef.current.get(tokenKey) === nextToken) {
          console.warn("Failed to read image file:", err);
        }
      }
    },
    [debouncedSave],
  );

  const activeSlide = slides[activeIndex];
  // Per-slide word-count cache, sized to the deck.
  //
  // perf: the toolbar reads `<active> / <total>` on every
  // render. A single keystroke on a 50-slide deck used to walk every
  // slide twice — once inline for `activeWordCount`, once via the
  // `useMemo` on `deckWordCount(slides)` — because the immutable
  // update yields a new `slides` reference even when only the active
  // slide actually changed.
  //
  // `wordCountCacheRef` survives the component lifetime in a `WeakMap`
  // (no manual cleanup; abandoned Slide objects garbage-collect
  // normally because the cache only weakly references them). Every
  // slide whose object identity didn't change between renders hits the
  // cache in O(1), so a one-slide edit costs `O(W_active_slide)`
  // instead of `O(N * W)`.
  //
  // The cache pattern mirrors `BaseEditor`'s `resolveLinkedRecords`
  // map (PR #84) and the `SheetEditor` incremental-recalc cache
  // (PR #83) — the third perf win, this time for the slide
  // surface.
  const wordCountCacheRef = useRef<WeakMap<Slide, number>>(new WeakMap());
  const wordCounts = useMemo(
    () => computeDeckWordCounts(slides, wordCountCacheRef.current),
    [slides],
  );
  const activeWordCount = wordCounts.perSlide[activeIndex] ?? 0;
  const totalWordCount = wordCounts.total;

  return (
    <div className="slide-editor">
      <div className="slide-editor-sidebar">
        <div className="slide-thumbnails">
          {slides.map((slide, i) => (
            <div
              // Stable key driven off `slide.id` (not `i`). Indices
              // would force React to destroy + remount the entire row
              // tree on every reorder, defeating the no-op-stable
              // contract of `moveSlide` and tearing down the layout
              // menu / aria-live state inside it.
              key={slide.id}
              className={`slide-thumb-row ${
                draggedSlideId === slide.id ? "is-dragging" : ""
              }`}
              draggable
              onDragStart={(event) => {
                setDraggedSlideId(slide.id);
                // Setting dataTransfer keeps the drag-image alive in
                // Chromium-based renderers — without `setData` the
                // browser cancels the drag immediately.
                event.dataTransfer.effectAllowed = "move";
                event.dataTransfer.setData("text/plain", slide.id);
              }}
              onDragOver={(event) => {
                // Default browser behaviour is "this drop target
                // doesn't accept anything"; we must preventDefault to
                // declare the row as a valid drop target so the
                // browser fires `onDrop` instead of swallowing the
                // release.
                if (draggedSlideId && draggedSlideId !== slide.id) {
                  event.preventDefault();
                  event.dataTransfer.dropEffect = "move";
                }
              }}
              onDrop={(event) => {
                if (!draggedSlideId || draggedSlideId === slide.id) {
                  // No active drag, or self-drop — nothing to do.
                  // The `onDragEnd` handler still fires and clears
                  // `draggedSlideId`, so leave it alone here.
                  return;
                }
                event.preventDefault();
                const fromIdx = slides.findIndex(
                  (s) => s.id === draggedSlideId,
                );
                // `setDraggedSlideId(null)` runs on every termination
                // path (success AND lookup-miss) so the `is-dragging`
                // visual cue can't stick if a concurrent edit shifts
                // the source out of the array before drop fires. The
                // `onDragEnd` handler is a defence in depth, but
                // dragend doesn't always fire reliably in Chromium's
                // touch-emulation path — clearing here guarantees the
                // class is removed at the exact moment the user
                // released the pointer.
                if (fromIdx < 0) {
                  setDraggedSlideId(null);
                  return;
                }
                moveSlide(fromIdx, i);
                setDraggedSlideId(null);
              }}
              onDragEnd={() => setDraggedSlideId(null)}
            >
              {/*
               * `draggable={false}` on every interactive child of the
               * `draggable` row mirrors the defensive pattern in
               * `SlideBlockRow` (textarea / input). Native HTML5 drag
               * inheritance means a `draggable` parent would otherwise
               * make these buttons drag-able too. In Chromium-on-
               * desktop the browser disambiguates click vs. drag on
               * `<button>` correctly, but accessibility tools that
               * simulate mouse events (and touch-emulation in Chrome
               * DevTools) can interpret a tap-with-millimetre-jitter
               * as a drag-start. Opting these children out forces the
               * row-level drag to only fire from non-button regions
               * (the empty padding / numbered chip), which is the
               * intended interaction.
               */}
              <button
                ref={setThumbRef(slide.id)}
                type="button"
                className={`slide-thumb ${i === activeIndex ? "active" : ""}`}
                draggable={false}
                // `aria-current="true"` is the WAI-ARIA standard for a
                // "the currently selected item in a non-page set"
                // signal. Pairs with the visual `active` class so
                // assistive tech announces the active slide alongside
                // sighted users' visual highlight.
                aria-current={i === activeIndex ? "true" : undefined}
                onClick={() => setActiveIndex(i)}
                onKeyDown={(event) => handleThumbKeyDown(event, i)}
              >
                <span className="slide-thumb-number">{i + 1}</span>
                <span className="slide-thumb-title">
                  {slide.title || "Untitled"}
                </span>
              </button>
              <div className="slide-thumb-actions">
                <button
                  type="button"
                  className="btn-xs"
                  draggable={false}
                  onClick={() => duplicateSlide(i)}
                  aria-label={`Duplicate slide ${i + 1}`}
                  title="Duplicate slide"
                >
                  ⎘
                </button>
                <button
                  type="button"
                  className="btn-xs danger"
                  draggable={false}
                  onClick={() => removeSlide(i)}
                  disabled={slides.length <= 1}
                  aria-label={`Delete slide ${i + 1}`}
                  title="Delete slide"
                >
                  ×
                </button>
              </div>
            </div>
          ))}
        </div>
        <div className="slide-sidebar-actions">
          <button
            ref={layoutButtonRef}
            type="button"
            className="btn-sm"
            onClick={() => openExclusiveMenu(layoutMenuOpen ? null : "layout")}
            aria-haspopup="menu"
            aria-expanded={layoutMenuOpen}
          >
            + Add Slide
          </button>
          {layoutMenuOpen && (
            <div ref={layoutMenuRef} className="slide-layout-menu" role="menu">
              {LAYOUT_ORDER.map((layout) => (
                <button
                  key={layout}
                  type="button"
                  role="menuitem"
                  className="slide-layout-menu-item"
                  onClick={() => addSlide(layout)}
                >
                  <span className="slide-layout-menu-item-icon">
                    <SlideMenuIcon
                      iconName={LAYOUT_META[layout].iconName}
                      glyph={LAYOUT_META[layout].glyph}
                    />
                  </span>
                  {LAYOUT_LABELS[layout]}
                </button>
              ))}
            </div>
          )}
        </div>
      </div>

      <div className="slide-editor-main">
        <div className="slide-editor-toolbar">
          {/*
           * the toolbar has TWO distinct pairs of
           * arrow buttons that used to be conflated:
           *
           *   1. Navigation (Prev / Next) — change which slide is
           *      active without touching deck order. Mirror of
           *      `Ctrl+PageUp` / `Ctrl+PageDown` (global) and the
           *      sidebar's `Arrow ↑` / `Arrow ↓` handler.
           *
           *   2. Reorder (Move ↑ / Move ↓) — shift the active slide
           *      one position earlier / later in the deck. Mirror of
           *      drag-and-drop reorder introduced in PR 82.
           *
           * Before this PR the toolbar had only the reorder pair but
           * labelled them "Prev / Next", which collides with the
           * standard slide-deck navigation convention (Impress /
           * Slides / Keynote all use Prev / Next to mean "navigate").
           * Both pairs now ship side-by-side with unambiguous labels
           * and aria-labels.
           */}
          <button
            type="button"
            className="btn-sm"
            onClick={() => navigateBy(-1)}
            disabled={activeIndex === 0}
            aria-label="Previous slide"
            title="Previous slide (Ctrl+PageUp)"
          >
            ← Prev
          </button>
          <span>
            Slide {activeIndex + 1} / {slides.length}
          </span>
          <button
            type="button"
            className="btn-sm"
            onClick={() => navigateBy(1)}
            disabled={activeIndex === slides.length - 1}
            aria-label="Next slide"
            title="Next slide (Ctrl+PageDown)"
          >
            Next →
          </button>
          <button
            type="button"
            className="btn-sm"
            onClick={() => moveSlide(activeIndex, activeIndex - 1)}
            disabled={activeIndex === 0}
            aria-label="Move slide up"
            title="Move this slide one position earlier"
          >
            ↑ Move
          </button>
          <button
            type="button"
            className="btn-sm"
            onClick={() => moveSlide(activeIndex, activeIndex + 1)}
            disabled={activeIndex === slides.length - 1}
            aria-label="Move slide down"
            title="Move this slide one position later"
          >
            ↓ Move
          </button>
          <span
            className="slide-word-count"
            title="Words on this slide / total in deck"
          >
            Words: {activeWordCount} / {totalWordCount}
          </span>
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
            className="btn-sm"
            onClick={startPresentation}
            disabled={slides.length === 0}
            aria-label="Start presentation"
            title="Present fullscreen with speaker notes in a second window"
          >
            Present
          </button>
          <button
            type="button"
            className={`btn-sm ${showNotes ? "active" : ""}`}
            onClick={() => setShowNotes(!showNotes)}
          >
            Notes
          </button>
          <button
            type="button"
            className={`btn-sm ${findPanelOpen ? "active" : ""}`}
            onClick={() => setFindPanelOpen((open) => !open)}
            aria-label="Find in slides"
            title="Find in slides (Cmd/Ctrl+F)"
          >
            Find
          </button>
          <button
            type="button"
            className={`btn-sm ${marpMode ? "active" : ""}`}
            onClick={() => {
              setMarpMode((prev) => {
                const next = !prev;
                debouncedSave(slides, {
                  enabled: next,
                  source: marpSource,
                  theme: marpTheme,
                });
                return next;
              });
            }}
            title="Toggle Marp Mode (raw Marp Markdown with live HTML preview)"
          >
            Marp Mode
          </button>
          {!marpMode && (
            <button
              type="button"
              className={`btn-sm ${designView ? "active" : ""}`}
              onClick={() => setDesignView((prev) => !prev)}
              aria-pressed={designView}
              title="Toggle Design view (edit directly on the themed slide)"
            >
              {designView ? "Outline" : "Design"}
            </button>
          )}
          <button
            type="button"
            className={`btn-sm ${deckGenOpen ? "active" : ""}`}
            onClick={() => openExclusiveMenu(deckGenOpen ? null : "deck")}
            aria-label="Generate a deck with AI"
            aria-expanded={deckGenOpen}
            title="Generate a deck from a prompt using the on-device model"
          >
            ✨ AI Deck
          </button>
          <button
            type="button"
            className={`btn-sm ${deckRestyleOpen ? "active" : ""}`}
            onClick={() =>
              openExclusiveMenu(deckRestyleOpen ? null : "restyle")
            }
            aria-label="Restyle the deck with AI"
            aria-expanded={deckRestyleOpen}
            title="Restyle the current deck with the on-device model"
          >
            Restyle
          </button>
          {!marpMode && (
            <label className="slide-layout-picker">
              Layout
              <select
                className="slide-layout-select"
                value={
                  activeSlide ? resolveSlideLayout(activeSlide) : "titleContent"
                }
                onChange={(e) => changeLayout(e.target.value as SlideLayout)}
                aria-label="Slide layout"
                title="Layout region arrangement for this slide"
              >
                {SLIDE_LAYOUTS.map((l) => (
                  <option key={l.id} value={l.id}>
                    {l.label}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!marpMode && (
            <label className="slide-layout-picker">
              Ratio
              <select
                className="slide-layout-select"
                value={aspectRatio}
                onChange={(e) =>
                  changeAspectRatio(e.target.value as SlideAspectRatio)
                }
                aria-label="Deck aspect ratio"
                title="Aspect ratio for the whole deck (16:9, 4:3, or square 1:1)"
              >
                <option value="16:9">16:9</option>
                <option value="4:3">4:3</option>
                <option value="1:1">1:1</option>
              </select>
            </label>
          )}
          {!marpMode && activeSlide && (
            <label className="slide-layout-picker">
              Background
              <select
                className="slide-layout-select"
                value={activeSlide.background ?? ""}
                onChange={(e) =>
                  changeSlideBackground(e.target.value as SlideBgStyle | "")
                }
                aria-label="Slide background style"
                title="Background for this slide (overrides the theme default)"
              >
                <option value="">Theme default</option>
                {SLIDE_BG_STYLES.map((style) => (
                  <option key={style} value={style}>
                    {style.charAt(0).toUpperCase() + style.slice(1)}
                  </option>
                ))}
              </select>
            </label>
          )}
          {!marpMode && (
            <div className="slide-theme-picker-wrap">
              <button
                ref={themePickerTriggerRef}
                type="button"
                className="slide-theme-picker-trigger"
                onClick={() =>
                  openExclusiveMenu(themePickerOpen ? null : "theme")
                }
                aria-haspopup="listbox"
                aria-expanded={themePickerOpen}
                aria-label="Deck theme"
                title="Curated deck theme (typography + colour)"
              >
                <span
                  className="slide-theme-swatch"
                  style={{
                    background:
                      getSlideTheme(themeId).swatch ?? "var(--color-primary)",
                  }}
                />
                {getSlideTheme(themeId).label}
              </button>
              {themePickerOpen && (
                <div
                  ref={themePickerRef}
                  className="slide-theme-picker-dropdown"
                  role="listbox"
                  aria-label="Choose theme"
                >
                  {SLIDE_THEMES.map((theme) => (
                    <button
                      key={theme.id}
                      type="button"
                      role="option"
                      className="slide-theme-card"
                      aria-selected={theme.id === themeId}
                      onClick={() => {
                        changeTheme(theme.id);
                        setThemePickerOpen(false);
                      }}
                    >
                      <span
                        className="slide-theme-card-swatch"
                        style={{
                          background: theme.swatch ?? "var(--color-primary)",
                        }}
                      />
                      <span>
                        <span className="slide-theme-card-label">
                          {theme.label}
                        </span>
                        <br />
                        <span className="slide-theme-card-desc">
                          {theme.description}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {!marpMode && (
            <button
              type="button"
              className="slide-brand-trigger"
              onClick={() => {
                // Close any open toolbar popover first, mirroring how the
                // template picker opens (`openExclusiveMenu(null)` before
                // `setTemplatePickerOpen(true)`), so a popover can't linger
                // behind the modal.
                openExclusiveMenu(null);
                setBrandBuilderOpen(true);
              }}
              aria-haspopup="dialog"
              aria-expanded={brandBuilderOpen}
              title="Copy a theme and re-skin it with your brand colours, fonts and logo"
              data-testid="slide-brand-trigger"
            >
              {activeBrandKit ? (
                <>
                  <span
                    className="slide-brand-swatch"
                    style={{ background: activeBrandKit.colors.accent }}
                  />
                  {activeBrandKit.name}
                </>
              ) : (
                "Customize brand"
              )}
            </button>
          )}
          {!marpMode && (
            <div style={{ position: "relative", display: "inline-flex" }}>
              <button
                ref={insertPresetTriggerRef}
                type="button"
                className="btn-sm"
                onClick={() =>
                  openExclusiveMenu(insertPresetOpen ? null : "insert")
                }
                aria-haspopup="menu"
                aria-expanded={insertPresetOpen}
                title="Quick-insert a pre-built slide card"
              >
                + Insert
              </button>
              {insertPresetOpen && (
                <div
                  ref={insertPresetRef}
                  className="slide-insert-presets"
                  role="menu"
                >
                  {INSERT_CARD_PRESETS.map((preset) => (
                    <button
                      key={preset.id}
                      type="button"
                      role="menuitem"
                      className="slide-insert-preset-item"
                      onClick={() => insertPreset(preset)}
                    >
                      <span className="slide-insert-preset-icon">
                        <SlideMenuIcon
                          iconName={preset.iconName}
                          glyph={preset.icon}
                          size={18}
                        />
                      </span>
                      <span>
                        <span className="slide-insert-preset-label">
                          {preset.label}
                        </span>
                        <br />
                        <span className="slide-insert-preset-desc">
                          {preset.description}
                        </span>
                      </span>
                    </button>
                  ))}
                </div>
              )}
            </div>
          )}
          {!marpMode && (
            <button
              type="button"
              className="btn-sm"
              onClick={() => {
                openExclusiveMenu(null);
                setTemplatePickerOpen(true);
              }}
              title="Start from a pre-built deck template"
            >
              Templates
            </button>
          )}
        </div>

        {findPanelOpen && (
          <div className="slide-find-panel" role="search">
            <input
              type="text"
              className="slide-find-input"
              value={findQuery}
              onChange={(e) => {
                setFindQuery(e.target.value);
                // Reset to the first match when the query changes so
                // the user lands on the first hit rather than at a
                // stale index that may now overshoot the new match
                // count (the clamp would correct it, but starting from
                // 0 matches typical find-bar UX).
                setFindActiveIndex(0);
              }}
              placeholder="Find in slides..."
              aria-label="Find query"
              autoFocus
            />
            <label className="slide-find-toggle">
              <input
                type="checkbox"
                checked={findCaseSensitive}
                onChange={(e) => setFindCaseSensitive(e.target.checked)}
              />
              Case
            </label>
            <span className="slide-find-status">
              {findMatches.length === 0
                ? findQuery
                  ? "No matches"
                  : "Type to search"
                : `${effectiveFindIndex + 1} of ${findMatches.length}`}
            </span>
            <button
              type="button"
              className="btn-sm"
              onClick={() => navigateFind("previous")}
              disabled={findMatches.length === 0}
              aria-label="Previous match"
            >
              ‹
            </button>
            <button
              type="button"
              className="btn-sm"
              onClick={() => navigateFind("next")}
              disabled={findMatches.length === 0}
              aria-label="Next match"
            >
              ›
            </button>
            <button
              type="button"
              className="btn-sm"
              onClick={() => {
                setFindPanelOpen(false);
                setFindQuery("");
              }}
              aria-label="Close find panel"
            >
              ×
            </button>
          </div>
        )}

        <SlideDeckGenerator
          open={deckGenOpen}
          onClose={() => setDeckGenOpen(false)}
          onApply={applyGeneratedDeck}
        />

        <SlideDeckRestyler
          open={deckRestyleOpen}
          onClose={() => setDeckRestyleOpen(false)}
          slides={slides}
          onApply={applyGeneratedDeck}
        />

        {marpMode && (
          <div className="marp-mode">
            <div className="marp-mode-toolbar">
              <label className="marp-mode-label">
                Theme
                <select
                  value={marpTheme ?? "default"}
                  onChange={(e) => {
                    const newTheme = e.target.value;
                    setMarpTheme(newTheme);
                    // Also rewrite the frontmatter in the raw source so the
                    // dropdown and source never desynchronize.
                    const updatedSource = setFrontmatterTheme(
                      marpSource,
                      newTheme,
                    );
                    setMarpSource(updatedSource);
                    debouncedSave(slides, {
                      enabled: marpMode,
                      source: updatedSource,
                      theme: newTheme,
                    });
                  }}
                >
                  <option value="default">default</option>
                  <option value="gaia">gaia</option>
                  <option value="uncover">uncover</option>
                </select>
              </label>
              <span className="marp-mode-hint">
                Use <code>---</code> to separate slides;{" "}
                <code>&lt;!-- notes --&gt;</code> for speaker notes.
              </span>
            </div>
            <div className="marp-mode-split">
              <textarea
                className="marp-mode-source"
                value={marpSource}
                onChange={(e) => {
                  const newSource = e.target.value;
                  setMarpSource(newSource);
                  // Sync theme from frontmatter → dropdown if the user
                  // manually edited the `theme:` directive.
                  const fmTheme = extractFrontmatterTheme(newSource);
                  const effectiveTheme = fmTheme ?? marpTheme;
                  if (fmTheme && fmTheme !== marpTheme) {
                    setMarpTheme(fmTheme);
                  }
                  debouncedSave(slides, {
                    enabled: marpMode,
                    source: newSource,
                    theme: effectiveTheme,
                  });
                }}
                placeholder="---&#10;marp: true&#10;theme: default&#10;---&#10;&#10;# Slide 1"
                rows={20}
                spellCheck={false}
              />
              <MarpPreview
                markdown={marpSource}
                theme={marpTheme ?? "default"}
              />
            </div>
          </div>
        )}

        {!marpMode && activeSlide && (
          <div
            className={`slide-canvas${designView ? " slide-canvas-design" : ""}`}
            data-slide-theme={themeId}
            data-slide-layout={resolveSlideLayout(activeSlide)}
            // Background precedence: an explicit per-slide override (the
            // most specific user choice) wins, then a brand kit's bgStyle,
            // then the curated theme's default.
            data-slide-bg={
              activeSlide.background ??
              activeBrandKit?.bgStyle ??
              getSlideTheme(themeId).bgStyle ??
              undefined
            }
            data-slide-aspect={aspectRatio}
            // Presence of `data-slide-brand` is the hook the appended
            // brand CSS keys on (e.g. brand body-text colour in Design
            // view); `style` stamps the actual `--slide-*` overrides.
            data-slide-brand={activeBrandKit?.id}
            data-slide-logo={activeBrandKit?.logo?.placement}
            style={brandStyle}
          >
            {activeBrandKit?.logo && (
              <img
                className="slide-brand-logo"
                src={activeBrandKit.logo.dataUrl}
                alt={activeBrandKit.logo.alt}
              />
            )}
            <input
              className="slide-title-input"
              value={activeSlide.title}
              onChange={(e) =>
                updateSlide(activeIndex, { title: e.target.value })
              }
              placeholder="Slide Title"
            />
            {designView ? (
              <SlideDesignCanvas
                slide={activeSlide}
                onChangeBlockContent={(bi, content) =>
                  onBlockReplace(activeIndex, bi, {
                    ...activeSlide.blocks[bi],
                    content,
                  })
                }
                onChangeBlockAlt={(bi, alt) =>
                  onBlockReplace(activeIndex, bi, {
                    ...activeSlide.blocks[bi],
                    alt,
                  })
                }
                onImageFile={(bi, file) =>
                  onImageUpload(activeSlide.id, activeSlide.blocks[bi].id, file)
                }
                onMoveBlock={(from, to) => onBlockMove(activeIndex, from, to)}
                onRemoveBlock={(bi) => onBlockRemove(activeIndex, bi)}
                onAppendBlock={() =>
                  onBlockAppend(
                    activeIndex,
                    buildBlock({ type: "text", content: "" }),
                  )
                }
              />
            ) : (
              <div className="slide-blocks">
                {activeSlide.blocks.map((block, bi) => (
                  <SlideBlockRow
                    // Stable key driven off `block.id` (not `bi`) so a
                    // drag-reorder preserves component identity — the
                    // `<textarea>` keeps its cursor / selection state
                    // across the reorder, instead of being unmounted
                    // and re-created with a fresh DOM node.
                    key={block.id}
                    block={block}
                    blockIndex={bi}
                    totalBlocks={activeSlide.blocks.length}
                    onTypeChange={(nextType) => {
                      onBlockReplace(
                        activeIndex,
                        bi,
                        nextBlockForTypeChange(block, nextType),
                      );
                    }}
                    onContentChange={(nextContent) => {
                      onBlockReplace(activeIndex, bi, {
                        ...block,
                        content: nextContent,
                      });
                    }}
                    onAltChange={(nextAlt) => {
                      onBlockReplace(activeIndex, bi, {
                        ...block,
                        alt: nextAlt,
                      });
                    }}
                    onImageFile={(file) => {
                      // Pass `activeSlide.id` and `block.id` (not
                      // `activeIndex` / `bi`) so that an in-flight upload
                      // still lands on the right block after a drag-
                      // reorder shifts positions at either the slide or
                      // block level.
                      onImageUpload(activeSlide.id, block.id, file);
                    }}
                    onMoveUp={() => onBlockMove(activeIndex, bi, bi - 1)}
                    onMoveDown={() => onBlockMove(activeIndex, bi, bi + 1)}
                    onRemove={() => onBlockRemove(activeIndex, bi)}
                    draggedBlockId={draggedBlockId}
                    onDragStartBlock={setDraggedBlockId}
                    onDragEndBlock={() => setDraggedBlockId(null)}
                    onDropBlock={(targetIdx) => {
                      if (!draggedBlockId) return;
                      const fromIdx = activeSlide.blocks.findIndex(
                        (b) => b.id === draggedBlockId,
                      );
                      // Clear on every termination path (success AND
                      // lookup-miss) so the `is-dragging` class can't
                      // stick if the source block is removed mid-drag
                      // (e.g. the active slide changes via find-panel
                      // jump or version restore between dragstart and
                      // drop). `onDragEnd` is a defence in depth but
                      // doesn't always fire reliably in Chromium's
                      // touch-emulation path.
                      if (fromIdx < 0) {
                        setDraggedBlockId(null);
                        return;
                      }
                      onBlockMove(activeIndex, fromIdx, targetIdx);
                      setDraggedBlockId(null);
                    }}
                  />
                ))}
                <button
                  type="button"
                  className="btn-sm"
                  onClick={() =>
                    onBlockAppend(
                      activeIndex,
                      buildBlock({ type: "text", content: "" }),
                    )
                  }
                >
                  + Add Block
                </button>
              </div>
            )}

            <SlideAiActions
              slide={activeSlide}
              artifactId={artifactId}
              onApplyBullets={(bullets) =>
                applySlideBullets(activeIndex, bullets)
              }
              onApplyNotes={(notes) => {
                updateSlide(activeIndex, { notes });
                setShowNotes(true);
              }}
              onApplyRegenerated={(regen) =>
                regenerateSlide(activeIndex, regen)
              }
              deckTitle={slides[0]?.title}
              onApplyLayout={(layout) => changeLayout(layout)}
              onInsertImage={(assetUrl, alt) =>
                onBlockAppend(
                  activeIndex,
                  buildBlock({ type: "image", content: assetUrl, alt }),
                )
              }
            />

            {showNotes && (
              <SpeakerNotesField
                notes={activeSlide.notes}
                onChange={(notes) => updateSlide(activeIndex, { notes })}
              />
            )}
          </div>
        )}
      </div>
      {brandBuilderOpen && (
        <BrandKitBuilderModal
          isOpen
          deckThemeId={themeId}
          activeKitId={brandKitId}
          onApply={applyBrandKit}
          onClear={clearBrandKit}
          onClose={() => setBrandBuilderOpen(false)}
        />
      )}
      {templatePickerOpen && (
        <div
          className="slide-template-picker-overlay"
          onClick={(e) => {
            if (e.target === e.currentTarget) setTemplatePickerOpen(false);
          }}
        >
          <div
            ref={templatePickerRef}
            className="slide-template-picker slide-template-gallery"
            role="dialog"
            aria-modal="true"
            aria-label="Choose a deck template"
            tabIndex={-1}
          >
            <div className="slide-template-gallery-header">
              <h2>Start from a Template</h2>
              <input
                type="search"
                className="input slide-template-search"
                value={templateQuery}
                onChange={(e) => setTemplateQuery(e.target.value)}
                placeholder="Search templates…"
                aria-label="Search templates by name or description"
              />
            </div>
            <div
              className="slide-template-categories"
              role="group"
              aria-label="Filter templates by category"
            >
              {[ALL_TEMPLATES_CATEGORY, ...TEMPLATE_CATEGORIES].map(
                (category) => (
                  <button
                    key={category}
                    type="button"
                    className={`slide-template-chip${
                      templateCategory === category ? " is-active" : ""
                    }`}
                    aria-pressed={templateCategory === category}
                    onClick={() => setTemplateCategory(category)}
                  >
                    {category}
                  </button>
                ),
              )}
            </div>
            {visibleTemplates.length === 0 ? (
              <p className="slide-template-empty" role="status">
                No templates match your search.
              </p>
            ) : (
              <div className="slide-template-picker-grid slide-template-gallery-grid">
                {visibleTemplates.map((template) => (
                  <div
                    key={template.id}
                    className="slide-template-card slide-template-gallery-card"
                  >
                    {template.category && (
                      <span className="slide-template-card-category">
                        {template.category}
                      </span>
                    )}
                    <SlideThumbnail
                      slide={template.slides[0]}
                      themeId={
                        template.suggestedTheme ?? DEFAULT_SLIDE_THEME_ID
                      }
                    />
                    <span className="slide-template-card-meta">
                      <span className="slide-template-card-icon">
                        {template.icon}
                      </span>
                      <span className="slide-template-card-text">
                        <span className="slide-template-card-title">
                          {template.label}
                        </span>
                        <span className="slide-template-card-desc">
                          {template.description}
                        </span>
                      </span>
                    </span>
                    {/* Stretched, transparent click target so the whole
                        card is one focusable control without nesting the
                        thumbnail's block markup inside a <button>. */}
                    <button
                      type="button"
                      className="slide-template-card-button"
                      onClick={() => applyTemplate(template)}
                      aria-label={`Use the ${template.label} template — ${template.description}`}
                    />
                  </div>
                ))}
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}

interface SlideBlockRowProps {
  block: SlideBlock;
  blockIndex: number;
  totalBlocks: number;
  onTypeChange: (next: SlideBlockType) => void;
  onContentChange: (next: string) => void;
  onAltChange: (next: string) => void;
  onImageFile: (file: File) => void;
  onMoveUp: () => void;
  onMoveDown: () => void;
  onRemove: () => void;
  /**
   * Drag-and-drop coordination — the parent owns the "currently
   * dragged block id" so multiple SlideBlockRow siblings can
   * coordinate without each maintaining its own copy of the
   * cross-row drag state.
   */
  draggedBlockId: string | null;
  onDragStartBlock: (id: string) => void;
  onDragEndBlock: () => void;
  onDropBlock: (targetIndex: number) => void;
}

/**
 * Per-block editor row. Pulled out into a separate component so the
 * per-block hooks (`useId` for the alt-text label) don't have to live
 * inside the `.map(...)` body — calling hooks inside a `.map` callback
 * works in practice but is fragile (the React docs warn against it
 * because reordering the map breaks the hook call order). Owning a
 * component per block lets us also memoise file-input id generation
 * cheaply.
 */
function SlideBlockRow({
  block,
  blockIndex,
  totalBlocks,
  onTypeChange,
  onContentChange,
  onAltChange,
  onImageFile,
  onMoveUp,
  onMoveDown,
  onRemove,
  draggedBlockId,
  onDragStartBlock,
  onDragEndBlock,
  onDropBlock,
}: SlideBlockRowProps) {
  const altId = useId();
  const fileInputRef = useRef<HTMLInputElement>(null);

  const handleFileChange = (e: ChangeEvent<HTMLInputElement>) => {
    const file = e.target.files?.[0];
    if (file) onImageFile(file);
    // Reset the input so picking the same file twice still fires
    // `onChange` — browsers suppress the change event when the
    // selection matches the previous one.
    if (fileInputRef.current) fileInputRef.current.value = "";
  };

  const isDragging = draggedBlockId === block.id;
  const isDropTargetCandidate =
    draggedBlockId !== null && draggedBlockId !== block.id;

  return (
    <div
      className={`slide-block ${isDragging ? "is-dragging" : ""}`}
      data-slot={block.slot ?? undefined}
      // Block-level drag-and-drop. We attach to the outer wrapper so
      // the whole block "card" is the drag handle / drop target, not
      // just one button inside it. The `<textarea>` and `<input>`
      // children still let the user click into them normally because
      // the browser only initiates a drag when the user grabs a
      // non-text-input region (the toolbar / preview gutter).
      draggable
      onDragStart={(event) => {
        onDragStartBlock(block.id);
        event.dataTransfer.effectAllowed = "move";
        event.dataTransfer.setData("text/plain", block.id);
      }}
      onDragOver={(event) => {
        if (isDropTargetCandidate) {
          event.preventDefault();
          event.dataTransfer.dropEffect = "move";
        }
      }}
      onDrop={(event) => {
        if (!isDropTargetCandidate) return;
        event.preventDefault();
        onDropBlock(blockIndex);
      }}
      onDragEnd={onDragEndBlock}
    >
      <div className="slide-block-toolbar">
        {/*
         * `draggable={false}` on every interactive child of the
         * toolbar so the parent `.slide-block` wrapper's `draggable`
         * can't be triggered by accessibility tools, touch-emulation,
         * or millimetre-jitter taps that the browser would otherwise
         * interpret as a drag-start. Mirrors the existing defensive
         * pattern on the textarea / file-input / alt-text input
         * further down in this component, and the slide-thumbnail-row
         * buttons in the parent component.
         */}
        <select
          value={block.type}
          onChange={(e) => onTypeChange(e.target.value as SlideBlockType)}
          aria-label={`Block ${blockIndex + 1} type`}
          draggable={false}
        >
          <option value="text">Text</option>
          <option value="bullets">Bullets</option>
          <option value="diagram">Diagram</option>
          <option value="table">Table</option>
          <option value="chart">Chart</option>
          <option value="image">Image</option>
        </select>
        <button
          type="button"
          className="btn-xs"
          onClick={onMoveUp}
          disabled={blockIndex === 0}
          aria-label={`Move block ${blockIndex + 1} up`}
          title="Move block up"
          draggable={false}
        >
          ↑
        </button>
        <button
          type="button"
          className="btn-xs"
          onClick={onMoveDown}
          disabled={blockIndex === totalBlocks - 1}
          aria-label={`Move block ${blockIndex + 1} down`}
          title="Move block down"
          draggable={false}
        >
          ↓
        </button>
        <button
          type="button"
          className="btn-xs danger"
          onClick={onRemove}
          aria-label={`Remove block ${blockIndex + 1}`}
          title="Remove block"
          draggable={false}
        >
          ×
        </button>
      </div>

      {block.type === "image" ? (
        <div className="slide-block-image">
          <input
            type="file"
            ref={fileInputRef}
            accept="image/*"
            onChange={handleFileChange}
            // Defensive: the parent `.slide-block` wrapper has
            // `draggable`, and some Chromium versions can initiate
            // the parent's drag if the user grabs the file-input's
            // border/padding instead of the button face. Setting
            // `draggable={false}` on the input prevents that escape.
            draggable={false}
          />
          {block.content && (
            <img
              src={block.content}
              alt={block.alt ?? ""}
              className="slide-block-image-preview"
            />
          )}
          <label htmlFor={altId} className="slide-block-alt-label">
            Alt text
          </label>
          <input
            id={altId}
            type="text"
            className="slide-block-alt-input"
            value={block.alt ?? ""}
            onChange={(e) => onAltChange(e.target.value)}
            placeholder="Describe the image for screen readers..."
            // See note on file input above — keep drag-grab confined
            // to the toolbar / preview gutter, not the alt-text
            // entry, so reorder can't be triggered by mis-clicks
            // while typing alt text.
            draggable={false}
          />
        </div>
      ) : (
        <>
          <textarea
            className="slide-block-content"
            value={block.content}
            onChange={(e) => onContentChange(e.target.value)}
            // Defensive: prevent the parent `.slide-block` wrapper's
            // `draggable` from intercepting drag-starts that begin
            // in the textarea's padding/border area. The browser
            // normally allows text-selection inside `<textarea>` to
            // win over a parent's drag, but Chromium edge cases can
            // initiate the parent drag when the grab point misses
            // the text-content layer (e.g. a click in the scrollbar
            // gutter on a wrap-wrapped line).
            draggable={false}
            placeholder={
              BLOCK_PLACEHOLDERS[block.type] ?? "Enter text content..."
            }
            rows={MONOSPACE_BLOCK_TYPES.has(block.type) ? 8 : 4}
            spellCheck={!MONOSPACE_BLOCK_TYPES.has(block.type)}
          />
          {block.type === "diagram" && <MermaidPreview dsl={block.content} />}
          {block.type === "table" && (
            <SlideTablePreview source={block.content} />
          )}
          {block.type === "chart" && (
            <SlideChartPreview source={block.content} />
          )}
        </>
      )}
    </div>
  );
}

/**
 * Per-block textarea placeholder copy, keyed by block type. Falls back
 * to the generic prompt for `text` (and any future plain-text type).
 */
const BLOCK_PLACEHOLDERS: Partial<Record<SlideBlockType, string>> = {
  bullets: "One bullet point per line...",
  diagram: "Mermaid diagram DSL...",
  table: "| Header | Header |\n| --- | --- |\n| Cell | Cell |",
  chart: "type: bar\nlabels: A, B, C\nSeries: 1, 2, 3",
};

/**
 * Block types whose content is structured source rather than prose:
 * they get a taller textarea and spell-check disabled so the editor
 * doesn't flag DSL tokens / cell values.
 */
const MONOSPACE_BLOCK_TYPES: ReadonlySet<SlideBlockType> =
  new Set<SlideBlockType>(["diagram", "table", "chart"]);

function MarpPreview({ markdown, theme }: { markdown: string; theme: string }) {
  const [html, setHtml] = useState("");
  const [css, setCss] = useState("");
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef(0);
  const hostRef = useRef<HTMLDivElement | null>(null);

  // Debounce Marp rendering. Marp.render() can be expensive for large decks
  // and the textarea fires on every keystroke; without a debounce, typing
  // lag becomes noticeable in long presentations.
  useEffect(() => {
    const handle = setTimeout(() => {
      const token = ++tokenRef.current;
      try {
        const result = renderMarp(markdown, { theme });
        if (token !== tokenRef.current) return;
        setHtml(result.html);
        setCss(result.css);
        setError(null);
      } catch (err) {
        if (token !== tokenRef.current) return;
        if (err instanceof MarpRenderError) {
          setError(err.message);
        } else {
          setError(String(err));
        }
        setHtml("");
        setCss("");
      }
    }, 250);
    return () => clearTimeout(handle);
  }, [markdown, theme]);

  // Render the deck inside a Shadow DOM so the Marp-emitted CSS (which can
  // include global selectors like `:root` / `body` / `*`) cannot bleed out
  // into the surrounding Tessera UI.
  //
  // The shadow-DOM mutation is delegated to `applyMarpToShadow`, which uses
  // Constructable Stylesheets (`adoptedStyleSheets`) where supported and a
  // `</style`-sanitising `<style>` fallback otherwise. Either way the
  // `</style>` breakout vector is closed — see `applyMarpToShadow` for the
  // full rationale.
  useEffect(() => {
    const host = hostRef.current;
    if (!host) return;
    const shadow = host.shadowRoot ?? host.attachShadow({ mode: "open" });
    applyMarpToShadow(shadow, html, css);
  }, [html, css]);

  if (error) {
    return (
      <div className="marp-preview-error" role="alert">
        {error}
      </div>
    );
  }
  return <div ref={hostRef} className="marp-preview" />;
}
