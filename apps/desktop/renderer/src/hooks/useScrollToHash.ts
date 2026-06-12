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
 *
 * `ready` gates the attempt for pages that render their anchors only
 * after an async load: when navigating cross-page to e.g.
 * `/sources#connectors`, the target `<div id="connectors">` doesn't
 * exist during the page's loading skeleton, so a one-shot lookup on
 * mount would silently miss. Callers pass their loading-complete
 * signal (`!loading`) so the effect re-fires once the content — and
 * thus the anchor — is present. Each hash is scrolled to at most once
 * (tracked by ref) so a later background refresh doesn't yank the user
 * back to the anchor. Defaults to `true` for callers whose anchors are
 * always present.
 */

import { useEffect, useRef } from "react";
import { useLocation } from "react-router-dom";

export function useScrollToHash(ready: boolean = true): void {
  const { hash } = useLocation();
  // The hash we've already scrolled to; advances only on a successful
  // scroll so a not-yet-rendered anchor keeps retrying on the next
  // `ready`/`hash` change, while a settled anchor is honoured once.
  const handledHashRef = useRef<string | null>(null);

  useEffect(() => {
    if (!hash || !ready) return;
    if (handledHashRef.current === hash) return;
    const id = decodeURIComponent(hash.slice(1));
    if (!id) return;
    // Defer one frame so a freshly-navigated page has rendered its
    // sections before we try to find the anchor.
    const t = setTimeout(() => {
      const el = document.getElementById(id);
      if (!el) return;
      handledHashRef.current = hash;
      el.scrollIntoView({ behavior: "smooth", block: "start" });
      if (el.tabIndex < 0) el.tabIndex = -1;
      el.focus({ preventScroll: true });
    }, 0);
    return () => clearTimeout(t);
  }, [hash, ready]);
}
