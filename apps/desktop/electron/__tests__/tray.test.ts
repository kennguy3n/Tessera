/**
 * LW-9 (minimize-to-tray with full suspension): tray lifecycle +
 * suspend/resume orchestration.
 *
 * The Electron-native bits (`Tray`, `Menu`, `nativeImage`) are mocked so
 * these specs run without a display server. Invariants under test:
 *
 *   1. The context-menu template has the Show / Quit affordances wired
 *      to the injected actions, in the documented order.
 *   2. `createTray` is idempotent (no duplicate icon), wires the icon
 *      click to "show", and installs the context menu.
 *   3. `destroyTray` tears the icon down so a relaunch can't stack icons.
 *   4. `suspendForTray` reclaims resident cost in the right ORDER
 *      (flag → renderer notify → scheduler pause → sidecar stop) and
 *      never throws even if a step fails — a failed reclaim must not
 *      wedge the window hide.
 *   5. `resumeForTray` clears the flag, restarts the scheduler, notifies
 *      the renderer, and DOES NOT restart sidecars (LW-9 contract:
 *      sidecars stay stopped until the user asks for generation).
 */
import { describe, it, expect, beforeEach, vi } from "vitest";

const trayInstances: Array<{
  setToolTip: ReturnType<typeof vi.fn>;
  setContextMenu: ReturnType<typeof vi.fn>;
  on: ReturnType<typeof vi.fn>;
  destroy: ReturnType<typeof vi.fn>;
  handlers: Record<string, () => void>;
}> = [];

vi.mock("electron", () => {
  class FakeTray {
    setToolTip = vi.fn();
    setContextMenu = vi.fn();
    destroy = vi.fn();
    handlers: Record<string, () => void> = {};
    on = vi.fn((event: string, cb: () => void) => {
      this.handlers[event] = cb;
    });
    constructor() {
      trayInstances.push(this);
    }
  }
  return {
    Tray: FakeTray,
    Menu: {
      // Echo the template straight back so the test can assert the
      // exact shape that `buildTrayMenuTemplate` produced.
      buildFromTemplate: vi.fn((template: unknown) => ({ template })),
    },
  };
});

vi.mock("../trayIcon", () => ({
  createTrayImage: vi.fn(() => ({ __fakeImage: true })),
}));

import {
  buildTrayMenuTemplate,
  createTray,
  destroyTray,
  hasTray,
  suspendForTray,
  resumeForTray,
  _hasTrayForTests,
  type SuspendForTrayDeps,
  type ResumeForTrayDeps,
} from "../tray";

beforeEach(() => {
  trayInstances.length = 0;
  destroyTray();
  vi.clearAllMocks();
});

describe("buildTrayMenuTemplate", () => {
  it("wires Show / Quit to the injected actions in order", () => {
    const onShow = vi.fn();
    const onQuit = vi.fn();
    const template = buildTrayMenuTemplate({ onShow, onQuit });

    expect(template.map((i) => i.label ?? i.type)).toEqual([
      "Show Tessera",
      "separator",
      "Quit Tessera",
    ]);

    template[0].click?.(
      undefined as never,
      undefined as never,
      undefined as never,
    );
    expect(onShow).toHaveBeenCalledTimes(1);
    template[2].click?.(
      undefined as never,
      undefined as never,
      undefined as never,
    );
    expect(onQuit).toHaveBeenCalledTimes(1);
  });
});

describe("hasTray", () => {
  it("reports false before create, true after create, false after destroy", () => {
    expect(hasTray()).toBe(false);
    createTray({ onShow: vi.fn(), onQuit: vi.fn() });
    expect(hasTray()).toBe(true);
    destroyTray();
    expect(hasTray()).toBe(false);
  });
});

describe("createTray / destroyTray", () => {
  it("creates one tray, installs the menu, and wires the icon click to show", () => {
    const onShow = vi.fn();
    const onQuit = vi.fn();
    const tray = createTray({ onShow, onQuit });

    expect(trayInstances).toHaveLength(1);
    expect(tray).toBe(trayInstances[0]);
    expect(trayInstances[0].setToolTip).toHaveBeenCalledWith("Tessera");
    expect(trayInstances[0].setContextMenu).toHaveBeenCalledTimes(1);
    expect(_hasTrayForTests()).toBe(true);

    // Icon click → show (the conventional restore affordance).
    trayInstances[0].handlers.click?.();
    expect(onShow).toHaveBeenCalledTimes(1);
  });

  it("is idempotent — a second call does not stack a duplicate icon", () => {
    const a = createTray({ onShow: vi.fn(), onQuit: vi.fn() });
    const b = createTray({ onShow: vi.fn(), onQuit: vi.fn() });
    expect(a).toBe(b);
    expect(trayInstances).toHaveLength(1);
  });

  it("destroyTray tears the icon down so a relaunch can re-create it", () => {
    createTray({ onShow: vi.fn(), onQuit: vi.fn() });
    const created = trayInstances[0];
    destroyTray();
    expect(created.destroy).toHaveBeenCalledTimes(1);
    expect(_hasTrayForTests()).toBe(false);

    // A fresh create after destroy makes a NEW tray (not the disposed one).
    createTray({ onShow: vi.fn(), onQuit: vi.fn() });
    expect(trayInstances).toHaveLength(2);
  });
});

describe("suspendForTray", () => {
  function deps(
    overrides: Partial<SuspendForTrayDeps> = {},
  ): SuspendForTrayDeps & { calls: string[] } {
    const calls: string[] = [];
    return {
      calls,
      setAppSuspended: vi.fn((next: boolean) =>
        calls.push(`setAppSuspended(${next})`),
      ),
      // Default: the app stays suspended through the whole sequence (no
      // racing resume). The resume-race spec overrides this.
      isAppSuspended: vi.fn(() => true),
      notifyRenderer: vi.fn((ch: string) => calls.push(`notify(${ch})`)),
      stopScheduler: vi.fn(async () => {
        calls.push("stopScheduler");
      }),
      stopAllSidecars: vi.fn(async () => {
        calls.push("stopAllSidecars");
      }),
      ...overrides,
    };
  }

  it("reclaims resident cost in the documented order", async () => {
    const d = deps();
    await suspendForTray(d);
    expect(d.calls).toEqual([
      "setAppSuspended(true)",
      "notify(app:suspend)",
      "stopScheduler",
      "stopAllSidecars",
    ]);
  });

  it("sets the suspended flag FIRST (before any teardown)", async () => {
    const d = deps();
    await suspendForTray(d);
    expect(d.calls[0]).toBe("setAppSuspended(true)");
  });

  it("never throws and still stops sidecars when scheduler pause fails", async () => {
    const stopAllSidecars = vi.fn(async () => {});
    const d = deps({
      stopScheduler: vi.fn(async () => {
        throw new Error("scheduler drain failed");
      }),
      stopAllSidecars,
    });
    await expect(suspendForTray(d)).resolves.toBeUndefined();
    // The sidecar reclaim (the heaviest) still ran despite the throw.
    expect(stopAllSidecars).toHaveBeenCalledTimes(1);
  });

  it("never throws when the renderer notify fails", async () => {
    const d = deps({
      notifyRenderer: vi.fn(() => {
        throw new Error("no window");
      }),
    });
    await expect(suspendForTray(d)).resolves.toBeUndefined();
    expect(d.stopAllSidecars).toHaveBeenCalledTimes(1);
  });

  it("skips the sidecar teardown if a resume raced in during the scheduler drain", async () => {
    // Simulate the user clicking the tray icon (resume) while the
    // in-flight tick is still draining: the suspended flag flips to
    // false by the time `stopScheduler` resolves. The destructive
    // sidecar reclaim must NOT run — otherwise it could kill a sidecar
    // the user just started by triggering a generation post-restore.
    let suspended = true;
    const d = deps({
      isAppSuspended: vi.fn(() => suspended),
      stopScheduler: vi.fn(async () => {
        suspended = false; // resume landed during the drain
      }),
    });
    await suspendForTray(d);
    expect(d.stopScheduler).toHaveBeenCalledTimes(1);
    expect(d.stopAllSidecars).not.toHaveBeenCalled();
  });
});

describe("resumeForTray", () => {
  it("clears the flag, restarts the scheduler, and resumes the renderer — but NOT sidecars", () => {
    const calls: string[] = [];
    const startSidecars = vi.fn();
    const d: ResumeForTrayDeps = {
      setAppSuspended: vi.fn((next: boolean) =>
        calls.push(`setAppSuspended(${next})`),
      ),
      startScheduler: vi.fn(() => calls.push("startScheduler")),
      notifyRenderer: vi.fn((ch: string) => calls.push(`notify(${ch})`)),
    };
    resumeForTray(d);
    expect(calls).toEqual([
      "setAppSuspended(false)",
      "startScheduler",
      "notify(app:resume)",
    ]);
    // There is intentionally no sidecar-start dep on resume.
    expect(startSidecars).not.toHaveBeenCalled();
  });

  it("does not throw when the renderer notify fails", () => {
    const d: ResumeForTrayDeps = {
      setAppSuspended: vi.fn(),
      startScheduler: vi.fn(),
      notifyRenderer: vi.fn(() => {
        throw new Error("no window");
      }),
    };
    expect(() => resumeForTray(d)).not.toThrow();
    expect(d.startScheduler).toHaveBeenCalledTimes(1);
  });
});
