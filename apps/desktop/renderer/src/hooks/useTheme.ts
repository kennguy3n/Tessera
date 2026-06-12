import { useEffect } from "react";
import { ACCENT_COLORS, type AccentColor } from "../types/ipc";
import { useSettings } from "./useSettings";

const DEFAULT_ACCENT: AccentColor = "violet";
const ACCENT_SET: ReadonlySet<string> = new Set(ACCENT_COLORS);

/**
 * Reads `settings.theme` / `settings.accentColor` and applies them as
 * `data-theme` / `data-accent` attributes on `<html>` so tokens.css
 * can switch palettes and the accent ramp.
 *
 *   - "light"  → data-theme="light"
 *   - "dark"   → data-theme="dark"
 *   - "system" → no attribute; the `prefers-color-scheme` media
 *                query in tokens.css decides at runtime
 *
 * The accent is applied independently of the theme: each
 * `[data-accent="<key>"]` ramp in tokens.css declares both a light
 * and a dark base, and the active theme selects which one resolves.
 * `data-accent` is always set (defaulting to "violet") so the
 * `:root` fallback ramp and the attribute ramp can never disagree.
 *
 * Tessera always uses the renderer-stored settings as the source of
 * truth — the OS may still influence the choice but only when the
 * user explicitly opts into "system".
 */
export function useTheme() {
  const { settings, loading } = useSettings();

  useEffect(() => {
    if (loading) return;
    const root = document.documentElement;
    const theme = (settings.theme || "light").toLowerCase();
    if (theme === "dark") {
      root.setAttribute("data-theme", "dark");
    } else if (theme === "light") {
      root.setAttribute("data-theme", "light");
    } else {
      root.removeAttribute("data-theme");
    }
  }, [settings.theme, loading]);

  useEffect(() => {
    if (loading) return;
    const root = document.documentElement;
    const accent =
      settings.accentColor && ACCENT_SET.has(settings.accentColor)
        ? settings.accentColor
        : DEFAULT_ACCENT;
    root.setAttribute("data-accent", accent);
  }, [settings.accentColor, loading]);
}
