/**
 * Test-only re-export of MermaidExtension's private constants.
 *
 * The MermaidExtension module is a React component file (registers a Tiptap
 * NodeView), so any non-component export breaks the React Fast Refresh
 * boundary for the entire file. Constants used by unit tests live here
 * instead, and the component file re-imports them.
 *
 * Production code should NOT import from this module — use MermaidExtension's
 * public API. The `__testing` name is preserved for parity with the
 * pre-extraction import call sites.
 */

export const DEFAULT_DSL = `flowchart TD
  A[Start] --> B{Decision?}
  B -- Yes --> C[OK]
  B -- No  --> D[Stop]`;

export const DEBOUNCE_MS = 250;

export const __testing = {
  DEFAULT_DSL,
  DEBOUNCE_MS,
};
