/**
 * Sanitised inline-typography extensions.
 *
 * The stock `@tiptap/extension-text-style` children (`Color`, `FontFamily`,
 * `FontSize`) and `@tiptap/extension-highlight` all interpolate their stored
 * attribute straight into an inline `style` string, e.g.
 *
 *     renderHTML: (attrs) => ({ style: `color: ${attrs.color}` })
 *
 * The attribute round-trips through the saved document, so a crafted artifact
 * — `color: red; background: url(https://evil/pixel)` — would emit extra CSS
 * declarations when rendered. In a multi-tenant deployment that is an
 * injection / privacy-leak vector the moment a document authored by one tenant
 * is opened by another (a `url(...)` background beacons on open).
 *
 * Browsers split a parsed `style` attribute into individual properties, so the
 * `parseHTML` path is mostly safe on its own; the real exposure is the
 * `renderHTML` path, which re-emits whatever value sits on the node — including
 * values injected directly into stored ProseMirror JSON, bypassing HTML
 * parsing. We therefore re-declare each attribute with the same shape but
 * validate the value against a strict allow-list on BOTH read and write, and
 * drop anything outside the grammar rather than serialising it. Every
 * legitimate toolbar preset (hex colours, `16px`, `Inter, system-ui,
 * sans-serif`) passes unchanged.
 */
import { mergeAttributes } from "@tiptap/core";
import { Color, FontFamily, FontSize } from "@tiptap/extension-text-style";
import Highlight from "@tiptap/extension-highlight";

const MAX_LEN = 128;

// `#rgb` / `#rgba` / `#rrggbb` / `#rrggbbaa`.
const HEX = /^#(?:[0-9a-f]{3,4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
// `rgb()` / `rgba()` / `hsl()` / `hsla()`. The inner characters are limited to
// the numeric grammar (digits, separators, units) so no `url(`, identifier or
// `;` can be smuggled inside the parentheses.
const COLOR_FN = /^(?:rgb|rgba|hsl|hsla)\(\s*[0-9.,%/\sdeg]+\)$/i;
// Bare CSS keyword colours. Rather than accept any letters-only token, we match
// against the explicit CSS Color Module Level 4 named-colour set plus the
// CSS-wide keywords. A letters-only regex can never form an injection payload,
// but an exact allow-list rejects garbage (`color: abcxyz`) up front — the
// stricter posture we want for documents that cross tenant boundaries.
const COLOR_KEYWORDS: ReadonlySet<string> = new Set([
  // CSS-wide keywords + functional keywords.
  "transparent",
  "currentcolor",
  "inherit",
  "initial",
  "unset",
  "revert",
  // CSS Color Module Level 4 named colours.
  "aliceblue",
  "antiquewhite",
  "aqua",
  "aquamarine",
  "azure",
  "beige",
  "bisque",
  "black",
  "blanchedalmond",
  "blue",
  "blueviolet",
  "brown",
  "burlywood",
  "cadetblue",
  "chartreuse",
  "chocolate",
  "coral",
  "cornflowerblue",
  "cornsilk",
  "crimson",
  "cyan",
  "darkblue",
  "darkcyan",
  "darkgoldenrod",
  "darkgray",
  "darkgreen",
  "darkgrey",
  "darkkhaki",
  "darkmagenta",
  "darkolivegreen",
  "darkorange",
  "darkorchid",
  "darkred",
  "darksalmon",
  "darkseagreen",
  "darkslateblue",
  "darkslategray",
  "darkslategrey",
  "darkturquoise",
  "darkviolet",
  "deeppink",
  "deepskyblue",
  "dimgray",
  "dimgrey",
  "dodgerblue",
  "firebrick",
  "floralwhite",
  "forestgreen",
  "fuchsia",
  "gainsboro",
  "ghostwhite",
  "gold",
  "goldenrod",
  "gray",
  "green",
  "greenyellow",
  "grey",
  "honeydew",
  "hotpink",
  "indianred",
  "indigo",
  "ivory",
  "khaki",
  "lavender",
  "lavenderblush",
  "lawngreen",
  "lemonchiffon",
  "lightblue",
  "lightcoral",
  "lightcyan",
  "lightgoldenrodyellow",
  "lightgray",
  "lightgreen",
  "lightgrey",
  "lightpink",
  "lightsalmon",
  "lightseagreen",
  "lightskyblue",
  "lightslategray",
  "lightslategrey",
  "lightsteelblue",
  "lightyellow",
  "lime",
  "limegreen",
  "linen",
  "magenta",
  "maroon",
  "mediumaquamarine",
  "mediumblue",
  "mediumorchid",
  "mediumpurple",
  "mediumseagreen",
  "mediumslateblue",
  "mediumspringgreen",
  "mediumturquoise",
  "mediumvioletred",
  "midnightblue",
  "mintcream",
  "mistyrose",
  "moccasin",
  "navajowhite",
  "navy",
  "oldlace",
  "olive",
  "olivedrab",
  "orange",
  "orangered",
  "orchid",
  "palegoldenrod",
  "palegreen",
  "paleturquoise",
  "palevioletred",
  "papayawhip",
  "peachpuff",
  "peru",
  "pink",
  "plum",
  "powderblue",
  "purple",
  "rebeccapurple",
  "red",
  "rosybrown",
  "royalblue",
  "saddlebrown",
  "salmon",
  "sandybrown",
  "seagreen",
  "seashell",
  "sienna",
  "silver",
  "skyblue",
  "slateblue",
  "slategray",
  "slategrey",
  "snow",
  "springgreen",
  "steelblue",
  "tan",
  "teal",
  "thistle",
  "tomato",
  "turquoise",
  "violet",
  "wheat",
  "white",
  "whitesmoke",
  "yellow",
  "yellowgreen",
]);

/** A safe CSS colour: hex, an `rgb/hsl(...)` function, or a named keyword. */
export function isSafeCssColor(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const s = value.trim();
  if (s === "" || s.length > MAX_LEN) return false;
  return HEX.test(s) || COLOR_FN.test(s) || COLOR_KEYWORDS.has(s.toLowerCase());
}

// A number with an allow-listed unit, e.g. `16px`, `1.5em`, `120%`, `.5em`.
// The mantissa accepts a leading-dot form (`.5`) as well as the usual
// `16` / `1.5`, so values pasted from other editors aren't silently dropped.
const FONT_SIZE = /^(?:\d+(?:\.\d+)?|\.\d+)(?:px|em|rem|pt|%)$/;

/** A safe `font-size`: a non-negative number with an allow-listed unit. */
export function isSafeFontSize(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const s = value.trim();
  return s.length <= 16 && FONT_SIZE.test(s);
}

// A font-family list: Unicode letters/marks/digits (so CJK, Arabic, etc.
// names round-trip), underscore, quotes, commas, spaces and hyphens. The
// hyphen is placed first to read unambiguously as a literal. No structural
// CSS characters (`;`, `:`, `(`, `)`, `{`, `}`, `/`) so it can neither break
// out of the declaration nor invoke `url(...)`. The `u` flag is required for
// the `\p{...}` property escapes.
const FONT_FAMILY = /^[-\p{L}\p{M}\p{N}_\s,'"]+$/u;

/** A safe `font-family` list: name tokens, quotes, commas and spaces only. */
export function isSafeFontFamily(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const s = value.trim();
  return s !== "" && s.length <= MAX_LEN && FONT_FAMILY.test(s);
}

/** `Color` that only ever serialises an allow-listed CSS colour. */
export const SafeColor = Color.extend({
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          color: {
            default: null,
            parseHTML: (element) => {
              const raw = element.style.color?.replace(/['"]+/g, "");
              return isSafeCssColor(raw) ? raw.trim() : null;
            },
            renderHTML: (attributes) => {
              const value = attributes.color as unknown;
              if (!isSafeCssColor(value)) return {};
              return { style: `color: ${value.trim()}` };
            },
          },
        },
      },
    ];
  },
});

/** `FontFamily` that only ever serialises an allow-listed family list. */
export const SafeFontFamily = FontFamily.extend({
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontFamily: {
            default: null,
            parseHTML: (element) => {
              const raw = element.style.fontFamily;
              return isSafeFontFamily(raw) ? raw.trim() : null;
            },
            renderHTML: (attributes) => {
              const value = attributes.fontFamily as unknown;
              if (!isSafeFontFamily(value)) return {};
              return { style: `font-family: ${value.trim()}` };
            },
          },
        },
      },
    ];
  },
});

/** `FontSize` that only ever serialises a number with an allow-listed unit. */
export const SafeFontSize = FontSize.extend({
  addGlobalAttributes() {
    return [
      {
        types: this.options.types,
        attributes: {
          fontSize: {
            default: null,
            parseHTML: (element) => {
              const raw = element.style.fontSize;
              return isSafeFontSize(raw) ? raw.trim() : null;
            },
            renderHTML: (attributes) => {
              const value = attributes.fontSize as unknown;
              if (!isSafeFontSize(value)) return {};
              return { style: `font-size: ${value.trim()}` };
            },
          },
        },
      },
    ];
  },
});

/** `Highlight` (multicolor) that only ever serialises a safe CSS colour. */
export const SafeHighlight = Highlight.extend({
  addAttributes() {
    if (!this.options.multicolor) return {};
    return {
      color: {
        default: null,
        parseHTML: (element) => {
          const raw =
            element.getAttribute("data-color") || element.style.backgroundColor;
          return isSafeCssColor(raw) ? raw.trim() : null;
        },
        renderHTML: (attributes) => {
          const value = attributes.color as unknown;
          if (!isSafeCssColor(value)) return {};
          const safe = value.trim();
          return {
            "data-color": safe,
            style: `background-color: ${safe}; color: inherit`,
          };
        },
      },
    };
  },

  // Defence-in-depth: the `color` attribute's own `renderHTML` already
  // sanitises, but we also override the mark-level `renderHTML` so the emitted
  // `<mark>` can never carry a `style`/`data-color` outside the allow-list —
  // independent of how the attribute pipeline (or a future base-extension
  // change) feeds this method. We re-derive `style` from the validated
  // `data-color` rather than trusting whatever `style` arrives.
  renderHTML({ HTMLAttributes }) {
    const dataColor = HTMLAttributes["data-color"];
    const safe = isSafeCssColor(dataColor) ? dataColor.trim() : null;
    // Merge option- and node-level attributes first (so classes etc. survive),
    // then *overwrite* the sanitised keys last. `mergeAttributes` concatenates
    // `style` strings, so a configured `options.HTMLAttributes.style` could
    // otherwise be glued onto our output and smuggle unsafe CSS back in;
    // assigning `style`/`data-color` after the merge discards any such
    // concatenation and guarantees only the validated value is emitted.
    const merged: Record<string, unknown> = mergeAttributes(
      this.options.HTMLAttributes,
      HTMLAttributes,
    );
    if (safe !== null) {
      merged["data-color"] = safe;
      merged.style = `background-color: ${safe}; color: inherit`;
    } else {
      delete merged["data-color"];
      delete merged.style;
    }
    return ["mark", merged, 0];
  },
});
