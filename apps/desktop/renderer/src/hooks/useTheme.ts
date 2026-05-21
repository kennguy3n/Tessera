import { useEffect } from "react";
import { useSettings } from "./useSettings";

/**
 * Reads `settings.theme` and applies it as a `data-theme` attribute
 * on `<html>` so tokens.css can switch palettes.
 *
 *   - "light"  → data-theme="light"
 *   - "dark"   → data-theme="dark"
 *   - "system" → no attribute; the `prefers-color-scheme` media
 *                query in tokens.css decides at runtime
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
}
