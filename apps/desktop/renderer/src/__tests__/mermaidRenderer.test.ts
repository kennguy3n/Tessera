import { describe, it, expect, beforeEach } from "vitest";
import {
  renderMermaid,
  detectDiagramType,
  SUPPORTED_DIAGRAM_TYPES,
  wrapSvgForEmbed,
  resetMermaidForTests,
  __testing,
  initializeMermaid,
  MermaidRenderError,
  MermaidEnvironmentError,
} from "../services/mermaidRenderer";

describe("mermaidRenderer", () => {
  beforeEach(() => {
    resetMermaidForTests();
  });

  describe("detectDiagramType", () => {
    it("detects flowchart from `flowchart` keyword", () => {
      expect(detectDiagramType("flowchart TD\nA-->B")).toBe("flowchart");
    });

    it("detects flowchart from legacy `graph` keyword", () => {
      expect(detectDiagramType("graph LR\nA-->B")).toBe("flowchart");
    });

    it("detects all officially supported types", () => {
      const samples: Record<(typeof SUPPORTED_DIAGRAM_TYPES)[number], string> =
        {
          flowchart: "flowchart TD\nA-->B",
          sequence: "sequenceDiagram\nA->>B: Hi",
          class: "classDiagram\nclass Foo",
          state: "stateDiagram-v2\n[*] --> A",
          gantt: "gantt\ntitle Demo",
          er: "erDiagram\nA ||--o{ B : has",
          pie: "pie\ntitle Breakdown",
          architecture: "architecture-beta\ngroup api",
          mindmap: "mindmap\nroot",
          timeline: "timeline\ntitle History",
        };
      for (const [type, dsl] of Object.entries(samples)) {
        expect(detectDiagramType(dsl)).toBe(type);
      }
    });

    it("skips %% comment lines", () => {
      expect(detectDiagramType("%% header\n%% notes\npie\ntitle X")).toBe(
        "pie",
      );
    });

    it("returns 'unknown' for empty input", () => {
      expect(detectDiagramType("")).toBe("unknown");
      expect(detectDiagramType("   \n  ")).toBe("unknown");
    });

    it("returns 'unknown' for unrecognized first non-comment line", () => {
      expect(detectDiagramType("not_a_diagram\nfoo")).toBe("unknown");
    });
  });

  describe("wrapSvgForEmbed", () => {
    it("wraps raw svg in tessera container div", () => {
      const out = wrapSvgForEmbed("<svg>x</svg>");
      expect(out).toBe('<div class="tessera-mermaid"><svg>x</svg></div>');
    });
  });

  describe("initializeMermaid", () => {
    it("merges Tessera theme variables with caller overrides", async () => {
      await initializeMermaid({
        themeVariables: { primaryColor: "#ff0000", customVar: "x" } as Record<
          string,
          string
        >,
      });
      expect(__testing.isInitialized()).toBe(true);
    });
  });

  describe("renderMermaid", () => {
    it("rejects empty DSL with a typed error", async () => {
      await expect(renderMermaid("")).rejects.toBeInstanceOf(
        MermaidRenderError,
      );
      await expect(renderMermaid("   ")).rejects.toBeInstanceOf(
        MermaidRenderError,
      );
    });

    it("returns SVG for a valid flowchart", async () => {
      const result = await renderMermaid("flowchart TD\nA-->B");
      expect(result.svg).toContain("<svg");
      expect(result.id).toMatch(/^tessera-mermaid-/);
    });

    it("returns SVG for a sequence diagram", async () => {
      const result = await renderMermaid(
        "sequenceDiagram\nAlice->>Bob: Hello\nBob-->>Alice: Hi",
      );
      expect(result.svg).toContain("<svg");
    });

    it("throws MermaidRenderError for invalid DSL", async () => {
      await expect(
        renderMermaid("flowchart\n!!!syntax broken!!!"),
      ).rejects.toBeInstanceOf(MermaidRenderError);
    });

    it("throws MermaidEnvironmentError when DOM is unavailable", async () => {
      const origWindow = globalThis.window;
      const origDocument = globalThis.document;
      // @ts-expect-error simulating non-browser
      delete globalThis.window;
      // @ts-expect-error simulating non-browser
      delete globalThis.document;
      try {
        await expect(
          renderMermaid("flowchart TD\nA-->B"),
        ).rejects.toBeInstanceOf(MermaidEnvironmentError);
      } finally {
        globalThis.window = origWindow;
        globalThis.document = origDocument;
      }
    });

    it("skipEnvironmentCheck bypasses the DOM availability gate", async () => {
      // Regression for the previous `browserOnly` flag whose semantics were
      // inverted relative to its name. The renamed `skipEnvironmentCheck`
      // is the only opt-out for the DOM check, and a caller that opts out
      // must NOT receive `MermaidEnvironmentError` even when window /
      // document are missing. The downstream mermaid call may still fail
      // for unrelated reasons (we have no real DOM), but it must not be the
      // environment-gate error.
      const origWindow = globalThis.window;
      const origDocument = globalThis.document;
      // @ts-expect-error simulating non-browser
      delete globalThis.window;
      // @ts-expect-error simulating non-browser
      delete globalThis.document;
      try {
        await expect(
          renderMermaid("flowchart TD\nA-->B", { skipEnvironmentCheck: true }),
        ).rejects.not.toBeInstanceOf(MermaidEnvironmentError);
      } finally {
        globalThis.window = origWindow;
        globalThis.document = origDocument;
      }
    });
  });
});
