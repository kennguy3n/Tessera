/**
 * Iterative directory walker used by the .kcz build script.
 *
 * Yields absolute paths of regular files in a deterministic order.
 * The order is "reverse-alphabetical depth-first by directory" —
 * within each directory we sort entries alphabetically and push them
 * onto a LIFO stack, so the *last* entry alphabetically is popped
 * first. The exact traversal order is not significant for downstream
 * correctness: `build.mjs` sorts the final file list alphabetically
 * (`zipWriter.mjs:51` — `[...files.keys()].sort()`) before laying
 * out the zip's central directory, so the produced `.kcz` is
 * reproducible byte-for-byte across machines regardless of the order
 * this walker yields in. Determinism is therefore preserved via the
 * downstream sort, not via the walker's local ordering.
 */
import { readdirSync } from "node:fs";
import { resolve } from "node:path";

export function* walkDir(root) {
  const stack = [root];
  while (stack.length > 0) {
    const dir = stack.pop();
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      continue;
    }
    entries.sort((a, b) => a.name.localeCompare(b.name));
    for (const entry of entries) {
      const absPath = resolve(dir, entry.name);
      if (entry.isDirectory()) {
        stack.push(absPath);
      } else if (entry.isFile()) {
        yield absPath;
      }
    }
  }
}
