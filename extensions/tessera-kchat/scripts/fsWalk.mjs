/**
 * Iterative directory walker used by the .kcz build script.
 *
 * Yields absolute paths of regular files, deterministically ordered
 * (alphabetical by depth-first traversal) so the produced .kcz is
 * reproducible byte-for-byte across machines.
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
