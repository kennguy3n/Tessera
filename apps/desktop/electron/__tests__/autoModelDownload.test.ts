/**
 * First-launch auto-download trigger tests (Session 5, Step 1 + 6).
 *
 * `maybeAutoDownloadRecommendedModel` is the authoritative main-process
 * trigger that runs after `init_bridge` succeeds. It is fully
 * dependency-injected, so these tests exercise every precondition branch
 * and the success / failure paths WITHOUT touching Electron, the
 * filesystem, the network, or the real download machinery.
 *
 * The sibling modules are mocked only so importing the module under test
 * is side-effect free in the vitest runtime; the behavior is driven
 * entirely through injected deps.
 */
import { describe, it, expect, vi } from "vitest";

vi.mock("electron", () => ({
  app: { getPath: vi.fn(() => "/tmp/userData") },
  BrowserWindow: { getAllWindows: vi.fn(() => []) },
}));
vi.mock("../config", () => ({ loadConfig: vi.fn() }));
vi.mock("../modelManagement", () => ({
  getInstalledModel: vi.fn(),
  // Mirror the real classifier so the orchestrator can distinguish a
  // user-initiated cancellation from a genuine setup failure.
  isDownloadAbortedError: (err: unknown) =>
    typeof err === "object" &&
    err !== null &&
    ((err as { name?: unknown }).name === "DownloadAbortedError" ||
      (err as { name?: unknown }).name === "AbortError"),
}));
vi.mock("../ipc/runtime", () => ({
  downloadRecommendedModel: vi.fn(),
  resolveRecommendedModel: vi.fn(),
}));
vi.mock("../logger", () => ({
  getLogger: () => ({ info: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

import {
  downloadHostFor,
  maybeAutoDownloadRecommendedModel,
  AUTO_DOWNLOAD_CAPABILITY,
  type AutoDownloadDeps,
} from "../autoModelDownload";
import type { ResolvedModel, InstalledModelRecord } from "../modelManagement";

const model = {
  id: "text-model-v1",
  url: "https://models.example.com/text-model-v1.gguf",
  downloadSizeMb: 450,
  capability: "text",
} as unknown as ResolvedModel;

const record = { modelId: "text-model-v1" } as unknown as InstalledModelRecord;

/** Build a fully-stubbed dep set for the happy path; override per test. */
function deps(overrides: Partial<AutoDownloadDeps> = {}): AutoDownloadDeps {
  return {
    loadConfig: () => ({ autoDownloadModel: true, onboardingCompleted: false }),
    getInstalledModel: vi.fn().mockResolvedValue(null),
    resolveRecommended: vi.fn().mockReturnValue(model),
    isOnline: vi.fn().mockResolvedValue(true),
    download: vi.fn().mockResolvedValue(record),
    broadcast: vi.fn(),
    broadcastError: vi.fn(),
    logger: { info: vi.fn(), warn: vi.fn() },
    ...overrides,
  };
}

describe("downloadHostFor", () => {
  it("returns the host for http/https URLs", () => {
    expect(downloadHostFor(model)).toBe("models.example.com");
    expect(
      downloadHostFor({
        ...model,
        url: "http://h.test/m.gguf",
      } as ResolvedModel),
    ).toBe("h.test");
  });
  it("returns null for non-network URLs (skip the DNS probe)", () => {
    expect(
      downloadHostFor({
        ...model,
        url: "file:///models/m.gguf",
      } as ResolvedModel),
    ).toBeNull();
  });
  it("returns null for an unparseable URL", () => {
    expect(
      downloadHostFor({ ...model, url: "not a url" } as ResolvedModel),
    ).toBeNull();
  });
});

describe("maybeAutoDownloadRecommendedModel", () => {
  it("downloads on a fresh, online install with no model", async () => {
    const d = deps();
    const outcome = await maybeAutoDownloadRecommendedModel(d);
    expect(outcome).toBe("downloaded");
    // The gate-phase resolved model is handed straight to the download
    // (third arg) so the manifest is NOT resolved a second time.
    expect(d.download).toHaveBeenCalledWith(
      AUTO_DOWNLOAD_CAPABILITY,
      d.broadcast,
      model,
    );
    // Resolution happens exactly once — in the gate phase.
    expect(d.resolveRecommended).toHaveBeenCalledTimes(1);
    expect(d.broadcastError).not.toHaveBeenCalled();
  });

  it("treats a cancelled download as a silent opt-out (no error broadcast)", async () => {
    const aborted = Object.assign(new Error("Download cancelled by user"), {
      name: "DownloadAbortedError",
    });
    const d = deps({ download: vi.fn().mockRejectedValue(aborted) });
    expect(await maybeAutoDownloadRecommendedModel(d)).toBe("cancelled");
    // A deliberate cancellation must NOT flash "Setup failed — retry".
    expect(d.broadcastError).not.toHaveBeenCalled();
  });

  it("skips when the user opted out", async () => {
    const d = deps({
      loadConfig: () => ({
        autoDownloadModel: false,
        onboardingCompleted: false,
      }),
    });
    expect(await maybeAutoDownloadRecommendedModel(d)).toBe("disabled");
    expect(d.download).not.toHaveBeenCalled();
  });

  it("skips for an already-onboarded user", async () => {
    const d = deps({
      loadConfig: () => ({
        autoDownloadModel: true,
        onboardingCompleted: true,
      }),
    });
    expect(await maybeAutoDownloadRecommendedModel(d)).toBe("onboarded");
    expect(d.download).not.toHaveBeenCalled();
  });

  it("skips when a model is already installed", async () => {
    const d = deps({ getInstalledModel: vi.fn().mockResolvedValue(record) });
    expect(await maybeAutoDownloadRecommendedModel(d)).toBe(
      "already-installed",
    );
    expect(d.download).not.toHaveBeenCalled();
  });

  it("skips when the manifest has no candidate for this machine", async () => {
    const d = deps({ resolveRecommended: vi.fn().mockReturnValue(null) });
    expect(await maybeAutoDownloadRecommendedModel(d)).toBe("no-candidate");
    expect(d.download).not.toHaveBeenCalled();
  });

  it("skips when offline (does not start a doomed download)", async () => {
    const d = deps({ isOnline: vi.fn().mockResolvedValue(false) });
    expect(await maybeAutoDownloadRecommendedModel(d)).toBe("offline");
    expect(d.download).not.toHaveBeenCalled();
  });

  it("skips the DNS probe for a non-network (file://) model URL", async () => {
    const isOnline = vi.fn();
    const d = deps({
      resolveRecommended: vi
        .fn()
        .mockReturnValue({ ...model, url: "file:///m.gguf" }),
      isOnline,
    });
    expect(await maybeAutoDownloadRecommendedModel(d)).toBe("downloaded");
    expect(isOnline).not.toHaveBeenCalled();
  });

  it("broadcasts a download error and never throws when the fetch fails", async () => {
    const d = deps({
      download: vi.fn().mockRejectedValue(new Error("boom")),
    });
    const outcome = await maybeAutoDownloadRecommendedModel(d);
    expect(outcome).toBe("error");
    expect(d.broadcastError).toHaveBeenCalledWith({
      capability: AUTO_DOWNLOAD_CAPABILITY,
      modelId: "text-model-v1",
      message: "boom",
    });
  });

  it("reports no-candidate (not downloaded) when the download resolves to null", async () => {
    // The gate phase resolved a candidate, but the download path
    // returns null (manifest race, or a dep that declines). We must
    // NOT claim "downloaded": nothing was fetched and no completion
    // event was emitted. It is also not a surfaced failure.
    const d = deps({ download: vi.fn().mockResolvedValue(null) });
    const outcome = await maybeAutoDownloadRecommendedModel(d);
    expect(outcome).toBe("no-candidate");
    expect(d.broadcastError).not.toHaveBeenCalled();
  });

  it("fails silently (no error broadcast) when gating itself throws", async () => {
    const d = deps({
      loadConfig: () => {
        throw new Error("unreadable config");
      },
    });
    const outcome = await maybeAutoDownloadRecommendedModel(d);
    expect(outcome).toBe("error");
    // A gate failure must NOT flash a "Setup failed" banner.
    expect(d.broadcastError).not.toHaveBeenCalled();
    expect(d.download).not.toHaveBeenCalled();
  });
});
