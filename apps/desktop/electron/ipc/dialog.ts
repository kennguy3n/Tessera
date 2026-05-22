/**
 * IPC handlers for the `dialog:*` channels.
 *
 * Thin wrapper over Electron's native save dialog so the renderer can
 * trigger a save-as flow without holding a `BrowserWindow` handle
 * directly.
 *
 * The native dialog itself can't write files, so the security risk is
 * limited — but we still validate the options payload against
 * `SaveDialogOptionsSchema` to keep the validation policy uniform
 * across every IPC channel and to bound the size of strings handed
 * straight to OS APIs (a hostile renderer could otherwise hand
 * `defaultPath` a 100 MB string and trigger pathological behaviour in
 * the underlying GTK / Cocoa / Win32 dialog implementation).
 */
import { BrowserWindow, dialog, ipcMain } from "electron";
import { SaveDialogOptionsSchema } from "./schemas";

export function registerDialogHandlers(): void {
  ipcMain.handle(
    "dialog:showSaveDialog",
    async (event, options: unknown) => {
      const parsed = SaveDialogOptionsSchema.parse(options);
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = win
        ? await dialog.showSaveDialog(win, parsed)
        : await dialog.showSaveDialog(parsed);
      return result;
    },
  );
}
