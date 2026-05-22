/**
 * IPC handlers for the `templates:*` channels.
 *
 * Templates are the YAML-defined artifact blueprints in `templates/`.
 * They are read-only from the renderer's perspective; this module
 * therefore exposes only `list` and `get`.
 */
import { getBridge } from "../appState";
import { assertId } from "./validate";
import { idempotentHandle } from "./register";

export function registerTemplatesHandlers(): void {
  idempotentHandle("templates:list", async () => {
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeListTemplates();
    }
    return [];
  });

  idempotentHandle("templates:get", async (_event, id: unknown) => {
    const validated = assertId(id, "templateId");
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeGetTemplate(validated);
    }
    return null;
  });
}
