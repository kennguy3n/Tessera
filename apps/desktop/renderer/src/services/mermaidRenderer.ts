/**
 * Mermaid renderer service — wraps `mermaid.render()` with Tessera's theme
 * (purple accent #7C3AED), supports all major diagram types, and produces
 * an isolated SVG string suitable for embedding inline in HTML or rasterizing
 * during export.
 *
 * The mermaid runtime is heavy (it pulls in dagre, d3, cytoscape, katex, etc.)
 * and only supports a browser-like environment, so we lazy-load it on first
 * use to keep the initial bundle small.
 */
import type { MermaidConfig } from "mermaid";

export interface MermaidRenderResult {
  /** Full <svg ...> markup ready to embed or save. */
  svg: string;
  /** The unique id assigned to this render (used for unmount cleanup). */
  id: string;
  /** Estimated bounding box derived from the SVG attributes. */
  bbox?: { width: number; height: number };
}

export interface MermaidRenderOptions {
  /** Optional override of the auto-generated svg element id. */
  id?: string;
  /** Override the entire mermaid config; merged on top of Tessera defaults. */
  config?: MermaidConfig;
  /** Force browser-only rendering (no-op outside browser). */
  browserOnly?: boolean;
}

const DEFAULT_CONFIG: MermaidConfig = {
  startOnLoad: false,
  securityLevel: "strict",
  theme: "base",
  themeVariables: {
    primaryColor: "#7C3AED",
    primaryTextColor: "#111827",
    primaryBorderColor: "#5B21B6",
    lineColor: "#6B7280",
    secondaryColor: "#F5F3FF",
    tertiaryColor: "#EDE9FE",
    background: "#FFFFFF",
    mainBkg: "#F5F3FF",
    nodeBorder: "#7C3AED",
    clusterBkg: "#FAF5FF",
    clusterBorder: "#A78BFA",
    fontFamily:
      "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  },
  fontFamily:
    "Inter, -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif",
  flowchart: { curve: "basis", htmlLabels: true },
  sequence: { useMaxWidth: true, showSequenceNumbers: false },
  gantt: { useWidth: 1200 },
  pie: { useWidth: 800 },
};

let initialized = false;
let mermaidModule: typeof import("mermaid") | null = null;

async function loadMermaid(): Promise<typeof import("mermaid").default> {
  if (!mermaidModule) {
    mermaidModule = await import("mermaid");
  }
  return mermaidModule.default;
}

export async function initializeMermaid(config?: MermaidConfig): Promise<void> {
  const mermaid = await loadMermaid();
  const merged = mergeConfig(DEFAULT_CONFIG, config);
  mermaid.initialize(merged);
  initialized = true;
}

export function resetMermaidForTests(): void {
  initialized = false;
  mermaidModule = null;
}

/**
 * Render a Mermaid DSL string to an SVG string.
 *
 * On non-browser environments (e.g. cargo / electron main-process IPC) this
 * function throws — diagrams must be rendered in the renderer process and
 * then passed back to the main process for export. We surface that case with
 * a typed error so callers can fall back to inlining the raw DSL.
 */
export async function renderMermaid(
  dsl: string,
  options: MermaidRenderOptions = {},
): Promise<MermaidRenderResult> {
  if (!isBrowserEnvironment() && !options.browserOnly) {
    throw new MermaidEnvironmentError(
      "Mermaid rendering requires a DOM. Render in the renderer process or use a server-side mermaid-cli adapter.",
    );
  }
  if (!initialized) {
    await initializeMermaid(options.config);
  } else if (options.config) {
    const mermaid = await loadMermaid();
    mermaid.initialize(mergeConfig(DEFAULT_CONFIG, options.config));
  }

  const mermaid = await loadMermaid();
  const id = options.id ?? `tessera-mermaid-${cryptoRandomId()}`;
  const sanitized = dsl.trim();
  if (!sanitized) {
    throw new MermaidRenderError("Cannot render empty Mermaid DSL");
  }

  try {
    const result = await mermaid.render(id, sanitized);
    return {
      svg: result.svg,
      id,
      bbox: extractBoundingBox(result.svg),
    };
  } catch (err) {
    throw new MermaidRenderError(
      `Mermaid render failed: ${err instanceof Error ? err.message : String(err)}`,
      { cause: err },
    );
  }
}

export class MermaidRenderError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = "MermaidRenderError";
  }
}

export class MermaidEnvironmentError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "MermaidEnvironmentError";
  }
}

/**
 * Enumerate the diagram types Tessera officially supports — used by the
 * diagram picker UI in the document and slide editors.
 */
export const SUPPORTED_DIAGRAM_TYPES = [
  "flowchart",
  "sequence",
  "class",
  "state",
  "gantt",
  "er",
  "pie",
  "architecture",
  "mindmap",
  "timeline",
] as const;
export type MermaidDiagramType = (typeof SUPPORTED_DIAGRAM_TYPES)[number];

/**
 * Detect the diagram type by scanning the first non-empty / non-comment line
 * of the DSL. Mirrors mermaid's own parser dispatch table without invoking it.
 */
export function detectDiagramType(dsl: string): MermaidDiagramType | "unknown" {
  for (const raw of dsl.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("%%")) continue;
    if (line.startsWith("flowchart") || line.startsWith("graph")) return "flowchart";
    if (line.startsWith("sequenceDiagram")) return "sequence";
    if (line.startsWith("classDiagram")) return "class";
    if (line.startsWith("stateDiagram")) return "state";
    if (line.startsWith("gantt")) return "gantt";
    if (line.startsWith("erDiagram")) return "er";
    if (line.startsWith("pie")) return "pie";
    if (line.startsWith("architecture-beta") || line.startsWith("architecture"))
      return "architecture";
    if (line.startsWith("mindmap")) return "mindmap";
    if (line.startsWith("timeline")) return "timeline";
    return "unknown";
  }
  return "unknown";
}

/** Wrap a raw SVG result in a container that gives it a stable display size. */
export function wrapSvgForEmbed(svg: string): string {
  return `<div class="tessera-mermaid">${svg}</div>`;
}

function isBrowserEnvironment(): boolean {
  return (
    typeof window !== "undefined" &&
    typeof document !== "undefined" &&
    typeof document.createElement === "function"
  );
}

function mergeConfig(base: MermaidConfig, override?: MermaidConfig): MermaidConfig {
  if (!override) return base;
  return {
    ...base,
    ...override,
    themeVariables: {
      ...(base.themeVariables ?? {}),
      ...(override.themeVariables ?? {}),
    },
  };
}

function cryptoRandomId(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID().replace(/-/g, "");
  }
  return Math.random().toString(36).slice(2, 14);
}

function extractBoundingBox(svg: string): { width: number; height: number } | undefined {
  const m = svg.match(/viewBox="0 0 ([\d.]+) ([\d.]+)"/);
  if (!m) return undefined;
  return { width: parseFloat(m[1]), height: parseFloat(m[2]) };
}

export const __testing = {
  DEFAULT_CONFIG,
  isInitialized: () => initialized,
};
