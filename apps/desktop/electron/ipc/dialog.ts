/**
 * IPC handlers for the `dialog:*` channels.
 *
 * Thin wrapper over Electron's native save dialog so the renderer can
 * trigger a save-as flow without holding a `BrowserWindow` handle
 * directly.
 */
import { BrowserWindow, dialog, ipcMain } from "electron";

export function registerDialogHandlers(): void {
  ipcMain.handle(
    "dialog:showSaveDialog",
    async (event, options: Electron.SaveDialogOptions) => {
      const win = BrowserWindow.fromWebContents(event.sender);
      const result = win
        ? await dialog.showSaveDialog(win, options)
        : await dialog.showSaveDialog(options);
      return result;
    },
  );
}
