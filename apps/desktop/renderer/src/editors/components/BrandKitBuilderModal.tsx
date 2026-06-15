/**
 * "Copy & customize a theme" brand-kit builder.
 *
 * A thin form over {@link Modal} that edits a {@link BrandKitDraft} —
 * base theme, brand colours, heading/body fonts, a corner logo and an
 * optional background style — with a live preview, then builds +
 * persists it through {@link useBrandKits} on save. All normalisation +
 * validation lives in `slideBrandKit.ts`; this component only collects
 * the draft, renders the preview, and surfaces build errors, so it stays
 * presentational and easy to reason about.
 *
 * The host (`SlideEditor`) mounts this only while open, so the form seeds
 * its draft once in the `useState` initialiser — from an imported draft
 * ({@link BrandKitBuilderModalProps.initialDraft}, reviewed before save),
 * else the active kit (edit), else a fresh kit (create) — no render-phase
 * re-seed needed.
 */

import { useState, type ChangeEvent, type CSSProperties } from "react";
import Modal from "../../components/Modal";
import {
  BRAND_FONTS,
  LOGO_PLACEMENTS,
  MAX_LOGO_IMAGE_KB,
  brandDraftCssVars,
  brandKitToDraft,
  emptyBrandKitDraft,
  isInlineImageDataUrl,
  normalizeHexColor,
  type BrandKit,
  type BrandKitDraft,
  type LogoPlacement,
} from "../slideBrandKit";
import { fileToDataUrl } from "../slideEditorHelpers";
import { SLIDE_THEMES, getSlideTheme, type SlideBgStyle } from "../slideThemes";
import { useBrandKits } from "../useBrandKits";

/** Human labels for the corner placements, in {@link LOGO_PLACEMENTS} order. */
const PLACEMENT_LABELS: Record<LogoPlacement, string> = {
  tl: "Top left",
  tr: "Top right",
  bl: "Bottom left",
  br: "Bottom right",
};

/** Background-style options offered in the picker ("" ⇒ inherit theme). */
const BG_STYLE_OPTIONS: ReadonlyArray<{ value: SlideBgStyle; label: string }> =
  [
    { value: "solid", label: "Solid" },
    { value: "gradient", label: "Gradient" },
    { value: "mesh", label: "Mesh" },
    { value: "dots", label: "Dots" },
    { value: "lines", label: "Lines" },
  ];

/** Fallback colour for the native colour input when the hex is empty/invalid. */
function colorInputValue(raw: string, fallback: string): string {
  return normalizeHexColor(raw) ?? fallback;
}

/** Seed a fresh draft for `themeId`, pre-filling sensible brand colours. */
function newDraftForTheme(themeId: string): BrandKitDraft {
  const draft = emptyBrandKitDraft(themeId);
  // Pre-fill the three required colours so the preview + colour pickers
  // start from a coherent state. The accent comes from the theme's own
  // swatch; surface/text default to a legible light pairing the user can
  // immediately recolour.
  draft.colors.accent =
    normalizeHexColor(getSlideTheme(draft.baseThemeId).swatch) ?? "#7c3aed";
  draft.colors.surface = "#ffffff";
  draft.colors.text = "#1e1b2e";
  return draft;
}

export interface BrandKitBuilderModalProps {
  isOpen: boolean;
  /** Deck's current curated theme — the default base for a new kit. */
  deckThemeId: string;
  /** Deck's active brand-kit id, or `undefined` when none is applied. */
  activeKitId: string | undefined;
  /**
   * A draft to seed the form with — used by the import flow to open the
   * builder pre-filled from a Brand Pack so the user reviews it before
   * saving. It carries NO id (see {@link parseBrandPack}), so saving
   * persists a NEW kit and never overwrites an existing one. When absent
   * the form seeds from the active kit (edit) or a fresh kit (create).
   */
  initialDraft?: BrandKitDraft;
  /** Apply a (just-saved or existing) kit to the deck. */
  onApply: (kit: BrandKit) => void;
  /** Remove the brand kit from the deck (keep the curated theme). */
  onClear: () => void;
  onClose: () => void;
}

export function BrandKitBuilderModal({
  isOpen,
  deckThemeId,
  activeKitId,
  initialDraft,
  onApply,
  onClear,
  onClose,
}: BrandKitBuilderModalProps) {
  const { brandKits, saveBrandKit, deleteBrandKit } = useBrandKits();

  const [draft, setDraft] = useState<BrandKitDraft>(() => {
    if (initialDraft) return initialDraft;
    const active = activeKitId
      ? (brandKits.find((k) => k.id === activeKitId) ?? null)
      : null;
    return active ? brandKitToDraft(active) : newDraftForTheme(deckThemeId);
  });
  const [errors, setErrors] = useState<string[]>([]);
  // Whether the draft currently shown is still the freshly imported one.
  // Drives the title: it must stop saying "Import brand kit" the moment the
  // user navigates to a saved kit or starts a new draft, rather than tracking
  // the (immutable) `initialDraft` prop for the modal's whole lifetime.
  const [isImporting, setIsImporting] = useState<boolean>(() => !!initialDraft);

  const patch = (next: Partial<BrandKitDraft>) =>
    setDraft((d) => ({ ...d, ...next }));
  const patchColor = (key: keyof BrandKitDraft["colors"], value: string) =>
    setDraft((d) => ({ ...d, colors: { ...d.colors, [key]: value } }));

  const loadKit = (kit: BrandKit) => {
    setDraft(brandKitToDraft(kit));
    setErrors([]);
    setIsImporting(false);
  };
  const startNew = () => {
    setDraft(newDraftForTheme(deckThemeId));
    setErrors([]);
    setIsImporting(false);
  };

  const handleLogoFile = (event: ChangeEvent<HTMLInputElement>) => {
    const file = event.target.files?.[0];
    // Reset the input so re-picking the same file fires `onChange` again.
    event.target.value = "";
    if (!file) return;
    fileToDataUrl(file)
      .then((dataUrl) => {
        if (!isInlineImageDataUrl(dataUrl)) {
          setErrors([
            `Logo image is too large — choose a smaller image (under ~${MAX_LOGO_IMAGE_KB} KB).`,
          ]);
          return;
        }
        setErrors([]);
        setDraft((d) => ({
          ...d,
          logoDataUrl: dataUrl,
          logoAlt: d.logoAlt || file.name.replace(/\.[^.]+$/, ""),
        }));
      })
      .catch((err: unknown) => {
        setErrors([
          err instanceof Error ? err.message : "Failed to read image.",
        ]);
      });
  };

  const handleSave = () => {
    const result = saveBrandKit(draft);
    if (result.ok) {
      onApply(result.brandKit);
      onClose();
    } else {
      setErrors(result.errors);
    }
  };

  const handleDelete = (id: string) => {
    deleteBrandKit(id);
    if (id === activeKitId) onClear();
    if (draft.id === id) startNew();
  };

  const previewStyle = brandDraftCssVars(draft) as CSSProperties;
  const previewBg =
    (draft.bgStyle || getSlideTheme(draft.baseThemeId).bgStyle) ?? undefined;
  const hasLogo = isInlineImageDataUrl(draft.logoDataUrl);

  return (
    <Modal
      isOpen={isOpen}
      onClose={onClose}
      title={
        isImporting
          ? "Import brand kit"
          : draft.id
            ? "Edit brand kit"
            : "Customize brand"
      }
      closeOnOverlayClick={false}
    >
      <div className="brand-kit-builder" data-testid="brand-kit-builder">
        {brandKits.length > 0 && (
          <fieldset className="brand-kit-fieldset">
            <legend>Saved brand kits</legend>
            <div className="brand-kit-saved-list">
              {brandKits.map((kit) => (
                <div
                  key={kit.id}
                  className="brand-kit-saved-row"
                  data-testid={`brand-kit-saved-${kit.id}`}
                >
                  <button
                    type="button"
                    className="brand-kit-saved-name"
                    onClick={() => loadKit(kit)}
                    title="Load into the editor"
                  >
                    <span
                      className="brand-kit-saved-swatch"
                      style={{ background: kit.colors.accent }}
                    />
                    {kit.name}
                    {kit.id === activeKitId && (
                      <span className="brand-kit-saved-active">Active</span>
                    )}
                  </button>
                  <button
                    type="button"
                    className="btn-sm"
                    onClick={() => {
                      onApply(kit);
                      onClose();
                    }}
                    data-testid={`brand-kit-apply-${kit.id}`}
                  >
                    Apply
                  </button>
                  <button
                    type="button"
                    className="btn-sm brand-kit-delete"
                    onClick={() => handleDelete(kit.id)}
                    aria-label={`Delete ${kit.name}`}
                    data-testid={`brand-kit-delete-${kit.id}`}
                  >
                    Delete
                  </button>
                </div>
              ))}
            </div>
            <button
              type="button"
              className="btn-sm"
              onClick={startNew}
              data-testid="brand-kit-new"
            >
              + New brand kit
            </button>
          </fieldset>
        )}

        <div className="brand-kit-grid">
          <div className="brand-kit-form">
            <label className="ai-panel-field">
              <span>Name</span>
              <input
                type="text"
                className="input"
                value={draft.name}
                onChange={(e) => patch({ name: e.target.value })}
                placeholder="e.g. Acme Corp"
                data-testid="brand-kit-name"
                aria-label="Brand kit name"
              />
            </label>

            <label className="ai-panel-field">
              <span>Base theme</span>
              <select
                className="input"
                value={draft.baseThemeId}
                onChange={(e) => patch({ baseThemeId: e.target.value })}
                data-testid="brand-kit-base-theme"
                aria-label="Base theme"
              >
                {SLIDE_THEMES.map((theme) => (
                  <option key={theme.id} value={theme.id}>
                    {theme.label}
                  </option>
                ))}
              </select>
            </label>

            <fieldset className="brand-kit-fieldset">
              <legend>Colours</legend>
              <p className="ai-panel-hint">
                Accent, surface and text are required. Heading and muted are
                optional and inherit the base theme when left blank.
              </p>
              <BrandColorField
                label="Accent"
                hint="Links, bullets, dividers"
                value={draft.colors.accent}
                fallback="#7c3aed"
                required
                onChange={(v) => patchColor("accent", v)}
                testId="brand-kit-color-accent"
              />
              <BrandColorField
                label="Surface"
                hint="Slide background"
                value={draft.colors.surface}
                fallback="#ffffff"
                required
                onChange={(v) => patchColor("surface", v)}
                testId="brand-kit-color-surface"
              />
              <BrandColorField
                label="Text"
                hint="Body copy"
                value={draft.colors.text}
                fallback="#1e1b2e"
                required
                onChange={(v) => patchColor("text", v)}
                testId="brand-kit-color-text"
              />
              <BrandColorField
                label="Heading"
                hint="Optional — titles"
                value={draft.colors.heading}
                fallback="#1e1b2e"
                onChange={(v) => patchColor("heading", v)}
                onClear={() => patchColor("heading", "")}
                testId="brand-kit-color-heading"
              />
              <BrandColorField
                label="Muted"
                hint="Optional — captions"
                value={draft.colors.muted}
                fallback="#6b7280"
                onChange={(v) => patchColor("muted", v)}
                onClear={() => patchColor("muted", "")}
                testId="brand-kit-color-muted"
              />
            </fieldset>

            <fieldset className="brand-kit-fieldset">
              <legend>Fonts</legend>
              <label className="ai-panel-field">
                <span>Heading font</span>
                <select
                  className="input"
                  value={draft.headingFont}
                  onChange={(e) => patch({ headingFont: e.target.value })}
                  data-testid="brand-kit-heading-font"
                  aria-label="Heading font"
                >
                  <option value="">Theme default</option>
                  {BRAND_FONTS.map((font) => (
                    <option key={font.id} value={font.id}>
                      {font.label}
                    </option>
                  ))}
                </select>
              </label>
              <label className="ai-panel-field">
                <span>Body font</span>
                <select
                  className="input"
                  value={draft.bodyFont}
                  onChange={(e) => patch({ bodyFont: e.target.value })}
                  data-testid="brand-kit-body-font"
                  aria-label="Body font"
                >
                  <option value="">Theme default</option>
                  {BRAND_FONTS.map((font) => (
                    <option key={font.id} value={font.id}>
                      {font.label}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>

            <fieldset className="brand-kit-fieldset">
              <legend>Background</legend>
              <label className="ai-panel-field">
                <span>Background style</span>
                <select
                  className="input"
                  value={draft.bgStyle}
                  onChange={(e) => patch({ bgStyle: e.target.value })}
                  data-testid="brand-kit-bg-style"
                  aria-label="Background style"
                >
                  <option value="">Theme default</option>
                  {BG_STYLE_OPTIONS.map((opt) => (
                    <option key={opt.value} value={opt.value}>
                      {opt.label}
                    </option>
                  ))}
                </select>
              </label>
            </fieldset>

            <fieldset className="brand-kit-fieldset">
              <legend>Logo</legend>
              <p className="ai-panel-hint">
                Pinned to a slide corner on every slide. Embedded inline so the
                deck stays self-contained.
              </p>
              <div className="brand-kit-logo-row">
                <label className="btn-sm brand-kit-logo-upload">
                  {hasLogo ? "Replace logo" : "Upload logo"}
                  <input
                    type="file"
                    accept="image/*"
                    onChange={handleLogoFile}
                    data-testid="brand-kit-logo-file"
                    aria-label="Upload logo image"
                    hidden
                  />
                </label>
                {hasLogo && (
                  <button
                    type="button"
                    className="btn-sm brand-kit-delete"
                    onClick={() => patch({ logoDataUrl: "", logoAlt: "" })}
                    data-testid="brand-kit-logo-remove"
                  >
                    Remove logo
                  </button>
                )}
              </div>
              {hasLogo && (
                <>
                  <label className="ai-panel-field">
                    <span>Logo alt text</span>
                    <input
                      type="text"
                      className="input"
                      value={draft.logoAlt}
                      onChange={(e) => patch({ logoAlt: e.target.value })}
                      placeholder="Describe the logo (blank = decorative)"
                      data-testid="brand-kit-logo-alt"
                      aria-label="Logo alt text"
                    />
                  </label>
                  <label className="ai-panel-field">
                    <span>Placement</span>
                    <select
                      className="input"
                      value={draft.logoPlacement}
                      onChange={(e) =>
                        patch({
                          logoPlacement: e.target.value as LogoPlacement,
                        })
                      }
                      data-testid="brand-kit-logo-placement"
                      aria-label="Logo placement"
                    >
                      {LOGO_PLACEMENTS.map((placement) => (
                        <option key={placement} value={placement}>
                          {PLACEMENT_LABELS[placement]}
                        </option>
                      ))}
                    </select>
                  </label>
                </>
              )}
            </fieldset>
          </div>

          <div className="brand-kit-preview-pane">
            <span className="brand-kit-preview-label">Live preview</span>
            <div
              className="slide-canvas slide-canvas-design brand-kit-preview"
              data-slide-theme={draft.baseThemeId}
              data-slide-bg={previewBg}
              data-slide-brand="preview"
              data-slide-logo={hasLogo ? draft.logoPlacement : undefined}
              style={previewStyle}
              data-testid="brand-kit-preview"
            >
              {hasLogo && (
                <img
                  className="slide-brand-logo"
                  src={draft.logoDataUrl}
                  alt={draft.logoAlt}
                />
              )}
              <div className="slide-title-input brand-kit-preview-title">
                {draft.name || "Presentation title"}
              </div>
              <p className="slide-wys-text brand-kit-preview-body">
                Body copy renders in your brand text colour and font, while the
                surface, accent and headings re-skin the chosen base theme.
              </p>
              <div className="brand-kit-preview-bullets">
                <span className="brand-kit-preview-bullet">
                  Accent-coloured highlight
                </span>
                <span className="brand-kit-preview-bullet">
                  Structure stays, skin changes
                </span>
              </div>
            </div>
          </div>
        </div>

        {errors.length > 0 && (
          <div
            className="ai-panel-error brand-kit-errors"
            role="alert"
            data-testid="brand-kit-errors"
          >
            <ul>
              {errors.map((err, i) => (
                <li key={i} data-testid="brand-kit-error">
                  {err}
                </li>
              ))}
            </ul>
          </div>
        )}

        <div className="ai-panel-run-row brand-kit-actions">
          <button
            type="button"
            className="btn btn-primary"
            onClick={handleSave}
            data-testid="brand-kit-save"
          >
            Save &amp; apply
          </button>
          {activeKitId && (
            <button
              type="button"
              className="btn btn-secondary"
              onClick={() => {
                onClear();
                onClose();
              }}
              data-testid="brand-kit-clear"
            >
              Remove from deck
            </button>
          )}
          <button
            type="button"
            className="btn btn-secondary"
            onClick={onClose}
            data-testid="brand-kit-cancel"
          >
            Cancel
          </button>
        </div>
      </div>
    </Modal>
  );
}

interface BrandColorFieldProps {
  label: string;
  hint: string;
  value: string;
  /** Colour shown by the native picker when `value` is empty/invalid. */
  fallback: string;
  required?: boolean;
  onChange: (value: string) => void;
  /** When provided, renders a "clear" affordance for an optional colour. */
  onClear?: () => void;
  testId: string;
}

/** One labelled colour control: native swatch picker + editable hex text. */
function BrandColorField({
  label,
  hint,
  value,
  fallback,
  required,
  onChange,
  onClear,
  testId,
}: BrandColorFieldProps) {
  return (
    <div className="brand-kit-color-field">
      <div className="brand-kit-color-label">
        <span>{label}</span>
        <span className="ai-panel-hint">{hint}</span>
      </div>
      <div className="brand-kit-color-controls">
        <input
          type="color"
          className="brand-kit-color-swatch"
          value={colorInputValue(value, fallback)}
          onChange={(e) => onChange(e.target.value)}
          data-testid={`${testId}-swatch`}
          aria-label={`${label} colour`}
        />
        <input
          type="text"
          className="input brand-kit-color-hex"
          value={value}
          onChange={(e) => onChange(e.target.value)}
          placeholder={required ? fallback : "Inherit"}
          data-testid={`${testId}-hex`}
          aria-label={`${label} hex value`}
          spellCheck={false}
        />
        {onClear && value.trim() !== "" && (
          <button
            type="button"
            className="btn-sm brand-kit-color-clear"
            onClick={onClear}
            aria-label={`Clear ${label} colour`}
            data-testid={`${testId}-clear`}
          >
            Clear
          </button>
        )}
      </div>
    </div>
  );
}
