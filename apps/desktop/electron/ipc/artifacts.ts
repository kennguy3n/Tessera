/**
 * IPC handlers for the `artifacts:*` channels.
 *
 * Covers four concerns in a single domain because the underlying
 * objects and bridge calls overlap so heavily that splitting them
 * would create circular import noise without buying clarity:
 *
 *   1. CRUD + render-time updates (`artifacts:create`, `update`,
 *      `list`, `get`, `remove`)
 *   2. Exports — generic (`artifacts:export`, `exportToFile`) and
 *      format-specialised (`exportTypst`, `exportMarp`,
 *      `exportEvidencePack`)
 *   3. Version history (`artifacts:listVersions`,
 *      `artifacts:restoreVersion`)
 *   4. Template-driven generation + post-generation analysis
 *      (`artifacts:generateFromTemplate`,
 *      `artifacts:extractTasksDecisions`,
 *      `artifacts:compareSources`)
 */
import { app, BrowserWindow, dialog } from "electron";
import { idempotentHandle } from "./register";
import * as fsp from "fs/promises";
import * as path from "path";
import { getBridge } from "../appState";
import { isSafeExportPath } from "../exportPathSafety";
import { dispatchOnGenerate } from "../scheduler";
import { validateExtractedItems } from "../extractedItemValidation";
import { assertId, assertNumber, assertString } from "./validate";
import { MarpExportSchema, TypstExportSchema } from "./schemas";
import { getSafeExportRoots, getDenyExportRoots } from "./shared";

export function registerArtifactsHandlers(): void {
  idempotentHandle(
    "artifacts:create",
    async (
      _event,
      title: unknown,
      artifactType: unknown,
      templateId?: unknown,
    ) => {
      const t = assertString(title, "title", { maxLen: 1024 });
      const a = assertString(artifactType, "artifactType", { maxLen: 64 });
      const tpl =
        templateId === undefined || templateId === null
          ? undefined
          : assertId(templateId, "templateId");
      const bridge = getBridge();
      if (bridge) {
        return bridge.bridgeCreateArtifact(t, a, tpl);
      }
      throw new Error("Native bridge not available");
    },
  );

  idempotentHandle(
    "artifacts:update",
    async (_event, id: unknown, content: unknown) => {
      const aId = assertId(id, "artifactId");
      const c = assertString(content, "content", {
        maxLen: 10_000_000,
        allowEmpty: true,
      });
      const bridge = getBridge();
      if (bridge) {
        return bridge.bridgeUpdateArtifactContent(aId, c);
      }
      throw new Error("Native bridge not available");
    },
  );

  idempotentHandle("artifacts:list", async () => {
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeListArtifacts();
    }
    return [];
  });

  idempotentHandle("artifacts:get", async (_event, id: unknown) => {
    const validated = assertId(id, "artifactId");
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeGetArtifact(validated);
    }
    throw new Error("Native bridge not available");
  });

  idempotentHandle("artifacts:remove", async (_event, id: unknown) => {
    const validated = assertId(id, "artifactId");
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeDeleteArtifact(validated);
    }
    throw new Error("Native bridge not available");
  });

  idempotentHandle(
    "artifacts:export",
    async (
      _event,
      id: unknown,
      format: unknown,
      contentOverride?: unknown,
    ) => {
      const aId = assertId(id, "artifactId");
      const fmt = assertString(format, "format", { maxLen: 32 });
      const co =
        contentOverride === undefined || contentOverride === null
          ? null
          : assertString(contentOverride, "contentOverride", {
              maxLen: 10_000_000,
              allowEmpty: true,
            });
      const bridge = getBridge();
      if (bridge) {
        return bridge.bridgeExportArtifact(aId, fmt, co);
      }
      throw new Error("Native bridge not available");
    },
  );

  idempotentHandle(
    "artifacts:exportToFile",
    async (
      event,
      id: unknown,
      format: unknown,
      filePath: unknown,
      contentOverride?: unknown,
    ) => {
      const aId = assertId(id, "artifactId");
      const fmt = assertString(format, "format", { maxLen: 32 });
      const fp = assertString(filePath, "filePath", {
        maxLen: 4096,
        allowEmpty: true,
      });
      const co =
        contentOverride === undefined || contentOverride === null
          ? null
          : assertString(contentOverride, "contentOverride", {
              maxLen: 10_000_000,
              allowEmpty: true,
            });
      const bridge = getBridge();
      if (!bridge) {
        throw new Error("Native bridge not available");
      }

      // Resolve the final on-disk path. Three modes (in order of
      // preference):
      //   1) An absolute path supplied by the renderer is honoured
      //      only if it resolves inside the allowlist of safe export
      //      roots (Downloads, Documents, Desktop, the user's home
      //      directory, the app's `userData` directory and the
      //      system temp dir). A compromised renderer cannot request
      //      a write to e.g. `/etc/passwd` because `/etc` is not
      //      under any of those roots — `isSafeExportPath` returns
      //      false in that case. Tests + scripted exports that use
      //      `os.tmpdir()` keep working without change.
      //   2) Otherwise (or if the absolute path was rejected as
      //      unsafe), prompt the user via the native save dialog
      //      seeded with the renderer's suggested filename under
      //      ~/Downloads.
      //   3) If the user dismisses the dialog, we return `null` so
      //      the renderer can surface an "Export cancelled" status
      //      without writing any file — matching standard desktop
      //      save-dialog UX.
      let resolvedPath: string;
      if (path.isAbsolute(fp)) {
        if (!isSafeExportPath(fp, getSafeExportRoots(), getDenyExportRoots())) {
          // Refuse the request outright instead of silently
          // rewriting the path or showing the user a dialog with a
          // dangerous suggestion. This is the security boundary;
          // making it visible as an error is the point.
          throw new Error(
            `Export path is outside the allowed locations (Downloads, Documents, Desktop, Home, App data, system temp): ${fp}`,
          );
        }
        resolvedPath = fp;
      } else {
        const downloads = app.getPath("downloads");
        const suggested = path.join(downloads, fp || `artifact.${fmt}`);
        const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
        const result = await (win
          ? dialog.showSaveDialog(win, {
              defaultPath: suggested,
              title: "Export artifact",
            })
          : dialog.showSaveDialog({
              defaultPath: suggested,
              title: "Export artifact",
            }));
        if (result.canceled || !result.filePath) {
          return null;
        }
        resolvedPath = result.filePath;
      }

      // Make sure the parent directory exists before the Rust bridge
      // writes.
      await fsp.mkdir(path.dirname(resolvedPath), { recursive: true });
      bridge.bridgeExportArtifactToFile(aId, fmt, resolvedPath, co);
      return resolvedPath;
    },
  );

  idempotentHandle("artifacts:exportTypst", async (_event, req: unknown) => {
    const parsed = TypstExportSchema.parse(req);
    // Path safety: same allowlist gate as `artifacts:exportToFile`
    // and `artifacts:exportMarp` — a compromised renderer must not
    // be able to turn the Typst export IPC into a write-anywhere
    // primitive by supplying e.g. `/etc/cron.d/malicious` as the
    // output path. Relative / undefined paths fall through to
    // `runTypstExport`'s temp-file default (which uses `os.tmpdir()`,
    // itself in the allowlist).
    if (parsed.outputPath && path.isAbsolute(parsed.outputPath)) {
      if (!isSafeExportPath(parsed.outputPath, getSafeExportRoots(), getDenyExportRoots())) {
        throw new Error(
          `Export path is outside the allowed locations (Downloads, Documents, Desktop, Home, App data, system temp): ${parsed.outputPath}`,
        );
      }
    }
    const { runTypstExport } = await import("../typstExport");
    return runTypstExport({
      markup: parsed.markup,
      format: parsed.format,
      outputPath: parsed.outputPath,
    });
  });

  idempotentHandle("artifacts:exportMarp", async (event, req: unknown) => {
    const parsed = MarpExportSchema.parse(req);
    let resolvedPath: string;
    if (path.isAbsolute(parsed.outputPath)) {
      if (!isSafeExportPath(parsed.outputPath, getSafeExportRoots(), getDenyExportRoots())) {
        throw new Error(
          `Export path is outside the allowed locations (Downloads, Documents, Desktop, Home, App data, system temp): ${parsed.outputPath}`,
        );
      }
      resolvedPath = parsed.outputPath;
    } else {
      const downloads = app.getPath("downloads");
      const fallbackName =
        parsed.outputPath && parsed.outputPath.length > 0
          ? parsed.outputPath
          : `artifact.${parsed.format}`;
      const suggested = path.join(downloads, fallbackName);
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const result = await (win
        ? dialog.showSaveDialog(win, {
            defaultPath: suggested,
            title: "Export slides",
          })
        : dialog.showSaveDialog({
            defaultPath: suggested,
            title: "Export slides",
          }));
      // Standard desktop UX: a cancelled save dialog means no file
      // is written. The renderer translates the `null` return into
      // an "Export cancelled" status indicator.
      if (result.canceled || !result.filePath) {
        return null;
      }
      resolvedPath = result.filePath;
    }
    await fsp.mkdir(path.dirname(resolvedPath), { recursive: true });
    const { runMarpExport } = await import("../marpExport");
    await runMarpExport({
      markdown: parsed.markdown,
      format: parsed.format,
      outputPath: resolvedPath,
      theme: parsed.theme,
      includeNotes: parsed.includeNotes,
      allowHtml: parsed.allowHtml,
    });
    return resolvedPath;
  });

  // --- Version History ---

  idempotentHandle("artifacts:listVersions", async (_event, id: unknown) => {
    const validated = assertId(id, "artifactId");
    const bridge = getBridge();
    if (bridge) {
      return bridge.bridgeListVersions(validated);
    }
    return [];
  });

  idempotentHandle(
    "artifacts:restoreVersion",
    async (_event, id: unknown, versionNumber: unknown) => {
      const aId = assertId(id, "artifactId");
      const v = assertNumber(versionNumber, "versionNumber", {
        integer: true,
        min: 1,
      });
      const bridge = getBridge();
      if (bridge) {
        return bridge.bridgeRestoreVersion(aId, v);
      }
      throw new Error("Native bridge not available");
    },
  );

  // --- Artifact Generation ---

  idempotentHandle(
    "artifacts:generateFromTemplate",
    async (_event, templateId: unknown, sourceIds: unknown) => {
      const tpl = assertId(templateId, "templateId");
      if (!Array.isArray(sourceIds)) {
        throw new Error("sourceIds must be an array of strings");
      }
      const ids = sourceIds.map((s, i) =>
        typeof s === "string"
          ? s
          : (() => {
              throw new Error(
                `sourceIds[${i}] must be a string (got ${typeof s})`,
              );
            })(),
      );
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      const artifact = bridge.bridgeGenerateFromTemplate(tpl, ids);
      // Fire any `OnGenerate` automations tied to this template
      // immediately, off the request critical path. Awaiting would
      // make the user wait on downstream re-indexes / cascade
      // generations before the editor opens; we deliberately don't
      // surface dispatch errors back to the caller — they're recorded
      // per-automation via `bridgeRecordAutomationRun` and visible on
      // the Automations page.
      void dispatchOnGenerate(tpl).catch((e) => {
        console.error("[ipc] OnGenerate dispatch failed:", e);
      });
      return artifact;
    },
  );

  idempotentHandle(
    "artifacts:extractTasksDecisions",
    async (_event, sourceId: unknown) => {
      const sId = assertId(sourceId, "sourceId");
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      const json = bridge.bridgeExtractTasksDecisions(sId);
      // Validate at the IPC boundary so a misbehaving Rust bridge
      // never ships shape-violating data to the renderer. The
      // validator throws on non-array input and on 100%-drop input
      // (unambiguous schema regressions); partial drops return valid
      // items + log a single summary. Logic lives in
      // ./extractedItemValidation so it can be exercised without
      // Electron.
      return validateExtractedItems(JSON.parse(json) as unknown, {
        context: sId,
        warn: (message) => console.warn(message),
      });
    },
  );

  idempotentHandle(
    "artifacts:compareSources",
    async (_event, sourceIdA: unknown, sourceIdB: unknown) => {
      const a = assertId(sourceIdA, "sourceIdA");
      const b = assertId(sourceIdB, "sourceIdB");
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      return bridge.bridgeCompareSources(a, b);
    },
  );

  idempotentHandle(
    "artifacts:exportEvidencePack",
    async (_event, artifactId: unknown, outputPath: unknown) => {
      const aId = assertId(artifactId, "artifactId");
      const op = assertString(outputPath, "outputPath", { maxLen: 4096 });
      // Defence in depth: same safe-path allowlist as the other
      // export channels. Relative paths fall through to the bridge,
      // which writes alongside the artifact's own export directory.
      if (path.isAbsolute(op)) {
        if (!isSafeExportPath(op, getSafeExportRoots(), getDenyExportRoots())) {
          throw new Error(
            `Export path is outside the allowed locations (Downloads, Documents, Desktop, Home, App data, system temp): ${op}`,
          );
        }
      }
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      return bridge.bridgeExportEvidencePack(aId, op);
    },
  );
}
