/**
 * iconResolver — resolves icon names from Lucide and Phosphor icon sets to
 * raw SVG strings suitable for inline HTML/PDF export.
 *
 * Resolution algorithm:
 *
 *   1. Caller provides an icon spec as either `"lucide:home"`,
 *      `"phosphor:check-circle"`, or a bare name (defaults to lucide).
 *   2. `resolveIconSvg()` returns a complete `<svg ...>...</svg>` string
 *      with the requested size, color, and stroke width.
 *   3. Lucide icons are stroke-based (stroke-currentColor); Phosphor icons
 *      come in six weights (thin/light/regular/bold/fill/duotone) and use
 *      fill or fill+stroke depending on the weight.
 *
 * This service is consumed by:
 *   - IconPicker (browse-and-select UI)
 *   - export pipelines (mermaid/marp render layers, infographic/landing
 *     page editors) that need inline SVG bytes
 *   - tests that verify icon embedding works
 */

import { renderToStaticMarkup } from "react-dom/server";
import * as React from "react";
import * as LucideAll from "lucide-react";
import * as PhosphorAll from "@phosphor-icons/react";

export type IconSet = "lucide" | "phosphor";
export type PhosphorWeight =
  | "thin"
  | "light"
  | "regular"
  | "bold"
  | "fill"
  | "duotone";

export interface IconResolveOptions {
  size?: number;
  color?: string;
  strokeWidth?: number;
  weight?: PhosphorWeight; // phosphor only
  className?: string;
}

export interface IconSpec {
  set: IconSet;
  name: string;
}

/** Convert "home", "Home", "home-icon", "homeIcon" → "Home" (Pascal). */
export function toPascalCase(name: string): string {
  return name
    .trim()
    .replace(/[_\s.]+/g, "-")
    .split("-")
    .filter((s) => s.length > 0)
    .map((s) => s.charAt(0).toUpperCase() + s.slice(1))
    .join("");
}

/** Parse "lucide:home", "phosphor:check-circle", or a bare "home". */
export function parseIconSpec(input: string): IconSpec {
  const trimmed = input.trim();
  const sep = trimmed.indexOf(":");
  if (sep === -1) {
    return { set: "lucide", name: trimmed };
  }
  const prefix = trimmed.slice(0, sep).toLowerCase();
  const rest = trimmed.slice(sep + 1);
  if (prefix === "lucide" || prefix === "phosphor") {
    return { set: prefix as IconSet, name: rest };
  }
  // Unknown prefix — fall through to lucide so callers don't crash on
  // typos; resolution will return null and the caller logs a warning.
  return { set: "lucide", name: rest };
}

interface IconModule {
  [key: string]: unknown;
}

function lookupComponent(
  mod: IconModule,
  name: string,
): React.ComponentType<Record<string, unknown>> | null {
  const pascal = toPascalCase(name);
  const candidates = [pascal, `${pascal}Icon`];
  for (const c of candidates) {
    const v = mod[c];
    if (typeof v === "function" || typeof v === "object") {
      return v as React.ComponentType<Record<string, unknown>>;
    }
  }
  return null;
}

/**
 * Resolve an icon spec to a React component. Returns null if the name
 * isn't found in the requested set. Callers that need a string SVG should
 * use `resolveIconSvg()`.
 */
export function resolveIconComponent(
  spec: IconSpec,
): React.ComponentType<Record<string, unknown>> | null {
  if (spec.set === "lucide") {
    return lookupComponent(LucideAll as IconModule, spec.name);
  }
  return lookupComponent(PhosphorAll as IconModule, spec.name);
}

/**
 * Render an icon to a self-contained SVG string. The returned markup is
 * safe to drop into HTML/PDF exports as-is.
 *
 * Returns null when the icon can't be found — callers should decide
 * whether to log, show a fallback, or skip the placeholder.
 */
export function resolveIconSvg(
  input: string | IconSpec,
  opts: IconResolveOptions = {},
): string | null {
  const spec = typeof input === "string" ? parseIconSpec(input) : input;
  const Component = resolveIconComponent(spec);
  if (!Component) return null;

  const size = opts.size ?? 20;
  const color = opts.color ?? "currentColor";
  const props: Record<string, unknown> = {
    size,
    color,
    className: opts.className,
  };
  if (spec.set === "lucide" && opts.strokeWidth != null) {
    props.strokeWidth = opts.strokeWidth;
  }
  if (spec.set === "phosphor" && opts.weight) {
    props.weight = opts.weight;
  }
  return renderToStaticMarkup(React.createElement(Component, props));
}

/**
 * Enumerate available icons. Useful for the icon picker.
 *
 * Returns sorted names with the `Icon` alias suffixes deduplicated.
 *
 * The Lucide and Phosphor modules export thousands of components each, and
 * `IconPicker` invokes `searchIcons` (which calls into here) on every
 * keystroke. We memoise the per-set result at module scope so the picker
 * re-uses the same sorted array instead of re-walking `Object.keys` every
 * render — the underlying module is immutable for the process lifetime.
 */
const LIST_ICONS_CACHE: Partial<Record<IconSet, string[]>> = {};

export function listIcons(set: IconSet): string[] {
  const cached = LIST_ICONS_CACHE[set];
  if (cached) return cached;
  const mod = (set === "lucide" ? LucideAll : PhosphorAll) as IconModule;
  const seen = new Set<string>();
  for (const key of Object.keys(mod)) {
    if (!/^[A-Z]/.test(key)) continue;
    // Phosphor exposes both `Home` and `HomeIcon` (legacy alias). Strip
    // the trailing Icon so the picker doesn't show duplicates.
    const base = key.endsWith("Icon") && key.length > 4 ? key.slice(0, -4) : key;
    if (typeof mod[key] !== "function" && typeof mod[key] !== "object")
      continue;
    seen.add(base);
  }
  const sorted = Array.from(seen).sort();
  LIST_ICONS_CACHE[set] = sorted;
  return sorted;
}

/**
 * Search icons by case-insensitive substring on the icon name.
 * Returns up to `limit` matches (default 100). Used by the picker's
 * search box.
 */
export function searchIcons(
  set: IconSet,
  query: string,
  limit = 100,
): string[] {
  const q = query.trim().toLowerCase();
  const names = listIcons(set);
  if (!q) return names.slice(0, limit);
  const out: string[] = [];
  for (const n of names) {
    if (n.toLowerCase().includes(q)) {
      out.push(n);
      if (out.length >= limit) break;
    }
  }
  return out;
}

/**
 * Token grammar accepted by `embedIcons`:
 *
 *   {{icon:lucide:home}}
 *   {{icon:lucide:home size=24}}
 *   {{icon:phosphor:check-circle weight=bold size=32 color=#7C3AED}}
 *
 * The token is replaced with an inline `<svg>` string at export time so
 * the Rust HTML/PDF exporter never has to know about the JS icon
 * catalogs. Tokens that don't resolve are left intact so the user can
 * see something is wrong (rather than a silent blank).
 */
const ICON_TOKEN_RE = /\{\{icon:([a-zA-Z0-9_:\-+# .=]+)\}\}/g;

interface ParsedIconToken {
  spec: IconSpec;
  opts: IconResolveOptions;
}

function parseToken(inner: string): ParsedIconToken | null {
  // inner looks like "lucide:home" or "lucide:home size=24 color=#7C3AED"
  const parts = inner.trim().split(/\s+/);
  if (parts.length === 0) return null;
  const head = parts[0];
  const spec = parseIconSpec(head);
  if (!spec.name) return null;
  const opts: IconResolveOptions = {};
  for (const tail of parts.slice(1)) {
    const eq = tail.indexOf("=");
    if (eq === -1) continue;
    const k = tail.slice(0, eq).toLowerCase();
    const v = tail.slice(eq + 1);
    if (k === "size") {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) opts.size = n;
    } else if (k === "color") {
      opts.color = v;
    } else if (k === "strokewidth" || k === "stroke-width") {
      const n = Number(v);
      if (Number.isFinite(n) && n > 0) opts.strokeWidth = n;
    } else if (k === "weight") {
      opts.weight = v as PhosphorWeight;
    }
  }
  return { spec, opts };
}

/**
 * Replace `{{icon:...}}` tokens in `text` with inline `<svg>` markup
 * resolved against the Lucide / Phosphor catalogs. Returns the rewritten
 * string. Idempotent for tokens that don't resolve (they are left in
 * place so missing icons are visible during authoring).
 */
export function embedIcons(text: string): string {
  return text.replace(ICON_TOKEN_RE, (match, inner: string) => {
    const parsed = parseToken(inner);
    if (!parsed) return match;
    const svg = resolveIconSvg(parsed.spec, parsed.opts);
    return svg ?? match;
  });
}
