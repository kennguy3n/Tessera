/**
 * Preload script for the password vault prompt window.
 *
 * The prompt window is created with `sandbox: true`,
 * `nodeIntegration: false`, and `contextIsolation: true`, so
 * `require('electron')` is NOT available in the renderer page. This
 * preload bridges the gap by exposing a minimal, typed API to the
 * renderer via `contextBridge.exposeInMainWorld`. The renderer can
 * call:
 *
 *   - `window.tesseraPasswordPrompt.submit(password)` — fire-and-forget
 *     message to the main process with the typed password.
 *   - `window.tesseraPasswordPrompt.cancel()` — fire-and-forget message
 *     telling the main process the user explicitly cancelled (vs.
 *     closing the window via the OS chrome).
 *
 * Channel names are **fixed constants** (not interpolated with
 * `win.id`) because at most one prompt window can be open at a time
 * — `promptForVaultPassword` `await`s the promise before any other
 * code can call it again. This sidesteps the `data:` URL query-string
 * limitation that previously made channel routing impossible.
 *
 * The preload deliberately exposes ONLY these two narrow functions.
 * No `ipcRenderer.invoke`, no broad `ipcRenderer` handle, no module
 * loaders. A compromised prompt page can at worst trigger the two
 * pre-existing main-process handlers; it cannot escalate to arbitrary
 * IPC or file access.
 */

import { contextBridge, ipcRenderer } from "electron";

export const PASSWORD_PROMPT_SUBMIT_CHANNEL = "password-vault:submit";
export const PASSWORD_PROMPT_CANCEL_CHANNEL = "password-vault:cancel";

contextBridge.exposeInMainWorld("tesseraPasswordPrompt", {
  submit(password: string): void {
    ipcRenderer.send(PASSWORD_PROMPT_SUBMIT_CHANNEL, { password });
  },
  cancel(): void {
    ipcRenderer.send(PASSWORD_PROMPT_CANCEL_CHANNEL);
  },
});
