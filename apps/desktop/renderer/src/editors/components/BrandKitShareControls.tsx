/**
 * Share-controls row for the Slide editor's brand surface: Export the
 * active Brand Kit to a portable `tessera-brand-<slug>.json` file, or
 * Import one. Sits next to the "Customize brand" trigger so a brand can
 * travel between machines / Devin sessions — the cross-session vehicle
 * for the brand-kit feature, mirroring the Skill export/import controls.
 *
 * Only USER brand kits are exportable (built-in/base themes are not brand
 * kits), so Export is disabled unless a kit is active. Import reads the
 * file, parses it, and hands a builder-ready draft to the host via
 * {@link BrandKitShareControlsProps.onImported}; the host opens the
 * builder pre-filled (like Duplicate) so the user reviews before saving.
 * The parsed draft carries no id, so saving mints a fresh one — an import
 * can never overwrite an existing kit. A bad file shows an inline
 * `role="alert"` error and is otherwise a no-op. Local-first: the file
 * is read in-renderer and never leaves the machine.
 */

import { useRef, useState } from "react";
import {
  brandPackFilename,
  parseBrandPack,
  serializeBrandPack,
  type BrandKit,
  type BrandKitDraft,
} from "../slideBrandKit";

export interface BrandKitShareControlsProps {
  /** The deck's active brand kit, or `null` when none is applied. */
  activeKit: BrandKit | null;
  /** Hand a parsed, id-less draft to the host to open the builder pre-filled. */
  onImported: (draft: BrandKitDraft) => void;
}

export function BrandKitShareControls({
  activeKit,
  onImported,
}: BrandKitShareControlsProps) {
  const [importError, setImportError] = useState<string | null>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);

  // Download the active kit as a Brand Pack. Pure read of the kit — the
  // blob-download dance (createObjectURL → click → revoke) mirrors
  // `BaseEditor.triggerDownload` / `SkillManagerControls.exportSelected`.
  const exportActive = () => {
    if (!activeKit) return;
    const blob = new Blob([serializeBrandPack(activeKit)], {
      type: "application/json",
    });
    const url = URL.createObjectURL(blob);
    const a = document.createElement("a");
    a.href = url;
    a.download = brandPackFilename(activeKit);
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
  };

  const openImportPicker = () => {
    setImportError(null);
    fileInputRef.current?.click();
  };

  const onImportFile = (e: React.ChangeEvent<HTMLInputElement>) => {
    const input = e.currentTarget;
    const file = input.files?.[0];
    // Reset so picking the same file again re-fires onChange.
    input.value = "";
    if (!file) return;
    file
      .text()
      .then((body) => {
        const result = parseBrandPack(body);
        if (!result.ok) {
          setImportError(result.error);
          return;
        }
        // Hand the id-less draft to the host: it opens the builder
        // pre-filled so the user reviews before a fresh id is minted.
        setImportError(null);
        onImported(result.draft);
      })
      .catch(() => setImportError("Couldn’t read that file."));
  };

  return (
    <span
      className="brand-share"
      role="group"
      aria-label="Share brand kit"
      data-testid="brand-share"
    >
      <button
        type="button"
        className="btn btn-secondary brand-share-btn"
        onClick={exportActive}
        disabled={!activeKit}
        title={
          activeKit
            ? "Export this brand kit to a file"
            : "Apply a brand kit to export it"
        }
        data-testid="brand-share-export"
      >
        Export
      </button>
      <button
        type="button"
        className="btn btn-secondary brand-share-btn"
        onClick={openImportPicker}
        title="Import a brand kit file"
        data-testid="brand-share-import"
      >
        Import
      </button>

      <input
        ref={fileInputRef}
        type="file"
        accept=".json,application/json"
        onChange={onImportFile}
        aria-label="Import brand kit file"
        data-testid="brand-share-import-input"
        style={{ display: "none" }}
      />

      {importError && (
        <p
          className="ai-panel-hint brand-share-error"
          role="alert"
          data-testid="brand-share-import-error"
        >
          {importError}
        </p>
      )}
    </span>
  );
}
