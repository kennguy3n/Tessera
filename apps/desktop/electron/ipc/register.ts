/**
 * Idempotent IPC handler registration helper.
 *
 * Electron's `ipcMain.handle()` throws "Attempted to register a second
 * handler for 'channel'" if a channel is registered twice. The
 * production main-process startup calls `registerAllIpcHandlers()`
 * exactly once, but two other paths re-import this directory:
 *
 *   1. The vitest test harness re-evaluates the IPC modules whenever a
 *      test's `vi.resetModules()` runs (e.g. tests that exercise the
 *      registrar against a stubbed `ipcMain`).
 *   2. A future hot-reload main-process workflow would re-run module
 *      top-level code on every save.
 *
 * The pre-split monolith only guarded a handful of channels
 * (`connectors:gdrive:*`) inside one explicit `removeHandler` loop —
 * every other handler was "register once and crash on the second
 * call". After splitting `ipc.ts` into eleven per-domain modules the
 * asymmetry became hard to reason about; centralising the
 * remove-then-handle dance in one helper makes every channel
 * idempotent without forcing each domain module to ship its own
 * `removeHandler` loop.
 *
 * Use this helper instead of `ipcMain.handle()` for every channel
 * registered out of `apps/desktop/electron/ipc/*.ts`.
 */
import { ipcMain } from "electron";

type IpcHandlerListener = Parameters<typeof ipcMain.handle>[1];

/**
 * Register an IPC handler that supersedes any previous registration
 * for the same channel. Equivalent to
 * `ipcMain.removeHandler(channel); ipcMain.handle(channel, listener);`
 * but expressed as a single call so the intent ("this channel may have
 * been registered before, and that's fine") is obvious at every call
 * site.
 */
export function idempotentHandle(
  channel: string,
  listener: IpcHandlerListener,
): void {
  ipcMain.removeHandler(channel);
  ipcMain.handle(channel, listener);
}
