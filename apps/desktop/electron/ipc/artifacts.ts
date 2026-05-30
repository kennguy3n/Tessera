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
import {
  assertId,
  assertNumber,
  assertString,
  assertStringArray,
} from "./validate";
import { MarpExportSchema, TypstExportSchema } from "./schemas";
import { getSafeExportRoots, getDenyExportRoots } from "./shared";
import { BATCH_MAX_ITEMS, runBatch } from "./batch";
import {
  writeRecovery,
  loadRecovery,
  clearRecovery,
} from "../artifactRecovery";
import {
  enqueueFailedExport,
  listFailedExports,
  removeFailedExport,
  bumpRetryCount,
  getFailedExport,
} from "../failedExportQueue";

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
      if (!bridge) {
        throw new Error("Native bridge not available");
      }
      // Phase 15 Task 8: write the recovery sidecar BEFORE the bridge
      // call so a crash inside the N-API boundary still leaves a
      // restorable copy on disk. The sidecar is removed AFTER the
      // bridge call returns successfully; if recovery-write itself
      // fails we still attempt the bridge save (the recovery layer
      // is defence-in-depth, not the primary persistence path) but
      // log so a disk-full / permission regression is visible.
      try {
        await writeRecovery(aId, c);
      } catch (e) {
        console.error(
          `[tessera] artifact recovery sidecar write failed (id=${aId}); proceeding with bridge save:`,
          e,
        );
      }
      // If the bridge save throws (DB locked, disk full, etc.)
      // we deliberately let the exception propagate to the
      // renderer WITHOUT clearing the recovery sidecar — the
      // sidecar contains the user's latest in-flight edits and
      // is exactly what we want to keep on disk so the next
      // launch can offer to restore them. Letting the throw
      // bubble naturally (rather than wrapping in a try/catch +
      // re-throw) keeps eslint's `no-useless-catch` happy AND
      // matches the implicit contract that the sidecar lifecycle
      // is: written before bridge, cleared only after bridge ack.
      const result = bridge.bridgeUpdateArtifactContent(aId, c);
      // Bridge confirmed the new content is in the DB — sidecar
      // is now redundant. Failure to clear is non-fatal (a stale
      // sidecar will be detected at next open and the
      // `checkRecovery` handler's timestamp comparison will
      // resolve it correctly because the DB row's `updated_at`
      // is newer).
      await clearRecovery(aId).catch((e) => {
        console.warn(
          `[tessera] failed to clear recovery sidecar after successful save (id=${aId}); will be cleared at next open:`,
          e,
        );
      });
      return result;
    },
  );

  // Phase 15 Task 8: recovery-check entrypoint. Called by the
  // renderer when an artifact is opened, to decide whether to show
  // the "Restore unsaved changes from <time>?" prompt. Returns the
  // recovery envelope if there's a sidecar newer than the DB row's
  // `updated_at`, otherwise `null` (no prompt).
  //
  // We could have folded this into `artifacts:get`, but keeping it a
  // separate handler means a renderer that doesn't know about
  // recovery just doesn't call this channel and pays no cost — and
  // the `artifacts:get` IPC shape stays unchanged for older callers.
  idempotentHandle(
    "artifacts:checkRecovery",
    async (_event, id: unknown) => {
      const aId = assertId(id, "artifactId");
      const env = await loadRecovery(aId);
      if (env === null) return null;
      const bridge = getBridge();
      if (!bridge) {
        // No bridge means we can't compare against the DB row, so
        // we conservatively return the envelope and let the
        // renderer decide. In practice this only fires in tests
        // and headless harnesses.
        return env;
      }
      // The bridge's `bridgeGetArtifact` returns the canonical row
      // including `updatedAt` in ISO-8601 form. We compare against
      // the sidecar's epoch-ms `timestamp` and only surface the
      // envelope if the sidecar is STRICTLY newer — a sidecar
      // older than the DB row indicates the save succeeded and we
      // missed the post-save cleanup (the recovery is stale).
      let dbUpdatedAtMs: number | null = null;
      try {
        const artifact = bridge.bridgeGetArtifact(aId);
        if (artifact && typeof artifact.updatedAt === "string") {
          const parsed = Date.parse(artifact.updatedAt);
          if (!Number.isNaN(parsed)) dbUpdatedAtMs = parsed;
        }
      } catch {
        // Unknown artifact id — fall through and surface the
        // envelope; the renderer will reject if the id is bogus.
      }
      if (dbUpdatedAtMs !== null && env.timestamp <= dbUpdatedAtMs) {
        // DB row caught up; clear the stale sidecar so the next
        // open doesn't have to make this decision again.
        await clearRecovery(aId).catch(() => undefined);
        return null;
      }
      return env;
    },
  );

  // Phase 15 Task 8: explicit-discard entrypoint. Renderer calls
  // this when the user clicks "Discard" on the restore prompt.
  // Idempotent (the underlying `clearRecovery` swallows `ENOENT`),
  // so a duplicate click is harmless.
  idempotentHandle(
    "artifacts:discardRecovery",
    async (_event, id: unknown) => {
      const aId = assertId(id, "artifactId");
      await clearRecovery(aId);
      return true;
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

  // Phase 15 Task 6: bulk export entrypoint. Bulk export is a real
  // workflow (the user picks a project's worth of slide decks and
  // exports them to PDF) and the per-artifact `artifacts:export`
  // channel was the obvious choke point — every artifact paid one
  // IPC round-trip plus one renderer-side `Promise.all` slot,
  // which for 30 decks meant 30 N-API bridge re-entries with no
  // amortisation. The batched call funnels them into one
  // contiguous bridge sequence and isolates per-item failures so
  // one bad deck doesn't fail the whole job.
  //
  // The `contentOverride` argument from the single-shot
  // `artifacts:export` is intentionally NOT forwarded — bulk
  // export pulls the canonical artifact body from the DB for
  // every id, the renderer can't reasonably supply 30 different
  // overrides in one call. If a future surface needs the
  // override, add a separate
  // `artifacts:batchExportWithOverrides(items: { id, override }[])`
  // channel rather than complicate this shape.
  idempotentHandle(
    "artifacts:batchExport",
    async (_event, artifactIds: unknown, format: unknown) => {
      const ids = assertStringArray(artifactIds, "artifactIds", {
        maxLen: BATCH_MAX_ITEMS,
        itemMaxLen: 128,
      });
      const validatedIds = ids.map((id) => assertId(id, "artifactId"));
      const fmt = assertString(format, "format", { maxLen: 32 });
      const bridge = getBridge();
      if (!bridge) {
        throw new Error("Native bridge not available");
      }
      return runBatch(validatedIds, async (id) =>
        bridge.bridgeExportArtifact(id, fmt, null),
      );
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
      // Phase 15 Task 10: wrap the bridge call so any failure
      // (Typst syntax error, disk full, permission denied during
      // the actual write) is enqueued into the failed-export
      // queue. The user can then inspect / one-click-retry from
      // Settings. We do NOT enqueue when the user explicitly
      // cancelled the save dialog above (handled by the earlier
      // `return null` path).
      try {
        bridge.bridgeExportArtifactToFile(aId, fmt, resolvedPath, co);
      } catch (e) {
        const message = e instanceof Error ? e.message : String(e);
        // Best-effort enqueue: a queue-write failure here is
        // doubly unfortunate (the export already failed) but
        // must not mask the original export error from the
        // renderer, so we just log.
        await enqueueFailedExport({
          artifactId: aId,
          format: fmt,
          filePath: resolvedPath,
          errorMessage: message,
        }).catch((qe) =>
          console.warn(
            `[tessera] failed to enqueue failed-export (id=${aId}, fmt=${fmt}):`,
            qe,
          ),
        );
        throw e;
      }
      return resolvedPath;
    },
  );

  // Phase 15 Task 10: list the persisted failed-export queue. Read-
  // only; the renderer's Settings page polls this to render the
  // "Failed exports" card. Snapshot read — no consistency concerns
  // because the atomic-rename writer guarantees we see a
  // self-consistent file.
  idempotentHandle("artifacts:failedExports", async () => {
    return listFailedExports();
  });

  // Phase 15 Task 10: one-click retry of a previously failed export.
  // Pulls the original arguments from the queue and re-runs them
  // through the bridge. Two outcomes:
  //   * success → dequeues the entry and returns the resolved path.
  //   * failure → bumps `retryCount` and re-throws so the renderer
  //     can show the error inline.
  // Idempotent against duplicate clicks: if the entry is already
  // gone (concurrent removal), returns null.
  idempotentHandle("artifacts:retryExport", async (_event, id: unknown) => {
    const entryId = assertString(id, "exportId", { maxLen: 128 });
    const entry = await getFailedExport(entryId);
    if (!entry) return null;
    const bridge = getBridge();
    if (!bridge) {
      throw new Error("Native bridge not available");
    }
    // Re-check the destination path against the safe-export
    // allowlist before retry. A path that was safe when originally
    // attempted might not be safe now if the allowlist tightened
    // (e.g. the user reset the Downloads override). This also
    // forecloses the corner case where a malicious file at the
    // path could redirect the write — checking again is cheap and
    // closes the gap structurally.
    if (
      entry.filePath &&
      path.isAbsolute(entry.filePath) &&
      !isSafeExportPath(
        entry.filePath,
        getSafeExportRoots(),
        getDenyExportRoots(),
      )
    ) {
      throw new Error(
        `Retry destination is no longer in the safe-export allowlist: ${entry.filePath}`,
      );
    }
    await fsp.mkdir(path.dirname(entry.filePath), { recursive: true });
    try {
      bridge.bridgeExportArtifactToFile(
        entry.artifactId,
        entry.format,
        entry.filePath,
        null,
      );
      await removeFailedExport(entryId);
      return entry.filePath;
    } catch (e) {
      await bumpRetryCount(entryId).catch(() => undefined);
      throw e;
    }
  });

  // Phase 15 Task 10: explicit-discard for a failed-export entry.
  // Used when the user clicks "Dismiss" instead of "Retry" — e.g.
  // because the artifact has since been deleted and retry is no
  // longer meaningful.
  idempotentHandle(
    "artifacts:discardFailedExport",
    async (_event, id: unknown) => {
      const entryId = assertString(id, "exportId", { maxLen: 128 });
      return removeFailedExport(entryId);
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
