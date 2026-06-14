/**
 * Live, injection-safe previews for the structured Slide editor's
 * non-prose block types (`table`, `chart`, `diagram`).
 *
 * Extracted out of `SlideEditor.tsx` so both the structured "Outline"
 * canvas (`SlideBlockRow`) and the WYSIWYG "Design" canvas
 * (`SlideDesignCanvas`) render the exact same preview for a given block
 * source — there is one renderer per block type, not two that can drift
 * apart. All three parse the block's text DSL through the shared
 * helpers in `slideEditorHelpers` and render via React text
 * interpolation / vetted SVG, never raw user `innerHTML`.
 */
import { useEffect, useMemo, useRef, useState } from "react";
import {
  renderMermaid,
  MermaidEnvironmentError,
  MermaidRenderError,
} from "../../services/mermaidRenderer";
import { parseSlideTable, parseSlideChart } from "../slideEditorHelpers";
import { SlideChart } from "./SlideChart";

/**
 * Live preview of a `table` block. Parses the GitHub-flavoured Markdown
 * source into a header + rows and renders a real `<table>`; every cell
 * goes through React's text interpolation (never `innerHTML`), so the
 * preview is injection-safe. Falls back to a placeholder while the
 * source is empty / unparseable.
 */
export function SlideTablePreview({ source }: { source: string }) {
  const table = useMemo(() => parseSlideTable(source), [source]);
  if (!table) {
    return (
      <div className="slide-table-placeholder">
        Add a row like <code>| A | B |</code> to preview a table.
      </div>
    );
  }
  return (
    <div className="slide-table-preview">
      <table className="slide-table">
        <thead>
          <tr>
            {table.header.map((cell, i) => (
              <th key={i} scope="col">
                {cell}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {table.rows.map((row, ri) => (
            <tr key={ri}>
              {row.map((cell, ci) => (
                <td key={ci}>{cell}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
    </div>
  );
}

/**
 * Live preview of a `chart` block. Parses the data DSL and renders it
 * through {@link SlideChart} (shared SVG geometry); shows a placeholder
 * while the source has no plottable series.
 */
export function SlideChartPreview({ source }: { source: string }) {
  const spec = useMemo(() => parseSlideChart(source), [source]);
  if (!spec) {
    return (
      <div className="slide-chart-placeholder">
        Add a <code>labels:</code> line and a data series to preview a chart.
      </div>
    );
  }
  return (
    <div className="slide-chart-preview">
      <SlideChart type={spec.type} data={spec.data} title={spec.title} />
    </div>
  );
}

/**
 * Live preview of a `diagram` block. Renders the Mermaid DSL to SVG via
 * the shared renderer (debounced), surfacing parse / environment errors
 * inline instead of throwing. The emitted SVG comes from the trusted
 * Mermaid renderer, not user HTML.
 */
export function MermaidPreview({ dsl }: { dsl: string }) {
  const [svg, setSvg] = useState<string>("");
  const [error, setError] = useState<string | null>(null);
  const tokenRef = useRef(0);
  useEffect(() => {
    const handle = setTimeout(() => {
      const token = ++tokenRef.current;
      renderMermaid(dsl)
        .then((result) => {
          if (token !== tokenRef.current) return;
          setSvg(result.svg);
          setError(null);
        })
        .catch((err) => {
          if (token !== tokenRef.current) return;
          if (err instanceof MermaidEnvironmentError) {
            setError("Preview unavailable in this context");
          } else if (err instanceof MermaidRenderError) {
            setError(err.message);
          } else {
            setError(String(err));
          }
          setSvg("");
        });
    }, 250);
    return () => clearTimeout(handle);
  }, [dsl]);
  if (error) {
    return (
      <div className="slide-diagram-error" role="alert">
        {error}
      </div>
    );
  }
  if (!svg) return <div className="slide-diagram-placeholder">Rendering…</div>;
  return (
    <div
      className="slide-diagram-preview"
      dangerouslySetInnerHTML={{ __html: svg }}
    />
  );
}
