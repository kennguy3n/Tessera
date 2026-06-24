/**
 * End-to-end signature-enforcement tests for the auto-updater
 * pipeline. We exercise the real `update-downloaded` event handler
 * registered in `autoUpdater.ts` against a fake `electron-updater`
 * that lets us synthesize events, then assert the broadcast status +
 * the install-gate behaviour.
 *
 * Signatures are real Ed25519 — we generate a per-test keypair, sign
 * the staged artifact bytes, and inject the public key as a custom
 * anchor by overriding the verifier's anchor argument. The autoUpdater
 * itself calls `verifyUpdateSignature(artifactPath)` (no `anchors`
 * override) so we mock the verifier through `vi.mock("../updaterSignature")`
 * with a delegating implementation that injects per-test anchors.
 */

import * as crypto from "crypto";
import * as fs from "fs";
import * as os from "os";
import * as path from "path";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const mocks = vi.hoisted(() => {
  const handlers = new Map<
    string,
    (event: unknown, ...args: unknown[]) => unknown
  >();
  const updaterListeners = new Map<string, (...args: unknown[]) => void>();
  const fakeUpdater = {
    autoDownload: true,
    autoInstallOnAppQuit: true,
    logger: null as unknown,
    on(event: string, cb: (...args: unknown[]) => void): void {
      updaterListeners.set(event, cb);
    },
    checkForUpdates: vi.fn().mockResolvedValue(undefined),
    quitAndInstall: vi.fn(),
  };
  return {
    handlers,
    updaterListeners,
    fakeUpdater,
    ipcMain: {
      handle(
        name: string,
        fn: (event: unknown, ...args: unknown[]) => unknown,
      ): void {
        handlers.set(name, fn);
      },
      removeHandler(name: string): void {
        handlers.delete(name);
      },
    },
    config: {
      autoUpdate: false,
      enforceUpdateSignature: true,
    },
    testAnchors: [] as string[],
    counterCalls: [] as string[],
  };
});

async function invoke(name: string, ...args: unknown[]): Promise<unknown> {
  const fn = mocks.handlers.get(name);
  if (!fn) throw new Error(`No handler registered for ${name}`);
  return fn({}, ...args);
}

function emitUpdaterEvent(event: string, ...args: unknown[]): void {
  const cb = mocks.updaterListeners.get(event);
  if (!cb) throw new Error(`No listener registered for ${event}`);
  cb(...args);
}

vi.mock("electron", () => ({
  app: {
    isPackaged: true,
    getPath: vi.fn().mockReturnValue("/tmp"),
    whenReady: vi.fn().mockResolvedValue(undefined),
  },
  BrowserWindow: {
    getAllWindows: () => [],
  },
  ipcMain: mocks.ipcMain,
}));

vi.mock("electron-updater", () => ({
  autoUpdater: mocks.fakeUpdater,
}));

vi.mock("../config", () => ({
  loadConfig: () => ({
    autoUpdate: mocks.config.autoUpdate,
    enforceUpdateSignature: mocks.config.enforceUpdateSignature,
  }),
  updateConfig: (
    patch: Partial<{ autoUpdate: boolean; enforceUpdateSignature: boolean }>,
  ) => {
    Object.assign(mocks.config, patch);
  },
}));

vi.mock("../logger", () => ({
  getLogger: () => ({
    info: vi.fn(),
    warn: vi.fn(),
    error: vi.fn(),
    debug: vi.fn(),
  }),
}));

vi.mock("../telemetrySink", () => ({
  recordCounter: (key: string) => {
    mocks.counterCalls.push(key);
  },
}));

// Delegating verifier mock — injects per-test anchors into every
// `verifyUpdateSignature(path)` call. The real implementation is
// imported here (NOT mocked away) so the actual Ed25519 crypto runs.
vi.mock("../updaterSignature", async () => {
  const actual = await vi.importActual<typeof import("../updaterSignature")>(
    "../updaterSignature",
  );
  return {
    ...actual,
    verifyUpdateSignature: (
      artifactPath: string,
      options?: { anchors?: readonly string[]; signaturePath?: string },
    ) => {
      return actual.verifyUpdateSignature(artifactPath, {
        ...options,
        anchors: options?.anchors ?? mocks.testAnchors,
      });
    },
  };
});

import {
  _injectUpdaterForTests,
  _resetForTests,
  _setInstallGateStateForTests,
  registerAutoUpdaterIpc,
} from "../autoUpdater";
import { SIGNATURE_SUFFIX } from "../updaterSignature";

function generateTestKeypair(): {
  publicKeyBase64: string;
  privateKey: crypto.KeyObject;
} {
  const { publicKey, privateKey } = crypto.generateKeyPairSync("ed25519");
  const spki = publicKey.export({ type: "spki", format: "der" });
  const raw = spki.subarray(12);
  return { publicKeyBase64: raw.toString("base64"), privateKey };
}

let tmpDir: string;

beforeEach(() => {
  _resetForTests();
  mocks.handlers.clear();
  mocks.updaterListeners.clear();
  mocks.config.autoUpdate = false;
  mocks.config.enforceUpdateSignature = true;
  mocks.testAnchors = [];
  mocks.counterCalls = [];
  mocks.fakeUpdater.quitAndInstall = vi.fn();
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), "tessera-au-sig-"));
  // Wire the IPC handlers + the updater listeners. We use the
  // test-only injection hook instead of `initAutoUpdater()` because
  // the production path goes through `require("electron-updater")`,
  // which vitest's ESM `vi.mock("electron-updater", …)` cannot
  // intercept reliably across the test runner's transform layer.
  registerAutoUpdaterIpc();
  _injectUpdaterForTests(
    mocks.fakeUpdater as unknown as Parameters<
      typeof _injectUpdaterForTests
    >[0],
  );
});

afterEach(() => {
  try {
    fs.rmSync(tmpDir, { recursive: true, force: true });
  } catch {
    /* ignore */
  }
});

describe("update-downloaded — enforcement ON", () => {
  it("transitions to 'downloaded' when the signature verifies against a trust anchor", async () => {
    const { publicKeyBase64, privateKey } = generateTestKeypair();
    mocks.testAnchors = [publicKeyBase64];

    const artifactPath = path.join(tmpDir, "Tessera-Setup-1.2.3.exe");
    const payload = Buffer.from("signed installer bytes");
    fs.writeFileSync(artifactPath, payload);
    fs.writeFileSync(
      `${artifactPath}${SIGNATURE_SUFFIX}`,
      crypto.sign(null, payload, privateKey),
    );

    emitUpdaterEvent("update-downloaded", {
      version: "1.2.3",
      downloadedFile: artifactPath,
    });

    const status = (await invoke("updates:status")) as {
      status: string;
      newVersion?: string;
    };
    expect(status.status).toBe("downloaded");
    expect(status.newVersion).toBe("1.2.3");
    expect(mocks.counterCalls).toContain("update.signature_pass");
  });

  it("transitions to 'signature-rejected' when the signature does NOT verify", async () => {
    const trustedKey = generateTestKeypair();
    const attackerKey = generateTestKeypair();
    mocks.testAnchors = [trustedKey.publicKeyBase64];

    const artifactPath = path.join(tmpDir, "Tessera-Setup-1.2.3.exe");
    const payload = Buffer.from("malicious installer bytes");
    fs.writeFileSync(artifactPath, payload);
    fs.writeFileSync(
      `${artifactPath}${SIGNATURE_SUFFIX}`,
      crypto.sign(null, payload, attackerKey.privateKey),
    );

    emitUpdaterEvent("update-downloaded", {
      version: "1.2.3",
      downloadedFile: artifactPath,
    });

    const status = (await invoke("updates:status")) as {
      status: string;
      signature?: { reason?: string };
    };
    expect(status.status).toBe("signature-rejected");
    expect(status.signature?.reason).toBe("verification-failed");
    expect(mocks.counterCalls).toContain("update.signature_fail");
  });

  it("transitions to 'signature-rejected' when the .sig file is missing", async () => {
    const { publicKeyBase64 } = generateTestKeypair();
    mocks.testAnchors = [publicKeyBase64];

    const artifactPath = path.join(tmpDir, "Tessera-Setup-1.2.3.exe");
    fs.writeFileSync(artifactPath, Buffer.from("installer bytes"));

    emitUpdaterEvent("update-downloaded", {
      version: "1.2.3",
      downloadedFile: artifactPath,
    });

    const status = (await invoke("updates:status")) as {
      status: string;
      signature?: { reason?: string };
    };
    expect(status.status).toBe("signature-rejected");
    expect(status.signature?.reason).toBe("signature-missing");
  });

  it("transitions to 'signature-rejected' when downloadedFile is missing from the event payload", async () => {
    const { publicKeyBase64 } = generateTestKeypair();
    mocks.testAnchors = [publicKeyBase64];

    emitUpdaterEvent("update-downloaded", { version: "1.2.3" });

    const status = (await invoke("updates:status")) as {
      status: string;
      signature?: { reason?: string };
    };
    expect(status.status).toBe("signature-rejected");
    expect(status.signature?.reason).toBe("verifier-error");
  });
});

describe("update-downloaded — enforcement OFF", () => {
  it("transitions to 'downloaded' without verifying", async () => {
    mocks.config.enforceUpdateSignature = false;
    // Note: NO `.sig` file on disk, NO anchors configured. Enforcement
    // off means we don't care.
    const artifactPath = path.join(tmpDir, "Tessera-Setup-1.2.3.exe");
    fs.writeFileSync(artifactPath, Buffer.from("anything"));

    emitUpdaterEvent("update-downloaded", {
      version: "1.2.3",
      downloadedFile: artifactPath,
    });

    const status = (await invoke("updates:status")) as { status: string };
    expect(status.status).toBe("downloaded");
    expect(mocks.counterCalls).not.toContain("update.signature_pass");
    expect(mocks.counterCalls).not.toContain("update.signature_fail");
  });
});

describe("updates:install gate — enforcement ON", () => {
  it("allows install when signature has verified", async () => {
    const { publicKeyBase64, privateKey } = generateTestKeypair();
    mocks.testAnchors = [publicKeyBase64];

    const artifactPath = path.join(tmpDir, "Tessera-Setup-1.2.3.exe");
    const payload = Buffer.from("signed installer");
    fs.writeFileSync(artifactPath, payload);
    fs.writeFileSync(
      `${artifactPath}${SIGNATURE_SUFFIX}`,
      crypto.sign(null, payload, privateKey),
    );

    emitUpdaterEvent("update-downloaded", {
      version: "1.2.3",
      downloadedFile: artifactPath,
    });

    const result = (await invoke("updates:install")) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(mocks.fakeUpdater.quitAndInstall).toHaveBeenCalled();
  });

  it("blocks install when signature has been rejected", async () => {
    const trustedKey = generateTestKeypair();
    const attackerKey = generateTestKeypair();
    mocks.testAnchors = [trustedKey.publicKeyBase64];

    const artifactPath = path.join(tmpDir, "Tessera-Setup-1.2.3.exe");
    const payload = Buffer.from("malicious installer");
    fs.writeFileSync(artifactPath, payload);
    fs.writeFileSync(
      `${artifactPath}${SIGNATURE_SUFFIX}`,
      crypto.sign(null, payload, attackerKey.privateKey),
    );

    emitUpdaterEvent("update-downloaded", {
      version: "1.2.3",
      downloadedFile: artifactPath,
    });
    // Even though `lastStatus` is "signature-rejected" (not "downloaded"),
    // the explicit guard fires first; we assert the guard message.
    const result = (await invoke("updates:install")) as {
      ok: boolean;
      message?: string;
    };
    expect(result.ok).toBe(false);
    expect(mocks.fakeUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("blocks install when no download has been verified yet", async () => {
    // No `update-downloaded` event has been emitted; install should
    // be refused both because `lastStatus !== "downloaded"` AND because
    // there is no positive signature check on file.
    const result = (await invoke("updates:install")) as {
      ok: boolean;
      message?: string;
    };
    expect(result.ok).toBe(false);
  });

  it("resets the signature cache on a new download cycle", async () => {
    const { publicKeyBase64, privateKey } = generateTestKeypair();
    mocks.testAnchors = [publicKeyBase64];

    // First download succeeds and caches a positive result.
    const artifactPath = path.join(tmpDir, "Tessera-Setup-1.2.3.exe");
    const payload = Buffer.from("first install");
    fs.writeFileSync(artifactPath, payload);
    fs.writeFileSync(
      `${artifactPath}${SIGNATURE_SUFFIX}`,
      crypto.sign(null, payload, privateKey),
    );
    emitUpdaterEvent("update-downloaded", {
      version: "1.2.3",
      downloadedFile: artifactPath,
    });

    // Then a new download cycle starts — `download-progress` clears
    // the cache. Without that clear, calling `updates:install` next
    // would inherit the prior `ok: true`.
    emitUpdaterEvent("download-progress", { percent: 10 });

    const result = (await invoke("updates:install")) as { ok: boolean };
    expect(result.ok).toBe(false);
    expect(mocks.fakeUpdater.quitAndInstall).not.toHaveBeenCalled();
  });
});

describe("updates:install gate — enforcement OFF", () => {
  it("allows install when verification is disabled and download succeeded", async () => {
    mocks.config.enforceUpdateSignature = false;
    const artifactPath = path.join(tmpDir, "Tessera-Setup-1.2.3.exe");
    fs.writeFileSync(artifactPath, Buffer.from("anything"));

    emitUpdaterEvent("update-downloaded", {
      version: "1.2.3",
      downloadedFile: artifactPath,
    });

    const result = (await invoke("updates:install")) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(mocks.fakeUpdater.quitAndInstall).toHaveBeenCalled();
  });
});

describe("update-downloaded — enforcement ON but no trust anchors configured", () => {
  // Regression for the production-breaking interim state: shipping
  // `enforceUpdateSignature: true` (the config default) with an empty
  // `UPDATER_TRUST_ANCHORS` array (until the release pipeline starts
  // signing artifacts) used to silently broadcast `signature-rejected`
  // for every download, breaking auto-updates for every user. The
  // handler now special-cases `reason: "no-trust-anchors"` to log a
  // WARN and fall through to `downloaded`.
  it("transitions to 'downloaded' (with a skip counter) when no anchors are configured", async () => {
    mocks.testAnchors = []; // <-- empty anchor array
    const artifactPath = path.join(tmpDir, "Tessera-Setup-1.2.3.exe");
    const payload = Buffer.from("any installer bytes");
    fs.writeFileSync(artifactPath, payload);
    // Sig file is irrelevant — verifier short-circuits before reading
    // it when anchors are empty. We omit it to confirm that.

    emitUpdaterEvent("update-downloaded", {
      version: "1.2.3",
      downloadedFile: artifactPath,
    });

    const status = (await invoke("updates:status")) as {
      status: string;
      newVersion?: string;
      signature?: { reason?: string };
    };
    expect(status.status).toBe("downloaded");
    expect(status.newVersion).toBe("1.2.3");
    // The signature payload is preserved so a renderer can surface
    // the "verification skipped" state to the user if it wants to.
    expect(status.signature?.reason).toBe("no-trust-anchors");
    // Telemetry tags the skip distinctly from pass/fail so an
    // operator can see how many installs are in the no-anchor interim.
    expect(mocks.counterCalls).toContain("update.signature_skipped_no_anchors");
    expect(mocks.counterCalls).not.toContain("update.signature_pass");
    expect(mocks.counterCalls).not.toContain("update.signature_fail");
  });

  it("allows install (with a WARN log) when no anchors are configured", async () => {
    mocks.testAnchors = [];
    const artifactPath = path.join(tmpDir, "Tessera-Setup-1.2.3.exe");
    fs.writeFileSync(artifactPath, Buffer.from("any installer bytes"));

    emitUpdaterEvent("update-downloaded", {
      version: "1.2.3",
      downloadedFile: artifactPath,
    });

    const result = (await invoke("updates:install")) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(mocks.fakeUpdater.quitAndInstall).toHaveBeenCalled();
  });
});

describe("updates:install gate — defense-in-depth (state injected directly)", () => {
  // Regression for ANALYSIS_0002: the install-time signature gate is
  // defense-in-depth that fires only when a hypothetical caller
  // somehow constructs the state `lastStatus.status === "downloaded"`
  // + `lastSignatureCheck.ok === false`. The production
  // `update-downloaded` handler refuses to put the system into that
  // state (it broadcasts `signature-rejected` instead of `downloaded`
  // when verification fails), so the guard is unreachable through
  // normal event flow. These tests inject the state directly via the
  // `_setInstallGateStateForTests` hook so a regression in the
  // install-gate path is caught even if the download-gate stays
  // healthy.
  it("blocks install when lastStatus is 'downloaded' but lastSignatureCheck.ok is false (verification-failed)", async () => {
    _setInstallGateStateForTests(
      { status: "downloaded", newVersion: "1.2.3" },
      {
        ok: false,
        reason: "verification-failed",
        message: "Signature did not verify against any trust anchor",
      },
    );

    const result = (await invoke("updates:install")) as {
      ok: boolean;
      message?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.message).toContain("did not verify");
    expect(mocks.fakeUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("blocks install when lastStatus is 'downloaded' but lastSignatureCheck is null (cache cleared)", async () => {
    // Simulates the `download-progress` race where the in-flight
    // verifier never wrote a result. The install gate refuses rather
    // than letting a stale `downloaded` status leak through.
    _setInstallGateStateForTests(
      { status: "downloaded", newVersion: "1.2.3" },
      null,
    );

    const result = (await invoke("updates:install")) as {
      ok: boolean;
      message?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Signature verification has not run");
    expect(mocks.fakeUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("blocks install for signature-malformed even when lastStatus says downloaded", async () => {
    _setInstallGateStateForTests(
      { status: "downloaded", newVersion: "1.2.3" },
      {
        ok: false,
        reason: "signature-malformed",
        message: "Signature length 12 is not the expected 64 bytes",
      },
    );

    const result = (await invoke("updates:install")) as {
      ok: boolean;
      message?: string;
    };
    expect(result.ok).toBe(false);
    expect(result.message).toContain("Signature length");
    expect(mocks.fakeUpdater.quitAndInstall).not.toHaveBeenCalled();
  });

  it("allows install for the no-trust-anchors skip even when ok is false", async () => {
    // The only `ok: false` reason that DOES pass the install gate is
    // `no-trust-anchors` — the deliberate fall-through documented in
    // both the download handler and the install gate.
    _setInstallGateStateForTests(
      { status: "downloaded", newVersion: "1.2.3" },
      {
        ok: false,
        reason: "no-trust-anchors",
        message: "Refusing to verify update: UPDATER_TRUST_ANCHORS is empty",
      },
    );

    const result = (await invoke("updates:install")) as { ok: boolean };
    expect(result.ok).toBe(true);
    expect(mocks.fakeUpdater.quitAndInstall).toHaveBeenCalled();
  });
});
