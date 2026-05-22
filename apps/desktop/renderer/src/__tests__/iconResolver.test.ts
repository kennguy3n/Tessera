import { describe, it, expect } from "vitest";
import {
  resolveIconSvg,
  resolveIconComponent,
  parseIconSpec,
  toPascalCase,
  listIcons,
  searchIcons,
  embedIcons,
  iconsToTextPlaceholder,
} from "../services/iconResolver";

describe("iconResolver", () => {
  describe("toPascalCase", () => {
    it("converts kebab/snake/space/camel to PascalCase", () => {
      expect(toPascalCase("home")).toBe("Home");
      expect(toPascalCase("check-circle")).toBe("CheckCircle");
      expect(toPascalCase("check_circle")).toBe("CheckCircle");
      expect(toPascalCase("CheckCircle")).toBe("CheckCircle");
      expect(toPascalCase("file text")).toBe("FileText");
    });
  });

  describe("parseIconSpec", () => {
    it("parses prefixed names", () => {
      expect(parseIconSpec("lucide:home")).toEqual({
        set: "lucide",
        name: "home",
      });
      expect(parseIconSpec("phosphor:check-circle")).toEqual({
        set: "phosphor",
        name: "check-circle",
      });
    });

    it("defaults bare names to lucide", () => {
      expect(parseIconSpec("home")).toEqual({ set: "lucide", name: "home" });
    });

    it("falls back to lucide for unknown prefixes", () => {
      expect(parseIconSpec("octicons:home")).toEqual({
        set: "lucide",
        name: "home",
      });
    });
  });

  describe("resolveIconComponent", () => {
    it("finds a known lucide icon", () => {
      const c = resolveIconComponent({ set: "lucide", name: "home" });
      expect(c).toBeTruthy();
    });

    it("finds a known phosphor icon", () => {
      const c = resolveIconComponent({ set: "phosphor", name: "check-circle" });
      expect(c).toBeTruthy();
    });

    it("returns null for unknown names", () => {
      expect(
        resolveIconComponent({
          set: "lucide",
          name: "this-icon-does-not-exist",
        }),
      ).toBeNull();
    });
  });

  describe("resolveIconSvg", () => {
    it("renders a lucide icon to <svg> markup", () => {
      const svg = resolveIconSvg("lucide:home", { size: 24 });
      expect(svg).toBeTruthy();
      expect(svg!.startsWith("<svg")).toBe(true);
      expect(svg!).toContain("width=\"24\"");
      expect(svg!).toContain("height=\"24\"");
    });

    it("honours strokeWidth on lucide icons", () => {
      const svg = resolveIconSvg("lucide:home", {
        size: 24,
        strokeWidth: 1.5,
      });
      expect(svg).toContain("stroke-width=\"1.5\"");
    });

    it("renders a phosphor icon to <svg>", () => {
      const svg = resolveIconSvg("phosphor:check-circle", {
        size: 32,
        weight: "bold",
      });
      expect(svg).toBeTruthy();
      expect(svg!).toContain("<svg");
      expect(svg!).toContain("32");
    });

    it("defaults to lucide for bare names", () => {
      const svg = resolveIconSvg("settings");
      expect(svg).toBeTruthy();
      expect(svg!.startsWith("<svg")).toBe(true);
    });

    it("returns null for unknown icons", () => {
      expect(resolveIconSvg("lucide:nope-such-icon-xyz")).toBeNull();
    });

    it("applies a custom color", () => {
      const svg = resolveIconSvg("lucide:home", { color: "#7C3AED" });
      // Lucide passes color through to `color=` or `stroke=` depending on
      // the version; assert it shows up somewhere in the output.
      expect(svg).toMatch(/#7C3AED/);
    });

    it("falls back to currentColor when the color value fails CSS-color validation", () => {
      // (iconResolver color consistency). We share the same sanitizer as
      // InfographicEditor / LandingPageEditor so an injection payload in
      // the color slot cannot ride through to the inlined SVG attribute.
      const malicious = "red; background-image: url('javascript:alert(1)')";
      const svg = resolveIconSvg("lucide:home", { color: malicious });
      expect(svg).toBeTruthy();
      expect(svg).not.toContain("javascript:");
      expect(svg).not.toContain("background-image");
      // The fallback `currentColor` keeps the icon themable while making
      // the rejected payload invisible.
      expect(svg).toMatch(/currentColor/i);
    });

    it("accepts well-formed rgb() and hsl() colors", () => {
      expect(resolveIconSvg("lucide:home", { color: "rgb(124, 58, 237)" }))
        .toMatch(/rgb\(124, 58, 237\)/);
      expect(resolveIconSvg("lucide:home", { color: "hsl(258, 85%, 58%)" }))
        .toMatch(/hsl\(258, 85%, 58%\)/);
    });
  });

  describe("listIcons / searchIcons", () => {
    it("lists lucide icons", () => {
      const icons = listIcons("lucide");
      expect(icons.length).toBeGreaterThan(100);
      expect(icons).toContain("Home");
    });

    it("lists phosphor icons", () => {
      const icons = listIcons("phosphor");
      expect(icons.length).toBeGreaterThan(100);
      // Phosphor's "Home" icon — also exposed as `HomeIcon` legacy alias.
      expect(icons).toContain("House");
    });

    it("search filters by substring case-insensitively", () => {
      const matches = searchIcons("lucide", "fold");
      expect(matches.length).toBeGreaterThan(0);
      expect(matches.every((n) => /fold/i.test(n))).toBe(true);
    });

    it("search respects the limit", () => {
      const all = searchIcons("lucide", "");
      const limited = searchIcons("lucide", "", 25);
      expect(limited.length).toBe(25);
      expect(all.length).toBeGreaterThan(limited.length);
    });
  });

  describe("embedIcons", () => {
    it("replaces a simple lucide token with inline svg", () => {
      const text = "Hello {{icon:lucide:home}} world";
      const out = embedIcons(text);
      expect(out).not.toContain("{{icon:");
      expect(out).toMatch(/<svg/);
      expect(out).toMatch(/<\/svg>/);
    });

    it("honors size, color, strokeWidth attributes", () => {
      const out = embedIcons(
        "{{icon:lucide:home size=32 color=#FF0000 strokeWidth=1.5}}",
      );
      expect(out).toContain("width=\"32\"");
      expect(out).toContain("stroke-width=\"1.5\"");
      expect(out).toMatch(/#FF0000/);
    });

    it("handles phosphor tokens with weight", () => {
      const out = embedIcons(
        "{{icon:phosphor:check-circle weight=bold size=20}}",
      );
      expect(out).toContain("<svg");
      expect(out).toContain("20");
    });

    it("leaves unresolved tokens intact", () => {
      const text = "x {{icon:lucide:nope-such-icon-xyz}} y";
      expect(embedIcons(text)).toBe(text);
    });

    it("ignores text without tokens", () => {
      expect(embedIcons("nothing to do here")).toBe("nothing to do here");
    });

    it("rewrites multiple tokens in one pass", () => {
      const out = embedIcons(
        "a {{icon:lucide:home}} b {{icon:lucide:settings}} c",
      );
      const svgCount = (out.match(/<svg/g) ?? []).length;
      expect(svgCount).toBe(2);
    });
  });

  describe("iconsToTextPlaceholder", () => {
    // The fallback PDF builder is text-only — these tests lock in the
    // contract that icon tokens degrade to "[name]" placeholders
    // instead of inline <svg> markup that the builder would render as
    // garbled escaped text.
    it("replaces tokens with [name] placeholders", () => {
      const out = iconsToTextPlaceholder(
        "a {{icon:lucide:home}} b {{icon:phosphor:check-circle weight=bold}} c",
      );
      expect(out).toBe("a [home] b [check-circle] c");
      expect(out).not.toMatch(/<svg/);
      expect(out).not.toMatch(/\{\{icon:/);
    });

    it("is idempotent — running twice produces the same output", () => {
      const text = "Hello {{icon:lucide:home}}";
      const once = iconsToTextPlaceholder(text);
      const twice = iconsToTextPlaceholder(once);
      expect(twice).toBe(once);
      expect(once).toBe("Hello [home]");
    });

    it("leaves unresolved-name tokens intact (so missing icons stay visible)", () => {
      // Token with no parseable name is left alone for authoring
      // visibility — same behavior as embedIcons.
      expect(iconsToTextPlaceholder("x {{icon:}} y")).toBe("x {{icon:}} y");
    });

    it("ignores text without tokens", () => {
      expect(iconsToTextPlaceholder("plain text")).toBe("plain text");
    });
  });
});
