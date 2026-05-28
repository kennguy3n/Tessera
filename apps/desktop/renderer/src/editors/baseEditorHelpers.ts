/**
 * Pure parsers for `BaseEditor`'s artifact body.
 *
 * Extracted out of `BaseEditor.tsx` so the component file's exports
 * are all components — required for React Fast Refresh to preserve
 * editor state across HMR edits. `import type` is used to break the
 * runtime cycle with the component file (types are erased at
 * compile time, so the cycle exists only at the type level).
 */
import type { BaseContent } from "./BaseEditor";

/**
 * Decode the artifact's serialized JSON body into the in-memory
 * BaseContent shape the editor mounts. Falls back to a
 * two-field (Name + Status) default when the body is empty or
 * not valid JSON.
 *
 * Exported so unit tests can pin this independently of the
 * BaseEditor's full render pipeline.
 */
export function parseBaseContent(content: string): BaseContent {
  if (!content) {
    return {
      fields: [
        { name: "Name", type: "text" },
        { name: "Status", type: "text" },
      ],
      records: [{ Name: "", Status: "" }],
    };
  }
  try {
    const parsed = JSON.parse(content) as BaseContent;
    if (parsed.fields && Array.isArray(parsed.fields)) {
      return parsed;
    }
  } catch {
    // Not JSON
  }
  return {
    fields: [{ name: "Name", type: "text" }],
    records: [{ Name: content }],
  };
}
