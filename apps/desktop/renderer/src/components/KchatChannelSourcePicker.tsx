/**
 * "Add KChat channel as source" modal.
 *
 * Lists the user's KChat teams, then channels in the selected team,
 * lets the user preview the channel's file list, and on submit
 * registers the channel as a Tessera source via
 * `sources:addKchatChannel`. The main process downloads the
 * channel's files to a cache directory and runs them through the
 * standard extraction + indexing pipeline.
 *
 * Rendered only when KChat is `connected` — the caller (SourcesPage)
 * gates visibility on `window.tessera.kchat.status()`.
 */
import { useCallback, useEffect, useId, useMemo, useState } from "react";
import Modal from "./Modal";
import Button from "./Button";
import { useToast } from "./Toast";
import {
  getStoredDefaultTeamId,
  setStoredDefaultTeamId,
} from "./KchatSettingsCard";
import type {
  KchatChannelView,
  KchatFileView,
  KchatTeamView,
} from "../../../shared/types";

interface KchatChannelSourcePickerProps {
  isOpen: boolean;
  onClose: () => void;
  /** Called after a successful registration so the parent can refresh. */
  onAdded?: (sourceId: string) => void;
  /** Override `window.tessera.kchat` (used by tests). */
  api?: typeof window.tessera.kchat;
}

export default function KchatChannelSourcePicker({
  isOpen,
  onClose,
  onAdded,
  api,
}: KchatChannelSourcePickerProps) {
  const kchat = api ?? window.tessera?.kchat;
  const toast = useToast();
  const teamId = useId();
  const channelId = useId();

  const [teams, setTeams] = useState<KchatTeamView[]>([]);
  const [selectedTeam, setSelectedTeam] = useState<string>(
    getStoredDefaultTeamId() ?? "",
  );
  const [channels, setChannels] = useState<KchatChannelView[]>([]);
  const [selectedChannel, setSelectedChannel] = useState<string>("");
  const [files, setFiles] = useState<KchatFileView[]>([]);
  const [loadingFiles, setLoadingFiles] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isOpen || !kchat) return;
    let cancelled = false;
    setError(null);
    (async () => {
      try {
        const list = await kchat.listTeams();
        if (cancelled) return;
        setTeams(list);
        if (!selectedTeam && list[0]) {
          setSelectedTeam(list[0].id);
          setStoredDefaultTeamId(list[0].id);
        }
      } catch (err) {
        if (!cancelled) setError(`Failed to list teams: ${msg(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, kchat, selectedTeam]);

  useEffect(() => {
    if (!isOpen || !kchat || !selectedTeam) return;
    let cancelled = false;
    setChannels([]);
    setSelectedChannel("");
    (async () => {
      try {
        const list = await kchat.listChannels(selectedTeam);
        if (cancelled) return;
        const sharable = list.filter(
          (c) => c.type === "O" || c.type === "P",
        );
        setChannels(sharable);
        if (sharable[0]) setSelectedChannel(sharable[0].id);
      } catch (err) {
        if (!cancelled) setError(`Failed to list channels: ${msg(err)}`);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, kchat, selectedTeam]);

  useEffect(() => {
    if (!isOpen || !kchat || !selectedChannel) {
      setFiles([]);
      return;
    }
    let cancelled = false;
    setLoadingFiles(true);
    (async () => {
      try {
        const list = await kchat.listChannelFiles(selectedChannel, 0, 50);
        if (!cancelled) setFiles(list);
      } catch (err) {
        if (!cancelled) setError(`Failed to list files: ${msg(err)}`);
      } finally {
        if (!cancelled) setLoadingFiles(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [isOpen, kchat, selectedChannel]);

  const channelName = useMemo(() => {
    const c = channels.find((x) => x.id === selectedChannel);
    return c?.display_name || c?.name || "";
  }, [channels, selectedChannel]);

  const handleAdd = useCallback(async () => {
    if (!kchat) return;
    if (!selectedChannel || !channelName) {
      setError("Pick a channel first");
      return;
    }
    setBusy(true);
    setError(null);
    try {
      const result = await kchat.addChannelSource(
        selectedChannel,
        channelName,
      );
      toast.addToast(
        `Added KChat channel "${channelName}" as a source`,
        "success",
      );
      onAdded?.(result.sourceId);
      onClose();
    } catch (err) {
      setError(msg(err));
    } finally {
      setBusy(false);
    }
  }, [kchat, selectedChannel, channelName, toast, onAdded, onClose]);

  return (
    <Modal isOpen={isOpen} onClose={onClose} title="Add KChat channel as source">
      <div style={{ display: "flex", flexDirection: "column", gap: "var(--spacing-md)" }}>
        <p style={{ fontSize: "var(--font-size-sm)", color: "var(--color-text-secondary)" }}>
          Tessera will download and index the files in the selected
          channel so you can search and cite them. Future files added
          to the channel are picked up by the next scheduled sync.
        </p>

        <div>
          <label htmlFor={teamId} style={labelStyle}>
            Team
          </label>
          <select
            id={teamId}
            className="input"
            value={selectedTeam}
            onChange={(e) => {
              setSelectedTeam(e.target.value);
              setStoredDefaultTeamId(e.target.value || null);
            }}
            disabled={teams.length === 0 || busy}
            data-testid="kchat-source-team"
          >
            {teams.length === 0 ? (
              <option value="">No teams</option>
            ) : (
              teams.map((t) => (
                <option key={t.id} value={t.id}>
                  {t.display_name || t.name}
                </option>
              ))
            )}
          </select>
        </div>

        <div>
          <label htmlFor={channelId} style={labelStyle}>
            Channel
          </label>
          <select
            id={channelId}
            className="input"
            value={selectedChannel}
            onChange={(e) => setSelectedChannel(e.target.value)}
            disabled={channels.length === 0 || busy}
            data-testid="kchat-source-channel"
          >
            {channels.length === 0 ? (
              <option value="">No shareable channels</option>
            ) : (
              channels.map((c) => (
                <option key={c.id} value={c.id}>
                  {(c.type === "P" ? "🔒 " : "# ") +
                    (c.display_name || c.name)}
                </option>
              ))
            )}
          </select>
        </div>

        <div>
          <div style={labelStyle}>Files preview</div>
          <div
            style={{
              border: "1px solid var(--color-border)",
              borderRadius: "var(--radius-sm)",
              maxHeight: "200px",
              overflow: "auto",
              fontSize: "var(--font-size-sm)",
            }}
            data-testid="kchat-source-file-list"
          >
            {loadingFiles ? (
              <div style={{ padding: "var(--spacing-sm)" }}>Loading…</div>
            ) : files.length === 0 ? (
              <div
                style={{
                  padding: "var(--spacing-sm)",
                  color: "var(--color-text-secondary)",
                }}
              >
                No files in this channel yet.
              </div>
            ) : (
              <ul style={{ margin: 0, padding: "var(--spacing-sm) var(--spacing-md)" }}>
                {files.map((f) => (
                  <li key={f.id} style={{ padding: "2px 0" }}>
                    <span>{f.name}</span>
                    <span
                      style={{
                        marginLeft: "var(--spacing-sm)",
                        color: "var(--color-text-secondary)",
                      }}
                    >
                      ({f.mime_type || f.extension || "file"} ·{" "}
                      {formatBytes(f.size)})
                    </span>
                  </li>
                ))}
              </ul>
            )}
          </div>
        </div>

        {error && (
          <p
            role="alert"
            style={{ fontSize: "var(--font-size-sm)", color: "var(--color-error, #c00)" }}
            data-testid="kchat-source-error"
          >
            {error}
          </p>
        )}

        <div style={{ display: "flex", gap: "var(--spacing-sm)", justifyContent: "flex-end" }}>
          <Button variant="secondary" onClick={onClose} disabled={busy}>
            Cancel
          </Button>
          <Button
            onClick={handleAdd}
            disabled={busy || !selectedChannel}
            data-testid="kchat-source-add"
          >
            {busy ? "Adding…" : "Add as source"}
          </Button>
        </div>
      </div>
    </Modal>
  );
}

const labelStyle = {
  display: "block",
  fontSize: "var(--font-size-sm)",
  fontWeight: "var(--font-weight-medium)" as unknown as number,
  marginBottom: "var(--spacing-xs)",
  color: "var(--color-text-headline)",
} as const;

function formatBytes(n: number): string {
  if (!Number.isFinite(n) || n < 0) return "0 B";
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  if (n < 1024 * 1024 * 1024) return `${(n / 1024 / 1024).toFixed(1)} MB`;
  return `${(n / 1024 / 1024 / 1024).toFixed(1)} GB`;
}

function msg(err: unknown): string {
  return err instanceof Error ? err.message : String(err);
}
