/**
 * IPC handlers for the `citations:*` channels.
 *
 * Citations bind a span of artifact content back to a specific
 * (source, chunk) pair so the UI can render provenance, and so the
 * "source changed" / "freshness" checks can detect when the cited
 * chunk no longer exists upstream.
 *
 * The inline `AddCitationRequest` / `ReplaceCitationRequest` shapes
 * MUST match the Rust N-API structs in
 * `crates/tessera_bridge/src/citations.rs`. The zod schemas in
 * `./schemas.ts` enforce that contract at the IPC boundary so a
 * malformed payload from a buggy renderer never reaches the SQL
 * driver.
 */
import { ipcMain } from "electron";
import { getBridge } from "../appState";
import { assertId } from "./validate";
import { AddCitationSchema, ReplaceCitationSchema } from "./schemas";

export function registerCitationsHandlers(): void {
  ipcMain.handle("citations:list", async (_event, artifactId: unknown) => {
    const validated = assertId(artifactId, "artifactId");
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeListCitations(validated);
    }
    return [];
  });

  ipcMain.handle("citations:add", async (_event, req: unknown) => {
    const parsed = AddCitationSchema.parse(req);
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeAddCitation(parsed);
    }
    throw new Error("Native bridge not available");
  });

  ipcMain.handle(
    "citations:remove",
    async (_event, artifactId: unknown, citationId: unknown) => {
      const aId = assertId(artifactId, "artifactId");
      const cId = assertId(citationId, "citationId");
      const bridge = getBridge();
      if (bridge) {
        bridge.bridgeRemoveCitation(aId, cId);
        return;
      }
      throw new Error("Native bridge not available");
    },
  );

  ipcMain.handle(
    "citations:checkChanged",
    async (_event, citationId: unknown) => {
      const validated = assertId(citationId, "citationId");
      const bridge = getBridge();
      if (bridge) {
        return bridge.bridgeCheckSourceChanged(validated);
      }
      throw new Error("Native bridge not available");
    },
  );

  ipcMain.handle(
    "citations:checkFreshness",
    async (_event, citationId: unknown) => {
      const validated = assertId(citationId, "citationId");
      const bridge = getBridge();
      if (bridge) {
        return bridge.bridgeCheckCitationFreshness(validated);
      }
      throw new Error("Native bridge not available");
    },
  );

  ipcMain.handle("citations:replace", async (_event, req: unknown) => {
    const parsed = ReplaceCitationSchema.parse(req);
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeReplaceCitation(parsed);
    }
    throw new Error("Native bridge not available");
  });
}
