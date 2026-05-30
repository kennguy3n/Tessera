/**
 * IconPicker — a searchable browse-and-select UI over the combined
 * Lucide + Phosphor icon catalog. Mirrors the contract of the existing
 * iconResolver service so callers can store the picked value as
 * `lucide:home` / `phosphor:check-circle` and round-trip it through the
 * resolver at render/export time.
 *
 * Designed to be embedded inside infographic / landing-page editors and
 * any future "pick an icon" flow.
 */

import { useEffect, useMemo, useState } from "react";
import type { IconSet, PhosphorWeight } from "../services/iconResolver";
import {
  listIcons,
  resolveIconComponent,
  searchIcons,
} from "../services/iconResolver";
import { useCspNonce } from "../utils/cspNonce";

export interface IconPickerValue {
  set: IconSet;
  name: string;
  weight?: PhosphorWeight;
}

interface IconPickerProps {
  value?: IconPickerValue | null;
  onChange: (value: IconPickerValue) => void;
  /** Initial size for the preview tiles. Defaults to 24px. */
  iconSize?: number;
  /** Maximum number of search results shown. Defaults to 200. */
  resultsLimit?: number;
}

const PHOSPHOR_WEIGHTS: PhosphorWeight[] = [
  "thin",
  "light",
  "regular",
  "bold",
  "fill",
  "duotone",
];

export default function IconPicker({
  value,
  onChange,
  iconSize = 24,
  resultsLimit = 200,
}: IconPickerProps) {
  const cspNonce = useCspNonce();
  const [set, setSet] = useState<IconSet>(value?.set ?? "lucide");
  const [weight, setWeight] = useState<PhosphorWeight>(
    value?.weight ?? "regular",
  );
  const [query, setQuery] = useState("");

  // Reset query (but not selected name) when the user flips between
  // libraries so they don't end up staring at "no matches".
  useEffect(() => {
    setQuery("");
  }, [set]);

  const matches = useMemo(() => {
    if (!query) {
      // Show the first slice of icons by default so the panel isn't
      // empty before the user types.
      return listIcons(set).slice(0, resultsLimit);
    }
    return searchIcons(set, query, resultsLimit);
  }, [set, query, resultsLimit]);

  const handlePick = (name: string) => {
    onChange({
      set,
      name,
      weight: set === "phosphor" ? weight : undefined,
    });
  };

  return (
    <div className="icon-picker">
      <div className="icon-picker-header">
        <div className="icon-picker-tabs" role="tablist">
          {(["lucide", "phosphor"] as IconSet[]).map((s) => (
            <button
              key={s}
              type="button"
              role="tab"
              aria-selected={set === s}
              className={`icon-picker-tab ${set === s ? "active" : ""}`}
              onClick={() => setSet(s)}
            >
              {s === "lucide" ? "Lucide" : "Phosphor"}
            </button>
          ))}
        </div>
        {set === "phosphor" && (
          <select
            aria-label="Phosphor weight"
            value={weight}
            onChange={(e) => setWeight(e.target.value as PhosphorWeight)}
            className="icon-picker-weight"
          >
            {PHOSPHOR_WEIGHTS.map((w) => (
              <option key={w} value={w}>
                {w}
              </option>
            ))}
          </select>
        )}
      </div>

      <input
        type="search"
        placeholder={`Search ${set} icons…`}
        value={query}
        onChange={(e) => setQuery(e.target.value)}
        className="icon-picker-search"
        // `aria-label` must mirror the dynamic `placeholder` so screen
        // readers announce the current icon set ("Search lucide icons" /
        // "Search phosphor icons"). Keeping the two strings in sync also
        // means accessibility-driven test queries can pin the active set
        // through a single source-of-truth label.
        aria-label={`Search ${set} icons`}
      />

      <div className="icon-picker-grid" role="listbox" aria-label="Icons">
        {matches.length === 0 ? (
          <p className="icon-picker-empty">No icons match.</p>
        ) : (
          matches.map((name) => {
            const Component = resolveIconComponent({ set, name });
            if (!Component) return null;
            const isSelected =
              value &&
              value.set === set &&
              value.name.toLowerCase() === name.toLowerCase();
            return (
              <button
                key={name}
                type="button"
                role="option"
                aria-selected={isSelected || false}
                aria-label={name}
                title={name}
                className={`icon-picker-tile ${isSelected ? "selected" : ""}`}
                onClick={() => handlePick(name)}
              >
                <Component
                  size={iconSize}
                  {...(set === "phosphor" ? { weight } : {})}
                />
              </button>
            );
          })
        )}
      </div>

      <style nonce={cspNonce}>{`
        .icon-picker {
          display: flex;
          flex-direction: column;
          gap: var(--spacing-sm);
          width: 100%;
          min-width: 320px;
          max-width: 520px;
        }
        .icon-picker-header {
          display: flex;
          gap: var(--spacing-sm);
          align-items: center;
          justify-content: space-between;
        }
        .icon-picker-tabs {
          display: flex;
          gap: 4px;
        }
        .icon-picker-tab {
          background: transparent;
          border: 1px solid var(--color-border);
          padding: 4px 12px;
          border-radius: var(--radius-sm);
          font-size: var(--font-size-sm);
          cursor: pointer;
          color: var(--color-text-secondary);
        }
        .icon-picker-tab.active {
          background: var(--color-primary, #7C3AED);
          color: #fff;
          border-color: var(--color-primary, #7C3AED);
        }
        .icon-picker-weight {
          padding: 4px 8px;
          font-size: var(--font-size-sm);
          border: 1px solid var(--color-border);
          border-radius: var(--radius-sm);
        }
        .icon-picker-search {
          padding: 6px 10px;
          border: 1px solid var(--color-border);
          border-radius: var(--radius-input, 6px);
          font-size: var(--font-size-sm);
        }
        .icon-picker-grid {
          display: grid;
          grid-template-columns: repeat(auto-fill, minmax(44px, 1fr));
          gap: 4px;
          max-height: 280px;
          overflow-y: auto;
          padding: 4px;
          border: 1px solid var(--color-border);
          border-radius: var(--radius-input, 6px);
          background: var(--color-bg-elevated, #fff);
        }
        .icon-picker-tile {
          aspect-ratio: 1;
          display: flex;
          align-items: center;
          justify-content: center;
          background: transparent;
          border: 1px solid transparent;
          border-radius: var(--radius-sm);
          cursor: pointer;
          color: var(--color-text-body);
        }
        .icon-picker-tile:hover {
          background: var(--color-primary-light, rgba(124, 58, 237, 0.1));
          color: var(--color-primary, #7C3AED);
        }
        .icon-picker-tile.selected {
          background: var(--color-primary, #7C3AED);
          color: #fff;
          border-color: var(--color-primary, #7C3AED);
        }
        .icon-picker-empty {
          padding: var(--spacing-md);
          color: var(--color-text-secondary);
          font-size: var(--font-size-sm);
          grid-column: 1 / -1;
        }
      `}</style>
    </div>
  );
}
