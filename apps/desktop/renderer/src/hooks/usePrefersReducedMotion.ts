import { useEffect, useState } from "react";

const QUERY = "(prefers-reduced-motion: reduce)";

/**
 * Observe the user's `prefers-reduced-motion` accessibility setting and
 * re-render when it changes. Components use this to gate JS-driven motion
 * (e.g. the concept graph's settling animation / pan-zoom tweens): when it
 * returns `true` they should jump straight to the final state instead of
 * animating.
 *
 * Defensive by construction: in environments without `window.matchMedia`
 * (jsdom under test, SSR, an old WebView) it reports `false` — i.e. "no
 * reduction requested" — and attaches no listener, so callers never crash
 * and simply fall back to their non-animated default in those contexts.
 * The animation itself is additionally gated on `requestAnimationFrame`
 * existing, so a `false` here under jsdom does not start a real tween.
 */
export function usePrefersReducedMotion(): boolean {
  const [reduced, setReduced] = useState<boolean>(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return false;
    }
    return window.matchMedia(QUERY).matches;
  });

  useEffect(() => {
    if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
      return;
    }
    const mql = window.matchMedia(QUERY);
    const onChange = (event: MediaQueryListEvent) => setReduced(event.matches);
    // Sync once in case the value changed between the initial render and
    // this effect attaching its listener.
    setReduced(mql.matches);
    mql.addEventListener("change", onChange);
    return () => mql.removeEventListener("change", onChange);
  }, []);

  return reduced;
}
