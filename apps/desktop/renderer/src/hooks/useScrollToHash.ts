/**
 * Scroll the element matching `location.hash` into view on mount and
 * whenever the hash changes. Lets command-palette commands deep-link
 * to a specific section of a long page (e.g. `/settings#performance`)
 * without each page reimplementing the lookup.
 *
 * No-op when the hash is empty or names an element that isn't on the
 * page, so a stale or cross-page anchor degrades gracefully to "land
 * at the top". Focus is moved to the target (after making it
 * programmatically focusable if needed) so keyboard and screen-reader
 * users follow the jump too, matching the WAI-ARIA in-page-link
 * pattern.
 */

import { useEffect } from "react";
import { useLocation } from "react-router-dom";

export function useScrollToHash(): void {
  const { hash } = useLocation();

  useEffect(() => {
    if (!hash) return;
    const id = decodeURIComponent(hash.slice(1));
    if (!id) return;
    // Defer one frame so a freshly-navigated page has rendered its
    // sections before we try to find the anchor.
    const t = setTimeout(() => {
      const el = document.getElementById(id);
      if (!el) return;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      if (el.tabIndex < 0) el.tabIndex = -1;
      el.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(t);
  }, [hash]);
}
