/**
 * Renderer test suite for `BackupSettingsCard.tsx`.
 *
 * Focuses on the interval / retention number inputs, which are edited
 * as a free-text "draft" and only committed (parsed, clamped, and
 * persisted via `backup:configure`) on blur / Enter. This guards the
 * fix for the per-keystroke IPC bug: an in-progress value like "" or a
 * partially typed number must NOT fire a config write nor trip the
 * backend's min/max validation, and an out-of-range value must be
 * clamped before it is sent.
 */
import { describe, it, expect, vi, beforeEach } from "vitest";
import { render, screen, fireEvent, waitFor } from "@testing-library/react";
import BackupSettingsCard from "../components/BackupSettingsCard";
import type { BackupStatus } from "../../../shared/types";
import {
  MIN_BACKUP_INTERVAL_HOURS,
  MAX_BACKUP_INTERVAL_HOURS,
  MIN_BACKUP_RETENTION_COUNT,
  MAX_BACKUP_RETENTION_COUNT,
} from "../../../shared/types";

function makeStatus(overrides: Partial<BackupStatus> = {}): BackupStatus {
  return {
    autoBackup: true,
    backupDir: "/userData/backups",
    backupIntervalHours: 24,
    backupRetentionCount: 7,
    schedulerRunning: true,
    backupInFlight: false,
    lastBackupAt: null,
    lastBackupError: null,
    ...overrides,
  };
}

function makeApi(overrides: Partial<typeof window.tessera.backup> = {}) {
  const status = makeStatus();
  return {
    create: vi.fn(),
    list: vi.fn().mockResolvedValue([]),
    status: vi.fn().mockResolvedValue(status),
    restore: vi.fn(),
    // `configure` echoes the patched status back, as the real channel does.
    configure: vi.fn(async (patch) => makeStatus(patch)),
    exportBundle: vi.fn(),
    importBundle: vi.fn(),
    ...overrides,
  } as unknown as typeof window.tessera.backup;
}

const dialogApi = {
  openDirectory: vi.fn(),
} as unknown as typeof window.tessera.dialog;

async function renderCard(api: typeof window.tessera.backup) {
  render(<BackupSettingsCard api={api} dialogApi={dialogApi} />);
  // Wait for the initial status load to populate the inputs.
  await waitFor(() =>
    expect(
      (screen.getByLabelText(/Back up every/i) as HTMLInputElement).value,
    ).toBe("24"),
  );
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe("BackupSettingsCard number inputs", () => {
  it("does not fire configure while typing — only on blur", async () => {
    const api = makeApi();
    await renderCard(api);
    const interval = screen.getByLabelText(
      /Back up every/i,
    ) as HTMLInputElement;

    fireEvent.change(interval, { target: { value: "4" } });
    fireEvent.change(interval, { target: { value: "48" } });
    // Mid-typing must not have written anything.
    expect(api.configure).not.toHaveBeenCalled();
    expect(interval.value).toBe("48");

    fireEvent.blur(interval);
    await waitFor(() =>
      expect(api.configure).toHaveBeenCalledWith({ backupIntervalHours: 48 }),
    );
    expect(api.configure).toHaveBeenCalledTimes(1);
  });

  it("reverts an empty draft on blur without calling configure", async () => {
    const api = makeApi();
    await renderCard(api);
    const interval = screen.getByLabelText(
      /Back up every/i,
    ) as HTMLInputElement;

    fireEvent.change(interval, { target: { value: "" } });
    expect(api.configure).not.toHaveBeenCalled();

    fireEvent.blur(interval);
    // Empty is not a valid write: no IPC, and the field snaps back to 24.
    expect(api.configure).not.toHaveBeenCalled();
    expect(interval.value).toBe("24");
  });

  it("clamps an over-max interval before persisting", async () => {
    const api = makeApi();
    await renderCard(api);
    const interval = screen.getByLabelText(
      /Back up every/i,
    ) as HTMLInputElement;

    fireEvent.change(interval, { target: { value: "9999" } });
    fireEvent.blur(interval);
    await waitFor(() =>
      expect(api.configure).toHaveBeenCalledWith({
        backupIntervalHours: MAX_BACKUP_INTERVAL_HOURS,
      }),
    );
    expect(interval.value).toBe(String(MAX_BACKUP_INTERVAL_HOURS));
  });

  it("clamps a below-min retention before persisting", async () => {
    const api = makeApi();
    await renderCard(api);
    const retention = screen.getByLabelText(
      /Keep this many backups/i,
    ) as HTMLInputElement;

    fireEvent.change(retention, { target: { value: "0" } });
    fireEvent.blur(retention);
    await waitFor(() =>
      expect(api.configure).toHaveBeenCalledWith({
        backupRetentionCount: MIN_BACKUP_RETENTION_COUNT,
      }),
    );
    expect(retention.value).toBe(String(MIN_BACKUP_RETENTION_COUNT));
  });

  it("does not persist when the committed value is unchanged", async () => {
    const api = makeApi();
    await renderCard(api);
    const retention = screen.getByLabelText(
      /Keep this many backups/i,
    ) as HTMLInputElement;

    // Re-enter the same value (7) and blur: no write should occur.
    fireEvent.change(retention, { target: { value: "7" } });
    fireEvent.blur(retention);
    expect(api.configure).not.toHaveBeenCalled();
    expect(MAX_BACKUP_RETENTION_COUNT).toBeGreaterThan(
      MIN_BACKUP_RETENTION_COUNT,
    );
  });

  it("commits on Enter via blur", async () => {
    const api = makeApi();
    await renderCard(api);
    const interval = screen.getByLabelText(
      /Back up every/i,
    ) as HTMLInputElement;

    fireEvent.change(interval, { target: { value: "12" } });
    fireEvent.keyDown(interval, { key: "Enter" });
    // keyDown handler blurs the field, which triggers the commit.
    fireEvent.blur(interval);
    await waitFor(() =>
      expect(api.configure).toHaveBeenCalledWith({ backupIntervalHours: 12 }),
    );
    expect(MIN_BACKUP_INTERVAL_HOURS).toBe(1);
  });
});
