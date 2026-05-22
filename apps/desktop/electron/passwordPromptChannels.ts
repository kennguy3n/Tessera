/**
 * Shared IPC channel names for the password-prompt window.
 *
 * Imported by BOTH:
 *
 *   - `passwordVault.ts` (main process, registers `ipcMain` listeners)
 *   - `passwordPromptPreload.ts` (preload, calls `ipcRenderer.send`)
 *
 * Kept in a standalone file (no `electron`, no `fs`, no `crypto`,
 * no `path` imports) so the preload — which runs in a sandboxed
 * renderer process where `fs`/`crypto`/etc. are unavailable — can
 * safely import this module without dragging in the rest of
 * `passwordVault.ts`. A constants-only module is the minimum surface
 * we can share across the sandbox boundary.
 *
 * Why this exists: previously these strings were declared
 * independently in `passwordVault.ts` and `passwordPromptPreload.ts`.
 * Renaming the channel in one place but not the other would silently
 * break the prompt — the submit button would fire on a channel main
 * isn't listening on, and the await would hang forever. Now there's
 * a single source of truth.
 *
 * The channels are fixed (not per-window-ID interpolated) because
 * at most one prompt window can be open at a time —
 * `promptForVaultPassword` `await`s the promise before any other
 * code path can call it again.
 */

export const PASSWORD_PROMPT_SUBMIT_CHANNEL = "password-vault:submit";
export const PASSWORD_PROMPT_CANCEL_CHANNEL = "password-vault:cancel";
