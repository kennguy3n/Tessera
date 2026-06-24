/**
 * IPC handlers for the `dialog:*` channels.
 *
 * Thin wrapper over Electron's native save / open dialogs so the
 * renderer can trigger file-system interaction without holding a
 * `BrowserWindow` handle directly.
 *
 * The native dialogs themselves can't read or write files (Electron's
 * `dialog` API returns paths only — the renderer still has to use a
 * dedicated IPC like `vision:describe` to act on the chosen file), so
 * the security risk is limited. We still validate every options
 * payload against a strict zod schema to (a) keep the validation
 * policy uniform across every IPC channel and (b) bound the size of
 * strings handed straight to OS APIs — a hostile renderer could
 * otherwise hand `defaultPath` / `title` a 100 MB string and trigger
 * pathological behaviour in the underlying GTK / Cocoa / Win32
 * dialog implementation.
 */
import { BrowserWindow, dialog } from "electron";
import { idempotentHandle } from "./register";
import {
  OpenBundleDialogSchema,
  OpenDirectoryDialogSchema,
  OpenImageDialogSchema,
  SaveDialogOptionsSchema,
} from "./schemas";

/**
 * Extension (no leading dot) of the workspace bundle archive accepted
 * by `dialog:openBundle`. Kept as a constant so the picker filter and
 * any future validation reference the same token. Mirrors the
 * `.tessera-backup` suffix the Rust bundle exporter writes.
 */
export const BUNDLE_EXTENSION = "tessera-backup";

/**
 * Extensions accepted by `dialog:pickImage`. Matches the formats the
 * vision sidecar (llama.cpp with --mmproj) and the indexer's
 * `VisionExtractor` recognise — JPEG (.jpg/.jpeg), PNG, WebP,
 * GIF (first frame), and BMP. Kept in sync with the
 * `image/` MIME-type allow-list the renderer's CSP enumerates;
 * adding a new extension here without also updating the CSP would
 * mean the Vision page picks up the file but the renderer can't
 * preview it.
 *
 * Exported as a constant (not inlined) so the renderer's accept-type
 * tests can pin the list — see `dialogIpc.test.ts`.
 */
export const PICK_IMAGE_EXTENSIONS: readonly string[] = [
  "jpg",
  "jpeg",
  "png",
  "webp",
  "gif",
  "bmp",
];

export function registerDialogHandlers(): void {
  idempotentHandle("dialog:showSaveDialog", async (event, options: unknown) => {
    const parsed = SaveDialogOptionsSchema.parse(options);
    const win = BrowserWindow.fromWebContents(event.sender);
    const result = win
      ? await dialog.showSaveDialog(win, parsed)
      : await dialog.showSaveDialog(parsed);
    return result;
  });

  // `dialog:pickImage` — opens an OS file picker locked to image
  // extensions and returns the chosen absolute path (or `null` if the
  // user cancelled). The Vision page uses this as its single entry
  // point for "pick an image to describe / OCR / analyse" — the
  // path is then forwarded to `vision:describe`.
  //
  // The handler intentionally returns just the path: the renderer has
  // no need for the bytes (the vision sidecar reads the file directly
  // off disk), and shovelling multi-megabyte images through the IPC
  // bridge would burn CPU on a needless base64 round-trip.
  //
  // `properties: ["openFile"]` (singular — no multi-select, no
  // directories) keeps the surface tight; the picker is for a single
  // image at a time and the renderer's UX flow assumes one path back.
  // `dontAddToRecent: true` keeps the OS-level "recent documents"
  // list clean — the user is picking a transient input for an
  // analysis, not opening a document they want to remember.
  idempotentHandle("dialog:pickImage", async (event, options: unknown) => {
    const parsed = OpenImageDialogSchema.parse(options ?? {});
    const win = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: Electron.OpenDialogOptions = {
      title: parsed.title ?? "Choose an image",
      properties: ["openFile", "dontAddToRecent"],
      filters: [
        {
          name: "Images",
          // Spread the readonly constant into a fresh array so
          // Electron's typings (which mutate the filters array
          // internally on some platforms) don't choke on the
          // frozen `as const` shape.
          extensions: [...PICK_IMAGE_EXTENSIONS],
        },
      ],
    };
    const result = win
      ? await dialog.showOpenDialog(win, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, filePath: null };
    }
    // `showOpenDialog` returns an array even with `openFile` (no
    // multi-select), so we explicitly pull the first element.
    return { canceled: false, filePath: result.filePaths[0] };
  });

  // `dialog:openDirectory` — opens an OS folder picker and returns the
  // chosen absolute directory path (or `null` if the user cancelled).
  // Used by Settings → Backup to let the user pick where backups are
  // written. `createDirectory: true` lets macOS users create a fresh
  // folder inline; `dontAddToRecent` keeps the OS "recent" list clean.
  idempotentHandle("dialog:openDirectory", async (event, options: unknown) => {
    const parsed = OpenDirectoryDialogSchema.parse(options ?? {});
    const win = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: Electron.OpenDialogOptions = {
      title: parsed.title ?? "Choose a folder",
      properties: ["openDirectory", "createDirectory", "dontAddToRecent"],
    };
    const result = win
      ? await dialog.showOpenDialog(win, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, filePath: null };
    }
    return { canceled: false, filePath: result.filePaths[0] };
  });

  // `dialog:openBundle` — opens an OS file picker locked to the
  // `.tessera-backup` archive extension and returns the chosen absolute
  // path (or `null` if cancelled). Used by Settings → Backup "Import
  // workspace bundle". `openFile` (singular, no directories / multi-
  // select) keeps the surface tight; `dontAddToRecent` keeps the OS
  // recent-documents list clean.
  idempotentHandle("dialog:openBundle", async (event, options: unknown) => {
    const parsed = OpenBundleDialogSchema.parse(options ?? {});
    const win = BrowserWindow.fromWebContents(event.sender);
    const dialogOptions: Electron.OpenDialogOptions = {
      title: parsed.title ?? "Choose a workspace bundle",
      properties: ["openFile", "dontAddToRecent"],
      filters: [
        { name: "Tessera workspace bundle", extensions: [BUNDLE_EXTENSION] },
        { name: "All files", extensions: ["*"] },
      ],
    };
    const result = win
      ? await dialog.showOpenDialog(win, dialogOptions)
      : await dialog.showOpenDialog(dialogOptions);
    if (result.canceled || result.filePaths.length === 0) {
      return { canceled: true, filePath: null };
    }
    return { canceled: false, filePath: result.filePaths[0] };
  });
}
