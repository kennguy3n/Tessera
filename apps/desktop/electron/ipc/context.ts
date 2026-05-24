/**
 * Shared IPC handler context (per-domain registrar pattern).
 *
 * Every domain module receives this context object via its
 * `register*Handlers(ctx)` registrar. Capturing the shared state in
 * a single object instead of via globals/imports:
 *   - Makes the handler modules easy to test (pass a fake context).
 *   - Makes the dependency graph between handler modules explicit
 *     (rather than reaching into appState / tokenVault / config from
 *     wherever a handler happens to be defined).
 *   - Lets the registrar bind utilities (rate limiter, logger,
 *     safe-export roots) once, so handlers don't have to redo that
 *     work on every call.
 */

import { app, BrowserWindow, dialog } from "electron";
import * as os from "os";
import * as fsp from "fs/promises";
import * as path from "path";

import type { Logger } from "../logger";
import type { NativeBridge } from "../appState";
import { getBridge } from "../appState";
import * as tokenVault from "../tokenVault";
import * as secretsVault from "../secretsVault";
import { isSafeExportPath } from "../exportPathSafety";
import { RateLimiter } from "./rateLimiter";

export interface IpcContext {
  /** Logger that writes to the rotating log file. */
  log: Logger;
  /** Per-process rate limiter. */
  rateLimiter: RateLimiter;
  /** Get the native Rust bridge or throw if it's unavailable. */
  requireBridge(): NativeBridge;
  /** Get the user data directory (cached). */
  userDataDir(): string;
  /** Get the allowlist of safe export roots, computed lazily. */
  safeExportRoots(): string[];
  /** Resolve a user-supplied path against the safe-export allowlist. */
  ensureSafeExportPath(p: string): string;
  /** Show the native save dialog seeded with the given default name. */
  promptSaveDialog(
    event: Electron.IpcMainInvokeEvent,
    defaultName: string,
    title: string,
  ): Promise<string | null>;
  /** Token vault namespace handle. */
  tokenVault: typeof tokenVault;
  /** Secrets vault namespace handle. */
  secretsVault: typeof secretsVault;
  /** Bind a destroyed-window-safe sender for an IPC channel. */
  safeRendererSender<T>(
    event: Electron.IpcMainInvokeEvent,
    channel: string,
  ): (payload: T) => void;
}

export function createDefaultContext(
  log: Logger,
  rateLimiter: RateLimiter,
): IpcContext {
  return {
    log,
    rateLimiter,
    requireBridge(): NativeBridge {
      const bridge = getBridge();
      if (!bridge) throw new Error("Native bridge not available");
      return bridge;
    },
    userDataDir(): string {
      return app.getPath("userData");
    },
    safeExportRoots(): string[] {
      const roots: string[] = [];
      for (const key of [
        "downloads",
        "documents",
        "desktop",
        "home",
        "userData",
      ]) {
        try {
          const p = app.getPath(key as Parameters<typeof app.getPath>[0]);
          if (p) roots.push(p);
        } catch {
          // Some keys are unavailable on headless platforms (e.g.
          // `desktop` on a CI runner). Skip per-key so a missing
          // standard folder doesn't disable the whole allowlist.
        }
      }
      try {
        roots.push(os.tmpdir());
      } catch {
        // skip
      }
      return roots;
    },
    ensureSafeExportPath(p: string): string {
      const roots = this.safeExportRoots();
      if (!path.isAbsolute(p)) {
        throw new Error(`Export path must be absolute (got ${p})`);
      }
      if (!isSafeExportPath(p, roots)) {
        throw new Error(
          `Export path is outside the allowed locations (Downloads, Documents, Desktop, Home, App data, system temp): ${p}`,
        );
      }
      return p;
    },
    async promptSaveDialog(
      event: Electron.IpcMainInvokeEvent,
      defaultName: string,
      title: string,
    ): Promise<string | null> {
      const downloads = app.getPath("downloads");
      const suggested = path.join(downloads, defaultName);
      const win = BrowserWindow.fromWebContents(event.sender) ?? undefined;
      const result = await (win
        ? dialog.showSaveDialog(win, { defaultPath: suggested, title })
        : dialog.showSaveDialog({ defaultPath: suggested, title }));
      if (result.canceled || !result.filePath) return null;
      await fsp.mkdir(path.dirname(result.filePath), { recursive: true });
      return result.filePath;
    },
    tokenVault,
    secretsVault,
    safeRendererSender<T>(
      event: Electron.IpcMainInvokeEvent,
      channel: string,
    ): (payload: T) => void {
      const win = BrowserWindow.fromWebContents(event.sender);
      return (payload: T) => {
        if (!win || win.isDestroyed()) return;
        try {
          win.webContents.send(channel, payload);
        } catch (err) {
          log.warn(`${channel} emit failed (continuing)`, {
            error: (err as Error).message,
          });
        }
      };
    },
  };
}
